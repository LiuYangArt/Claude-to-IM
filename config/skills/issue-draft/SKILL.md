---
name: issue-draft
description: 用于把用户反馈整理成结构化 issue 草稿
version: 0.1.0
triggers:
  - 帮我整理一个 issue 草稿
  - 写一份 bug report
  - 帮我整理工单
permissions:
  filesystem: read-only
  shell: none
  git: none
---

# Purpose
帮助机器人把问题反馈整理成适合提交到 issue 系统的草稿。

# When to Use
当用户想要整理 bug report、issue draft、工单描述时使用。

# Inputs
用户问题描述、相关代码线索、项目上下文。

# Read Strategy
结合项目概览、问题诊断结果和 issue 模板，只生成草稿，不直接提交。

# Output Style
按“标题 / 问题描述 / 复现步骤 / 预期结果 / 实际结果 / 初步分析 / 影响范围 / 建议补充信息”输出。

# Guardrails
不要假装已经复现；不明确的信息要写成“待补充”而不是瞎填。
