# Notes: 轻量 Skill 系统方向

## 现状
- 当前项目已具备 Discord Bot、频道人格、只读源码上下文、Docker 长期运行。
- 当前“介绍项目”类问题暴露出简单关键词检索不足，说明需要更明确的 skill 路由。
- 当前项目定位是客服 Bot，不适合直接引入完整 coding agent 能力。

## 方向判断

### Pi 借鉴点
- 内核轻
- 能力外置
- session / tool 注入明确
- 适合作为“轻量 agent 思想参考”

### Pi 不适合直接接入的点
- 偏 coding agent
- 默认世界观包括编辑 / 写入 / Bash
- 与当前“只读、安全、客服导向”的目标不完全一致

### Codex Skills 借鉴点
- `SKILL.md` 作为入口
- skill 目录可带 `scripts/`、`references/`、`assets/`
- 适合作为标准兼容格式

## 推荐方向
- 保留当前 Discord 宿主
- 在宿主内增加轻量 skill loader + router
- skill 存储位置采用 `config/skills`
- 目录结构尽量兼容 Codex / Open Agent Skills
- 第一阶段仅提供只读诊断能力
