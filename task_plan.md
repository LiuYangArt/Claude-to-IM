# Task Plan: 轻量 Skill 系统规划

## Goal
为当前 Discord 客服机器人设计一套轻量、可扩展、尽量兼容标准 Skill 格式的方案，并形成正式计划文档。

## Phases
- [x] Phase 1: 读取现有上下文和技能说明
- [x] Phase 2: 评估 Pi / Codex Skills 方向
- [x] Phase 3: 编写详细计划文档
- [x] Phase 4: 复核文档并交付

## Key Questions
1. 当前 Bot 需要哪些“只读诊断”能力？
2. Skill 应该如何兼容标准目录和 `SKILL.md` 入口？
3. 如何在不引入完整 coding agent 的前提下扩展诊断能力？
4. Docker、配置目录、频道人格如何与 Skill 系统协同？

## Decisions Made
- 采用“轻量宿主 + 轻量 skill router”的方向，不直接嵌入完整 Pi runtime。
- Skill 包格式尽量向 Codex / Open Agent Skills 靠拢。
- 运行时权限以只读为主，后续再扩展到受控执行层。
- Skill 实际维护目录优先考虑 `config/skills`。

## Errors Encountered
- 暂无

## Status
**Currently in Phase 4** - 文档已完成，正在准备交付。
