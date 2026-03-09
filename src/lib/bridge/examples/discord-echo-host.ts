import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { initBridgeContext } from '../context';
import * as bridgeManager from '../bridge-manager';
import {
  加载技能系统,
  构建技能上下文,
  type 技能系统,
  type 只读源码配置,
} from './discord-lightweight-skills';
import {
  反馈Issue工作流,
  type 反馈工作流配置,
} from './feedback-issue-workflow';
import {
  执行模型驱动检索问答,
  type 模型驱动源码配置,
} from './discord-model-driven-retrieval';
import type {
  BridgeStore,
  LLMProvider,
  PermissionGateway,
  LifecycleHooks,
  StreamChatParams,
  BridgeSession,
  BridgeMessage,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
} from '../host';
import type { ChannelBinding, ChannelType } from '../types';

interface 源码上下文配置 {
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

interface 人格配置 {
  default_prompt_file?: string;
  channel_prompt_files?: Record<string, string>;
}

interface 桥接配置 {
  bridge?: {
    default_work_dir?: string;
    default_model?: string;
  };
  discord: {
    bot_token: string;
    allowed_users?: string[];
    allowed_channels?: string[];
    allowed_guilds?: string[];
    group_policy?: 'open' | 'disabled';
    require_mention?: boolean;
    stream_enabled?: boolean;
    session_scope?: 'per_user' | 'per_thread' | 'per_channel';
    staged_reply_enabled?: boolean;
    staged_ack_enabled?: boolean;
    staged_ack_text?: string;
    staged_ack_text_by_channel?: Record<string, string>;
    staged_reaction_enabled?: boolean;
    staged_reaction_processing?: string;
    staged_reaction_done?: string;
    staged_reaction_fallback?: string;
  };
  openai?: {
    enabled?: boolean;
    base_url?: string;
    api_key?: string;
    model?: string;
  };
  github?: {
    enabled?: boolean;
    api_base_url?: string;
    api_token?: string;
    default_repo?: string;
    request_timeout_ms?: number;
  };
  feedback_issue?: {
    enabled?: boolean;
  };
  persona?: 人格配置;
  source_context?: 源码上下文配置;
}

interface 已加载人格配置 {
  默认提示词: string;
  频道提示词: Map<string, string>;
}

interface 阶段回复配置 {
  enabled: boolean;
  ackEnabled: boolean;
  ackTextByChannel: Record<string, string>;
  defaultAckText: string;
  reactionEnabled: boolean;
  processingReaction: string;
  doneReaction: string;
  fallbackReaction: string;
}

const 首轮客服引导增强提示 = [
  '这是该用户在当前会话中的第一轮消息。',
  '请你自行判断：这条消息是否已经表达了明确、可直接处理的问题、需求、反馈或任务。',
  '如果用户已经说清楚了具体问题，请直接进入回答，不要先输出欢迎词、菜单或多余引导。',
  '如果用户只是打招呼、试探是否在线、简单寒暄，或内容仍然比较空泛，再先亲切接待，并自然给出 2-3 个用户容易理解的帮助方向。',
  '引导时优先使用普通用户容易理解的话，不要堆术语，也不要长篇菜单。',
].join('\n');

type 已规范源码配置 = 模型驱动源码配置;

const 忽略目录 = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.idea',
  '.vscode',
]);

const 文本扩展名 = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.mdx', '.txt', '.yml', '.yaml', '.toml',
  '.html', '.css', '.scss', '.sass', '.less',
  '.rs', '.go', '.py', '.java', '.kt', '.swift',
  '.sql', '.sh', '.zsh', '.env', '.ini', '.conf',
]);

class InMemoryStore implements BridgeStore {
  private settings = new Map<string, string>();
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private dedup = new Set<string>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private locks = new Map<string, string>();
  private nextId = 1;

  constructor(
    initialSettings: Record<string, string>,
    private readonly 已加载人格: 已加载人格配置,
  ) {
    for (const [key, value] of Object.entries(initialSettings)) {
      this.settings.set(key, value);
    }
  }

  getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }

  getChannelBinding(channelType: string, chatId: string) {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput) {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const now = new Date().toISOString();
    const binding: ChannelBinding = {
      id: existing?.id ?? `binding-${this.nextId++}`,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: existing?.sdkSessionId ?? '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: existing?.mode ?? 'code',
      active: existing?.active ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.bindings.set(key, binding);
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>) {
    for (const [key, binding] of this.bindings.entries()) {
      if (binding.id !== id) continue;
      this.bindings.set(key, {
        ...binding,
        ...updates,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
  }

  listChannelBindings(channelType?: ChannelType) {
    const all = Array.from(this.bindings.values());
    return channelType ? all.filter(item => item.channelType === channelType) : all;
  }

  getSession(id: string) {
    const session = this.sessions.get(id) ?? null;
    if (!session) return null;

    const binding = Array.from(this.bindings.values()).find(item => item.codepilotSessionId === id);
    const 频道键 = binding ? 提取频道人格键(binding.chatId) : '';
    const 频道提示词 = 频道键 ? this.已加载人格.频道提示词.get(频道键) : undefined;
    const systemPrompt = 频道提示词 || this.已加载人格.默认提示词 || session.system_prompt;
    return systemPrompt ? { ...session, system_prompt: systemPrompt } : session;
  }

  createSession(_name: string, model: string, systemPrompt?: string, cwd?: string) {
    const session: BridgeSession = {
      id: `session-${this.nextId++}`,
      working_directory: cwd || process.cwd(),
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, provider_id: providerId });
  }

  addMessage(sessionId: string, role: string, content: string) {
    const list = this.messages.get(sessionId) || [];
    list.push({ role, content });
    this.messages.set(sessionId, list);
  }

  getMessages(sessionId: string, opts?: { limit?: number }) {
    const list = this.messages.get(sessionId) || [];
    const limit = opts?.limit;
    return { messages: limit ? list.slice(-limit) : list };
  }

  acquireSessionLock(sessionId: string, lockId: string) {
    const existing = this.locks.get(sessionId);
    if (existing && existing !== lockId) return false;
    this.locks.set(sessionId, lockId);
    return true;
  }

  renewSessionLock() {}

  releaseSessionLock(sessionId: string, lockId: string) {
    if (this.locks.get(sessionId) === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus() {}

  updateSdkSessionId(sessionId: string, sdkSessionId: string) {
    const binding = Array.from(this.bindings.values()).find(item => item.codepilotSessionId === sessionId);
    if (!binding) return;
    this.updateChannelBinding(binding.id, { sdkSessionId });
  }

  updateSessionModel(sessionId: string, model: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, model });
  }

  syncSdkTasks() {}

  getProvider() {
    return undefined;
  }

  getDefaultProviderId() {
    return null;
  }

  insertAuditLog(entry: AuditLogInput) {
    console.log(`[audit] ${entry.direction} ${entry.channelType}:${entry.chatId} ${entry.summary}`);
  }

  checkDedup(key: string) {
    return this.dedup.has(key);
  }

  insertDedup(key: string) {
    this.dedup.add(key);
  }

  cleanupExpiredDedup() {}

  insertOutboundRef(_ref: OutboundRefInput) {}

  insertPermissionLink(link: PermissionLinkInput) {
    this.permissionLinks.set(link.permissionRequestId, {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    });
  }

  getPermissionLink(permissionRequestId: string) {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string) {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    this.permissionLinks.set(permissionRequestId, { ...link, resolved: true });
    return true;
  }

  getChannelOffset(key: string) {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string) {
    this.offsets.set(key, offset);
  }
}

class EchoLLM implements LLMProvider {
  constructor(
    private readonly 源码配置: 已规范源码配置,
    private readonly 技能系统: 技能系统,
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const 技能上下文 = 构建技能上下文(params.prompt, params.workingDirectory, this.源码配置, this.技能系统);
    记录技能命中日志(技能上下文);
    const response = 技能上下文.文本
      ? `收到：${params.prompt}\n\n命中 Skill：${技能上下文.名称}\n命中原因：${技能上下文.原因}\n参考来源数：${技能上下文.来源.length}`
      : `收到：${params.prompt}`;
    return createSseTextStream(response);
  }
}

class OpenAICompatibleLLM implements LLMProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly 源码配置: 已规范源码配置,
    private readonly 技能系统: 技能系统,
    private readonly 反馈工作流: 反馈Issue工作流 | null,
    private readonly 阶段回复配置: 阶段回复配置,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      start: async controller => {
        try {
          if (this.反馈工作流) {
            const 反馈结果 = await this.反馈工作流.handle({
              sessionId: params.sessionId,
              prompt: params.prompt,
              conversationHistory: params.conversationHistory,
            });
            if (反馈结果.handled) {
              const text = (反馈结果.text || '').trim();
              if (text) {
                controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: text })}\n`);
              }
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: undefined }) })}\n`);
              controller.close();
              return;
            }
          }

          const 增强后参数: StreamChatParams = {
            ...params,
            systemPrompt: 构建运行时系统提示(params.systemPrompt, params),
          };

          const 技能上下文 = 构建技能上下文(增强后参数.prompt, 增强后参数.workingDirectory, this.源码配置, this.技能系统);
          记录技能命中日志(技能上下文);

          const 阶段确认文案 = 获取阶段确认文案(增强后参数.chatId, this.阶段回复配置, 增强后参数.conversationHistory);
          if (阶段确认文案) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ preview_text: 阶段确认文案 }) })}\n`);
          }

          if (this.源码配置.enabled && this.源码配置.retrievalMode === 'model_driven') {
            const 检索结果 = await 执行模型驱动检索问答({
              baseUrl: this.baseUrl,
              apiKey: this.apiKey,
              model: this.model,
              params: 增强后参数,
              源码配置: this.源码配置,
              技能上下文文本: 技能上下文.文本,
              技能名称: 技能上下文.名称,
              fetchImpl: this.fetchImpl,
            });

            if (检索结果.text.trim()) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 检索结果.text.trim() })}\n`);
            }
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: 检索结果.usage, evidence_insufficient: 检索结果.evidenceInsufficient }) })}\n`);
            controller.close();
            return;
          }
          const response = await this.fetchImpl(joinUrl(this.baseUrl, '/responses'), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: 增强后参数.model || this.model,
              stream: false,
              input: buildInput(增强后参数, 技能上下文.文本),
              instructions: 增强后参数.systemPrompt,
            }),
            signal: 增强后参数.abortController?.signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: errorText || `HTTP ${response.status}` })}\n`);
            controller.close();
            return;
          }

          const data: any = await response.json();
          const text = extractResponseText(data).trim();
          if (text) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: text })}\n`);
          }
          controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: data?.usage || undefined }) })}\n`);
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'LLM 请求失败';
          controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: message })}\n`);
          controller.close();
        }
      },
    });
  }
}

function createSseTextStream(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: text })}\n`);
      controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }) })}\n`);
      controller.close();
    },
  });
}

function buildInput(params: StreamChatParams, 源码上下文: string): string {
  const sections: string[] = [];
  if (params.systemPrompt) {
    sections.push(`System:\n${params.systemPrompt}`);
  }
  if (源码上下文) {
    sections.push(源码上下文);
  }
  for (const item of params.conversationHistory || []) {
    sections.push(`${item.role === 'assistant' ? 'Assistant' : 'User'}:\n${item.content}`);
  }
  sections.push(`User:\n${params.prompt}`);
  return sections.join('\n\n');
}

function 是否首轮用户消息(conversationHistory?: StreamChatParams['conversationHistory']): boolean {
  return !conversationHistory || conversationHistory.length === 0;
}

function 构建运行时系统提示(basePrompt: string | undefined, params: Pick<StreamChatParams, 'conversationHistory'>): string {
  const sections = [(basePrompt || '').trim()];
  if (是否首轮用户消息(params.conversationHistory)) {
    sections.push(首轮客服引导增强提示);
  }
  return sections.filter(Boolean).join('\n\n');
}

function extractResponseText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text) {
    return data.output_text;
  }

  if (Array.isArray(data?.output)) {
    const parts: string[] = [];
    for (const item of data.output) {
      if (typeof item?.text === 'string') {
        parts.push(item.text);
        continue;
      }
      if (!Array.isArray(item?.content)) continue;
      for (const content of item.content) {
        if (typeof content?.text === 'string') {
          parts.push(content.text);
        }
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item: any) => typeof item?.text === 'string' ? item.text : '')
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }

  return '模型返回成功，但没有提取到可显示文本。';
}

function joinUrl(baseUrl: string, pathValue: string): string {
  return `${baseUrl.replace(/\/$/, '')}${pathValue}`;
}

function 记录技能命中日志(技能上下文: { 名称: string; 原因: string; 来源: string[] }) {
  console.log(`[skill] 命中 ${技能上下文.名称} (${技能上下文.原因})`);
  if (技能上下文.来源.length > 0) {
    console.log(`[skill] 上下文来源: ${技能上下文.来源.join(', ')}`);
  }
}

function 提取频道人格键(bindingChatId: string): string {
  const raw = (bindingChatId || '').trim();
  if (!raw.includes(':')) return raw;

  const parts = raw.split(':').filter(Boolean);
  if (parts.length >= 3) {
    return parts[1] || raw;
  }
  if (parts.length === 2) {
    return parts[0] || raw;
  }
  return raw;
}

function 读取配置文件(): 桥接配置 {
  const configPath = path.resolve(process.cwd(), 'config', 'discord-bridge.json');
  if (!existsSync(configPath)) {
    throw new Error(`配置文件不存在：${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('配置文件内容不能为空对象');
  }

  return parsed as 桥接配置;
}

