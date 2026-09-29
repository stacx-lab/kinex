# Kinex standalone 功能对照

审计时间：2026-09-21。旧版为重构前 Kinex commit `1968e57`，新版为本仓库当前源码及实际安装的 Pi 0.86.1。旧证据路径指向历史仓库，新证据路径相对本仓库。第三方 Pi 包不在范围内；用户自己的 Kinex workspace 工具、skills、commands 在范围内。

这是源码功能盘点，不是所有功能的运行验收。最近完整验证为类型检查通过、46/46 项 standalone 测试、16/16 项 core 测试、14/14 项 native adapter 测试；其中 13 项覆盖 context/cache/热加载，14 项覆盖批次拒绝/取消/恢复、纯 coding 并行，以及手动/阈值/overflow 压缩、摘要重试/失败/取消、首次请求状态恢复。此前复现的拒绝 core 操作后兄弟工具仍执行问题已修复并加入回归。v0.6.0 新增宿主无关的 contribution API 和 Pi/OpenCode adapters；core 命令增加取消信号，机器人业务逻辑仍由 core 持有。没有调用真实 provider 或硬件。缓存请求结构验证详见 [CONTEXT_AUDIT.md](CONTEXT_AUDIT.md)，不能当作真实 cache-hit 测量。

状态：**保留** = core/适配层已接入；**Pi** = 新版实际使用的 Pi 功能；**变化** = 能力存在但入口、行为或完整程度不同；**未接入** = Pi 有基础能力但新版未连接；**缺失** = 当前无对应实现。Pi 有底层 API 不代表 Kinex CLI 已暴露该能力。

## 1. 启动与 CLI

| 原功能 | 状态 | 当前实现及差异 |
| --- | --- | --- |
| `kinex` 独立交互终端 | Pi | 使用 InteractiveMode；不需要安装 Pi CLI。 |
| `kinex run <prompt>` | Pi | 使用 runPrintMode。 |
| headless 实时文字、reasoning、工具执行摘要 | 变化 | 默认只打印最后回复；`--json` 提供 SDK 事件流，没有旧版人类可读的实时 renderer。 |
| `--model` | Pi | 接受 `provider/model`；旧 provider ID 不都兼容。 |
| `--effort` | Pi | 保留为 `--thinking` 别名；支持值与校验由新版及 Pi 定义。 |
| `--continue` | 变化 | 恢复新格式会话；无历史时 SDK 可创建新会话，旧版报错。 |
| `--session <id>` | 变化 | 支持新 ID 或文件路径；旧 ID 不迁移。显式文件可切换到记录的 cwd，旧版要求从原目录恢复。 |
| `--seed` | 保留 | 交互启动后提交初始消息。 |
| `--auto` / `--yolo` | 保留 | Kinex 适配层管理；新版 headless 也接受 yolo。 |
| `--enable-recording` / `--record` | 保留 | 模型录制 opt-in；headless 自动开始和结束录制。 |
| `kinex onboard` / `kinex calibrate` | 缺失 | 工作流仍在，可用 `--seed /onboarding` / `--seed /calibrate`；独立子命令未接入。 |
| `kinex auth login/list/logout` | 未接入 | TUI `/login`、`/logout` 可用；无旧 CLI 子命令及 `--provider/--method/--key` 参数。 |
| `kinex models [--refresh]` | 未接入 | TUI `/model` 可用；无旧 CLI 列表/刷新命令。 |
| `kinex export [id] --list/--markdown/--sanitize` | 缺失 | 没有该 CLI；Pi TUI 导出不等价，见下文。 |
| `kinex stats [--json]` | 缺失 | Pi 有当前会话统计，没有接入旧跨会话聚合。 |
| `kinex upgrade [version]` | 缺失 | 源码/npm 构建交付，没有自更新命令。 |
| `--log-level` / `KINEX_LOG_LEVEL` | 变化 | 无统一 CLI 日志选项；复制的 core 自身日志设施仍存在，不能当作整个新 harness 的日志控制。 |
| help/version、错误退出码 | 保留 | 新版 CLI 自行处理；版本为 0.9.0。 |

旧证据：`src/index.ts`、`src/cli/cmd/*`、`src/cli/chat.ts`。新证据：`src/cli.ts`。

## 2. Provider、认证与配置

