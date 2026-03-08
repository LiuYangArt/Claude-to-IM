import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

export interface 只读源码配置 {
  enabled: boolean;
  rootDir: string;
  readOnly: boolean;
  maxFiles: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
  maxFileSizeBytes: number;
}

interface 技能权限 {
  filesystem?: string;
  shell?: string;
  git?: string;
  [key: string]: string | undefined;
}

interface 技能参考资料 {
  路径: string;
  内容: string;
}

export interface 已加载技能 {
  名称: string;
  描述: string;
  版本: string;
  触发词: string[];
  权限: 技能权限;
  目录: string;
  技能文件: string;
  正文: string;
  参考资料: 技能参考资料[];
}

export interface 技能系统 {
  技能列表: Map<string, 已加载技能>;
  扫描目录: string[];
}

export type 技能名称 =
  | 'project-overview'
  | 'code-search'
  | 'bug-diagnosis'
  | 'feedback-intake'
  | 'issue-draft'
  | 'issue-submit'
  | 'support-answer';

export interface 技能路由结果 {
  名称: 技能名称;
  原因: string;
  技能?: 已加载技能;
}

export interface 技能上下文结果 extends 技能路由结果 {
  文本: string;
  来源: string[];
}

interface 文本片段 {
  路径: string;
  分数: number;
  内容: string;
}

const 默认技能目录 = ['config/skills', '.agents/skills'];

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

const 技能规则: Array<{ 名称: 技能名称; 模式: RegExp[] }> = [
  {
    名称: 'issue-submit',
    模式: [
      /确认提交/,
      /提交.*issue/i,
      /create.*issue/i,
      /submit.*issue/i,
      /同意提交/,
    ],
  },
  {
    名称: 'feedback-intake',
    模式: [
      /反馈/,
      /我要提/,
      /feature request/i,
      /bug report/i,
      /需求建议/,
      /缺陷反馈/,
      /issue 分诊/,
    ],
  },
  {
    名称: 'issue-draft',
    模式: [
      /issue/i,
      /bug\s*report/i,
      /report/i,
      /draft/i,
      /工单/,
      /草稿/,
      /整理.*issue/,
      /写一份.*(bug|问题)/,
    ],
  },
  {
    名称: 'bug-diagnosis',
    模式: [
      /报错/,
      /错误/,
      /异常/,
      /失败/,
      /不工作/,
      /没反应/,
      /卡住/,
      /why/i,
      /error/i,
      /broken/i,
      /bug/i,
      /fail/i,
    ],
  },
  {
    名称: 'code-search',
    模式: [
      /在哪/,
      /哪里/,
      /哪个文件/,
      /入口/,
      /实现/,
      /逻辑/,
      /函数/,
      /模块/,
      /where/i,
      /file/i,
      /entry/i,
      /implement/i,
      /function/i,
    ],
  },
  {
    名称: 'project-overview',
    模式: [
      /介绍/,
      /仓库/,
      /项目结构/,
      /目录结构/,
      /主要模块/,
      /做什么/,
      /是什么项目/,
      /overview/i,
      /repo/i,
      /repository/i,
      /what.*project/i,
    ],
  },
];

const 技能优先级: Record<技能名称, number> = {
  'issue-submit': 0,
  'feedback-intake': 1,
  'issue-draft': 1,
  'bug-diagnosis': 2,
  'code-search': 3,
  'project-overview': 4,
  'support-answer': 99,
};

export function 加载技能系统(项目根目录 = process.cwd(), 技能目录 = 默认技能目录): 技能系统 {
  const 扫描目录 = 技能目录.map(目录 => path.resolve(项目根目录, 目录));
  const 技能列表 = new Map<string, 已加载技能>();

  for (const 根目录 of 扫描目录) {
    if (!existsSync(根目录)) continue;
    const 条目列表 = readdirSync(根目录, { withFileTypes: true });
    for (const 条目 of 条目列表) {
      if (!条目.isDirectory()) continue;
      const 技能目录路径 = path.join(根目录, 条目.name);
      const 技能文件 = path.join(技能目录路径, 'SKILL.md');
      if (!existsSync(技能文件)) continue;
      const 原文 = readFileSync(技能文件, 'utf8');
      const { 元信息, 正文 } = 解析技能文档(原文);
      const 名称 = 读取字符串字段(元信息.name) || 条目.name;
      技能列表.set(名称, {
        名称,
        描述: 读取字符串字段(元信息.description),
        版本: 读取字符串字段(元信息.version) || '0.1.0',
        触发词: 读取数组字段(元信息.triggers),
        权限: 读取对象字段(元信息.permissions),
        目录: 技能目录路径,
        技能文件,
        正文: 正文.trim(),
        参考资料: 读取参考资料(技能目录路径),
      });
    }
  }

  return { 技能列表, 扫描目录 };
}