function 标准化ID数组(ids: unknown[] | undefined, 字段名: string): string[] {
  if (!ids) return [];
  return ids
    .filter(item => item !== '' && item != null)
    .map(item => {
      if (typeof item !== 'string') {
        throw new Error(`${字段名} 里的 Discord ID 必须写成字符串，例如 ["1479760489050275951"]，不能直接写数字`);
      }
      return item.trim();
    })
    .filter(Boolean);
}

function 解析路径(路径值: string | undefined, 默认值: string): string {
  const 值 = 路径值?.trim();
  if (!值) return 默认值;
  return path.isAbsolute(值) ? 值 : path.resolve(process.cwd(), 值);
}

function 读取Markdown文件(文件路径: string, 用途: string): string {
  const 实际路径 = 解析路径(文件路径, process.cwd());
  if (!existsSync(实际路径)) {
    throw new Error(`${用途} 不存在：${实际路径}`);
  }
  return readFileSync(实际路径, 'utf8').trim();
}

function 加载人格配置(config: 桥接配置): 已加载人格配置 {
  const 默认提示词 = config.persona?.default_prompt_file
    ? 读取Markdown文件(config.persona.default_prompt_file, '默认人格文件')
    : '';

  const 频道提示词 = new Map<string, string>();
  for (const [chatId, 文件路径] of Object.entries(config.persona?.channel_prompt_files || {})) {
    if (!chatId.trim()) continue;
    频道提示词.set(chatId.trim(), 读取Markdown文件(文件路径, `频道人格文件(${chatId})`));
  }

  return { 默认提示词, 频道提示词 };
}

