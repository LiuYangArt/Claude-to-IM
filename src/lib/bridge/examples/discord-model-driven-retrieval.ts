import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import type { StreamChatParams } from '../host.js';
import type { 只读源码配置 } from './discord-lightweight-skills.js';

const 忽略目录 = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.idea', '.vscode']);
const 文本扩展名 = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.txt', '.yml', '.yaml', '.toml', '.html', '.css', '.scss', '.sass', '.less', '.rs', '.go', '.py', '.java', '.kt', '.swift', '.sql', '.sh', '.zsh', '.env', '.ini', '.conf']);

export type 检索模式 = 'keyword' | 'model_driven';

export interface 模型驱动源码配置 extends 只读源码配置 {
  retrievalMode: 检索模式;
  maxToolRounds: number;
  maxReadFiles: number;
  maxReadCharsTotal: number;
  searchMaxResults: number;
  knowledgeDirs: string[];
  memoryFirst: boolean;
  memoryDirs: string[];
  memoryMaxFiles: number;
  memoryMaxCharsTotal: number;
  showEvidenceInReply: boolean;
}

export interface 阶段回复配置 {
  enabled: boolean;
  ackEnabled: boolean;
  ackTextByChannel: Record<string, string>;
  defaultAckText: string;
  reactionEnabled: boolean;
  processingReaction: string;
  doneReaction: string;
  fallbackReaction: string;
}

export interface 只读工具结果<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  truncated?: boolean;
  meta?: Record<string, unknown>;
}

export interface 模型驱动检索问答参数 {
  baseUrl: string;
  apiKey: string;
  model: string;
  params: StreamChatParams;
  源码配置: 模型驱动源码配置;
  技能上下文文本: string;
  技能名称?: string;
  fetchImpl?: typeof fetch;
}

export interface 模型驱动问答结果 {
  text: string;
  usage?: unknown;
  evidenceInsufficient: boolean;
  usedFallback: boolean;
}

interface 工具请求 {
  type: 'tool';
  tool: 'list_dir' | 'search_code' | 'read_file';
  arguments?: Record<string, unknown>;
}

interface 最终回答 {
  type: 'final';
  answer: string;
  citations?: string[];
  evidence_sufficient?: boolean;
}

type 模型决策 = 工具请求 | 最终回答;

interface 源码上下文输入 {
  enabled?: boolean;
  root_dir?: string;
  read_only?: boolean;
  max_files?: number;
  max_chars_per_file?: number;
  max_total_chars?: number;
  max_file_size_bytes?: number;
  retrieval_mode?: 'keyword' | 'model_driven';
  max_tool_rounds?: number;
  max_read_files?: number;
  max_read_chars_total?: number;
  search_max_results?: number;
  knowledge_dirs?: string[];
  memory_first?: boolean;
  memory_dirs?: string[];
  memory_max_files?: number;
  memory_max_chars_total?: number;
  show_evidence_in_reply?: boolean;
}

interface 阶段回复输入 {
  staged_reply_enabled?: boolean;
  staged_ack_enabled?: boolean;
  staged_ack_text?: string;
  staged_ack_text_by_channel?: Record<string, string>;
  staged_reaction_enabled?: boolean;
  staged_reaction_processing?: string;
  staged_reaction_done?: string;
  staged_reaction_fallback?: string;
}

interface 搜索命中 { path: string; line: number; text: string }

export function 规范化模型驱动源码配置(config: 源码上下文输入 | undefined, 默认工作目录: string): 模型驱动源码配置 {
  const rootRaw = config?.root_dir?.trim() || 默认工作目录;
  const rootDir = path.isAbsolute(rootRaw) ? rootRaw : path.resolve(process.cwd(), rootRaw);
  const enabled = config?.enabled !== false;
  const readOnly = config?.read_only !== false;
  if (!readOnly) throw new Error('source_context.read_only 只能为 true；当前宿主只支持只读源码访问');
  if (enabled && !existsSync(rootDir)) throw new Error(`源码目录不存在：${rootDir}`);
  return {
    enabled,
    rootDir,
    readOnly,
    maxFiles: config?.max_files || 4,
    maxCharsPerFile: config?.max_chars_per_file || 1600,
    maxTotalChars: config?.max_total_chars || 5000,
    maxFileSizeBytes: config?.max_file_size_bytes || 200_000,
    retrievalMode: config?.retrieval_mode === 'model_driven' ? 'model_driven' : 'keyword',
    maxToolRounds: config?.max_tool_rounds || 3,
    maxReadFiles: config?.max_read_files || 6,
    maxReadCharsTotal: config?.max_read_chars_total || 12_000,
    searchMaxResults: config?.search_max_results || 20,
    knowledgeDirs: (config?.knowledge_dirs || ['docs/knowledge']).map(item => item.trim()).filter(Boolean),
    memoryFirst: config?.memory_first !== false,
    memoryDirs: (config?.memory_dirs || ['docs/knowledge', 'docs', 'config/prompts']).map(item => item.trim()).filter(Boolean),
    memoryMaxFiles: config?.memory_max_files || 4,
    memoryMaxCharsTotal: config?.memory_max_chars_total || 6000,
    showEvidenceInReply: config?.show_evidence_in_reply === true,
  };
}