| 原功能 | 状态 | 当前实现及差异 |
| --- | --- | --- |
| OpenAI API、Anthropic、Moonshot | Pi | 对应 provider 能力由 Pi 提供，未进行真实账号/API 验收。 |
| ChatGPT 订阅 OAuth：浏览器、device-code、刷新 | Pi | 当前 Pi OAuth 实现支持这些流程；入口为 `/login`，没有旧 headless CLI 参数。 |
| API key 环境变量与持久化凭据 | Pi | 使用 Pi ModelRuntime/auth；旧 auth.json 不读取。 |
| provider ID 兼容 | 变化 | `openai` 的订阅连接通常用 `openai-codex`；`moonshot`/`moonshot-cn` 改为 `moonshotai`/`moonshotai-cn`。 |
| endpoint 环境变量兼容 | 缺失 | 未提供旧 `OPENAI_BASE_URL`、`OPENAI_API_BASE`、`MOONSHOT*_BASE_URL` 的适配；应使用 Pi models.json 的 baseUrl。 |
| Moonshot CN 独立 key 变量 | 变化 | Pi 当前两个 Moonshot provider 都映射 `MOONSHOT_API_KEY`；旧 `MOONSHOT_CN_API_KEY` 不直接延续。 |
| 自定义模型、能力、上下文窗口 | Pi | 由 agent/models.json 提供；旧 kinex.json 的 models 字段不迁移。 |
| 默认模型选择及认证优先级 | 变化 | 采用 Pi 规则和 settings.json，不保留旧默认型号/优先级算法。 |
| 模型目录、账号可用性刷新 | 变化 | Pi 有模型目录/可用性设施和 TUI 刷新路径；新版启动不主动请求网络目录，无旧 24h 策略及 models --refresh CLI。 |
| 全局/项目 coding 配置 | Pi | agent/settings.json 和 .kinex/agent/settings.json，替换旧配置格式。 |
| 全局→祖先→最近项目的旧 coding 配置递归合并、JSONC | 缺失 | coding settings 改为 Pi global/project JSON；旧 model/models/compaction/command 字段不应用。 |
| permission/record 的旧 core 配置发现、合并、JSONC | 保留 | core 仍读取 kinex.json/jsonc；不能把 coding 配置变化误认为整个旧配置都失效。 |
| KINEX_CONFIG_DIR、KINEX_DATA_DIR、XDG | 保留 | coding 状态放入新的 agent 子目录；core 原目录规则保留。 |
| 项目 AGENTS.md / CLAUDE.md | 变化 | Pi loader 沿 cwd 向上收集；旧版使用全局文件及最近一个项目文件，发现语义不同。 |
| 全局 AGENTS.md | 变化 | 从旧配置根目录移到配置目录的 agent/AGENTS.md；无兼容加载。 |

旧证据：`src/config/config.ts`、`src/provider/*`、`src/auth/*`、`src/session/instruction.ts`。新证据：`src/settings.ts`、`application.ts`；安装包 `pi-ai/dist/env-api-keys.js`、`auth/oauth/openai-codex.js`，`pi-coding-agent/dist/core/model-runtime.js`。

## 3. Agent loop、上下文与会话

