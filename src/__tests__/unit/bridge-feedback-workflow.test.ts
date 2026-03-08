import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  反馈Issue工作流,
  解析IssueForm字段,
  计算缺失字段,
  生成Issue正文,
  type 反馈工作流配置,
} from '../../lib/bridge/examples/feedback-issue-workflow';

describe('feedback issue workflow helpers', () => {
  it('解析 issue form required 字段', () => {
    const yaml = [
      'name: Bug Report',
      'body:',
      '  - type: input',
      '    id: title',
      '    attributes:',
      '      label: 标题',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: summary',
      '    attributes:',
      '      label: 问题描述',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: env',
      '    attributes:',
      '      label: 环境',
      '    validations:',
      '      required: false',
    ].join('\n');

    const fields = 解析IssueForm字段(yaml);
    assert.equal(fields.length, 3);
    assert.deepEqual(fields.filter(f => f.required).map(f => f.id), ['title', 'summary']);
  });

  it('缺失字段计算与正文生成符合预期', () => {
    const template = {
      name: 'bug',
      sourcePath: 'fallback',
      fields: [
        { id: 'title', label: '标题', type: 'input', required: true },
        { id: 'summary', label: '描述', type: 'textarea', required: true },
        { id: 'steps', label: '复现步骤', type: 'textarea', required: true },
      ],
    };

    const missing = 计算缺失字段(template, { title: '登录无响应', summary: '点击按钮无反馈' });
    assert.deepEqual(missing, ['steps']);

    const body = 生成Issue正文(template, {
      title: '登录无响应',
      summary: '点击登录按钮后没有任何响应',
      steps: '1. 打开页面\n2. 点击登录',
    });

    assert.match(body, /## 标题/);
    assert.match(body, /## 描述/);
    assert.match(body, /## 复现步骤/);
  });
});

describe('feedback issue workflow guards', () => {
  it('required 不全时确认提交也不会调用 GitHub 创建', async () => {
    let issueCreateCalled = 0;

    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/responses')) {
        const body = JSON.parse(String(init?.body || '{}')) as { instructions?: string };

        if ((body.instructions || '').includes('feedback-intake')) {
          return new Response(JSON.stringify({
            output_text: JSON.stringify({
              intent: 'bug',
              confidence: 0.88,
              fields: {
                title: '登录按钮无响应',
                summary: '点击登录后无任何反应',
              },
              next_question: '请补充复现步骤。',
              can_preview: false,
            }),
          }), { status: 200 });
        }

        return new Response(JSON.stringify({ output_text: 'draft' }), { status: 200 });
      }

      if (url.includes('/contents/.github/ISSUE_TEMPLATE')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }

      if (url.includes('/issues') && init?.method === 'POST') {
        issueCreateCalled += 1;
        return new Response(JSON.stringify({ html_url: 'https://github.com/a/b/issues/1' }), { status: 201 });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    };

    const config: 反馈工作流配置 = {
      enabled: true,
      openaiBaseUrl: 'https://llm.example.com/v1',
      openaiApiKey: 'token',
      model: 'gpt-5',
      githubApiBaseUrl: 'https://api.github.com',
      githubToken: 'ghp_xxx',
      defaultTargetRepo: 'owner/repo',
      requestTimeoutMs: 5000,
    };

    const workflow = new 反馈Issue工作流(config, fetchMock);

    const first = await workflow.handle({
      sessionId: 's1',
      prompt: '我想提交 issue：登录没反应',
      conversationHistory: [],
    });

    assert.equal(first.handled, true);
    assert.match(first.text || '', /缺少必填项|补充复现步骤/);

    const confirm = await workflow.handle({
      sessionId: 's1',
      prompt: '确认提交',
      conversationHistory: [],
    });

    assert.equal(confirm.handled, true);
    assert.match(confirm.text || '', /缺少必填项|还不能提交/);
    assert.equal(issueCreateCalled, 0);
  });

  it('预览后确认提交才会创建 issue 并返回链接', async () => {
    let issueCreateCalled = 0;

    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/responses')) {
        const body = JSON.parse(String(init?.body || '{}')) as { instructions?: string };

        if ((body.instructions || '').includes('feedback-intake')) {
          return new Response(JSON.stringify({
            output_text: JSON.stringify({
              intent: 'bug',
              confidence: 0.92,
              fields: {
                title: '登录按钮无响应',
                summary: '点击登录按钮后无任何提示',
                steps: '1. 打开登录页\n2. 点击登录按钮',
                expected: '进入首页',
                actual: '页面无变化',
              },
              can_preview: true,
              next_question: '',
            }),
          }), { status: 200 });
        }

        return new Response(JSON.stringify({
          output_text: '**标题**: 登录按钮无响应\n\n**待补充字段**: 无',
        }), { status: 200 });
      }

      if (url.includes('/contents/.github/ISSUE_TEMPLATE')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }

      if (url.includes('/issues') && init?.method === 'POST') {
        issueCreateCalled += 1;
        return new Response(JSON.stringify({ html_url: 'https://github.com/owner/repo/issues/123' }), { status: 201 });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    };

    const config: 反馈工作流配置 = {
      enabled: true,
      openaiBaseUrl: 'https://llm.example.com/v1',
      openaiApiKey: 'token',
      model: 'gpt-5',
      githubApiBaseUrl: 'https://api.github.com',
      githubToken: 'ghp_xxx',
      defaultTargetRepo: 'owner/repo',
      requestTimeoutMs: 5000,
    };

    const workflow = new 反馈Issue工作流(config, fetchMock);

    const first = await workflow.handle({
      sessionId: 's2',
      prompt: '请帮我提交 issue：登录没反应',
      conversationHistory: [],
    });

    assert.equal(first.handled, true);
    assert.match(first.text || '', /已生成 issue 预览/);
    assert.equal(issueCreateCalled, 0);

    const confirm = await workflow.handle({
      sessionId: 's2',
      prompt: '确认提交',
      conversationHistory: [],
    });

    assert.equal(confirm.handled, true);
    assert.match(confirm.text || '', /Issue 已创建成功/);
    assert.match(confirm.text || '', /issues\/123/);
    assert.equal(issueCreateCalled, 1);
  });
});
