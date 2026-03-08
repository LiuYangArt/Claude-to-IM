# AI 优先的反馈分诊与动态 Issue 创建计划

## 1. 目标

把 Discord 客服反馈流程简化为一条 AI 主导链路：
- 自动判断反馈属于 `bug` / `feature` / `unclear`
- 用对非技术用户友好的方式继续追问缺失信息
- 在真正创建 issue 前，动态读取目标仓库的 Issue 模板并填充
- 多用户同时提问时，上下文严格隔离，不串会话

本期不做复杂工单系统，不引入重型状态机平台。

---

## 2. 方案结论（精简版）

采用：
- **AI 主导决策 + 少量硬规则兜底**
- **3 个核心 Skill + 1 个轻量执行器**

不采用：
- 预先写死某个仓库的 issue 模板
- 频道级共享上下文
- 多层复杂审批流

---

## 3. 最小架构

### 3.1 Skill 设计

1. `feedback-intake`
- 产出结构化结果：`intent`、`confidence`、`missing_fields`、`next_question`、`can_preview`
- 负责“本轮该问什么”，每轮只问一个问题

2. `issue-draft`
- 基于当前草稿 + 动态模板字段生成预览
- 明确哪些字段是“已确认”、哪些是“待补充”

3. `issue-submit`
- 只在用户明确确认后执行
- 调用 GitHub 创建 issue，并回贴链接

### 3.2 执行器职责（薄层）

执行器只做编排，不做重决策：
- 运行 `feedback-intake`
- `can_preview=true` 时运行 `issue-draft`
- 用户确认后运行 `issue-submit`

---

## 4. 动态模板读取（不写死）

### 4.1 目标

issue 模板来源应由“目标仓库”决定，而不是由 Bot 源码写死。

### 4.2 读取策略

触发 `issue-draft` / `issue-submit` 时：
1. 确定目标仓库（例如 `owner/repo`）
2. 读取该仓库 `.github/ISSUE_TEMPLATE/*.yml`
3. 解析 `issue forms` 字段（重点：`required`、`id`、`type`）
4. 生成“字段清单 + 缺失字段”并驱动追问

### 4.3 兜底策略

- 若目标仓库没有 issue form：
  - 降级到通用 `bug`/`feature` 模板
- 若模板解析失败：
  - 输出可读错误并提示人工确认，不静默失败

---

## 5. 多用户并发与上下文隔离

### 5.1 核心原则

- **同一用户的反馈要聚合成一条完整草稿**
- **不同用户问题不能混在一起**

### 5.2 会话键策略

默认使用 `per_user` 粒度：
- 普通频道：`guildId:channelId:userId`
- 线程频道：`guildId:threadId:userId`

可配置扩展：
- `per_thread`：`guildId:threadId`
- `per_channel`：`guildId:channelId`（不推荐默认）

### 5.3 并发处理

- 每个会话键一把锁，串行处理该会话消息
- 不同会话键并行处理
- 每个会话独立维护：
  - 原始消息片段
  - 滚动摘要
  - 当前草稿
  - 当前状态（collecting/preview/confirmed/submitted）

---

## 6. 硬规则（最少但必须）

1. 未确认不提交 GitHub
2. 模板 `required` 字段未满足不提交
3. 提交动作只开放受控能力（创建 issue）
4. 失败必须可见（向用户解释失败原因和下一步）

---

## 7. 关键数据结构

```ts
interface FeedbackDraft {
  sessionKey: string;
  intent: 'bug' | 'feature' | 'unclear';
  targetRepo: string;
  title?: string;
  fields: Record<string, unknown>;
  missingFields: string[];
  status: 'collecting' | 'preview' | 'confirmed' | 'submitted' | 'cancelled';
  issueUrl?: string;
  updatedAt: string;
}
```

---

## 8. 实施阶段

### Phase 1：会话隔离与 AI 分诊
- 引入 `sessionKey` 规则
- 每会话独立草稿
- 接入 `feedback-intake` 结构化输出

### Phase 2：动态模板与草稿预览
- 读取目标仓库 issue form
- 解析 required 字段
- 按缺失字段驱动追问
- 输出可确认的 issue 预览

### Phase 3：受控提交
- 用户确认后创建 issue
- 返回 issue 链接
- 失败可重试与降级提示

---

## 9. 验收标准

1. 多个用户在同一频道同时提问，不会串上下文
2. 单个用户多轮消息会被聚合为一份完整草稿
3. issue 字段来自目标仓库模板，不写死
4. required 字段未满足时不会提交
5. 用户明确确认后才能创建 issue
6. 创建成功后能回贴链接

---

## 10. 推荐先做顺序

1. 先改会话键与并发隔离（解决串上下文）
2. 再接 `feedback-intake` 结构化输出
3. 再做动态模板读取与缺失字段追问
4. 最后接提交动作与确认门禁

最终建议：

**用 AI 决定“问什么”和“怎么填”，用代码只保障“隔离、权限、提交门禁”。**
