---
name: issue-submit
description: 在用户确认且字段完整时执行受控 issue 创建
version: 0.1.0
triggers:
  - 确认提交
  - 提交 issue
  - create issue
permissions:
  filesystem: read-only
  shell: none
  git: read-only
---

# Purpose
在严格门禁下把草稿提交到 GitHub Issue，成功后回贴链接。

# Preconditions
- 用户明确确认提交
- required 字段齐全
- 目标仓库和认证配置可用

# Guardrails
- 未确认不得提交
- required 字段不齐不得提交
- 失败必须返回可读错误和重试建议
