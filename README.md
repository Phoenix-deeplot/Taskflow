# 出海产品需求工作台

一个用于整理需求、做版本取舍、分配 AI 任务并回收结果的轻量工作台。当前是本地调试原型，页面无需安装第三方依赖。

## 本地运行

### 环境

- Node.js 22.13 或更新版本（使用内置 `node:sqlite`，无需额外安装数据库依赖）
- Windows、macOS、Linux 均可

### 启动

在项目目录执行：

```powershell
npm run dev
```

或不使用 npm：

```powershell
node scripts/serve-local.mjs
```

浏览器打开终端显示的地址，默认是 <http://127.0.0.1:4179>。停止服务按 `Ctrl+C`。如端口被占用，可换一个端口：

```powershell
node scripts/serve-local.mjs --port 4180
```

不需要先运行 `npm install`。修改 `dist/index.html` 或 `dist/enhancements.js` 后刷新浏览器即可。

首次启动会在项目目录创建 `data/requirements.sqlite`，按需求、任务、快照、Run、事件等多张表保存。这是本地单人工作区数据库，不会上传到云端；整个 `data/` 目录已加入 Git 忽略规则。浏览器已有的旧数据会在数据库为空时做可追溯迁移。若数据库与浏览器缓存不同，会先把两边状态写入备份键，再提示或按更新时间请你选择，不静默覆盖。

可用 `GET /api/health` 检查本地服务状态。要把数据库放到其他目录，可通过环境变量 `WORKBENCH_DATA_DIR` 指定。

### 数据库备份与恢复

- 主数据库：`data/requirements.sqlite`；自动迁移/恢复前生成的数据库副本放在 `data/backups/`。备份整个 `data/` 目录即可保留主库和自动副本。
- 日常可在页面点“数据备份与迁移 → 下载 JSON 备份”。正常连接数据库时下载的是包含多表数据的 v2 整库导出；数据库离线时才会退回下载浏览器缓存 v1。
- v2 整库恢复只允许写入空数据库。导入 v2 文件时页面先预览；已有数据会被拒绝，不会覆盖。需要恢复时，先备份当前库，再用新的数据目录启动：

  ```powershell
  $env:WORKBENCH_DATA_DIR = "E:\\Ztree\\chuhaila-restore-test"
  npm run dev
  ```

  打开新地址后，通过“数据备份与迁移 → 导入 JSON”选择 v2 文件并确认。确认恢复内容正确后，可退出服务，把主目录切换到新目录；旧目录保留作回滚备份。
- v1 旧格式文件仍按 ID 合并导入，不会清空现有数据。v1 不是整库恢复文件。
- 若页面看起来像“数据丢了”，先检查浏览器地址的主机名和端口：`localhost` 与 `127.0.0.1`、不同端口对应不同的浏览器 `localStorage`。数据库则取决于服务启动时的 `WORKBENCH_DATA_DIR`；确认页面连接的是预期服务，并检查启动日志显示的 SQLite 路径，不要先清理旧目录。

### 本地 Agent Runner

本地服务使用启动目录作为默认项目仓库；执行看板可改成另一个 Git 仓库目录。Runner 必须在服务之外的另一个终端启动。页面支持 Claude Code、Codex 和你自己添加的命令行 Agent。Claude Code 与 Codex 默认使用本机各自的登录状态；命令行里的 `claude` 要单独登录（Claude 桌面应用的登录不通用），在页面侧栏“设置（Agent 与密钥）”里点“登录 Claude Code”，或粘贴订阅令牌（`claude setup-token` 生成）/ API Key。设置页还能添加自定义 Agent、保存“拆分需求”用的模型接口 Key。这些密钥只保存在本地服务的 `data/agent-secrets.json`（不在数据库里，不进导出和备份，页面读不回来，Windows 上仅当前用户可读），只在启动对应 Agent 时交给那一个进程。

```powershell
# 终端 1：启动服务
npm run dev

# 终端 2：启动 Runner（默认自动按任务执行器选择 Claude Code 或 Codex）
npm run runner
```