function 规范化源码配置(config: 桥接配置): 已规范源码配置 {
  const rootDir = 解析路径(
    config.source_context?.root_dir,
    config.bridge?.default_work_dir?.trim() || process.cwd(),
  );

  const 已启用 = config.source_context?.enabled !== false;
  const 只读 = config.source_context?.read_only !== false;
  if (!只读) {
    throw new Error('source_context.read_only 只能为 true；当前宿主只支持只读源码访问');
  }

  if (已启用 && !existsSync(rootDir)) {
    throw new Error(`源码目录不存在：${rootDir}`);
  }

  return {
    enabled: 已启用,
    rootDir,
    readOnly: 只读,
    maxFiles: config.source_context?.max_files || 4,
    maxCharsPerFile: config.source_context?.max_chars_per_file || 1600,
    maxTotalChars: config.source_context?.max_total_chars || 5000,
    maxFileSizeBytes: config.source_context?.max_file_size_bytes || 200_000,
    retrievalMode: config.source_context?.retrieval_mode || 'keyword',
    maxToolRounds: config.source_context?.max_tool_rounds || 3,
    maxReadFiles: config.source_context?.max_read_files || 6,
    maxReadCharsTotal: config.source_context?.max_read_chars_total || 12_000,
    searchMaxResults: config.source_context?.search_max_results || 20,
    knowledgeDirs: (config.source_context?.knowledge_dirs || ['docs/knowledge']).filter(Boolean),
    memoryFirst: config.source_context?.memory_first !== false,
    memoryDirs: (config.source_context?.memory_dirs || ['docs/knowledge', 'docs', 'config/prompts']).filter(Boolean),
    memoryMaxFiles: config.source_context?.memory_max_files || 4,
    memoryMaxCharsTotal: config.source_context?.memory_max_chars_total || 6000,
    showEvidenceInReply: config.source_context?.show_evidence_in_reply === true,
  };
}

