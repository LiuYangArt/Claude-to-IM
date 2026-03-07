import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { initBridgeContext } from '../context';
import * as bridgeManager from '../bridge-manager';
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
  };
  openai?: {
    enabled?: boolean;
    base_url?: string;
    api_key?: string;
    model?: string;
  };
}

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

  constructor(initialSettings: Record<string, string>) {
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
    return this.sessions.get(id) ?? null;
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
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const response = `收到：${params.prompt}`;
    return createSseTextStream(response);
  }
}

class OpenAICompatibleLLM implements LLMProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      start: async controller => {
        try {
          const response = await fetch(joinUrl(this.baseUrl, '/responses'), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: params.model || this.model,
              stream: false,
              input: buildInput(params),
              instructions: params.systemPrompt,
            }),
            signal: params.abortController?.signal,
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

function buildInput(params: StreamChatParams): string {
  const sections: string[] = [];
  if (params.systemPrompt) {
    sections.push(`System:\n${params.systemPrompt}`);
  }
  for (const item of params.conversationHistory || []) {
    sections.push(`${item.role === 'assistant' ? 'Assistant' : 'User'}:\n${item.content}`);
  }
  sections.push(`User:\n${params.prompt}`);
  return sections.join('\n\n');
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

function 校验配置(config: 桥接配置): void {
  if (!config.discord?.bot_token?.trim()) {
    throw new Error('请在 config/discord-bridge.json 中填写 discord.bot_token');
  }

  const allowedUsers = config.discord.allowed_users?.filter(Boolean) || [];
  const allowedChannels = config.discord.allowed_channels?.filter(Boolean) || [];
  if (allowedUsers.length === 0 && allowedChannels.length === 0) {
    throw new Error('请至少填写 discord.allowed_users 或 discord.allowed_channels 其中一个');
  }
}

function buildSettings(config: 桥接配置) {
  return {
    remote_bridge_enabled: 'true',
    bridge_auto_start: 'false',
    bridge_default_work_dir: config.bridge?.default_work_dir?.trim() || process.cwd(),
    bridge_default_model: config.openai?.model?.trim() || config.bridge?.default_model?.trim() || 'echo-model',
    bridge_discord_enabled: 'true',
    bridge_discord_bot_token: config.discord.bot_token.trim(),
    bridge_discord_allowed_users: (config.discord.allowed_users || []).join(','),
    bridge_discord_allowed_channels: (config.discord.allowed_channels || []).join(','),
    bridge_discord_allowed_guilds: (config.discord.allowed_guilds || []).join(','),
    bridge_discord_group_policy: config.discord.group_policy || 'open',
    bridge_discord_require_mention: String(config.discord.require_mention ?? true),
    bridge_discord_stream_enabled: String(config.discord.stream_enabled ?? true),
  };
}

function createLlm(config: 桥接配置): LLMProvider {
  const openai = config.openai;
  if (openai?.enabled) {
    if (!openai.base_url?.trim() || !openai.api_key?.trim() || !openai.model?.trim()) {
      throw new Error('openai.enabled=true 时，必须填写 openai.base_url、openai.api_key、openai.model');
    }
    console.log(`[llm] 使用 OpenAI 兼容接口：${openai.base_url}`);
    return new OpenAICompatibleLLM(openai.base_url.trim(), openai.api_key.trim(), openai.model.trim());
  }

  console.log('[llm] 当前使用 Echo 模式');
  return new EchoLLM();
}

async function main() {
  const config = 读取配置文件();
  校验配置(config);

  const store = new InMemoryStore(buildSettings(config));
  const llm = createLlm(config);
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

  console.log('[ready] Discord bridge 已启动');
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

main().catch(error => {
  console.error('[fatal]', error instanceof Error ? error.message : error);
  process.exit(1);
});
