import type { StreamChatParams } from '../host.js';

export type 反馈意图 = 'bug' | 'feature' | 'unclear';

export interface 模板字段 {
  id: string;
  label: string;
  type: string;
  required: boolean;
}

export interface Issue模板 {
  name: string;
  sourcePath: string;
  fields: 模板字段[];
}

export interface 反馈草稿 {
  sessionKey: string;
  intent: 反馈意图;
  targetRepo: string;
  title?: string;
  fields: Record<string, string>;
  missingFields: string[];
  status: 'collecting' | 'preview' | 'confirmed' | 'submitted' | 'cancelled';
  issueUrl?: string;
  updatedAt: string;
}

interface 模板缓存记录 {
  expiresAt: number;
  template: Issue模板;
}

interface Intake结构化输出 {
  intent?: string;
  confidence?: number;
  missing_fields?: unknown;
  next_question?: string;
  can_preview?: boolean;
  target_repo?: string;
  title?: string;
  fields?: Record<string, unknown>;
}

export interface 反馈工作流配置 {
  enabled: boolean;
  openaiBaseUrl: string;
  openaiApiKey: string;
  model: string;
  githubApiBaseUrl: string;
  githubToken?: string;
  defaultTargetRepo?: string;
  requestTimeoutMs?: number;
}

export interface 反馈处理结果 {
  handled: boolean;
  text?: string;
}

type FetchLike = typeof fetch;

const 默认超时毫秒 = 20_000;
const 模板缓存毫秒 = 5 * 60_000;

const 进入反馈关键词 = [
  /\bissue\b/i,
  /bug report/i,
  /feature request/i,
  /提交\s*issue/,
  /提\s*issue/,
  /反馈/,
  /工单/,
  /功能建议/,
  /缺陷反馈/,
];

const 确认关键词 = [/^确认$/, /确认提交/, /提交吧/, /同意提交/, /^yes$/i, /^confirm$/i, /^ok$/i];
const 取消关键词 = [/^取消$/, /停止$/, /终止$/, /^cancel$/i, /^abort$/i];

const 兜底模板: Record<'bug' | 'feature', Issue模板> = {
  bug: {
    name: 'generic-bug',
    sourcePath: 'fallback:generic-bug',
    fields: [
      { id: 'title', label: '标题', type: 'input', required: true },
      { id: 'summary', label: '问题描述', type: 'textarea', required: true },
      { id: 'steps', label: '复现步骤', type: 'textarea', required: true },
      { id: 'expected', label: '预期结果', type: 'textarea', required: true },
      { id: 'actual', label: '实际结果', type: 'textarea', required: true },
      { id: 'environment', label: '环境信息', type: 'textarea', required: false },
    ],
  },
  feature: {
    name: 'generic-feature',
    sourcePath: 'fallback:generic-feature',
    fields: [
      { id: 'title', label: '标题', type: 'input', required: true },
      { id: 'summary', label: '需求描述', type: 'textarea', required: true },
      { id: 'motivation', label: '动机与价值', type: 'textarea', required: true },
      { id: 'proposal', label: '建议方案', type: 'textarea', required: false },
      { id: 'alternatives', label: '备选方案', type: 'textarea', required: false },
    ],
  },
};

export class 反馈Issue工作流 {
  private readonly drafts = new Map<string, 反馈草稿>();
  private readonly templateCache = new Map<string, 模板缓存记录>();

