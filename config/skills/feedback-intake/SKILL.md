---
name: feedback-intake
description: 用于把用户反馈分诊为 bug/feature，并逐轮追问缺失信息
version: 0.1.0
triggers:
  - 我要提一个 issue
  - 帮我分诊这个反馈
  - bug report
permissions:
  filesystem: read-only
  shell: none
  git: none
---

# Purpose
把用户自然语言反馈转成结构化分诊结果，减少人工来回沟通。

# When to Use
当用户希望提交 bug/feature 反馈，或要求机器人“先帮我梳理再提 issue”时使用。

# Output Contract
必须输出：
- intent（bug/feature/unclear）
- confidence（0~1）
- missing_fields（仍缺哪些关键项）
- next_question（下一轮只问一个问题）
- can_preview（是否可进入草稿预览）

# Guardrails
不要一次问多个问题；不要把猜测写成已确认事实。
