import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { 构建Discord会话键 } from '../../lib/bridge/adapters/discord-adapter';

describe('discord session key', () => {
  it('per_user 在普通频道按 guild:channel:user 生成', () => {
    const key = 构建Discord会话键({
      sessionScope: 'per_user',
      guildId: 'g1',
      channelId: 'c1',
      userId: 'u1',
    });
    assert.equal(key, 'g1:c1:u1');
  });

  it('per_user 在线程按 guild:thread:user 生成', () => {
    const key = 构建Discord会话键({
      sessionScope: 'per_user',
      guildId: 'g1',
      channelId: 'c-parent',
      threadId: 't1',
      userId: 'u1',
    });
    assert.equal(key, 'g1:t1:u1');
  });

  it('per_channel 忽略 user 维度', () => {
    const key = 构建Discord会话键({
      sessionScope: 'per_channel',
      guildId: 'g1',
      channelId: 'c1',
      userId: 'u1',
    });
    assert.equal(key, 'g1:c1');
  });

  it('私聊 per_user 回退为 channel:user', () => {
    const key = 构建Discord会话键({
      sessionScope: 'per_user',
      channelId: 'dm-c1',
      userId: 'u1',
    });
    assert.equal(key, 'dm-c1:u1');
  });
});