  constructor(
    private readonly config: 反馈工作流配置,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async handle(params: Pick<StreamChatParams, 'sessionId' | 'prompt' | 'conversationHistory'>): Promise<反馈处理结果> {
    if (!this.config.enabled) return { handled: false };

    const text = (params.prompt || '').trim();
    if (!text) return { handled: false };

    const sessionId = params.sessionId;
    const existing = this.drafts.get(sessionId);

    if (!existing && !是反馈入口消息(text)) {
      return { handled: false };
    }

    if (existing && 命中关键词(text, 取消关键词)) {
      existing.status = 'cancelled';
      existing.updatedAt = new Date().toISOString();
      this.drafts.delete(sessionId);
      return {
        handled: true,
        text: '已取消本次反馈分诊流程。你可以随时重新说“提交 issue”来开始新的草稿。',
      };
    }

    const draft = existing ?? this.创建初始草稿(sessionId, text);
    this.drafts.set(sessionId, draft);

    if (draft.status === 'preview' && 命中关键词(text, 确认关键词)) {
      return this.提交Issue(draft);
    }

    return this.继续分诊(draft, text, params.conversationHistory || []);
  }

  private 创建初始草稿(sessionId: string, text: string): 反馈草稿 {
    const targetRepo = 提取仓库(text) || this.config.defaultTargetRepo || '';
    const now = new Date().toISOString();
    return {
      sessionKey: sessionId,
      intent: 'unclear',
      targetRepo,
      fields: {},
      missingFields: [],
      status: 'collecting',
      updatedAt: now,
    };
  }

  private async 继续分诊(
    draft: 反馈草稿,
    text: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<反馈处理结果> {
    const repoFromText = 提取仓库(text);
    if (repoFromText) {
      draft.targetRepo = repoFromText;
    }

    if (!draft.targetRepo) {
      draft.updatedAt = new Date().toISOString();
      return {
        handled: true,
        text: '请先告诉我要提交到哪个仓库，例如 `owner/repo` 或 GitHub issue 链接。',
      };
    }

    const template = await this.加载动态模板(draft.targetRepo, draft.intent);
    const intake = await this.调用Intake技能(draft, text, history, template);

    this.合并意图与字段(draft, intake, template);

    const missing = 计算缺失字段(template, draft.fields);
    draft.missingFields = missing;
    draft.status = missing.length > 0 ? 'collecting' : 'preview';
    draft.updatedAt = new Date().toISOString();

    if (draft.status === 'collecting') {
      const nextQuestion = this.构建下一问(template, draft, intake.next_question);
      const missingLabels = missing.map(id => 字段标签(template, id)).join('、');
      return {
        handled: true,
        text: [
          `我在继续整理 issue 草稿（仓库：${draft.targetRepo}）。`,
          `当前还缺少必填项：${missingLabels || '无'}`,
          nextQuestion,
          '你也可以直接补充多项信息，我会自动聚合。',
        ].join('\n'),
      };
    }

    const preview = await this.调用Draft技能生成预览(draft, template);
    return {
      handled: true,
      text: [
        `已生成 issue 预览（仓库：${draft.targetRepo}）：`,
        '',
        preview,
        '',
        '如果确认无误，请回复“确认提交”。如需修改，直接补充内容即可。',
      ].join('\n'),
    };
  }

  private 构建下一问(template: Issue模板, draft: 反馈草稿, modelQuestion?: string): string {
    const question = (modelQuestion || '').trim();
    if (question) return question;

    const firstMissing = draft.missingFields[0];
    if (!firstMissing) {
      return '请补充你希望写入 issue 的更多细节。';
    }

    const label = 字段标签(template, firstMissing);
    return `请先补充“${label}”。`;
  }

  private async 提交Issue(draft: 反馈草稿): Promise<反馈处理结果> {
    const template = await this.加载动态模板(draft.targetRepo, draft.intent);
    const missing = 计算缺失字段(template, draft.fields);
    draft.missingFields = missing;
    draft.updatedAt = new Date().toISOString();

    if (missing.length > 0) {
      draft.status = 'collecting';
      return {
        handled: true,
        text: `还不能提交：缺少必填项 ${missing.map(id => 字段标签(template, id)).join('、')}。请补充后我再提交。`,
      };
    }

    if (!this.config.githubToken?.trim()) {
      draft.status = 'preview';
      return {
        handled: true,
        text: '当前未配置 GitHub Token，无法直接创建 issue。你可以先复制预览手动提交，或在配置里补充 github.api_token。',
      };
    }

    const title = 生成Issue标题(draft);
    const body = 生成Issue正文(template, draft.fields);

    const controller = new AbortController();
    const timeoutMs = this.config.requestTimeoutMs || 默认超时毫秒;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(
        joinUrl(this.config.githubApiBaseUrl, `/repos/${draft.targetRepo}/issues`),
        {
          method: 'POST',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.config.githubToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ title, body }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        draft.status = 'preview';
        return {
          handled: true,
          text: `创建 issue 失败（HTTP ${response.status}）。${简化错误(errText)}\n你可以修正后回复“确认提交”重试。`,
        };
      }

      const payload = await response.json() as { html_url?: string };
      const issueUrl = payload.html_url || '';
      draft.issueUrl = issueUrl;
      draft.status = 'submitted';
      draft.updatedAt = new Date().toISOString();

      return {
        handled: true,
        text: issueUrl
          ? `Issue 已创建成功：${issueUrl}`
          : 'Issue 已创建成功，但未返回可展示链接。',
      };
    } catch (error) {
      draft.status = 'preview';
      const message = error instanceof Error ? error.message : String(error);
      return {
        handled: true,
        text: `提交时发生错误：${message}\n请稍后回复“确认提交”重试。`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private 合并意图与字段(draft: 反馈草稿, intake: Intake结构化输出, template: Issue模板): void {
    const intent = 标准化意图(intake.intent);
    if (intent) {
      draft.intent = intent;
    }

    const targetRepo = 标准化仓库(intake.target_repo || '');
    if (targetRepo) {
      draft.targetRepo = targetRepo;
    }

    if (typeof intake.title === 'string' && intake.title.trim()) {
      draft.title = intake.title.trim();
      draft.fields.title = intake.title.trim();
    }

    const incomingFields = intake.fields && typeof intake.fields === 'object'
      ? Object.entries(intake.fields)
      : [];

    for (const [rawKey, rawValue] of incomingFields) {
      const normalizedKey = 映射字段ID(rawKey, template);
      const normalizedValue = 规范化字段值(rawValue);
      if (!normalizedKey || !normalizedValue) continue;
      draft.fields[normalizedKey] = normalizedValue;
      if (normalizedKey === 'title') {
        draft.title = normalizedValue;
      }
    }

    if (!draft.fields.title && draft.title) {
      draft.fields.title = draft.title;
    }
  }

  private async 调用Intake技能(
    draft: 反馈草稿,
    text: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    template: Issue模板,
  ): Promise<Intake结构化输出> {
    const requiredIds = template.fields.filter(item => item.required).map(item => item.id);
    const historyText = history
      .slice(-6)
      .map(item => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.content}`)
      .join('\n');

    const instructions = [
      '你是 feedback-intake 技能。',
      '目标：把用户反馈整理成可提交 issue 的结构化信息，并且每轮只问一个问题。',
      '仅输出 JSON，不要输出额外解释。',
      'JSON 字段：intent, confidence, target_repo, title, fields, missing_fields, next_question, can_preview。',
      'intent 只能是 bug|feature|unclear。',
      'fields 优先使用模板字段 id 作为 key。',
    ].join('\n');

    const input = [
      `target_repo: ${draft.targetRepo}`,
      `required_field_ids: ${JSON.stringify(requiredIds)}`,
      `template_fields: ${JSON.stringify(template.fields)}`,
      `current_fields: ${JSON.stringify(draft.fields)}`,
      `history:\n${historyText || '(empty)'}`,
      `latest_user_message: ${text}`,
    ].join('\n\n');

    const output = await this.调用模型(instructions, input);
    const parsed = 解析JSON输出(output);

    if (parsed && typeof parsed === 'object') {
      return parsed as Intake结构化输出;
    }

    // AI 返回异常时做安全兜底，保证流程不中断
    return {
      intent: 从文本猜测意图(text),
      fields: {},
      next_question: '我需要更多细节才能整理成 issue。请描述“实际发生了什么”和“你期望发生什么”。',
      can_preview: false,
    };
  }

  private async 调用Draft技能生成预览(draft: 反馈草稿, template: Issue模板): Promise<string> {
    const instructions = [
      '你是 issue-draft 技能。',
      '根据输入内容生成可读 issue 预览。',
      '必须包含：标题、摘要、按模板字段展开的正文、待补充项（若无则写“无”）。',
      '输出 Markdown 文本，不要输出 JSON。',
    ].join('\n');

    const input = [
      `intent: ${draft.intent}`,
      `target_repo: ${draft.targetRepo}`,
      `template: ${JSON.stringify(template)}`,
      `fields: ${JSON.stringify(draft.fields)}`,
      `missing_fields: ${JSON.stringify(draft.missingFields)}`,
    ].join('\n\n');

    const text = (await this.调用模型(instructions, input)).trim();
    if (text) return text;

    return 生成预览Markdown(draft, template);
  }

  private async 调用模型(instructions: string, input: string): Promise<string> {
    const controller = new AbortController();
    const timeoutMs = this.config.requestTimeoutMs || 默认超时毫秒;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(joinUrl(this.config.openaiBaseUrl, '/responses'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          input,
          instructions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return '';
      }

      const data = await response.json() as unknown;
      return 提取响应文本(data);
    } catch {
      return '';
    } finally {
      clearTimeout(timeout);
    }
  }

  private async 加载动态模板(repo: string, intent: 反馈意图): Promise<Issue模板> {
    const normalizedRepo = 标准化仓库(repo);
    if (!normalizedRepo) {
      return 兜底模板[intent === 'feature' ? 'feature' : 'bug'];
    }

    const cacheKey = `${normalizedRepo}:${intent}`;
    const cached = this.templateCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.template;
    }

    const loaded = await this.从GitHub读取模板(normalizedRepo, intent);
    const template = loaded || 兜底模板[intent === 'feature' ? 'feature' : 'bug'];

    this.templateCache.set(cacheKey, {
      expiresAt: Date.now() + 模板缓存毫秒,
      template,
    });

    return template;
  }

  private async 从GitHub读取模板(repo: string, intent: 反馈意图): Promise<Issue模板 | null> {
    const list = await this.请求GitHub(
      `/repos/${repo}/contents/.github/ISSUE_TEMPLATE`,
      { method: 'GET' },
    );

    if (!Array.isArray(list)) return null;

    const candidates = list
      .filter((item): item is { type: string; name: string; url: string } => (
        Boolean(item)
        && typeof item === 'object'
        && (item as { type?: unknown }).type === 'file'
        && typeof (item as { name?: unknown }).name === 'string'
        && typeof (item as { url?: unknown }).url === 'string'
      ))
      .filter(item => /\.ya?ml$/i.test(item.name));

    if (candidates.length === 0) return null;

    const parsedTemplates: Issue模板[] = [];
    for (const file of candidates) {
      const detail = await this.请求GitHub(file.url, { method: 'GET' }, true);
      const content = 解析GitHub文件内容(detail);
      if (!content) continue;

      const fields = 解析IssueForm字段(content);
      if (fields.length === 0) continue;

      const name = 从YAML提取名称(content) || file.name;
      parsedTemplates.push({
        name,
        sourcePath: `.github/ISSUE_TEMPLATE/${file.name}`,
        fields,
      });
    }

    if (parsedTemplates.length === 0) return null;

    const scored = parsedTemplates.map(template => ({
      template,
      score: 模板匹配分(template, intent),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0].template;
  }

  private async 请求GitHub(pathOrUrl: string, init: RequestInit, fullUrl = false): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = this.config.requestTimeoutMs || 默认超时毫秒;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
      };
      if (this.config.githubToken?.trim()) {
        headers.authorization = `Bearer ${this.config.githubToken}`;
      }

      const url = fullUrl ? pathOrUrl : joinUrl(this.config.githubApiBaseUrl, pathOrUrl);
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...headers,
          ...(init.headers || {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) return null;
      return await response.json() as unknown;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function 是反馈入口消息(text: string): boolean {
  return 命中关键词(text, 进入反馈关键词);
}

function 命中关键词(text: string, patterns: RegExp[]): boolean {
  const trimmed = text.trim();
  return patterns.some(pattern => pattern.test(trimmed));
}

function 提取仓库(text: string): string {
  const urlMatch = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(text);
  if (urlMatch?.[1]) {
    return 标准化仓库(urlMatch[1]);
  }

  const repoMatch = /(^|\s)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=\s|$)/.exec(text);
  if (repoMatch?.[2]) {
    return 标准化仓库(repoMatch[2]);
  }

  return '';
}

function 标准化仓库(input: string): string {
  const trimmed = (input || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

function 标准化意图(intent: unknown): 反馈意图 | null {
  if (typeof intent !== 'string') return null;
  const normalized = intent.trim().toLowerCase();
  if (normalized === 'bug' || normalized === 'feature' || normalized === 'unclear') {
    return normalized;
  }
  return null;
}

function 从文本猜测意图(text: string): 反馈意图 {
  if (/feature|enhancement|需求|建议|功能/.test(text.toLowerCase())) return 'feature';
  if (/bug|error|报错|异常|没反应|故障/.test(text.toLowerCase())) return 'bug';
  return 'unclear';
}

function 规范化字段值(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(item => 规范化字段值(item)).filter(Boolean).join('\n').trim();
  }
  return '';
}

function 映射字段ID(input: string, template: Issue模板): string {
  const key = (input || '').trim();
  if (!key) return '';

  const exact = template.fields.find(item => item.id.toLowerCase() === key.toLowerCase());
  if (exact) return exact.id;

  const aliasMap: Record<string, string> = {
    标题: 'title',
    title: 'title',
    summary: 'summary',
    description: 'summary',
    问题描述: 'summary',
    what_happened: 'summary',
    'what-happened': 'summary',
    steps: 'steps',
    复现步骤: 'steps',
    expected: 'expected',
    预期结果: 'expected',
    actual: 'actual',
    实际结果: 'actual',
    environment: 'environment',
    环境: 'environment',
    motivation: 'motivation',
    proposal: 'proposal',
  };

  const alias = aliasMap[key] || aliasMap[key.toLowerCase()];
  if (!alias) return key;

  const matched = template.fields.find(item => item.id.toLowerCase() === alias);
  return matched ? matched.id : alias;
}

function 模板匹配分(template: Issue模板, intent: 反馈意图): number {
  const seed = `${template.name} ${template.sourcePath}`.toLowerCase();
  let score = template.fields.filter(item => item.required).length;

  if (intent === 'bug') {
    if (/bug|defect|错误|异常|problem|crash/.test(seed)) score += 8;
  } else if (intent === 'feature') {
    if (/feature|enhancement|idea|proposal|需求|建议/.test(seed)) score += 8;
  }

  if (template.fields.some(item => item.id === 'title')) score += 2;
  return score;
}

function 解析GitHub文件内容(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const data = payload as { content?: unknown; encoding?: unknown };
  if (typeof data.content !== 'string') return '';

  if (data.encoding === 'base64') {
    const base = data.content.replace(/\n/g, '');
    return Buffer.from(base, 'base64').toString('utf8');
  }

  return data.content;
}

function 从YAML提取名称(yaml: string): string {
  const match = /^\s*name:\s*(.+)$/m.exec(yaml);
  if (!match?.[1]) return '';
  return 清理YAML值(match[1]);
}

function 清理YAML值(raw: string): string {
  return raw.trim().replace(/^['"]/, '').replace(/['"]$/, '');
}

export function 解析IssueForm字段(yaml: string): 模板字段[] {
  const lines = yaml.split(/\r?\n/);
  const fields: 模板字段[] = [];

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const start = /^(\s*)-\s*type:\s*([A-Za-z0-9_-]+)/.exec(line);
    if (!start) {
      i++;
      continue;
    }

    const baseIndent = start[1].length;
    const blockLines = [line];
    i++;

    while (i < lines.length) {
      const current = lines[i];
      const indent = (current.match(/^\s*/) || [''])[0].length;
      const isNext = indent <= baseIndent && /^\s*-\s*type:\s*/.test(current);
      if (isNext) break;
      blockLines.push(current);
      i++;
    }

    const block = blockLines.join('\n');
    const idMatch = /^\s*id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/m.exec(block);
    if (!idMatch?.[1]) continue;

    const labelMatch = /^\s*label:\s*(.+)$/m.exec(block);
    const required = /^\s*required:\s*true\s*$/mi.test(block);

    fields.push({
      id: idMatch[1].trim(),
      label: labelMatch?.[1] ? 清理YAML值(labelMatch[1]) : idMatch[1].trim(),
      type: start[2].trim(),
      required,
    });
  }

  return fields;
}

function 字段标签(template: Issue模板, fieldId: string): string {
  const found = template.fields.find(item => item.id === fieldId);
  return found?.label || fieldId;
}

export function 计算缺失字段(template: Issue模板, fields: Record<string, string>): string[] {
  return template.fields
    .filter(item => item.required)
    .map(item => item.id)
    .filter(id => !字段已填写(fields[id]));
}

function 字段已填写(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

function 生成Issue标题(draft: 反馈草稿): string {
  const title = draft.fields.title?.trim() || draft.title?.trim();
  if (title) return title;

  const fallback = draft.fields.summary?.trim() || '用户反馈';
  const prefix = draft.intent === 'feature' ? '[Feature]' : '[Bug]';
  const short = fallback.length > 70 ? `${fallback.slice(0, 70)}...` : fallback;
  return `${prefix} ${short}`;
}

export function 生成Issue正文(template: Issue模板, fields: Record<string, string>): string {
  const lines: string[] = [];

  for (const field of template.fields) {
    const value = (fields[field.id] || '').trim();
    if (!value) {
      if (field.required) {
        lines.push(`## ${field.label}`);
        lines.push('(待补充)');
        lines.push('');
      }
      continue;
    }

    lines.push(`## ${field.label}`);
    lines.push(value);
    lines.push('');
  }

  const known = new Set(template.fields.map(item => item.id));
  const extras = Object.entries(fields).filter(([id, value]) => !known.has(id) && value.trim());
  if (extras.length > 0) {
    lines.push('## Additional Context');
    for (const [id, value] of extras) {
      lines.push(`- ${id}: ${value}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

function 生成预览Markdown(draft: 反馈草稿, template: Issue模板): string {
  const title = 生成Issue标题(draft);
  const missing = draft.missingFields.map(id => 字段标签(template, id));
  const body = 生成Issue正文(template, draft.fields);

  return [
    `**标题**: ${title}`,
    '',
    '**正文预览**',
    body,
    '',
    `**待补充字段**: ${missing.length > 0 ? missing.join('、') : '无'}`,
  ].join('\n');
}

function 简化错误(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '未知错误';
  if (trimmed.length <= 240) return trimmed;
  return `${trimmed.slice(0, 240)}...`;
}

function joinUrl(baseUrl: string, pathValue: string): string {
  return `${baseUrl.replace(/\/$/, '')}${pathValue}`;
}

function 解析JSON输出(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // continue
  }

  const codeBlock = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (codeBlock?.[1]) {
    try {
      return JSON.parse(codeBlock[1].trim()) as Record<string, unknown>;
    } catch {
      // continue
    }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
}

function 提取响应文本(data: unknown): string {
  const anyData = data as {
    output_text?: unknown;
    output?: Array<{ text?: unknown; content?: Array<{ text?: unknown }> }>;
    choices?: Array<{ message?: { content?: unknown } }>;
  };

  if (typeof anyData?.output_text === 'string' && anyData.output_text.trim()) {
    return anyData.output_text;
  }

  if (Array.isArray(anyData?.output)) {
    const parts: string[] = [];
    for (const item of anyData.output) {
      if (typeof item?.text === 'string' && item.text) {
        parts.push(item.text);
      }
      if (!Array.isArray(item?.content)) continue;
      for (const content of item.content) {
        if (typeof content?.text === 'string' && content.text) {
          parts.push(content.text);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  const content = anyData?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map(item => (item && typeof item === 'object' && 'text' in item && typeof (item as { text?: unknown }).text === 'string')
        ? (item as { text: string }).text
        : '',
      )
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }

  return '';
}