function 规范化阶段回复配置(discordConfig: 桥接配置['discord']): 阶段回复配置 {
  return {
    enabled: discordConfig.staged_reply_enabled !== false,
    ackEnabled: discordConfig.staged_ack_enabled !== false,
    ackTextByChannel: discordConfig.staged_ack_text_by_channel || {},
    defaultAckText: discordConfig.staged_ack_text?.trim() || '收到，我先看一下。',
    reactionEnabled: discordConfig.staged_reaction_enabled !== false,
    processingReaction: discordConfig.staged_reaction_processing?.trim() || '👀',
    doneReaction: discordConfig.staged_reaction_done?.trim() || '✅',
    fallbackReaction: discordConfig.staged_reaction_fallback?.trim() || '⚠️',
  };
}

function 获取阶段确认文案(
  chatId: string | undefined,
  config: 阶段回复配置,
  conversationHistory?: StreamChatParams['conversationHistory'],
): string {
  if (!config.enabled || !config.ackEnabled) return '';
  if (是否首轮用户消息(conversationHistory)) return '';
  if (chatId && config.ackTextByChannel[chatId]?.trim()) {
    return config.ackTextByChannel[chatId].trim();
  }
  return config.defaultAckText;
}

function 是否证据不足文本(text: string): boolean {
  return /证据不足|未找到依据|未找到足够依据/i.test(text);
}

function 校验配置(config: 桥接配置): void {
  if (!config.discord?.bot_token?.trim()) {
    throw new Error('请在 config/discord-bridge.json 中填写 discord.bot_token');
  }

  const allowedUsers = 标准化ID数组(config.discord.allowed_users, 'discord.allowed_users');
  const allowedChannels = 标准化ID数组(config.discord.allowed_channels, 'discord.allowed_channels');
  标准化ID数组(config.discord.allowed_guilds, 'discord.allowed_guilds');
  if (allowedUsers.length === 0 && allowedChannels.length === 0) {
    throw new Error('请至少填写 discord.allowed_users 或 discord.allowed_channels 其中一个');
  }
}

function buildSettings(config: 桥接配置) {
  const 会话范围 = config.discord.session_scope || 'per_user';
  const 阶段回复 = 规范化阶段回复配置(config.discord);
  if (!['per_user', 'per_thread', 'per_channel'].includes(会话范围)) {
    throw new Error('discord.session_scope 仅支持 per_user | per_thread | per_channel');
  }

  return {
    remote_bridge_enabled: 'true',
    bridge_auto_start: 'false',
    bridge_default_work_dir: config.bridge?.default_work_dir?.trim() || process.cwd(),
    bridge_default_model: config.openai?.model?.trim() || config.bridge?.default_model?.trim() || 'echo-model',
    bridge_discord_enabled: 'true',
    bridge_discord_bot_token: config.discord.bot_token.trim(),
    bridge_discord_allowed_users: 标准化ID数组(config.discord.allowed_users, 'discord.allowed_users').join(','),
    bridge_discord_allowed_channels: 标准化ID数组(config.discord.allowed_channels, 'discord.allowed_channels').join(','),
    bridge_discord_allowed_guilds: 标准化ID数组(config.discord.allowed_guilds, 'discord.allowed_guilds').join(','),
    bridge_discord_group_policy: config.discord.group_policy || 'open',
    bridge_discord_require_mention: String(config.discord.require_mention ?? true),
    bridge_discord_stream_enabled: String(config.discord.stream_enabled ?? true),
    bridge_discord_session_scope: 会话范围,
    bridge_discord_staged_reply_enabled: String(阶段回复.enabled),
    bridge_discord_staged_ack_enabled: String(阶段回复.enabled && 阶段回复.ackEnabled),
    bridge_discord_staged_ack_text: 阶段回复.defaultAckText,
    bridge_discord_staged_ack_text_by_channel: JSON.stringify(阶段回复.ackTextByChannel),
    bridge_discord_staged_reaction_enabled: String(阶段回复.enabled && 阶段回复.reactionEnabled),
    bridge_discord_staged_reaction_processing: 阶段回复.processingReaction,
    bridge_discord_staged_reaction_done: 阶段回复.doneReaction,
    bridge_discord_staged_reaction_fallback: 阶段回复.fallbackReaction,
  };
}