export function 规范化阶段回复配置(config: 阶段回复输入 | undefined): 阶段回复配置 {
  return {
    enabled: config?.staged_reply_enabled !== false,
    ackEnabled: config?.staged_ack_enabled !== false,
    ackTextByChannel: Object.fromEntries(Object.entries(config?.staged_ack_text_by_channel || {}).filter(([k, v]) => k.trim() && typeof v === 'string' && v.trim()).map(([k, v]) => [k.trim(), v.trim()])),
    defaultAckText: config?.staged_ack_text?.trim() || '收到，我先看一下。',
    reactionEnabled: config?.staged_reaction_enabled !== false,
    processingReaction: config?.staged_reaction_processing?.trim() || '👀',
    doneReaction: config?.staged_reaction_done?.trim() || '✅',
    fallbackReaction: config?.staged_reaction_fallback?.trim() || '⚠️',
  };
}

export function 获取阶段确认文案(chatId: string | undefined, config: 阶段回复配置): string {
  if (!config.enabled || !config.ackEnabled) return '';
  const key = (chatId || '').trim();
  if (key && config.ackTextByChannel[key]) return config.ackTextByChannel[key] || '';
  return config.defaultAckText;
}

export function 是否证据不足文本(text: string): boolean {
  return /证据不足|未找到依据|未找到足够依据/i.test(text || '');
}

export function 创建只读检索器(config: 模型驱动源码配置) {
  const 已读文件 = new Set<string>();
  let 已读字符数 = 0;

  function 解析路径(input: unknown): { abs: string; rel: string } | null {
    const rel = typeof input === 'string' && input.trim() ? input.trim() : '.';
    const abs = path.resolve(config.rootDir, rel);
    const relBack = path.relative(path.resolve(config.rootDir), abs);
    if (relBack.startsWith('..') || path.isAbsolute(relBack)) return null;
    return { abs, rel: relBack === '' ? '.' : relBack.split(path.sep).join('/') };
  }

  function listDir(dirPath: unknown): 只读工具结果<Array<{ name: string; type: string }>> {
    const parsed = 解析路径(dirPath);
    if (!parsed) return { ok: false, error: 'path out of root_dir' };
    if (!existsSync(parsed.abs)) return { ok: false, error: 'path not found' };
    const entries = readdirSync(parsed.abs, { withFileTypes: true })
      .filter(entry => !忽略目录.has(entry.name))
      .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other' }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 80);
    return { ok: true, data: entries, meta: { path: parsed.rel, count: entries.length } };
  }

  function searchCode(query: unknown, dirPath: unknown, maxResults: unknown): 只读工具结果<搜索命中[]> {
    const keyword = typeof query === 'string' ? query.trim() : '';
    if (keyword.length < 2) return { ok: false, error: 'query must be at least 2 chars' };
    const parsed = 解析路径(dirPath);
    if (!parsed) return { ok: false, error: 'path out of root_dir' };
    if (!existsSync(parsed.abs)) return { ok: false, error: 'path not found' };
    const limit = Math.max(1, Math.min(Number(maxResults) || config.searchMaxResults, config.searchMaxResults));
    const result = spawnSync('rg', ['-n', '-F', '--color', 'never', '--max-count', String(limit), '-g', '!.git', '-g', '!node_modules', '-g', '!dist', '-g', '!build', '-g', '!coverage', keyword, parsed.rel], {
      cwd: config.rootDir,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0 && result.status !== 1) return { ok: false, error: (result.stderr || '').trim() || `rg exit ${result.status}` };
    const data = (result.stdout || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const [file, row, ...rest] = line.split(':');
      return { path: (file || '').split(path.sep).join('/'), line: Number(row) || 0, text: rest.join(':').trim() };
    }).slice(0, limit);
    return { ok: true, data, truncated: data.length >= limit, meta: { path: parsed.rel, count: data.length, query: keyword } };
  }

  function readFile(filePath: unknown, offset: unknown, limit: unknown): 只读工具结果<string> {
    const parsed = 解析路径(filePath);
    if (!parsed) return { ok: false, error: 'path out of root_dir' };
    if (!existsSync(parsed.abs)) return { ok: false, error: 'path not found' };
    const stat = statSync(parsed.abs);
    if (!stat.isFile()) return { ok: false, error: 'path is not file' };
    if (stat.size > config.maxFileSizeBytes) return { ok: false, error: 'file too large' };
    const isNew = !已读文件.has(parsed.rel);
    if (isNew && 已读文件.size >= config.maxReadFiles) return { ok: false, error: 'read file budget exhausted' };
    const remain = config.maxReadCharsTotal - 已读字符数;
    if (remain <= 0) return { ok: false, error: 'read char budget exhausted' };
    const start = Math.max(0, Number(offset) || 0);
    const length = Math.min(Math.max(1, Number(limit) || config.maxCharsPerFile), config.maxCharsPerFile, remain);
    const full = readFileSync(parsed.abs, 'utf8');
    const chunk = full.slice(start, start + length);
    if (isNew) 已读文件.add(parsed.rel);
    已读字符数 += chunk.length;
    return {
      ok: true,
      data: chunk,
      truncated: start + length < full.length,
      meta: { path: parsed.rel, offset: start, returned_chars: chunk.length, total_chars: full.length, read_files_used: 已读文件.size, read_chars_used: 已读字符数 },
    };
  }

  return { listDir, searchCode, readFile };
}

