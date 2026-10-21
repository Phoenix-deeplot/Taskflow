# Taskflow

> 把需求、AI Agent 任务和可验收交付放在同一条本地工作流里，少丢上下文、少靠人工盯进度。

**功能介绍：**[打开 Taskflow 功能介绍页](./dist/cover.html) · **本地试用：**按下方“快速开始”启动后打开 <http://127.0.0.1:4179>

> 当前仓库没有可随 README 展示的实拍截图或录屏。功能介绍页是静态说明页，不是线上 SaaS 试用站；本地启动才是可操作的试用入口。

## 三个主要场景

| 场景 | 适用人群 | Taskflow 能做什么 |
| --- | --- | --- |
| 把想法整理成可决策需求 | 独立产品负责人、创始人 | 粘贴 Prompt 或导入文档，形成需求清单；按版本筛选，决定保留、修改、延后或不做。 |
| 把需求交给本地 AI 执行 | 个人开发者、AI 编程使用者 | 将需求拆成任务，交给本机 Claude Code、Codex 或自定义 CLI Agent；查看进度、日志、产物，再人工验收。 |
| 试跑轻量 AI 协作流程 | 正在试用 Agent 的小团队 | 在一台受信任的机器上共享本地工作台状态；验证任务拆分、执行与验收流程。当前不是多人云协作服务，不支持多账号并发工作区。 |

## 快速开始

### 最短启动（只整理需求，不接 Agent）

需要 Node.js 22.13+。无需数据库安装；页面静态资源不需要额外 npm 依赖。

```powershell
npm run dev
```

打开终端显示的地址（默认 <http://127.0.0.1:4179>），停止时按 `Ctrl+C`。第一次进入是空工作区，可点击“载入工具模块样例”添加 15 条样例，或粘贴 Prompt / 导入 JSON、TXT、Markdown、DOCX 需求。

也可以用单条命令启动 Web + 本地 Runner：

```powershell
npm run taskflow
```

该方式需要 Node.js 22.13+、Git，以及你准备使用并已登录的 Agent CLI（如 Claude Code / Codex）。第一次使用时，在设置里选择一个 Git 项目目录。若只手动管理需求与任务，不需要 Agent CLI，也不需要模型 API Key。

### 模型/API 配置（可选）

只有使用模型驱动的需求分析或 AI 拆分时才需要模型服务 Key；在 Taskflow 设置页配置，或通过本地服务环境变量配置。当前支持 Claude、OpenAI、DeepSeek 的模型网关。手动拆分、导入需求、浏览看板不依赖模型 Key。不要把密钥写入需求正文、导出 JSON 或 Git 文件。

### Windows Web 便携包（可选）

在开发仓库中运行 `npm run pack:taskflow`，生成 `release/Taskflow-Web-0.1.0.zip`。解压后运行 `start-taskflow.cmd`。目标电脑需安装 Node.js 22.13+、Git 和需要使用的 Agent CLI；无需在目标电脑执行 `npm install`。当前也保留 Electron 桌面测试方式，见“配置、版本与路线图”。

## 使用示例：从需求到交付

假设你要给工作台增加“需求导入后先预览，确认后才写入；遇到重复 ID 跳过”的能力：

1. 在需求清单里粘贴这段描述，或导入文档；解析出的内容先作为待确认需求，不会自动覆盖现有记录。
2. 补充验收标准，例如“预览能显示新增/重复项；确认后只写入新增项；取消后数据不变”，再决定目标版本和需求状态。
3. 在 AI 协作区为需求创建任务。可以手动给出拆分和依赖；启用模型拆分时，先检查草稿再确认，不会直接把模型输出当成正式任务。
4. 在执行看板启动任务。Runner 为代码任务建立独立 Git worktree/分支并调用本地 Agent；页面记录 Run 状态、日志和交付产物。
5. 检查分支、diff、日志与验收标准。通过后将任务标记完成，再由你决定是否把产物分支合并进项目主分支；不通过则写明原因退回。

这条链路用于演示当前单机原型的工作方式。Agent 的实际可用性取决于本机 CLI 登录、项目仓库状态与模型服务配置；模型拆分/网关目前仍需用真实账户和 Key 做目标环境验证。

## 差异与限制

### 和把任务散落在文档、聊天窗口里的方式相比

- 需求、任务、依赖、运行记录和验收结果放在一个本地 SQLite 工作区中，减少上下文在不同对话间丢失。
- Agent 在隔离的 Git worktree/分支里执行；Taskflow 不直接改动主工作目录和主分支，结果可检查后再合并。
- 支持本地运行，不必把项目文件交给云端工作台；若主动使用模型网关，所选需求上下文会发送给对应模型服务。

