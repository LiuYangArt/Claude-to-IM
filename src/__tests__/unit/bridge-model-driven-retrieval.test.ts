import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  创建只读检索器,
  执行模型驱动检索问答,
  type 模型驱动源码配置,
} from '../../lib/bridge/examples/discord-model-driven-retrieval.js';
import type { StreamChatParams } from '../../lib/bridge/host.js';

const 临时目录列表: string[] = [];

function 创建配置(rootDir: string): 模型驱动源码配置 {
  return {
    enabled: true,
    rootDir,
    readOnly: true,
    maxFiles: 4,
    maxCharsPerFile: 500,
    maxTotalChars: 2000,
    maxFileSizeBytes: 100_000,
    retrievalMode: 'model_driven',
    maxToolRounds: 3,
    maxReadFiles: 2,
    maxReadCharsTotal: 120,
    searchMaxResults: 5,
    knowledgeDirs: ['docs/knowledge'],
    memoryFirst: true,
    memoryDirs: ['docs/knowledge', 'docs', 'config/prompts'],
    memoryMaxFiles: 2,
    memoryMaxCharsTotal: 800,
    showEvidenceInReply: false,
  };
}

function 创建临时仓库() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'retrieval-test-'));
  临时目录列表.push(rootDir);
  mkdirSync(path.join(rootDir, 'docs', 'knowledge', 'features'), { recursive: true });
  mkdirSync(path.join(rootDir, 'docs'), { recursive: true });
  mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  mkdirSync(path.join(rootDir, 'config', 'prompts'), { recursive: true });

  writeFileSync(path.join(rootDir, 'docs', 'knowledge', 'index.md'), [
    '# 项目知识库',
    '',
    '本项目通过 Discord 机器人宿主转发问题，并优先参考知识库文档回答。',
  ].join('\n'));
  writeFileSync(path.join(rootDir, 'docs', 'knowledge', 'features', 'blender.md'), [
    '# Blender Bridge',
    '',
    'Blender Bridge 通过 Discord 机器人宿主转发问题。',
    '如果要连接到 blender，需要先启动 bridge，然后检查配置。',
  ].join('\n'));
  writeFileSync(path.join(rootDir, 'docs', 'blender.md'), [
    '# Legacy Blender Doc',
    '',
    '这是旧文档，不应优先于 docs/knowledge。',
  ].join('\n'));
  writeFileSync(path.join(rootDir, 'src', 'index.ts'), 'export const bridge = true;\n');
  writeFileSync(path.join(rootDir, 'config', 'prompts', 'default.md'), '默认人格会尽量引用仓库证据。\n');

  return rootDir;
}

function 创建参数(prompt: string): StreamChatParams {
  return {
    prompt,
    sessionId: 's1',
    model: 'gpt-test',
    conversationHistory: [],
  };
}

afterEach(() => {
  for (const 目录 of 临时目录列表.splice(0)) {
    rmSync(目录, { recursive: true, force: true });
  }
});

describe('model-driven retrieval tools', () => {
  it('拒绝读取 root_dir 外路径', () => {
    const rootDir = 创建临时仓库();
    const 检索器 = 创建只读检索器(创建配置(rootDir));

    const result = 检索器.readFile('../outside.txt', 0, 20);
    assert.equal(result.ok, false);
    assert.match(result.error || '', /out of root_dir/);
  });

  it('达到读取预算后返回预算错误', () => {
    const rootDir = 创建临时仓库();
    writeFileSync(path.join(rootDir, 'src', 'large.ts'), 'a'.repeat(300));
    const 检索器 = 创建只读检索器(创建配置(rootDir));

    const first = 检索器.readFile('src/large.ts', 0, 100);
    assert.equal(first.ok, true);

    const second = 检索器.readFile('src/large.ts', 100, 100);
    assert.equal(second.ok, true);

    const third = 检索器.readFile('docs/knowledge/features/blender.md', 0, 50);
    assert.equal(third.ok, false);
    assert.match(third.error || '', /budget exhausted/);
  });

  it('search_code 在没有命中时返回空数组而不是报错', () => {
    const rootDir = 创建临时仓库();
    const 检索器 = 创建只读检索器(创建配置(rootDir));

    const result = 检索器.searchCode('totally-missing-keyword', '.', 5);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, []);
  });
});