export async function 执行模型驱动检索问答(args: 模型驱动检索问答参数): Promise<模型驱动问答结果> {
  const fetchImpl = args.fetchImpl || fetch;
  const retriever = 创建只读检索器(args.源码配置);
  const cited = new Set<string>();
  const knowledge = 构建目录证据上下文(args.params.prompt, args.源码配置, args.源码配置.knowledgeDirs, '以下是项目知识文档证据：');
  knowledge.sources.forEach(item => cited.add(item));
  if (knowledge.text) {
    const knowledgeDecision = await 请求知识文档直答(fetchImpl, args, knowledge.text);
    if (knowledgeDecision.parsed && knowledgeDecision.value.type === 'final' && knowledgeDecision.value.evidence_sufficient !== false) {
      return {
        text: 组装最终文本(knowledgeDecision.value, cited, args.源码配置.showEvidenceInReply === true),
        usage: knowledgeDecision.usage,
        evidenceInsufficient: false,
        usedFallback: false,
      };
    }
  }
  const memory = 构建记忆上下文(args.params.prompt, args.源码配置);
  memory.sources.forEach(item => cited.add(item));
  const transcript: string[] = [];
  let usage: unknown;
  let parsedAny = false;

  for (let round = 0; round < args.源码配置.maxToolRounds; round++) {
    const decision = await 请求模型决策(fetchImpl, args, transcript, memory.text, false);
    usage = decision.usage;
    if (!decision.parsed) {
      return { text: await 回退回答(fetchImpl, args), usage, evidenceInsufficient: false, usedFallback: true };
    }
    parsedAny = true;
    if (decision.value.type === 'final') {
      return { text: 组装最终文本(decision.value, cited, args.源码配置.showEvidenceInReply === true), usage, evidenceInsufficient: decision.value.evidence_sufficient === false, usedFallback: false };
    }

    const req = decision.value;
    const params = req.arguments || {};
    let result: 只读工具结果;
    if (req.tool === 'list_dir') {
      result = retriever.listDir(params.path);
    } else if (req.tool === 'search_code') {
      result = retriever.searchCode(params.query, params.path, params.max_results);
      for (const item of (result.data as 搜索命中[] | undefined) || []) cited.add(item.path);
    } else {
      result = retriever.readFile(params.path, params.offset, params.limit);
      const p = typeof params.path === 'string' ? params.path.trim() : '';
      if (result.ok && p) cited.add(p);
    }
    transcript.push(`Assistant tool request: ${JSON.stringify(req)}\nTool result: ${JSON.stringify(result)}`);
  }

  const finalDecision = await 请求模型决策(fetchImpl, args, transcript, memory.text, true);
  usage = finalDecision.usage;
  if (finalDecision.parsed && finalDecision.value.type === 'final') {
    return { text: 组装最终文本(finalDecision.value, cited, args.源码配置.showEvidenceInReply === true), usage, evidenceInsufficient: finalDecision.value.evidence_sufficient === false, usedFallback: false };
  }
  if (!parsedAny) {
    return { text: await 回退回答(fetchImpl, args), usage, evidenceInsufficient: false, usedFallback: true };
  }
  return {
    text: 组装最终文本({ type: 'final', answer: '目前没有找到足够依据来给出可靠结论。现有证据不足，请调整问题关键词或补充更具体的线索。', evidence_sufficient: false }, cited),
    usage,
    evidenceInsufficient: true,
    usedFallback: false,
  };
}