### 当前限制

- 当前是 **0.1.0 本地预览版 / 单人工作区**，没有账号、权限管理、云端同步或多人同时编辑。
- Web+Runner 需要本机 Node.js、Git 和 Agent CLI；Agent 自身的安装、登录与额度由用户管理。
- 模型拆分只生成待审阅草稿。模型供应商接入虽有网关和测试，但真实账号端到端验证仍需用户配置 Key 后完成。
- Windows 便携包可生成；Electron 桌面版仍属测试方式。安装包当前未代码签名，Windows 可能提示未知发布者。
- 不提供 Agent 产物自动合并；验收与合并由用户把关。

## 参与方式

- **反馈入口：**[GitHub Issues](https://github.com/Phoenix-deeplot/Taskflow/issues)。请描述复现步骤、预期与实际结果、操作系统和 Node.js 版本；提交日志前先移除 Key、令牌和私有业务数据。
- **代码贡献：**先说明要解决的问题，再提交尽量聚焦的改动；涉及数据/状态流转时，请附测试或可复现的验收步骤。当前没有单独的 CONTRIBUTING 指南。
- **适合先做的小任务：**补一张脱敏后的真实界面截图；补充一个可重复的端到端使用案例；在另一台干净 Windows 环境验证 Web 便携包与 Agent CLI 启动。
- 修改后可运行 `npm test` 执行项目测试。

## 基础信息

| 项目 | 当前信息 |
| --- | --- |
| 版本 | `0.1.0`（本地预览构建；以 `package.json` 为准） |
| 许可证 | 仓库暂未提供 LICENSE 文件，授权和再分发范围尚未声明；请勿据此假定可以再分发。 |
| 数据库 | 默认本地 SQLite：开发时为项目 `data/requirements.sqlite`；便携包默认在 Windows 用户数据目录 `%LOCALAPPDATA%\\Taskflow\\data`。 |
| 数据备份 | 页面可下载 JSON 整库备份。日常迁移或恢复前先备份；详细规则见下文。 |
| 源码结构 | 页面在 `dist/`；本地服务在 `scripts/serve-local.mjs`；API/领域服务在 `server/`；Agent Runner 在 `runner/`；测试在 `tests/`。 |

### 配置说明

开发时可用环境变量调整本地路径。PowerShell 示例：

```powershell
$env:WORKBENCH_DATA_DIR = "$env:TEMP\\taskflow-data"
$env:WORKBENCH_RUNNER_DIR = "$env:TEMP\\taskflow-runner"
npm run taskflow
```

Runner 单独启动时还可设置 `WORKBENCH_RUNNER_API`、`WORKBENCH_REPOSITORY`、`CLAUDE_CLI`、`CODEX_CLI`。模型网关可使用 `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`、`OPENAI_API_KEY` / `OPENAI_MODEL` 或 `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL`。密钥只应保存在本地服务配置中，不要提交到仓库。

### 数据备份与恢复

- 数据库主文件位于 `WORKBENCH_DATA_DIR` 指定目录（默认开发目录为项目 `data/`）；备份前先正常停止服务并复制整个数据目录。
- 页面提供“数据备份与迁移 → 下载 JSON 备份”。v2 整库恢复仅允许导入空数据库；恢复前先备份现有数据库，再使用新的 `WORKBENCH_DATA_DIR` 启动服务，预览并确认导入。
- 旧 v1 JSON 按 ID 合并，不是整库恢复文件，不会清空现有数据。
- 不要同时让两个工作台实例写入同一个 SQLite 文件。

### 桌面版与版本路线图

桌面版测试入口：

```powershell
npm install
npm run desktop
```

重新构建 Windows 安装包使用 `npm run pack:win`。Electron 依赖需要先安装；当前构建尚未代码签名。

路线图按“验证之后再扩展”推进，以下是方向，不代表已实现或承诺发布日期：

| 阶段 | 目标 |
| --- | --- |
| 当前：0.1 本地预览 | 稳定需求→任务→本地 Runner→人工验收；完善备份恢复与 Windows 启动体验。 |
| 后续：团队协作验证 | 在单人流程稳定后，再评估共享状态、账号/权限、多人并发和跨机器 Runner。 |
| 后续：扩展连接 | 根据真实使用反馈增加 Agent/工具连接与自动化；先验证需求，不预设技术方案或上线时间。 |

### 相关文档

- [功能介绍页](./dist/cover.html)
- [单人版验收用例](./docs/单人版-验收用例.md)
- [数据契约与状态机](./docs/V1-单人版-数据契约与状态机.md)
- [任务分配方案](./docs/V2-任务分配.md)