export function 路由技能(问题: string, 技能列表: Map<string, 已加载技能>): 技能路由结果 {
  const 小写问题 = 问题.toLowerCase();
  let 最佳匹配: 技能路由结果 | null = null;
  let 最佳分数 = 0;
  let 最佳优先级 = Number.POSITIVE_INFINITY;

  for (const [名称, 技能] of 技能列表.entries()) {
    let 分数 = 0;
    const 命中触发词 = 技能.触发词.filter(触发词 => 小写问题.includes(触发词.toLowerCase()));
    if (命中触发词.length > 0) {
      分数 += 命中触发词.length * 10;
      if (!是支持的技能名称(名称)) continue;
      const 当前优先级 = 技能优先级[名称];
      if (分数 > 最佳分数 || (分数 === 最佳分数 && 当前优先级 < 最佳优先级)) {
        最佳分数 = 分数;
        最佳优先级 = 当前优先级;
        最佳匹配 = {
          名称,
          原因: `命中 skill trigger：${命中触发词[0]}`,
          技能,
        };
      }
    }
  }

  if (最佳匹配) return 最佳匹配;

  for (const 规则 of 技能规则) {
    const 命中模式 = 规则.模式.find(模式 => 模式.test(问题));
    if (!命中模式) continue;
    return {
      名称: 规则.名称,
      原因: `命中规则：${命中模式.source}`,
      技能: 技能列表.get(规则.名称),
    };
  }

  return {
    名称: 'support-answer',
    原因: '未命中特定 skill，降级为通用客服回答路径',
  };
}

export function 构建技能上下文(
  问题: string,
  工作目录: string | undefined,
  配置: 只读源码配置,
  技能系统: 技能系统,
): 技能上下文结果 {
  const 路由结果 = 路由技能(问题, 技能系统.技能列表);
  if (!配置.enabled) {
    return {
      ...路由结果,
      文本: 构建技能说明文本(路由结果.技能),
      来源: 汇总技能来源(路由结果.技能),
    };
  }

  const 检索根目录 = 解析受限目录(配置.rootDir, 工作目录);
  const 技能说明文本 = 构建技能说明文本(路由结果.技能);
  const 技能来源 = 汇总技能来源(路由结果.技能);

  let 任务上下文 = { 文本: '', 来源: [] as string[] };
  if (路由结果.名称 === 'project-overview') {
    任务上下文 = 构建项目概览上下文(检索根目录);
  } else if (路由结果.名称 === 'code-search') {
    任务上下文 = 构建搜索型上下文(问题, 检索根目录, 配置, 'code-search');
  } else if (路由结果.名称 === 'bug-diagnosis') {
    任务上下文 = 构建搜索型上下文(问题, 检索根目录, 配置, 'bug-diagnosis');
  } else if (路由结果.名称 === 'feedback-intake') {
    任务上下文 = 构建反馈分诊上下文(问题, 检索根目录, 配置);
  } else if (路由结果.名称 === 'issue-draft') {
    任务上下文 = 构建Issue草稿上下文(问题, 检索根目录, 配置);
  } else if (路由结果.名称 === 'issue-submit') {
    任务上下文 = 构建Issue提交上下文();
  } else {
    任务上下文 = 构建搜索型上下文(问题, 检索根目录, 配置, 'support-answer');
  }

  const 段落 = [技能说明文本, 任务上下文.文本].filter(Boolean).join('\n\n');
  return {
    ...路由结果,
    文本: 段落,
    来源: Array.from(new Set([...技能来源, ...任务上下文.来源])),
  };
}

function 是支持的技能名称(名称: string): 名称 is 技能名称 {
  return [
    'project-overview',
    'code-search',
    'bug-diagnosis',
    'feedback-intake',
    'issue-draft',
    'issue-submit',
    'support-answer',
  ].includes(名称);
}

function 解析技能文档(原文: string): { 元信息: Record<string, unknown>; 正文: string } {
  if (!原文.startsWith('---\n') && !原文.startsWith('---\r\n')) {
    return { 元信息: {}, 正文: 原文 };
  }

  const 结束位置 = 原文.indexOf('\n---', 4);
  if (结束位置 < 0) {
    return { 元信息: {}, 正文: 原文 };
  }

  const 前言 = 原文.slice(4, 结束位置).trim();
  const 正文 = 原文.slice(结束位置 + 4).trim();
  return { 元信息: 解析前言(前言), 正文 };
}

