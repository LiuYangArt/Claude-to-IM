# AGENTS.md

## 项目定位

这个仓库当前已经被接成一个 **Discord 客服机器人宿主**
- 在 Discord 指定频道中回复用户消息
- 使用 OpenAI 兼容接口进行对话
- 结合本地源码目录的**只读上下文**辅助回答问题
- 通过不同频道加载不同人格 / 语言配置
- 以 Docker 方式长期稳定运行

当前实现重点是“**先稳定在线并可回复**”，不是复杂的多工具 Agent 平台。
后续改动应优先保持简单、稳定、可维护，不要过度工程化。

---

## 当前运行方式

当前正式运行入口是：
- `npm run example:discord`

对应宿主文件：
- `src/lib/bridge/examples/discord-echo-host.ts`

虽然文件名里有 `example`，但目前它已经承担实际宿主职责，包括：
- 读取 `config/discord-bridge.json`
- 加载人格 Markdown 文件
- 构建只读源码上下文
- 调用 OpenAI 兼容接口 `/responses`
- 启动 Discord Bot

如非必要，不要把这些逻辑拆成大量新模块；优先做小步、可审阅的修改。

---

## 配置约定

### 主配置文件

主配置文件位于：
- `config/discord-bridge.json`

该文件已经加入 `.gitignore`，原因是其中可能包含：
- Discord Bot Token
- OpenAI API Key
- 本地机器上的绝对路径

**禁止**把真实密钥、真实 token、真实本地路径硬编码到源码里。

### 人格文件

人格 / 语言 / 回复风格通过 Markdown 文件配置：
- `config/prompts/default.md`
- `config/prompts/sutu-cn.md`
- `config/prompts/sutu-en.md`

约定：
- `default.md`：默认人格，适合 general / 闲聊频道
- `sutu-cn.md`：中文客服频道人格
- `sutu-en.md`：英文客服频道人格

如果后续新增频道人格，优先继续沿用 `config/prompts/*.md` 的方式，不要把长 prompt 写回 JSON。

### 频道人格映射

频道到人格文件的映射配置写在：
- `config/discord-bridge.json` 的 `persona.channel_prompt_files`

修改规则：
- Discord channel ID **必须写成字符串**，不能写数字
- 例如正确写法：
  - `"1479760489050275951"`
- 错误写法会导致 JavaScript 精度丢失，进而让频道白名单和人格映射失效

### 白名单频道

允许机器人的频道配置在：
- `config/discord-bridge.json` 的 `discord.allowed_channels`

规则：
- 新增频道时，通常需要同时修改：
  - `discord.allowed_channels`
  - `persona.channel_prompt_files`（如果该频道需要专属人格）
- 如果只是闲聊频道且想使用默认人格，则只需要加入 `allowed_channels`

---

## Discord 侧约定

### 必须开启的设置

在 Discord Developer Portal 中，Bot 必须开启：
- `Message Content Intent`

否则机器人会报：
- `Used disallowed intents`

### 当前频道交互规则

当前默认配置下：
- `require_mention = true`

所以在服务器频道中：
- 必须 `@bot` 才会触发回复

如果后续改成无需 `@bot` 即回复，应谨慎评估噪音与误触发问题。

### OAuth2 / 邀请方式

Bot 不是通过“邀请朋友进频道”的方式添加。
正确方式是：
- 在 Discord Developer Portal 的 `OAuth2 -> URL Generator` 中生成邀请链接
- 使用 `bot` scope 安装到服务器

频道可见性和发言权限，则通过服务器 / 频道权限控制。

---

## OpenAI 兼容接口约定

当前宿主调用的是 OpenAI 兼容接口，并使用：
- `/responses`

配置位置：
- `config/discord-bridge.json` -> `openai`

如果修改兼容接口实现，请遵守以下原则：
- 优先兼容当前 `Responses` 风格
- 保持最小改动
- 出错时返回清晰错误，不要静默吞掉关键失败

不要把 Bot 逻辑写成依赖某单一云厂商 SDK 的深度耦合结构；当前仓库更适合保留轻量 HTTP 适配方式。

---

## 本地源码上下文（只读）

### 目标

机器人当前会结合本地项目源码辅助回答问题，但这个能力必须是：
- **只读**
- **宿主主动读取片段并注入 prompt**
- **不允许模型拥有本地文件写权限**