function createLlm(config: 桥接配置, 已规范源码: 已规范源码配置, 技能系统: 技能系统): LLMProvider {
  const 阶段回复 = 规范化阶段回复配置(config.discord);
  const openai = config.openai;
  if (openai?.enabled) {
    if (!openai.base_url?.trim() || !openai.api_key?.trim() || !openai.model?.trim()) {
      throw new Error('openai.enabled=true 时，必须填写 openai.base_url、openai.api_key、openai.model');
    }
    console.log(`[llm] 使用 OpenAI 兼容接口：${openai.base_url}`);
    return new OpenAICompatibleLLM(
      openai.base_url.trim(),
      openai.api_key.trim(),
      openai.model.trim(),
      已规范源码,
      技能系统,
      create反馈工作流配置(config, openai.base_url.trim(), openai.api_key.trim(), openai.model.trim()),
      阶段回复,
    );
  }

  console.log('[llm] 当前使用 Echo 模式');
  return new EchoLLM(已规范源码, 技能系统);
}

function create反馈工作流配置(
  config: 桥接配置,
  openaiBaseUrl: string,
  openaiApiKey: string,
  model: string,
): 反馈Issue工作流 | null {
  const enabled = config.feedback_issue?.enabled !== false;
  if (!enabled) return null;

  const githubEnabled = config.github?.enabled !== false;
  if (!githubEnabled) return null;

  const workflowConfig: 反馈工作流配置 = {
    enabled: true,
    openaiBaseUrl,
    openaiApiKey,
    model,
    githubApiBaseUrl: config.github?.api_base_url?.trim() || 'https://api.github.com',
    githubToken: config.github?.api_token?.trim() || undefined,
    defaultTargetRepo: config.github?.default_repo?.trim() || undefined,
    requestTimeoutMs: config.github?.request_timeout_ms,
  };

  if (!workflowConfig.defaultTargetRepo) {
    console.warn('[feedback] 未配置 github.default_repo，首次分诊时会要求用户指定 owner/repo');
  }

  return new 反馈Issue工作流(workflowConfig);
}

function 提取关键词(问题: string): string[] {
  const 候选 = (问题.toLowerCase().match(/[a-z0-9_./\-\u4e00-\u9fa5]+/g) || [])
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => item.length >= 2)
    .filter(item => !['please', 'help', 'with', 'this', 'that', 'what', 'how', 'the', 'and', 'for', '你', '我', '我们', '怎么', '什么', '一下', '这个', '那个'].includes(item));

  return Array.from(new Set(候选)).slice(0, 12);
}

function 是否文本文件(文件路径: string): boolean {
  const 文件名 = path.basename(文件路径).toLowerCase();
  if (['dockerfile', 'makefile'].includes(文件名)) return true;
  return 文本扩展名.has(path.extname(文件路径).toLowerCase());
}

function 收集候选文件(目录: string, 最大文件大小: number, 累积: string[] = []): string[] {
  const 条目列表 = readdirSync(目录, { withFileTypes: true });
  for (const 条目 of 条目列表) {
    const 完整路径 = path.join(目录, 条目.name);
    if (条目.isDirectory()) {
      if (忽略目录.has(条目.name)) continue;
      收集候选文件(完整路径, 最大文件大小, 累积);
      continue;
    }
    if (!条目.isFile()) continue;
    if (!是否文本文件(完整路径)) continue;
    const 信息 = statSync(完整路径);
    if (信息.size > 最大文件大小) continue;
    累积.push(完整路径);
  }
  return 累积;
}

function 计算文件得分(相对路径: string, 内容: string, 关键词: string[]): number {
  const 小写路径 = 相对路径.toLowerCase();
  const 小写内容 = 内容.toLowerCase();
  let 分数 = 0;
  for (const 词 of 关键词) {
    if (小写路径.includes(词)) 分数 += 6;
    const 首次位置 = 小写内容.indexOf(词);
    if (首次位置 >= 0) {
      分数 += 3;
      const 出现次数 = 小写内容.split(词).length - 1;
      分数 += Math.min(出现次数, 4);
    }
  }
  return 分数;
}

function 提取片段(内容: string, 关键词: string[], 最大字符数: number): string {
  if (!内容.trim()) return '';

  const 行列表 = 内容.split(/\r?\n/);
  const 小写关键词 = 关键词.map(item => item.toLowerCase());
  const 命中行 = 行列表.findIndex(line => 小写关键词.some(词 => line.toLowerCase().includes(词)));

  let 片段 = '';
  if (命中行 >= 0) {
    const 起始 = Math.max(0, 命中行 - 8);
    const 结束 = Math.min(行列表.length, 命中行 + 12);
    片段 = 行列表.slice(起始, 结束).join('\n');
  } else {
    片段 = 行列表.slice(0, 40).join('\n');
  }

  if (片段.length <= 最大字符数) return 片段;
  return `${片段.slice(0, 最大字符数)}\n...`;
}