| 原功能 | 状态 | 当前实现及差异 |
| --- | --- | --- |
| 多步工具调用，无固定 step cap | Pi | 使用 Pi agent runtime；不再维护旧 loop。 |
| 文本/reasoning 流、工具调用/结果事件 | Pi | TUI 和 SDK 事件保留。 |
| 运行中用户补充、steering、排队 | Pi | SDK/TUI 提供 steering/follow-up，队列语义不同于旧 runner。 |
| 中断模型、工具、shell 子进程 | 保留 | Pi 管 coding 取消，core 管设备；取消与 OS signal 已有集成验证。 |
| transient retry、退避及 UI 状态 | Pi | 采用 Pi retry 配置与实现；不是旧固定最多五次。 |
| 自动/手动压缩 | Pi | `/compact` 和自动压缩已接入。 |
| 旧压缩阈值公式及 token_limit 配置 | 变化 | 换成 Pi compaction settings，不沿用旧公式/配置字段。 |
| anchored summary 格式及合并旧摘要 | 变化 | Pi 原生摘要/分支格式代替旧模板。 |
| 机器人专用压缩要求 | 保留 | Pi 适配层向本次压缩 signal 对应的摘要请求加入机器人规则，保留 ID、校准值/单位/坐标系、loaded state、待执行动作和未确认结果。Pi 原摘要模板、用户 focus、分段摘要及重试仍保留；普通请求不注入临时规则。 |
| 稳定 system/tool 前缀、变化状态作为历史消息 | 保留 | Kinex snapshot 仅追加变化；Pi 支持的 Responses/Completions/Anthropic 动态工具协议已做本地请求验证。新增工具不一定改变旧前缀；不支持的模型、接口重定义及部分删除路径会回退，不能保证永久命中。真实 cache hit 未测。 |
| 每个模型 step 更新设备/Python/录制/发现错误上下文 | 保留 | before_agent_start 和 turn_end 追加变化状态；通过公开的下一轮准备 hook 同步到运行中的 Pi loop，无需新用户 prompt。 |
| 每个 step 重扫新工具/schema | 保留 | 每批工具完成后刷新新增、修改、删除及发现错误；headless 下一次模型请求可调用新工具。已有工具代码仍由 core 调用时重载。 |
| 给模型的工具发现说明 | 保留 | 已同步说明：完整工具批次结束后、下一次模型请求可见；同批调用之间不保证新增工具可用。 |
| 压缩后的状态补全 | 保留 | session_compact 提交后立即读取、持久化并同步完整 snapshot，首次后续请求可见；已验证手动、任务内阈值及 overflow 自动恢复。恢复失败则中止并阻止后续模型请求，成功刷新后才恢复。 |
| OpenAI 原始响应/推理状态、多 provider 规范化回放 | Pi | 使用 Pi provider-specific 处理；不保留旧 responseState 格式，也未逐 provider 验证完全等价。 |
| 图片不可变回放 | 保留 | 新版将 base64 图片持久化进 Pi transcript，已测试源文件替换及 resume。 |
| 图片内容寻址去重、5 MiB 上限、缺图/超大图固定 omission | 缺失 | Kinex core 附件桥直接 readFile→base64；旧 wrapper 的这些策略未移植。Pi 自身图像处理不能算相同合同。 |
| 会话持久化、恢复、标题 | Pi | 新格式 JSONL，`--continue`、`--session`、`/resume`、`/name`。 |
| 恢复后自动继续未处理的最后 user 消息 | 缺失 | 旧 runner.kick 行为未适配；新恢复不承诺自动执行未完成任务。 |
| `/clear` 同 session 清空上下文、保留全部磁盘历史 | 变化 | `/clear` 未注册；`/new` 创建新会话，不能当作完全相同的 clear boundary。 |
| 旧 session/auth/TUI KV 状态迁移 | 缺失 | 第一阶段明确不迁移；机器人 workspace 仍兼容。 |
| 会话间设备连接/录制归属 | 保留 | 同 cwd 切换聊天保留连接、停止当前录制；换 cwd/退出 dispose。 |

旧证据：`src/session/loop.ts`、`runner.ts`、`compact.ts`、`attachment.ts`、`src/integration/kinex/prompt.ts`、`compaction.txt`。新证据：`src/integration/context.ts`、`tools.ts`、`owner.ts` 及 `src/integration/extension.ts`。

## 4. 工具、权限与交互

