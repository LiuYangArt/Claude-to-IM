import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  获取阶段确认文案,
  是否首轮用户消息,
  构建运行时系统提示,
  规范化阶段回复配置,
} from '../../lib/bridge/examples/discord-echo-host.js';

describe('discord first-turn guidance', () => {
  const 阶段回复配置 = 规范化阶段回复配置({
    bot_token: 'token',
    staged_reply_enabled: true,
    staged_ack_enabled: true,
    staged_ack_text: '收到，我先看一下。',
    staged_ack_text_by_channel: {
      c1: '频道确认中',
    },
    staged_reaction_enabled: true,
    staged_reaction_processing: '👀',
    staged_reaction_done: '✅',
    staged_reaction_fallback: '⚠️',
  });

  it('空历史会被视为首轮消息', () => {
    assert.equal(是否首轮用户消息([]), true);
    assert.equal(是否首轮用户消息(undefined), true);
    assert.equal(是否首轮用户消息([{ role: 'user', content: '你好' }]), false);
  });

  it('首轮消息会追加运行时引导提示', () => {
    const 提示词 = 构建运行时系统提示('基础人格', { conversationHistory: [] });
    assert.match(提示词, /基础人格/);
    assert.match(提示词, /第一轮消息/);
    assert.match(提示词, /直接进入回答/);
  });

  it('非首轮消息不追加首轮引导提示', () => {
    const 提示词 = 构建运行时系统提示('基础人格', {
      conversationHistory: [{ role: 'assistant', content: '你好呀' }],
    });
    assert.equal(提示词, '基础人格');
  });

  it('首轮消息不返回阶段确认文案', () => {
    assert.equal(获取阶段确认文案('c1', 阶段回复配置, []), '');
  });

  it('非首轮消息仍返回频道或默认确认文案', () => {
    assert.equal(
      获取阶段确认文案('c1', 阶段回复配置, [{ role: 'user', content: '第二条' }]),
      '频道确认中',
    );
    assert.equal(
      获取阶段确认文案('c2', 阶段回复配置, [{ role: 'user', content: '第二条' }]),
      '收到，我先看一下。',
    );
  });
});
