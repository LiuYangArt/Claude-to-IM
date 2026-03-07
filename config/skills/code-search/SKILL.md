---
name: code-search
description: 用于回答“某功能在哪”“某段逻辑在哪个文件”“入口文件是哪个”
version: 0.1.0
triggers:
  - 入口文件是哪个
  - 某功能在哪
  - 实现在哪
permissions:
  filesystem: read-only
  shell: none
  git: none
---

# Purpose
帮助机器人从只读源码里定位功能入口、关键文件和相关实现点。

# When to Use
当用户在问“在哪个文件”“实现在哪里”“入口逻辑在哪”时使用。

# Inputs
用户问题、功能关键词、项目根目录。

# Read Strategy
先看文件名和路径，再看内容命中，最后只输出少量高相关片段。

# Output Style
按“相关文件 / 文件作用 / 最相关实现点 / 不确定项”组织回答。

# Guardrails
不要为了给出答案而硬猜；证据不足时明确说“目前只定位到疑似位置”。