| 原功能 | 状态 | 当前实现及差异 |
| --- | --- | --- |
| read：文本分页、图片 | Pi | Pi read；参数/输出/截断策略变化。 |
| write | Pi | Pi write + Kinex permission hook。 |
| edit：精确替换及 diff | Pi | Pi edit + 权限 hook；现接口为 path/edits[]。旧 replaceAll 参数无直接对应，Pi 增加多处编辑。 |
| shell：命令、超时、取消 | Pi | 工具改名 bash；超时单位/输出策略变化，权限名仍为 shell。 |
| glob 文件搜索、grep 内容搜索 | Pi | glob 用 find 替代，另有 ls；不保留旧 schema、排序、截断合同。 |
| todo：持久化完整任务清单 | 缺失 | 新版没有 todo；当前 Pi 内置工具也不提供。 |
| question 单选、自填、多题 | 保留 | Kinex 使用 Pi select/input；按题依次问。 |
| 多选勾选、题间回退、附加说明、最终确认页 | 变化 | 旧专用问卷未移植；multiple 改成自由输入，缺少原 UI 操作。 |
| allow/ask/deny 规则 | 保留 | 继续使用 core permission policy，coding write/edit/bash 也接入。 |
| Allow once / session grant / Deny | 保留 | 会话 grant 不写永久配置。 |
| 审批前 edit/write diff 预览 | 缺失 | 现在是 JSON 参数描述 + select；Pi 工具执行后的 diff 不是审批前预览。 |
| 拒绝权限时输入反馈 | 缺失 | 旧拒绝反馈 UI 未移植。 |
| 审批/问卷取消后终止 run | 保留 | 当前会调用 ctx.abort；已有单工具拒绝和 PTY Escape 测试。 |
| 同一 assistant batch 串行执行，拒绝后后续工具均未开始 | 变化／core 合同已恢复 | core 和 question 标记 sequential，包含它们的整批（含 coding 混合调用）按序执行；拒绝/取消后后续调用不启动，已完成调用不回滚。纯 coding 批次按已确认选择保持 Pi 并行。覆盖设备、校准、Python controller、question、运行中取消及恢复的回归通过。 |
| 连续三次相同调用触发 doom_loop 审批 | 缺失 | 新版未实现，检查的 Pi loop 中无同等 guard。旧版也是一次 permission ask，auto/yolo 会放行，不能将恢复旧 guard 等同于无人值守任务有硬性循环上限。 |
| auto 放行权限、继续采访；yolo 放行且禁采访 | 保留 | 策略与旧版一致；auto/yolo 仍覆盖配置 deny。 |
| headless/yolo 的 autonomous system instructions | 变化 | question 立即返回“无用户答案”，不会等待 stdin；但固定指令仍建议用 question 获取缺失信息，未明确禁止文字采访/等待选择。旧自主推进和 blocker 语义未完整移植，不能把自动权限放行等同于完整自主执行策略。 |
| device_stop 始终允许 | 保留 | core 行为保留，新版另加用户 `/stop`。 |
| calibration、Python controller、record 权限 | 保留 | 由原 core 校验及 host callback 实现。 |

旧证据：`src/tool/*`、`src/permission/index.ts`、`src/session/loop.ts`、`src/session/prompt/autonomous.txt`、`src/tui/routes/session/{permission,question}.tsx`。新证据：`src/integration/{interaction,tools,extension}.ts`；Pi `core/tools/*`、pi-agent-core `agent-loop.js`。

## 5. Core 与机器人集成

v0.5.0 迁移审计确认旧 core 的 104 个 src 文件、81 个 assets 文件和 3 个测试文件保留。v0.6.0 在此基础上增加 integration.ts contribution 合同及测试，commands.ts/runtime.ts 增加命令取消信号；本轮没有重写设备算法或 assets。下列“保留”指源码和接入保留，不代表所有真实设备重新验收过。