describe('model-driven retrieval loop', () => {
  it('知识文档足够时会直接回答，不再进入源码工具循环', async () => {
    const rootDir = 创建临时仓库();
    let 调用次数 = 0;

    const fetchMock: typeof fetch = async (_input, init) => {
      调用次数 += 1;
      const body = JSON.parse(String(init?.body || '{}')) as { instructions?: string; input?: string };

      assert.match(body.instructions || '', /只看项目知识文档证据/);
      assert.match(body.input || '', /docs\/knowledge\/features\/blender\.md/);

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          type: 'final',
          answer: '根据知识库文档，先启动 bridge，再检查配置。',
          citations: ['docs/knowledge/features/blender.md'],
          evidence_sufficient: true,
        }),
      }), { status: 200 });
    };

    const result = await 执行模型驱动检索问答({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'token',
      model: 'gpt-test',
      params: 创建参数('如何连接到 blender？'),
      源码配置: 创建配置(rootDir),
      技能上下文文本: '',
      fetchImpl: fetchMock,
    });

    assert.equal(调用次数, 1);
    assert.equal(result.usedFallback, false);
    assert.equal(result.evidenceInsufficient, false);
    assert.match(result.text, /先启动 bridge/);
  });

  it('知识文档不足时会再进入源码工具循环，默认不暴露来源路径', async () => {
    const rootDir = 创建临时仓库();
    let 调用次数 = 0;

    const fetchMock: typeof fetch = async (_input, init) => {
      调用次数 += 1;
      const body = JSON.parse(String(init?.body || '{}')) as { instructions?: string };

      if ((body.instructions || '').includes('只看项目知识文档证据')) {
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            type: 'final',
            answer: '知识文档还不够，需要继续查仓库其它证据。',
            citations: ['docs/knowledge/features/blender.md'],
            evidence_sufficient: false,
          }),
        }), { status: 200 });
      }

      if ((body.instructions || '').includes('必须直接输出 final JSON')) {
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            type: 'final',
            answer: '根据仓库文档，先启动 bridge，再检查 Discord 配置。',
            citations: ['docs/knowledge/features/blender.md'],
            evidence_sufficient: true,
          }),
        }), { status: 200 });
      }

      if (调用次数 === 2) {
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            type: 'tool',
            tool: 'search_code',
            arguments: { query: 'Blender Bridge', path: 'docs/knowledge', max_results: 5 },
          }),
        }), { status: 200 });
      }

      if (调用次数 === 3) {
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            type: 'tool',
            tool: 'read_file',
            arguments: { path: 'docs/knowledge/features/blender.md', offset: 0, limit: 200 },
          }),
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          type: 'final',
          answer: '根据仓库文档，先启动 bridge，再检查 Discord 配置。',
          citations: ['docs/knowledge/features/blender.md'],
          evidence_sufficient: true,
        }),
      }), { status: 200 });
    };

    const result = await 执行模型驱动检索问答({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'token',
      model: 'gpt-test',
      params: 创建参数('如何连接到 blender？'),
      源码配置: 创建配置(rootDir),
      技能上下文文本: '',
      fetchImpl: fetchMock,
    });

    assert.equal(result.usedFallback, false);
    assert.equal(result.evidenceInsufficient, false);
    assert.doesNotMatch(result.text, /docs\/knowledge\/features\/blender\.md/);
    assert.match(result.text, /先启动 bridge/);
  });

  it('达到工具预算后会降级为证据不足说明，而不是编造答案', async () => {
    const rootDir = 创建临时仓库();

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { instructions?: string };
      if ((body.instructions || '').includes('只看项目知识文档证据')) {
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            type: 'final',
            answer: '知识文档不足，需要继续查证。',
            citations: ['docs/knowledge/index.md'],
            evidence_sufficient: false,
          }),
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          type: 'tool',
          tool: 'list_dir',
          arguments: { path: '.' },
        }),
      }), { status: 200 });
    };

    const result = await 执行模型驱动检索问答({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'token',
      model: 'gpt-test',
      params: 创建参数('这个仓库支持什么特殊能力？'),
      源码配置: { ...创建配置(rootDir), maxToolRounds: 1 },
      技能上下文文本: '',
      fetchImpl: fetchMock,
    });

    assert.equal(result.usedFallback, false);
    assert.equal(result.evidenceInsufficient, true);
    assert.match(result.text, /证据不足|未找到足够依据/);
  });
});