function 解析前言(前言: string): Record<string, unknown> {
  const 结果: Record<string, unknown> = {};
  const 行列表 = 前言.split(/\r?\n/);

  for (let i = 0; i < 行列表.length;) {
    const 当前行 = 行列表[i];
    if (!当前行.trim()) {
      i++;
      continue;
    }

    const 字段匹配 = /^([A-Za-z0-9_-]+):(.*)$/.exec(当前行);
    if (!字段匹配) {
      i++;
      continue;
    }

    const 字段名 = 字段匹配[1];
    const 字段值 = 字段匹配[2].trim();
    if (字段值) {
      结果[字段名] = 清理字段值(字段值);
      i++;
      continue;
    }

    const 数组值: string[] = [];
    const 对象值: Record<string, string> = {};
    i++;
    while (i < 行列表.length && /^  /.test(行列表[i])) {
      const 嵌套行 = 行列表[i].slice(2);
      const 数组匹配 = /^-\s+(.+)$/.exec(嵌套行);
      if (数组匹配) {
        数组值.push(清理字段值(数组匹配[1]));
        i++;
        continue;
      }

      const 对象匹配 = /^([A-Za-z0-9_-]+):(.*)$/.exec(嵌套行);
      if (对象匹配) {
        对象值[对象匹配[1]] = 清理字段值(对象匹配[2].trim());
      }
      i++;
    }

    if (数组值.length > 0) {
      结果[字段名] = 数组值;
    } else {
      结果[字段名] = 对象值;
    }
  }

  return 结果;
}