| 原功能 | 状态 | 当前实现及差异 |
| --- | --- | --- |
| workspace/device profiles、严格 schema、配置优先级 | 保留 | 同一 core 实现和资源。 |
| 所有已有设备类型、mock、persistent/one-shot drivers | 保留 | 既有 devices/driver API 未重写。 |
| load/unload/reload/ping、loaded 恢复、stop | 保留 | 同一生命周期、owned process、取消和清理。 |
| device 工具经权限加载；Python 不得改生命周期 | 保留 | 同一 core 限制。 |
| 校准存储/plan、待校准状态、严格写入 | 保留 | 工具能力保留，状态栏另见 UI。 |
| frame forest、relative_pose/estimates、FK/IK | 保留 | 全部原核心算法/资源。 |
| 感知、模型调用、locate_object_3d | 保留 | 原 Python 工具及 helpers。 |
| servo_to、track | 替换 | 统一为 move_to / drive / run_policy，共用 kinex.control 循环；时长与频率一律以设备自身时钟表述，agent 不再感知 realtime/stepped。 |
| 懒初始化 .kinex/python、uv 项目、显式解释器 | 保留 | 普通 bash 不激活 core venv。 |
| workspace/global/builtin TS/JS/Python 工具 | 保留 | 不是第三方 Pi 包；每批工具结束后发现新增/变化的 schema，下次模型请求生效。不是文件监听，也不承诺同批兄弟调用立即看到新工具。 |
| core skills 发现和 skill 工具 | 保留 | 原 `.kinex/skill` 及全局/builtin 内容仍可由模型加载；目录变化在批次结束后追加，正文下次 skill 调用时读取。 |
| `/onboarding`、`/register`、`/calibrate` 工作流 | 保留 | 使用原 core 模板，通过 SDK 提交。 |
| 设备裸命令选择器 | 缺失 | `/load`、`/unload`、`/ping`、`/unregister` 不再弹 picker；需要名称。裸 `/reload` 改为 Pi resource reload。 |
| `/load` 后台激活与就绪通知 | 变化 | 新命令 await activation.ready；旧命令先返回、follow 异步通知。 |
| `/unregister` 删除确认 | 保留 | 明确确认后卸载/删除；headless 不自动确认。 |
| 录制 start/snap/stop/status、产品/配额/故障处理 | 保留 | core 功能相同；输出变成结构化 JSON 展示，未保留旧紧凑格式。 |
| 模型录制 opt-in、手动录制始终可用 | 保留 | `--enable-recording` 控制模型工具。 |
| 消息/工具录制关联与 transcript 导出 | 变化 | 已适配 Pi 持久化 message IDs；trace 为简化结构，不是旧完整消息格式。 |
| run --record 自动把任务 prompt 写入 instruction | 缺失 | 新 CLI 只传设备 rates，没有像旧版传任务文本作为 recording instruction。 |
| 退出时录制 finalize 和 driver 关闭 | 保留 | SIGINT/SIGTERM 活跃请求下已有真实子进程测试。 |

## 6. 本地命令、TUI 与键盘

| 原功能 | 状态 | 当前实现及差异 |
| --- | --- | --- |
| `.kinex/command/**/*.md`、配置 command templates | 未接入 | Pi 有 prompt templates，但当前关闭；旧 Kinex 发现规则未桥接。 |
| `$1..$N`、`$ARGUMENTS`、shell 插值 | 未接入 | 原 template engine 没移植。Pi 的普通参数模板可复用，但不保证 shell 插值等价。 |
| skills 自动变成 `/<skill-name>` 命令 | 缺失 | core skill 工具仍在，自动 slash 注册没有。 |
| `/init` 创建/完善 AGENTS.md | 缺失 | 旧模板未接入，Pi 当前内置 slash 列表无此项。 |
| Markdown/代码/工具结果/diff/reasoning 渲染 | Pi | 全部改为 Pi 原生组件，外观不同。 |
| 编辑器、多行输入、输入历史、路径/命令补全 | Pi | Pi 原生能力；Kinex 设备参数补全已接入并有 PTY 测试。 |
| Ctrl+P 命令面板 | 变化 | 未保留旧面板；Pi Ctrl+P 默认循环模型，slash 补全仍有。 |
| Shift+Tab 切换 normal/auto/yolo | 缺失 | Pi 默认切换 thinking；现在通过 `/mode` 切 Kinex 权限模式，normal 命名为 ask。 |
| 双 Escape / Ctrl+C 中断、Ctrl+D 总是退出 | 变化 | 改用 Pi 键位：Escape 中断；Ctrl+C 清输入等；Ctrl+D 在编辑器为空时退出。旧操作肌肉记忆不兼容。 |
| Ctrl+Z 编辑 undo | 变化 | Pi 默认 suspend；编辑 undo 使用 Pi 键位。 |
| 鼠标选区松开自动复制 | 缺失 | 没迁移 Kinex 的 copy-on-release；终端自身选择/复制仍可使用。 |
| light/dark 切换 | Pi | 使用 `/settings` 的主题选项；旧 `/themes`、`/theme` 别名未接入。 |
| 模型、tokens、运行/重试状态 | Pi | Pi footer；增加 Pi 成本/cache 等数据显示。 |
| 设备 loaded 数量、mode、REC 名称 | 保留 | 新 Kinex status 项。 |
| 校准 done/total、needs、next 状态栏 | 缺失 | core 仍能计算，host 不展示。 |
| REC 秒数、MB、录制状态实时栏 | 变化 | 新 footer 只显示 REC 名称；详细数据可通过 `/record status` 读。 |
| 专门的 device/todo/record 工具显示 | 变化 | core 工具走 Pi 通用渲染；旧特定工具 UI 没移植。 |
| KINEX_NO_KITTY、旧 TUI 偏好持久化 | 缺失 | 无兼容适配；改用 Pi 原生终端/设置机制。旧代码的 keybind schema 存在，但启动实际传空配置，不能误算成已发布的自定义配置文件能力。 |

