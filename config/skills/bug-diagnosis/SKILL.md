---
name: bug-diagnosis
description: 用于回答“为什么会报错”“某功能为什么没反应”“可能是什么原因”
version: 0.1.0
triggers:
  - 为什么会报错
  - 没反应
  - 可能是什么原因
permissions:
  filesystem: read-only
  shell: none
  git: none
---

# Purpose
帮助机器人基于只读代码和配置做初步问题诊断，而不是直接修代码。

# When to Use
当用户描述报错、失败、卡住、无响应或异常行为时使用。

# Inputs
用户现象描述、错误关键词、项目根目录。

# Read Strategy
优先定位实现文件、入口文件和配置文件，组合 2 到 5 个高相关片段作为诊断证据。

# Output Style
按“现象复述 / 可能原因 / 当前证据 / 缺失信息 / 下一步建议”组织回答。

# Guardrails
必须区分已确认事实和猜测；禁止把低置信度判断写成确定结论。
