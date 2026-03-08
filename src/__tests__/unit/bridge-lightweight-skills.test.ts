import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  加载技能系统,
  构建技能上下文,
  路由技能,
  type 只读源码配置,
} from '../../lib/bridge/examples/discord-lightweight-skills';

const 临时目录列表: string[] = [];

const 测试源码配置 = (rootDir: string): 只读源码配置 => ({
  enabled: true,
  rootDir,
  readOnly: true,
  maxFiles: 4,
  maxCharsPerFile: 1200,
  maxTotalChars: 5000,
  maxFileSizeBytes: 100_000,
});

function 创建临时项目(): { rootDir: string; outsideDir: string } {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'skill-project-'));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'skill-outside-'));
  临时目录列表.push(rootDir, outsideDir);

  mkdirSync(path.join(rootDir, 'src', 'features'), { recursive: true });
  mkdirSync(path.join(rootDir, 'config'), { recursive: true });

  writeFileSync(path.join(rootDir, 'README.md'), '# Demo Bot\n\nA Discord support bot with lightweight skills.\n');
  writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'demo-bot', scripts: { start: 'tsx src/index.ts' } }, null, 2));
  writeFileSync(path.join(rootDir, 'src', 'index.ts'), 'export function bootstrap() { return "entry"; }\n');
  writeFileSync(path.join(rootDir, 'src', 'features', 'login.ts'), [
    'export function loginUser() {',
    '  const loginLogic = true;',
    '  return loginLogic;',
    '}',
    '',
    'export function handleBrokenState() {',
    '  throw new Error("login failed");',
    '}',
  ].join('\n'));
  writeFileSync(path.join(rootDir, 'config', 'app.json'), JSON.stringify({ featureFlag: true, retry: 1 }, null, 2));
  writeFileSync(path.join(outsideDir, 'secret.ts'), 'export const outsideMagic = true;\n');

  return { rootDir, outsideDir };
}

afterEach(() => {
  for (const 目录 of 临时目录列表.splice(0)) {
    rmSync(目录, { recursive: true, force: true });
  }
});

describe('lightweight-skills', () => {
  it('加载仓库内置 skills 并解析元信息', () => {
    const 技能系统 = 加载技能系统(process.cwd());

    const 必备技能 = ['project-overview', 'code-search', 'bug-diagnosis', 'issue-draft'];
    for (const 技能名 of 必备技能) {
      assert.ok(技能系统.技能列表.has(技能名), `缺少内置 skill: ${技能名}`);
    }
    assert.equal(技能系统.技能列表.get('project-overview')?.权限.filesystem, 'read-only');
    assert.ok((技能系统.技能列表.get('issue-draft')?.触发词 || []).includes('帮我整理一个 issue 草稿'));
  });

  it('根据典型问题路由到对应 skill', () => {
    const 技能系统 = 加载技能系统(process.cwd());

    assert.equal(路由技能('介绍一下这个项目', 技能系统.技能列表).名称, 'project-overview');
    assert.equal(路由技能('这个功能入口文件是哪个', 技能系统.技能列表).名称, 'code-search');
    assert.equal(路由技能('为什么这里会报错', 技能系统.技能列表).名称, 'bug-diagnosis');
    assert.equal(路由技能('帮我整理一个 issue 草稿', 技能系统.技能列表).名称, 'issue-draft');
    assert.equal(路由技能('我们先闲聊一下', 技能系统.技能列表).名称, 'support-answer');
  });

  it('project-overview 会读取 README 和顶层目录概览', () => {
    const 技能系统 = 加载技能系统(process.cwd());
    const { rootDir } = 创建临时项目();

    const 结果 = 构建技能上下文('介绍一下这个项目', rootDir, 测试源码配置(rootDir), 技能系统);

    assert.equal(结果.名称, 'project-overview');
    assert.match(结果.文本, /Demo Bot/);
    assert.match(结果.文本, /demo-bot/);
    assert.match(结果.文本, /\[dir\] src/);
    assert.ok(结果.来源.some(路径 => 路径.endsWith('README.md')));
  });

  it('code-search 只会在受限根目录内检索，不会越权读取工作目录外文件', () => {
    const 技能系统 = 加载技能系统(process.cwd());
    const { rootDir, outsideDir } = 创建临时项目();

    const 结果 = 构建技能上下文('outsideMagic 在哪', outsideDir, 测试源码配置(rootDir), 技能系统);

    assert.equal(结果.名称, 'code-search');
    assert.doesNotMatch(结果.文本, /outsideMagic = true/);
    assert.ok(结果.来源.every(路径 => !路径.includes(path.basename(outsideDir))));
  });

  it('issue-draft 会给出结构化草稿要求', () => {
    const 技能系统 = 加载技能系统(process.cwd());
    const { rootDir } = 创建临时项目();

    const 结果 = 构建技能上下文('帮我整理一个 issue 草稿：登录按钮点击后没反应', rootDir, 测试源码配置(rootDir), 技能系统);

    assert.equal(结果.名称, 'issue-draft');
    assert.match(结果.文本, /标题 \/ 问题描述 \/ 复现步骤/);
    assert.match(结果.文本, /Issue 草稿模板/);
  });
});
