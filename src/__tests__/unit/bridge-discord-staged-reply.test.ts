import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types';
import {
  OpenAICompatibleLLM,
  规范化源码配置,
  规范化阶段回复配置,
  获取阶段确认文案,
} from '../../lib/bridge/examples/discord-echo-host';

const 临时目录列表: string[] = [];

afterEach(() => {
  for (const 目录 of 临时目录列表.splice(0)) {
    rmSync(目录, { recursive: true, force: true });
  }
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
});

function 创建临时仓库() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'staged-reply-test-'));
  临时目录列表.push(rootDir);
  mkdirSync(path.join(rootDir, 'docs'), { recursive: true });
  writeFileSync(path.join(rootDir, 'docs', 'blender.md'), 'Blender Bridge works through the Discord host.\n');
  return rootDir;
}

async function 读取SSE事件(stream: ReadableStream<string>) {
  const reader = stream.getReader();
  const events: Array<{ type: string; data: string }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

function 创建最小Store(settings: Record<string, string> = {}): BridgeStore {
  const sessions = new Map<string, { id: string; working_directory: string; model: string }>();
  const bindings = new Map<string, any>();
  let nextId = 1;

  return {
    getSetting: key => settings[key] ?? null,
    getChannelBinding: (channelType, chatId) => bindings.get(`${channelType}:${chatId}`) ?? null,
    upsertChannelBinding: data => {
      const key = `${data.channelType}:${data.chatId}`;
      const existing = bindings.get(key);
      const binding = {
        id: existing?.id ?? `binding-${nextId++}`,
        channelType: data.channelType,
        chatId: data.chatId,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: existing?.sdkSessionId ?? '',
        workingDirectory: data.workingDirectory,
        model: data.model,
        mode: 'code' as const,
        active: true,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      bindings.set(key, binding);
      return binding;
    },
    updateChannelBinding: () => {},
    listChannelBindings: () => Array.from(bindings.values()),
    getSession: id => sessions.get(id) ?? null,
    createSession: (_name, model, _systemPrompt, cwd) => {
      const session = { id: `session-${nextId++}`, working_directory: cwd || process.cwd(), model };
      sessions.set(session.id, session);
      return session as any;
    },
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function 创建MockDiscordAdapter(sent: OutboundMessage[]): BaseChannelAdapter {
  return {
    channelType: 'discord',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (msg: OutboundMessage): Promise<SendResult> => {
      sent.push(msg);
      return { ok: true, messageId: `msg-${sent.length}` };
    },
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

describe('discord staged reply', () => {
  it('优先使用频道确认文案', () => {
    const text = 获取阶段确认文案('c-1', 规范化阶段回复配置({
      bot_token: 'token',
      staged_ack_text: '默认确认',
      staged_ack_text_by_channel: { 'c-1': '频道确认' },
    } as any));

    assert.equal(text, '频道确认');
  });

  it('model-driven 模式会先发 status 预览，再输出最终回答且默认不暴露来源路径', async () => {
    const rootDir = 创建临时仓库();
    const llm = new OpenAICompatibleLLM(
      'https://llm.example.com/v1',
      'token',
      'gpt-5.4',
      规范化源码配置({
        bridge: { default_work_dir: rootDir },
        discord: { bot_token: 'token' },
        source_context: {
          enabled: true,
          root_dir: rootDir,
          read_only: true,
          retrieval_mode: 'model_driven',
          memory_first: false,
          max_tool_rounds: 1,
        },
      } as any),
      { 技能列表: new Map(), 扫描目录: [] },
      null,
      规范化阶段回复配置({ bot_token: 'token' } as any),
      async () => new Response(JSON.stringify({
        output_text: JSON.stringify({
          type: 'final',
          answer: '已找到答案。',
          citations: ['docs/blender.md'],
          evidence_sufficient: true,
        }),
      }), { status: 200 }),
    );

    const events = await 读取SSE事件(llm.streamChat({
      prompt: '帮我看看 Blender 怎么连接',
      sessionId: 's-1',
      chatId: 'c-1',
      conversationHistory: [],
    }));

    assert.equal(events[0]?.type, 'status');
    assert.match(events[0]?.data || '', /收到，我先看一下/);
    assert.equal(events[1]?.type, 'text');
    assert.match(events[1]?.data || '', /已找到答案/);
    assert.doesNotMatch(events[1]?.data || '', /docs\/blender\.md/);
  });

  it('bridge-manager 会先发送短确认语，再发送最终回答', async () => {
    const sent: OutboundMessage[] = [];
    const store = 创建最小Store({
      bridge_default_work_dir: process.cwd(),
      bridge_default_model: 'gpt-test',
      bridge_discord_staged_reply_enabled: 'true',
      bridge_discord_staged_ack_enabled: 'true',
      bridge_discord_staged_ack_text: '收到，我先看一下。',
      bridge_discord_staged_ack_text_by_channel: JSON.stringify({}),
      bridge_discord_stream_enabled: 'false',
    });

    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '最终答案' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: undefined }) })}\n`);
            controller.close();
          },
        }),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(创建MockDiscordAdapter(sent), {
      messageId: 'in-1',
      address: { channelType: 'discord', chatId: 'c-1', userId: 'u-1', displayName: 'tester' },
      text: '这个仓库怎么查 Blender Bridge？',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 2);
    assert.equal(sent[0].text, '收到，我先看一下。');
    assert.equal(sent[0].replyToMessageId, 'in-1');
    assert.match(sent[1].text, /最终答案/);
    assert.equal(sent[1].replyToMessageId, 'in-1');
  });
});