旧证据：`src/command/index.ts`、`src/tui/command/builtin.ts`、`src/tui/app.tsx`、`src/tui/config/keybind.ts`、`src/tui/status/footer.tsx`、`src/integration/kinex/tui/*`。新证据：`src/integration/extension.ts` 及 Pi `core/slash-commands.js`、`core/keybindings.js`。

## 7. 导出、统计、诊断与交付

| 原功能 | 状态 | 当前实现及差异 |
| --- | --- | --- |
| TUI `/export` Markdown | 变化 | Pi `/export` 默认 HTML，可指定 JSONL；没有旧 Markdown formatter。 |
| JSON 完整 trace 导出、按 ID/最新选取、会话列表 | 缺失 | 没有旧 CLI；Pi JSONL 导出/会话选择器只是部分替代。 |
| `--sanitize` 内容脱敏，保留结构 | 缺失 | 录制 trace 的清理不等于通用 export sanitization。 |
| `/copy` 完整会话 | 变化 | Pi `/copy` 只复制最后 agent 消息。 |
| `/rename` | 变化 | Pi `/name`；旧别名没接。 |
| 跨会话消息/tokens/model/tool/error/finish/interrupted/denied 聚合 | 缺失 | 没有 stats；Pi `/session` 是当前会话统计。 |
| cache read/write 数据 | Pi | Pi usage/footer/session stats；不能等同旧聚合语义。 |
| cache 未知≠0、reported-input coverage、跨会话 hit rate | 缺失 | 旧计算与覆盖率报告未移植。 |
| prompt 指纹/变化 section diagnostics | 缺失 | 旧 provider/diagnostics.ts 未迁移；Pi debug 不是同一报告。 |
| cache-audit 离线和可选真实 provider 测量 | 变化 | 已有实际 SDK 请求捕获，覆盖三种协议、五种兼容配置、动态追加/删除/重定义及会话恢复。旧独立审计 CLI、真实 provider hit rate 和跨会话聚合尚未接入。 |
| 自包含 Node release、校验、launcher 原子切换 | 缺失 | 当前独立源码/npm 包；需要用户的 Node >=22.19。 |
| curl installer、自更新、多平台二进制 release CI | 缺失 | 尚无旧 installer/自包含 Node 多平台构建；npm 发布流程见下一行。 |
| GitHub CI / tag 发布流程 | 变化 | 新增 Linux Node 22.19 类型检查、core/standalone/native adapters（含真实宿主、PTY/安装迁移）测试；v* tag 校验版本和内部依赖后生成四个 npm tarball 和 SHA256SUMS 并创建 GitHub Release，不发布 npm registry。工作流本地检查通过，尚未在 GitHub runner 执行。 |
| 独立 npm 打包/资产/移动安装后运行 | 保留 | core、Pi、OpenCode、standalone 四个 tarball 已验证；standalone 不依赖 OpenCode，adapters 不依赖 standalone。 |
| 验证覆盖 | 变化 | 旧 PLAN 记录 371 source tests、Node/PTY/RoboEnv/release 验证；新 46+16+14 测试不能声称等价覆盖。原 test/ 下的领域算法及 RoboEnv 测试尚未迁到新工程，core/package 自带 3 个文件已保留。 |

旧证据：`src/cli/cmd/{export,stats,upgrade}.ts`、`src/session/export.ts`、`src/provider/{usage,diagnostics}.ts`、`script/cache-audit.mjs`、`script/release.mjs`、`install`、`PLAN.md`。

## 8. 旧 slash 命令逐项映射