function 构建记忆上下文(prompt: string, config: 模型驱动源码配置): { text: string; sources: string[] } {
  if (!config.memoryFirst) return { text: '', sources: [] };
  return 构建目录证据上下文(prompt, config, config.memoryDirs, '以下是优先读取的记忆文档证据：');
}

function 构建目录证据上下文(prompt: string, config: 模型驱动源码配置, dirs: string[], title: string): { text: string; sources: string[] } {
  const keywords = 提取关键词(prompt);
  if (keywords.length === 0) return { text: '', sources: [] };
  const candidates: Array<{ rel: string; score: number; content: string }> = [];
  for (const dir of dirs) {
    const absDir = path.resolve(config.rootDir, dir);
    const relDir = path.relative(config.rootDir, absDir);
    if (relDir.startsWith('..') || path.isAbsolute(relDir) || !existsSync(absDir)) continue;
    for (const file of 收集文本文件(absDir, config.maxFileSizeBytes)) {
      const rel = path.relative(config.rootDir, file).split(path.sep).join('/');
      const content = readFileSync(file, 'utf8');
      const score = 计算文件得分(rel, content, keywords);
      if (score > 0) candidates.push({ rel, score, content });
    }
  }
  const picked = candidates.sort((a, b) => b.score - a.score).slice(0, config.memoryMaxFiles);
  const blocks: string[] = [];
  const sources: string[] = [];
  let total = 0;
  for (const item of picked) {
    const snippet = 提取片段(item.content, keywords, 1200);
    const block = `文件: ${item.rel}\n\
\`\`\`\n${snippet}\n\`\`\``;
    if (total + block.length > config.memoryMaxCharsTotal) break;
    blocks.push(block);
    sources.push(item.rel);
    total += block.length;
  }
  return { text: blocks.length > 0 ? `${title}\n\n${blocks.join('\n\n')}` : '', sources };
}