function 清理字段值(值: string): string {
  return 值.trim().replace(/^['"]/, '').replace(/['"]$/, '');
}

function 读取字符串字段(值: unknown): string {
  return typeof 值 === 'string' ? 值 : '';
}

function 读取数组字段(值: unknown): string[] {
  return Array.isArray(值) ? 值.filter(item => typeof item === 'string') as string[] : [];
}

function 读取对象字段(值: unknown): 技能权限 {
  if (!值 || typeof 值 !== 'object' || Array.isArray(值)) return {};
  const 结果: 技能权限 = {};
  for (const [键, 项] of Object.entries(值)) {
    if (typeof 项 === 'string') {
      结果[键] = 项;
    }
  }
  return 结果;
}

function 读取参考资料(技能目录: string): 技能参考资料[] {
  const 参考目录 = path.join(技能目录, 'references');
  if (!existsSync(参考目录)) return [];

  return readdirSync(参考目录, { withFileTypes: true })
    .filter(条目 => 条目.isFile())
    .map(条目 => path.join(参考目录, 条目.name))
    .filter(文件路径 => 是否文本文件(文件路径))
    .sort((a, b) => a.localeCompare(b))
    .map(文件路径 => ({
      路径: 文件路径,
      内容: readFileSync(文件路径, 'utf8').trim(),
    }));
}

function 构建技能说明文本(技能?: 已加载技能): string {
  if (!技能) return '';

  const 段落 = [
    `当前命中 Skill: ${技能.名称}`,
    技能.描述 ? `Skill 描述: ${技能.描述}` : '',
    Object.keys(技能.权限).length > 0
      ? `Skill 权限: ${Object.entries(技能.权限).map(([键, 值]) => `${键}=${值}`).join(', ')}`
      : '',
    技能.正文 ? `Skill 指南:\n${技能.正文}` : '',
  ].filter(Boolean);

  for (const 参考资料 of 技能.参考资料) {
    段落.push(`Skill 参考资料: ${参考资料.路径}\n${参考资料.内容}`);
  }

  return 段落.join('\n\n');
}

function 汇总技能来源(技能?: 已加载技能): string[] {
  if (!技能) return [];
  return [技能.技能文件, ...技能.参考资料.map(资料 => 资料.路径)].map(格式化路径);
}

function 构建项目概览上下文(根目录: string): { 文本: string; 来源: string[] } {
  const 段落: string[] = [
    '项目概览只读上下文（由宿主本地读取，仅供回答参考，禁止假装拥有写权限）:',
    `项目根目录: ${根目录}`,
  ];
  const 来源: string[] = [];

  for (const 文件名 of ['README.zh-CN.md', 'README.md', '.codebase_index.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'docker-compose.yml']) {
    const 文件路径 = path.join(根目录, 文件名);
    if (!existsSync(文件路径)) continue;
    段落.push(`文件: ${格式化项目内路径(根目录, 文件路径)}\n\n\`\`\`\n${读取文件开头(文件路径, 1800)}\n\`\`\``);
    来源.push(格式化路径(文件路径));
  }

  const 顶层条目 = readdirSync(根目录, { withFileTypes: true })
    .filter(条目 => !条目.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(条目 => `${条目.isDirectory() ? '[dir]' : '[file]'} ${条目.name}`)
    .join('\n');

  if (顶层条目) {
    段落.push(`顶层目录概览:\n\n\`\`\`\n${顶层条目}\n\`\`\``);
  }

  return { 文本: 段落.join('\n\n'), 来源 };
}

function 构建搜索型上下文(
  问题: string,
  根目录: string,
  配置: 只读源码配置,
  模式: 'code-search' | 'bug-diagnosis' | 'support-answer',
): { 文本: string; 来源: string[] } {
  const 关键词 = 提取关键词(问题);
  if (关键词.length === 0) {
    return {
      文本: [
        '检索型只读上下文：',
        `项目根目录: ${根目录}`,
        '当前未提取到足够明确的关键词，请优先说明模块名、错误信息、文件名或功能名称。',
      ].join('\n\n'),
      来源: [],
    };
  }

  const 候选文件 = 收集候选文件(根目录, 配置.maxFileSizeBytes);
  const 命中列表: 文本片段[] = [];
  for (const 文件路径 of 候选文件) {
    try {
      const 内容 = readFileSync(文件路径, 'utf8');
      const 相对路径 = 格式化项目内路径(根目录, 文件路径);
      const 分数 = 计算文件得分(相对路径, 内容, 关键词, 模式, 问题);
      if (分数 <= 0) continue;
      const 片段 = 提取片段(内容, 关键词, 配置.maxCharsPerFile, 模式);
      if (!片段.trim()) continue;
      命中列表.push({ 路径: 相对路径, 分数, 内容: 片段 });
    } catch {
      continue;
    }
  }

  const 已排序 = 命中列表.sort((a, b) => b.分数 - a.分数).slice(0, 配置.maxFiles);
  if (已排序.length === 0) {
    return {
      文本: [
        `${模式 === 'bug-diagnosis' ? '诊断型' : '检索型'}只读上下文：`,
        `项目根目录: ${根目录}`,
        `问题关键词: ${关键词.join(', ')}`,
        '没有命中足够相关的源码片段，请避免编造结论。',
      ].join('\n\n'),
      来源: [],
    };
  }

  const 段落 = [
    `${模式 === 'bug-diagnosis' ? '诊断型' : '检索型'}只读上下文（由宿主本地读取，仅供回答参考）:`,
    `项目根目录: ${根目录}`,
    `问题关键词: ${关键词.join(', ')}`,
  ];

  let 当前长度 = 段落.join('\n').length;
  const 来源: string[] = [];
  for (const 项 of 已排序) {
    const 片段文本 = [`文件: ${项.路径}`, `相关性: ${项.分数}`, '\`\`\`', 项.内容, '\`\`\`'].join('\n');
    if (当前长度 + 片段文本.length > 配置.maxTotalChars) break;
    段落.push(片段文本);
    当前长度 += 片段文本.length;
    来源.push(格式化路径(path.join(根目录, 项.路径)));
  }

  if (模式 === 'bug-diagnosis') {
    段落.push('诊断输出要求：区分“已确认的证据”“可能原因”“待补充信息”，不要把猜测写成确定事实。');
  }

  return { 文本: 段落.join('\n\n'), 来源 };
}

function 构建Issue草稿上下文(问题: string, 根目录: string, 配置: 只读源码配置): { 文本: string; 来源: string[] } {
  const 项目概览 = 构建项目概览上下文(根目录);
  const 诊断上下文 = 构建搜索型上下文(问题, 根目录, {
    ...配置,
    maxFiles: Math.min(配置.maxFiles, 3),
    maxTotalChars: Math.min(配置.maxTotalChars, 3600),
  }, 'bug-diagnosis');

  return {
    文本: [
      'Issue 草稿只读上下文：',
      '输出时请优先整理为：标题 / 问题描述 / 复现步骤 / 预期结果 / 实际结果 / 初步分析 / 影响范围 / 建议补充信息。',
      项目概览.文本,
      诊断上下文.文本,
    ].join('\n\n'),
    来源: Array.from(new Set([...项目概览.来源, ...诊断上下文.来源])),
  };
}

function 构建反馈分诊上下文(
  问题: string,
  根目录: string,
  配置: 只读源码配置,
): { 文本: string; 来源: string[] } {
  const 诊断上下文 = 构建搜索型上下文(问题, 根目录, {
    ...配置,
    maxFiles: Math.min(配置.maxFiles, 2),
    maxTotalChars: Math.min(配置.maxTotalChars, 2800),
  }, 'bug-diagnosis');

  return {
    文本: [
      '反馈分诊上下文：',
      '输出时优先给出：intent/confidence/missing_fields/next_question/can_preview。',
      '每轮只追问一个缺失信息，优先让非技术用户能回答。',
      诊断上下文.文本,
    ].join('\n\n'),
    来源: 诊断上下文.来源,
  };
}

function 构建Issue提交上下文(): { 文本: string; 来源: string[] } {
  return {
    文本: [
      'Issue 提交守卫：',
      '1) 未确认不提交；2) required 字段不全不提交；3) 仅允许受控 issue 创建能力。',
      '如果满足条件，输出简短确认与下一步提示。',
    ].join('\n\n'),
    来源: [],
  };
}

function 解析受限目录(根目录: string, 工作目录?: string): string {
  const 已解析根目录 = path.resolve(根目录);
  if (!工作目录?.trim()) return 已解析根目录;
  const 已解析工作目录 = path.resolve(工作目录);
  const 相对路径 = path.relative(已解析根目录, 已解析工作目录);
  if (!相对路径 || (!相对路径.startsWith('..') && !path.isAbsolute(相对路径))) {
    return 已解析工作目录;
  }
  return 已解析根目录;
}

function 读取文件开头(文件路径: string, 最大字符数: number): string {
  const 内容 = readFileSync(文件路径, 'utf8').trim();
  if (内容.length <= 最大字符数) return 内容;
  return `${内容.slice(0, 最大字符数)}\n...`;
}

function 提取关键词(问题: string): string[] {
  const 候选 = (问题.toLowerCase().match(/[a-z0-9_./\-\u4e00-\u9fa5]+/g) || [])
    .map(项 => 项.trim())
    .filter(Boolean)
    .filter(项 => 项.length >= 2)
    .filter(项 => !['please', 'help', 'with', 'this', 'that', 'what', 'how', 'the', 'and', 'for', 'why', '你', '我', '我们', '怎么', '什么', '一下', '这个', '那个'].includes(项));

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

function 计算文件得分(相对路径: string, 内容: string, 关键词: string[], 模式: string, 问题: string): number {
  const 小写路径 = 相对路径.toLowerCase();
  const 小写内容 = 内容.toLowerCase();
  const 小写问题 = 问题.toLowerCase();
  let 分数 = 0;

  for (const 词 of 关键词) {
    if (小写路径.includes(词)) 分数 += 8;
    const 首次位置 = 小写内容.indexOf(词);
    if (首次位置 >= 0) {
      分数 += 3;
      const 出现次数 = 小写内容.split(词).length - 1;
      分数 += Math.min(出现次数, 4);
    }
  }

  if (模式 === 'code-search') {
    if (/[\/](index|main|app|entry)\./.test(小写路径)) 分数 += 3;
    if (小写问题.includes('入口') && /(index|main|app|entry)/.test(小写路径)) 分数 += 6;
  }

  if (模式 === 'bug-diagnosis') {
    if (小写路径.includes('config')) 分数 += 2;
    if (小写路径.includes('error') || 小写路径.includes('exception')) 分数 += 2;
    if (/throw |catch |error|fail/i.test(内容)) 分数 += 3;
  }

  return 分数;
}

function 提取片段(内容: string, 关键词: string[], 最大字符数: number, 模式: string): string {
  if (!内容.trim()) return '';

  const 行列表 = 内容.split(/\r?\n/);
  const 小写关键词 = 关键词.map(项 => 项.toLowerCase());
  const 命中行 = 行列表.findIndex(行 => 小写关键词.some(词 => 行.toLowerCase().includes(词)));

  let 片段 = '';
  if (命中行 >= 0) {
    const 前置行数 = 模式 === 'bug-diagnosis' ? 10 : 8;
    const 后置行数 = 模式 === 'bug-diagnosis' ? 16 : 12;
    const 起始 = Math.max(0, 命中行 - 前置行数);
    const 结束 = Math.min(行列表.length, 命中行 + 后置行数);
    片段 = 行列表.slice(起始, 结束).join('\n');
  } else {
    片段 = 行列表.slice(0, 模式 === 'project-overview' ? 60 : 40).join('\n');
  }

  if (片段.length <= 最大字符数) return 片段;
  return `${片段.slice(0, 最大字符数)}\n...`;
}

function 格式化项目内路径(根目录: string, 文件路径: string): string {
  return path.relative(根目录, 文件路径) || path.basename(文件路径);
}

function 格式化路径(文件路径: string): string {
  return path.relative(process.cwd(), 文件路径) || 文件路径;
}