| 旧入口 | 新入口/状态 |
| --- | --- |
| `/mode` | 保留；normal 改叫 ask。 |
| `/models`，别名 `/model` | `/model`；`/models` 未注册。 |
| `/connect`，别名 `/login` | `/login`；`/connect` 未注册。 |
| `/themes`，别名 `/theme` | `/settings` 选主题；两个旧名未注册。 |
| `/clear`，别名 `/new` | `/new` 是新 session；`/clear` 未注册。 |
| `/compact`，别名 `/summarize` | `/compact`；`/summarize` 未注册。 |
| `/export` | 保留名称，格式/内容合同改变。 |
| `/copy` | 保留名称，改成最后回复。 |
| `/rename` | `/name`。 |
| `/exit`，别名 `/quit` | `/quit`；`/exit` 未注册。 |
| `/onboarding`、`/register`、`/calibrate` | 保留。 |
| `/load`、`/unload`、`/ping`、`/reload`、`/unregister` | 有参操作保留；picker 缺失；裸 reload 改义。 |
| `/record` | 保留子操作；裸命令现在默认 status。 |
| `/init` | 缺失。 |
| 自定义命令、skill 同名命令 | 未接入。 |

## 9. 新增能力

新版额外获得 Pi session tree/fork/clone、会话选择器、thinking 设置、原生 follow-up 队列、JSON 事件流、更多 provider 和更丰富的 TUI 设置。新 Kinex 还提供 `/devices`、`/stop` 及无模型执行的 headless 设备命令。SDK 提供的功能以实际入口为准；RPC CLI 等未接入的模式不算新增。

## 10. 优先级：哪些必须先补

按正确性和任务能否独立完成排序，不按旧版功能数量排序。运行内 context/schema 刷新、热加载说明和下列两个 P0 已完成；P1 建议仍未实施。

### 已修正：热加载说明

`src/integration/instructions.txt` 已说明“完整批次结束后、下一次模型请求可见”，并明确同批调用之间不保证新增工具可用。Pi/OpenCode adapter 各自说明其发现入口。

### 两个 P0：已实现并验证

| 功能 | 实现 | 验证 |
| --- | --- | --- |
| core 工具批次顺序、权限拒绝和取消语义 | 使用 Pi sequential 元数据，让含 core/question 的整批按序执行；纯 coding 保持并行。保留原权限、取消和 disposal。 | 设备/校准/Python controller 拒绝、question 取消、运行中取消不启动后续调用；已完成工作保留；热加载工具也保序；正常继续和重开会话可恢复；纯 coding rendezvous 验证并行。 |
| compaction 保留机器人事实，并在首次后续请求恢复最新状态 | 使用公开压缩事件、stream function 和 SessionManager API；临时摘要规则只作用于压缩请求，提交后立即持久化并同步完整 core snapshot。 | 手动、任务内阈值和 overflow 首次后续请求包含最新状态；用户 focus 保留；摘要重试/失败/取消无规则泄漏或重复 snapshot；状态恢复失败时停止，重新成功刷新后继续。 |

证据：`src/integration/tools.ts`、`src/integration/extension.ts`、`compaction.ts`、`compaction.txt`、`src/application.ts` 和 `test/p0.test.mjs`。这两个完整保证属于 standalone 适配层，其他 harness 仅安装 core 不会自动继承；本轮已为 native Pi/OpenCode 接入各自调度和压缩生命周期，差异见下表。测试验证请求与状态合同，不保证真实模型摘要绝不遗漏，也不代表物理硬件验收。

### P1：紧接着补，按实际使用场景设门槛

| 功能 | 紧迫场景与处理建议 |
| --- | --- |
| headless/yolo 的自主执行指令 | 本项目明确重视无人值守，应在扩大 headless 使用前补齐：不采访或等待用户，依据证据和合理默认值继续；缺少不可替代事实时明确报告 blocker，不虚构答案。现有 question 不阻塞，但仍可能消耗步骤或让最终回复停在问句。 |
| 机器人图片附件的有界读取和缺失降级 | 相机/视觉任务的发布门槛。当前桥接直接 readFile；一个消失的图片就可能把已有文本结果变成工具错误，超大源文件在 Pi 缩图前已经完整读入。先恢复读取上限、稳定 omission 和文本保留；内容寻址去重可以后排。 |
| 循环检测与任务预算 | 长时间无人值守前补。不要简单把三次相同调用视为错误：设备轮询可合法重复，旧 doom_loop 审批在 auto/yolo 也会放行。区分连续失败/无进展重复与正常采样，并明确无人值守达到预算后的结束或 blocker 行为。 |
| 关键 core 领域回归与 RoboEnv smoke | 是验证缺口，不是算法尚未实现。优先迁移校准、坐标系/单位、动作约束、取消与 driver 合同的测试，至少完成 simulator 端到端 smoke 后再声称可替代旧版机器人工作流；不以搬齐 371 个测试为前提。 |

