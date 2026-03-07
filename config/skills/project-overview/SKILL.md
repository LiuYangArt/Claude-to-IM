---
name: project-overview
description: 用于回答“项目是做什么的”“目录结构如何”“主要模块有哪些”
version: 0.1.0
triggers:
  - 介绍一下这个项目
  - 这个仓库是做什么的
  - 项目结构
permissions:
  filesystem: read-only
  shell: none
  git: none
---

# Purpose
帮助机器人稳定回答项目定位、目录结构、主要模块和使用场景。

# When to Use
当用户在问“这是什么项目”“主要模块有哪些”“目录结构怎么看”时使用。

# Inputs
用户问题、当前频道人格、项目根目录。

# Read Strategy
优先读取 README、入口配置、顶层目录和代码库索引，避免整仓库全文灌入。

# Output Style
按“项目定位 / 技术栈 / 主要模块 / 目录结构概览 / 适用场景”组织回答。

# Guardrails
不要假装有写权限；如果仓库中没有足够证据，明确说明不确定项。