先确认页面中的 Agent 状态显示“可用”，再在“分配 AI”中选择“分配并执行”，或在执行看板选择多项后点击“执行所选 / 执行全部待执行”。可用性检查通过 `claude --version`、`codex --version` 和 Windows Codex 商店包检查完成。普通 Codex CLI 优先；若命令不在 PATH，Windows Runner 会动态查找 Codex 商店包并通过 Appx 身份启动。商店版的进度和结果使用 Runner 目录中的日志及完成标记文件。

每项执行都在独立分支和 Git worktree 中运行，起点是项目目录当前 `HEAD`（不会复制原工作目录里的未提交更改）。分支名取自服务分配的 `wb/<任务号>-a<第几次>`，不合法或被占用时回退为 `workbench/<Run-ID>-<随机>`。执行类任务结束后，改动会在该分支上提交（`workbench: <需求标题>`）并作为 `branch` 产物上报，随后删除 worktree；你在项目目录里用 `git diff main..<分支>` 查看、`git merge <分支>` 合入，Runner 永远不动你的主分支和工作目录。分析任务不改文件，不留分支。Codex 使用 `codex exec --sandbox workspace-write`（分析为 `read-only`），不带任何“全部放行”参数；Claude Code 执行用 `acceptEdits`、分析用 `plan` 模式，不启用跳过权限。Runner 续租、上报进度/日志、结果、diff 和产物；运行详情自动刷新状态、时间线、心跳、错误、日志尾部和各次尝试。服务会回收超出租约的 Run 并将任务放回队列。

便携路径、临时目录和调试选项：

```powershell
$env:WORKBENCH_RUNNER_API = "http://127.0.0.1:4179"
$env:WORKBENCH_RUNNER_DIR = "E:\\path\\to\\runner-data"
$env:WORKBENCH_REPOSITORY = "E:\\path\\to\\git-repository" # 可选；设置后覆盖页面的项目目录
$env:CLAUDE_CLI = "claude" # 可选：覆盖可执行文件名/路径
$env:CODEX_CLI = "codex"   # 可选：覆盖可执行文件名/路径
npm run runner

# 仅用于协议联调，不调用模型
$env:WORKBENCH_RUNNER_ADAPTER = "fake"
npm run runner
```

### AI 拆分提供方

AI 拆分网关在本地服务端调用 Claude、OpenAI 或 DeepSeek；每家都需要配置对应的模型名和 API Key 环境变量。没有配置时可继续使用手动拆分或测试用假提供方。不要把密钥放到页面、JSON、需求上下文或 Git 中。

```powershell
$env:ANTHROPIC_API_KEY = "..."
$env:ANTHROPIC_MODEL = "你的 Claude 模型 ID"
$env:OPENAI_API_KEY = "..."
$env:OPENAI_MODEL = "你的 OpenAI 模型 ID"
$env:DEEPSEEK_API_KEY = "..."
$env:DEEPSEEK_MODEL = "你的 DeepSeek 模型 ID"
```

配置后重启服务，可由本地 API 生成待审阅草稿；草稿确认前不会创建正式任务。模型名不内置默认值，以便按账号权限和可用模型自行指定。

## 当前原型