function 构建只读源码上下文(
  问题: string,
  工作目录: string | undefined,
  配置: 已规范源码配置,
): { 文本: string; 命中文件数: number } {
  if (!配置.enabled) return { 文本: '', 命中文件数: 0 };

  const 根目录 = 配置.rootDir || 工作目录 || process.cwd();
  const 关键词 = 提取关键词(问题);
  if (关键词.length === 0) {
    return { 文本: '', 命中文件数: 0 };
  }

  const 候选文件 = 收集候选文件(根目录, 配置.maxFileSizeBytes);
  const 命中: Array<{ path: string; score: number; snippet: string }> = [];

  for (const 文件路径 of 候选文件) {
    try {
      const 内容 = readFileSync(文件路径, 'utf8');
      const 相对路径 = path.relative(根目录, 文件路径) || path.basename(文件路径);
      const 分数 = 计算文件得分(相对路径, 内容, 关键词);
      if (分数 <= 0) continue;
      const 片段 = 提取片段(内容, 关键词, 配置.maxCharsPerFile);
      if (!片段.trim()) continue;
      命中.push({ path: 相对路径, score: 分数, snippet: 片段 });
    } catch {
      // 只读检索时忽略单个文件错误，继续读取其它文件
    }
  }

  const 已排序 = 命中.sort((a, b) => b.score - a.score).slice(0, 配置.maxFiles);
  if (已排序.length === 0) {
    return { 文本: '', 命中文件数: 0 };
  }

  const 段落: string[] = [
    '只读源码上下文（由宿主本地读取，仅供回答参考，禁止假装拥有写权限）:',
    `项目根目录: ${根目录}`,
  ];

  let 当前长度 = 段落.join('\n').length;
  let 实际条数 = 0;
  for (const 项 of 已排序) {
    const 片段文本 = [`文件: ${项.path}`, '```', 项.snippet, '```'].join('\n');
    if (当前长度 + 片段文本.length > 配置.maxTotalChars) break;
    段落.push(片段文本);
    当前长度 += 片段文本.length;
    实际条数++;
  }

  if (实际条数 === 0) {
    return { 文本: '', 命中文件数: 0 };
  }

  return { 文本: 段落.join('\n\n'), 命中文件数: 实际条数 };
}

async function main() {
  const config = 读取配置文件();
  校验配置(config);

  const 已加载人格 = 加载人格配置(config);
  const 已规范源码 = 规范化源码配置(config);
  const 技能系统 = 加载技能系统(process.cwd());
  const store = new InMemoryStore(buildSettings(config), 已加载人格);
  const llm = createLlm(config, 已规范源码, 技能系统);
  const permissions: PermissionGateway = { resolvePendingPermission: () => true };
  const lifecycle: LifecycleHooks = {
    onBridgeStart: () => console.log('[lifecycle] Bridge started'),
    onBridgeStop: () => console.log('[lifecycle] Bridge stopped'),
  };

  initBridgeContext({ store, llm, permissions, lifecycle });
  await bridgeManager.start();

  const status = bridgeManager.getStatus();
  if (!status.running) {
    throw new Error('Bridge 未成功启动，请检查 config/discord-bridge.json 和 Discord Bot 配置');
  }

  console.log(`[ready] Discord bridge 已启动`);
  console.log(`[ready] 只读源码目录：${已规范源码.rootDir}`);
  console.log(`[ready] 已加载 Skill 数量：${技能系统.技能列表.size}`);
  console.log(`[ready] 默认人格已${已加载人格.默认提示词 ? '加载' : '关闭'}，频道人格数量：${已加载人格.频道提示词.size}`);
  console.log('[ready] 现在去 Discord 发消息测试');
  console.log('[ready] 按 Ctrl+C 可退出');

  const shutdown = async () => {
    console.log('\n[shutdown] 正在停止 bridge...');
    await bridgeManager.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[fatal]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export {
  OpenAICompatibleLLM,
  规范化源码配置,
  规范化阶段回复配置,
  获取阶段确认文案,
  是否首轮用户消息,
  构建运行时系统提示,
  buildInput,
  提取频道人格键,
  是否证据不足文本,
};