### 可以后排

- todo 持久化有助长任务，但 Pi 已有摘要及会话恢复，缺少 todo 并不等于无法多步执行。先解决上述状态和执行正确性。
- `.kinex/command`、skill slash、设备 picker、状态栏、审批 diff 提升日常效率；现有 tool/命令仍可完成主要操作。
- stats、Markdown/脱敏导出、完整 cache 审计 CLI 按实际观测与分享需求补。缓存请求结构已有回归，不能继续将其列作完全缺失；真实命中率验证是观测工作，不需要先重造 provider。
- `--record` 自动写入任务 instruction 是小而明确的补齐项；如果近期采集训练/评测数据，可与 P1 同批处理，但不阻塞普通 coding/设备操作。
- 旧命令别名、键位、配置/session 迁移、自包含发布和第三方 Pi 包，不作为当前 standalone 正确性修复的前置条件。插件发布另按既定阶段推进。

剩余建议顺序：**无人值守指令和图片稳健性 → 循环控制及领域回归**。每项复用现有 Pi/core 能力；不恢复一套独立 coding harness。

上游参考（实现结论以安装的 0.86.1 为准，main 文档可能继续变化）：
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md

## 11. v0.6.0 native adapter 范围

上文主要对照 standalone；adapter 复用 core，保留宿主原生 coding 功能与身份。

| 能力 | Standalone | Native Pi 0.86.1 | OpenCode 1.18.31 |
| --- | --- | --- | --- |
| feature packages | 显式 compose contributions | 同一合同 | 同一合同 |
| tools/skills | 原生工具，批次结束刷新 | 原生工具，冲突加前缀；`kinex_skill` 加载各来源 skill | 固定 `kinex_tools` / `kinex_call`，调用时读取最新目录 |
| 用户设备命令 | slash 参数与补全 | slash 参数、补全及 `kinex-` 别名 | TUI 原生选择/输入对话框，经本机 IPC 直达 server，不调用模型 |
| 权限 | Kinex ask/auto/yolo 包括 coding | `/kinex-mode` 仅管 Kinex 工具 | core deny + 宿主原生审批，不修改宿主全局策略 |
| 拒绝/取消 | 含机器人工具的整批顺序执行并中止后续调用 | 复用 Pi sequential 合同 | Kinex 调用串行并阻止该轮后续 Kinex 调用；已经运行的宿主 coding 工具不在保证内 |
| 压缩 | 专属摘要规则，提交后立即持久化全量状态 | Pi 默认摘要，首次后续请求补全最新状态 | compact hook 注入领域状态；首次后续请求补全 |
| context/cache | 持久化增量消息；Pi provider 协议 | 会话自定义条目、稳定位置投影 | 固定 gateway schema、消息 ID 锚定投影；ledger 存在机器人 workspace 下 |
| 会话/资源 | 同 cwd 保持连接并结束旧录制，换 cwd 释放 | 同 cwd SDK factory handoff 保持连接；换 cwd/reload/quit 释放 | server 实例持有；会话删除结束其录制，server dispose 关闭全部资源 |
| 录制 | 模型 opt-in，用户命令可直接操作 | `--kinex-recording` opt-in | server `enableRecording` opt-in；录制期间拒绝其他会话的非紧急 Kinex 操作 |
| 自定义工具内采访 | Kinex 问答 UI | Pi 问答 UI | 首版拒绝；先使用宿主 question 获取信息 |

额外限制：OpenCode context ledger 不随宿主 export/fork 转移；远程 attach 的直接命令和 Windows IPC 未支持。macOS 为目标平台但尚未实际验证。真实 Pi SDK/OpenCode server + TUI、同任务热加载、请求前缀、压缩、取消和录制归属已有回归；没有物理硬件或真实 cache-hit 验收。`@kinex/real-world` 和 Codex/MCP 尚未实现，第二 feature 的组合测试用于验证合同。