- 需求清单：新增、编辑、搜索、按模块/版本筛选、批量决策；每行有“删除”，工具栏有“删除所选”（删除会隐藏名下任务并终止其中正在执行的 Agent，变更记录保留）。
- 决策状态：待讨论、保留、修改后保留、延后、不做（“不做”只是一种决策，不会删除需求）。
- 终止：执行中的任务在看板、AI 协作任务和运行详情里都有“终止”，Agent 进程会被整个停掉，这次运行的改动、worktree 和分支一并丢弃，任务回到待执行。
- 导入草稿：粘贴 Prompt/文本，或选择 JSON、TXT、Markdown、DOCX；先预览候选需求，再确认导入。简单编号列表和标题可自动拆成草稿，不会自动调用 AI。
- AI 协作：为需求选择“只分配 / 分配并分析 / 分配并执行”；分析模板可以编辑。可将待执行任务交给本地 Claude Code 或 Codex。
- 执行看板：任务按待澄清、待执行、执行中、待验收、已完成、阻塞分栏；可多选、批量派发或执行全部待执行任务。依赖未满足的任务会被跳过并说明原因。
- Run 详情：显示阶段、进度、最后心跳、错误、日志尾部、事件时间线、diff/日志产物及历史尝试。
- 状态保存：SQLite 关系表为主存储、localStorage 为浏览器缓存；保存失败时提示并回退到缓存，下次启动会比较更新时间并让你选择较新的缓存是否恢复。
- 任务启动：冻结全局需求摘要、关联需求和任务说明为版本化上下文快照，同时追加运行记录；Runner 在独立 worktree 中调用真实本地 Agent。
- 变更历史：本浏览器内记录需求和任务的变更。
- JSON：整库导出和按 ID 合并导入；可以载入 15 条工具模块样例。

## 数据与密钥

当前主数据保存在项目目录 `data/requirements.sqlite`，只供本机服务使用。浏览器 `localStorage` 保留为缓存及冲突备份。清理项目目录、换电脑或重装前先下载 JSON 备份。状态机、Run、快照、验收和事件由服务端领域层处理；本地 Runner 可通过各自登录态调用 Claude Code / Codex。尚无共享数据库和账号系统。

不要在浏览器页面、`localStorage`、需求导出 JSON 或 Git 文件中放模型 API Key。后续如需工作台直接调用模型，应增加服务端 API，由服务端从环境变量/密钥管理中读取 Key；外部 Agent 自带模型凭证时，工作台只需发放短时任务访问凭证，不需要获得 Agent 的模型 Key。

## V1 待实现范围

| 功能 | 验收要点 | 当前状态 |
| --- | --- | --- |
| 粘贴 Prompt、文档、JSON 导入 | 先解析为待确认草稿；用户确认后才写入；重复 ID 跳过 | 已有本地原型；解析需人工核对 |
| 执行看板 | 按状态分栏；显示负责人、需求和任务说明 | 已有本地原型；依赖和文件占用待补 |
| 状态流转 | 只允许有效状态转换；阻塞必须有原因；完成需人工确认；记录事件时间 | 本地 API 服务端校验；还没有用户/Agent 权限认证 |
| Agent 对接 | 定义任务读取、领取/认领、心跳/续租、成果提交和失败回报接口；先支持一个执行器 | 本地 Runner 与执行生命周期已实现；商店版 Codex 需在目标 Windows 桌面验收 |
| AI 澄清与拆分 | 服务端调用模型并产出任务草稿；人确认后生成正式任务；记录模型和用量 | 已有服务端 Provider Gateway；仍需配置服务端 Key |
| 共享状态 | 多人和 Agent 读写同一份任务、决策、依赖及成果 | 待实现；当前仅本机 SQLite 单用户 |

## 建议的状态机

```text
待澄清 → 待执行 → 执行中 → 待验收 → 已完成
                 ↘ 阻塞 ↗
待验收 → 待执行（验收不通过，需附修改意见）
```

每个任务还应记录负责人/执行器、输入上下文快照、依赖、涉及文件、验收标准、产出链接和变更事件。Agent 可更新进度、报告阻塞并提交成果；“已完成/已验收”由负责人确认。

## 目录

- `dist/index.html`：当前单页应用。
- `scripts/serve-local.mjs`：本地静态服务和 API 启动入口。
- `server/`：多表 SQLite、领域服务、状态机、兼容旧页面的状态适配和 HTTP API。
- `data/requirements.sqlite`：首次运行时创建的本地数据库（Git 忽略）。
- `tests/`：领域、迁移策略、本地 HTTP API 和生命周期测试。
- `README.md`：本地运行说明与 V1 验收清单。