async function 请求知识文档直答(fetchImpl: typeof fetch, args: 模型驱动检索问答参数, knowledgeText: string): Promise<{ parsed: false; usage?: unknown } | { parsed: true; value: 模型决策; usage?: unknown }> {
  const response = await fetchImpl(joinUrl(args.baseUrl, '/responses'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify({
      model: args.params.model || args.model,
      stream: false,
      input: 构建知识文档直答输入(args.params, args.技能上下文文本, knowledgeText),
      instructions: 构建知识文档直答指令(args.params.systemPrompt, args.源码配置),
    }),
    signal: args.params.abortController?.signal,
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  const data: any = await response.json();
  const text = 提取响应文本(data).trim();
  const parsed = 解析模型决策(text);
  if (!parsed || parsed.type !== 'final') return { parsed: false, usage: data?.usage };
  return { parsed: true, value: parsed, usage: data?.usage };
}

async function 请求模型决策(fetchImpl: typeof fetch, args: 模型驱动检索问答参数, transcript: string[], memoryText: string, forceFinal: boolean): Promise<{ parsed: false; usage?: unknown } | { parsed: true; value: 模型决策; usage?: unknown }> {
  const response = await fetchImpl(joinUrl(args.baseUrl, '/responses'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify({
      model: args.params.model || args.model,
      stream: false,
      input: 构建模型输入(args.params, args.技能上下文文本, memoryText, transcript, forceFinal),
      instructions: 构建模型指令(args.params.systemPrompt, args.源码配置, transcript.length, forceFinal),
    }),
    signal: args.params.abortController?.signal,
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  const data: any = await response.json();
  const text = 提取响应文本(data).trim();
  const parsed = 解析模型决策(text);
  if (!parsed) return { parsed: false, usage: data?.usage };
  return { parsed: true, value: parsed, usage: data?.usage };
}

async function 回退回答(fetchImpl: typeof fetch, args: 模型驱动检索问答参数): Promise<string> {
  const response = await fetchImpl(joinUrl(args.baseUrl, '/responses'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify({
      model: args.params.model || args.model,
      stream: false,
      input: 构建普通输入(args.params, args.技能上下文文本),
      instructions: args.params.systemPrompt,
    }),
    signal: args.params.abortController?.signal,
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  const data: any = await response.json();
  return 提取响应文本(data).trim();
}

function 构建模型指令(systemPrompt: string | undefined, config: 模型驱动源码配置, usedRounds: number, forceFinal: boolean): string {
  const knowledgeDirs = config.knowledgeDirs.filter(Boolean);
  const lines = [
    systemPrompt?.trim() || '',
    '你现在处于只读证据检索模式，必须先找仓库证据再回答。',
    '只允许使用 list_dir(path)、search_code(query, path, max_results)、read_file(path, offset, limit) 三个只读工具。',
    knowledgeDirs.length > 0 ? `第一优先资料目录：${knowledgeDirs.join('、')}。先在这些目录找项目说明文档；只有证据仍不足时，才去查其它源码目录。` : '优先利用已提供的记忆文档证据；若不足，再查源码。',
    '不能编造；证据不足时必须明确写“证据不足”或“未找到依据”。',
    `工具预算：最多 ${config.maxToolRounds} 轮，当前已用 ${usedRounds} 轮。`,
    '输出必须是 JSON，且只能是 JSON。',
    knowledgeDirs.length > 0 ? `第一轮工具请求应优先类似：{"type":"tool","tool":"search_code","arguments":{"query":"...","path":"${knowledgeDirs[0]}","max_results":5}}` : '工具请求格式：{"type":"tool","tool":"search_code","arguments":{"query":"...","path":"docs","max_results":5}}',
    '最终回答格式：{"type":"final","answer":"...","citations":["docs/a.md"],"evidence_sufficient":true}',
  ].filter(Boolean);
  if (forceFinal) lines.push('你已到达工具预算上限，这一次只能输出 final JSON，不能再请求工具。');
  return lines.join('\n');
}

function 构建知识文档直答指令(systemPrompt: string | undefined, config: 模型驱动源码配置): string {
  const knowledgeDirs = config.knowledgeDirs.filter(Boolean);
  return [
    systemPrompt?.trim() || '',
    '你现在只看项目知识文档证据，不允许调用工具，也不要假设你看过源码。',
    knowledgeDirs.length > 0 ? `当前第一资料来源目录：${knowledgeDirs.join('、')}。` : '',
    '如果知识文档已经足够回答，就输出 final JSON，evidence_sufficient=true。',
    '如果知识文档不够，就输出 final JSON，说明证据不足，evidence_sufficient=false。',
    '输出必须是 JSON，且只能是 JSON。',
    '最终回答格式：{"type":"final","answer":"...","citations":["docs/knowledge/index.md"],"evidence_sufficient":true}',
  ].filter(Boolean).join('\n');
}

function 构建模型输入(params: StreamChatParams, skillText: string, memoryText: string, transcript: string[], forceFinal: boolean): string {
  const sections: string[] = [];
  if (skillText) sections.push(`Skill hints:\n${skillText}`);
  if (memoryText) sections.push(`Memory-first evidence:\n${memoryText}`);
  if (transcript.length > 0) sections.push(`Tool transcript:\n${transcript.join('\n\n')}`);
  for (const item of params.conversationHistory || []) sections.push(`${item.role === 'assistant' ? 'Assistant' : 'User'}:\n${item.content}`);
  sections.push(`User:\n${params.prompt}`);
  if (forceFinal) sections.push('现在必须直接给出最终回答。');
  return sections.join('\n\n');
}

function 构建知识文档直答输入(params: StreamChatParams, skillText: string, knowledgeText: string): string {
  const sections: string[] = [];
  if (skillText) sections.push(`Skill hints:\n${skillText}`);
  sections.push(`Knowledge-first evidence:\n${knowledgeText}`);
  for (const item of params.conversationHistory || []) sections.push(`${item.role === 'assistant' ? 'Assistant' : 'User'}:\n${item.content}`);
  sections.push(`User:\n${params.prompt}`);
  return sections.join('\n\n');
}

function 构建普通输入(params: StreamChatParams, sourceText: string): string {
  const sections: string[] = [];
  if (params.systemPrompt) sections.push(`System:\n${params.systemPrompt}`);
  if (sourceText) sections.push(sourceText);
  for (const item of params.conversationHistory || []) sections.push(`${item.role === 'assistant' ? 'Assistant' : 'User'}:\n${item.content}`);
  sections.push(`User:\n${params.prompt}`);
  return sections.join('\n\n');
}

function 解析模型决策(raw: string): 模型决策 | null {
  const jsonText = 提取JSON(raw);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as 模型决策;
    if (parsed.type === 'tool' && (parsed.tool === 'list_dir' || parsed.tool === 'search_code' || parsed.tool === 'read_file')) return parsed;
    if (parsed.type === 'final' && typeof parsed.answer === 'string') return parsed;
  } catch {
    return null;
  }
  return null;
}

function 提取JSON(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1).trim() : text;
}

function 组装最终文本(final: 最终回答, cited: Set<string>, showEvidenceInReply = false): string {
  for (const item of final.citations || []) if (item.trim()) cited.add(item.trim());
  const body = (final.answer || '').trim() || (final.evidence_sufficient === false ? '目前没有找到足够依据来给出可靠结论。' : '模型返回成功，但没有生成可显示答案。');
  if (!showEvidenceInReply) {
    if (final.evidence_sufficient === false && !是否证据不足文本(body)) {
      return `${body}\n\n说明：当前证据不足。`;
    }
    return body;
  }
  const sources = Array.from(cited).sort();
  const sourceText = sources.length > 0 ? `证据来源：\n- ${sources.join('\n- ')}` : '证据来源：未找到可引用文件';
  if (final.evidence_sufficient === false && !是否证据不足文本(body)) {
    return `${body}\n\n说明：当前证据不足，以下仅列出已检索到的相关来源。\n\n${sourceText}`;
  }
  return `${body}\n\n${sourceText}`;
}

function 提取响应文本(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text;
  if (Array.isArray(data?.output)) {
    const parts: string[] = [];
    for (const item of data.output) {
      if (typeof item?.text === 'string') parts.push(item.text);
      if (Array.isArray(item?.content)) {
        for (const content of item.content) if (typeof content?.text === 'string') parts.push(content.text);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item: any) => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('\n');
  return '';
}

function joinUrl(base: string, p: string): string {
  return `${base.replace(/\/$/, '')}${p}`;
}

function 提取关键词(prompt: string): string[] {
  return Array.from(new Set((prompt.toLowerCase().match(/[a-z0-9_./\-\u4e00-\u9fa5]+/g) || [])
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => item.length >= 2)
    .filter(item => !['please', 'help', 'with', 'this', 'that', 'what', 'how', 'the', 'and', 'for', '你', '我', '我们', '怎么', '什么', '一下', '这个', '那个'].includes(item)))).slice(0, 12);
}

function 收集文本文件(root: string, maxSize: number, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (忽略目录.has(entry.name)) continue;
      收集文本文件(full, maxSize, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!是否文本文件(full)) continue;
    if (statSync(full).size > maxSize) continue;
    out.push(full);
  }
  return out;
}

function 是否文本文件(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (name === 'dockerfile' || name === 'makefile') return true;
  return 文本扩展名.has(path.extname(filePath).toLowerCase());
}

function 计算文件得分(rel: string, content: string, keywords: string[]): number {
  const p = rel.toLowerCase();
  const c = content.toLowerCase();
  let score = 0;
  for (const key of keywords) {
    if (p.includes(key)) score += 6;
    const pos = c.indexOf(key);
    if (pos >= 0) {
      score += 3;
      if (pos < 400) score += 2;
    }
  }
  return score;
}

function 提取片段(content: string, keywords: string[], maxChars: number): string {
  const lower = content.toLowerCase();
  let pos = -1;
  for (const key of keywords) {
    const idx = lower.indexOf(key);
    if (idx >= 0 && (pos === -1 || idx < pos)) pos = idx;
  }
  if (pos === -1) return content.slice(0, maxChars).trim();
  const start = Math.max(0, pos - Math.floor(maxChars / 3));
  return content.slice(start, Math.min(content.length, start + maxChars)).trim();
}