### 当前约定

配置位于：
- `config/discord-bridge.json` -> `source_context`

关键规则：
- `read_only` 必须为 `true`
- 源码目录通过宿主读取
- 只提取有限片段，不直接整仓库塞给模型
- 只读上下文仅用于回答参考，不代表模型有真实文件系统操作权限

### 修改原则

如果后续优化源码检索：
- 优先继续保持“简单的只读检索 + prompt 注入”思路
- 不要在没有明确需求时引入复杂向量库 / 外部索引服务 / 大型 RAG 基础设施
- 先保证客服回答质量和稳定性，再考虑复杂检索系统

---

## Docker 部署约定

当前仓库已经支持 Docker 部署，相关文件：
- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`

### 当前部署目标

Docker 用于：
- 长期稳定在线
- 自动重启
- 将配置目录和源码目录挂载到容器外部

### 当前挂载约定

容器内会使用：
- `/app/config` 作为配置目录
- 本地源码目录以只读方式挂载

Compose 支持以下外部变量：
- `BOT_CONFIG_DIR`
- `SOURCE_ROOT_DIR`

如果用户希望把配置放到仓库外部，优先使用这两个变量，而不是再新造一套路径机制。

### 部署相关常用命令

- 启动：`docker compose up -d`
- 重建并启动：`docker compose up -d --build`
- 查看日志：`docker compose logs -f`
- 重启：`docker compose restart`
- 停止：`docker compose down`

### Docker 修改原则

改 Docker 配置时要遵守：
- 保持源码目录只读挂载
- 保持配置目录可外置挂载
- 保持容器长期运行能力（如 `restart: unless-stopped`）
- 不要为了“小功能”把部署结构改复杂

---

## 当前频道用途约定

按目前讨论结果：
- 中文客服频道：使用中文客服人格
- 英文客服频道：使用英文客服人格
- `general` 频道：作为闲聊用途，使用默认人格

后续如果新增频道，请先明确该频道属于：
- 客服频道
- 英文客服频道
- 闲聊频道
- 其它专用频道

然后再决定是否需要单独的 prompt 文件。

---

## 修改优先级

在这个仓库继续开发时，优先级如下：
1. 机器人持续在线、稳定可回复
2. Discord 配置与频道行为正确
3. 人格 / 语言配置易维护
4. 只读源码上下文安全、简单、稳定
5. Docker 部署可靠
6. 再考虑 issue 自动化、复杂工具调用等增强功能

如果一个改动会明显增加复杂度，请先问自己：
- 这是当前客服 Bot 真正需要的吗？
- 能不能先用更简单的方法达成？

---

## 明确禁止

以下方向默认不要主动引入，除非用户明确要求：
- 复杂 RAG 基础设施
- 向量数据库
- 自动修改本地源码
- 自动执行危险命令
- 自动创建大量 GitHub issue
- 多层过度抽象的“插件系统”
- 为了“看起来通用”而做的大规模重构

当前目标是：
- **客服机器人先稳定可用**
- **人格和频道行为可控**
- **本地源码仅只读参考**
- **Docker 长期运行稳定**

---

## 给未来协作者的建议

如果你接手这个仓库：
- 先看 `config/discord-bridge.json`
- 再看 `config/prompts/*.md`
- 再看 `src/lib/bridge/examples/discord-echo-host.ts`
- 最后再看 Docker 部署文件

多数需求都应优先在这几处做最小修改，而不是直接重构整个 bridge 层。

---

## 开发流程
- 功能或配置改动完成后，如果改动会影响 Discord bot 的运行结果，AI 协作者需要直接自动执行 `docker compose up -d --build`，让最新改动生效，不要把命令留给用户手动执行。
- 自动重建后，还需要继续自动检查 `docker compose ps` 与最近日志，确认容器已经成功启动并进入可用状态。
- 只有在 Docker Desktop / Docker daemon 未启动、宿主权限受限、或构建失败且无法自动修复时，才向用户说明具体问题并请求用户介入。
- 默认不要要求用户自己打开终端执行命令；用户已经明确表示不使用命令行。
- 一般情况下不需要重启整个 Docker Desktop；优先通过重建并重启 `discord-bot` 容器让改动生效。 
