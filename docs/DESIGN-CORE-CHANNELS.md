# 设计：核心与渠道拆分、存储接口与数据库解耦

> 状态：设计稿，尚未实现；§0.1 的决策已于 2026-10-22 分两轮与用户确认。对照代码：`main` @ `d53151b`。本文只写设计，不含代码改动；用户确认之前不进入开发。
> 行号均指该提交；后续代码变化后以函数名为准。

## 0. 结论摘要

### 0.1 已定决策（2026-10-22）

| # | 决策 | 说明 | 详见 |
| --- | --- | --- | --- |
| D1 | **本地数据库用 SQLite** | 性能优先：SQLite 在进程内直接调用 C 库，比 PGlite（PostgreSQL 编译成 WASM、单连接）更快、启动更快、内存更少，也更成熟。兼容由仓储接口 + Kysely + 契约测试保证，以后服务器版换 PostgreSQL 或 MySQL 只是新增一个实现。PGlite 不采用 | §5.7、§5.8 |
| D2 | **驱动优先 `better-sqlite3`，退路 `node:sqlite`** | `better-sqlite3` 最常用、最快，但是原生模块，需先确认 DSH 能加载；不行则用 Node 自带的 `node:sqlite`（不用打包，但仍标为实验性）。驱动在公共基础包里统一选定（D8） | §5.7、§5.8 |
| D3 | **Web 版暂缓，后续再考虑** | §6 与 Web 阶段全部暂缓。只保留每张表的 `user_id` 列（本地固定为 `'local'`，几乎没有成本），以后做 Web 版不用改表 | §6、§7 |
| D4 | **不兼容旧 JSON 数据**（第二轮修订） | 去掉 `workbench-v1.json` 的全部逻辑：不导入、不导出、不冻结，也不写过渡用的 JSON 实现，仓储接口直接配 SQLite。新版本首次启动为空库，旧数据由用户清理 | §5.9、§7 |
| D5 | **每个渠道一个小插件，邮件例外、内置** | 微信、以后的飞书/企微各是一个渠道插件，挂到工作台核心上，装上即多一个来源，卸载不影响核心。邮件内置在工作台里（主产品；发送、审核、自动发送与核心联系最紧；刚把 dsh-email 合进来，不再拆出），代码上同样按渠道接口实现 | §3、§4 |
| D6 | **渠道数据存在工作台的数据库里** | 按渠道区分，渠道插件不自建数据库；卸载渠道插件不丢数据 | §3、§5.5 |
| D7 | **拆插件前先在真实 DSH 验证跨插件挂接** | 后端 `ctx.provide` / `inject` 与前端由另一插件扩展界面都要先用最小示例验证；前端扩展不了时，微信界面暂留工作台前端、装了微信插件才显示 | §4.6、§7 |
| D8 | **每个插件各用一个 SQLite 库文件，共用一个公共基础包** | SQLite 同一文件同一时刻只有一个写入者，分开后互不阻塞；各插件独立升级、卸载、备份，出问题不连坐；插件间用服务接口取数据（如 `ctx.workbenchMail`），不直接读别人的表。基础包（暂称 `zq-sqlite`）统一负责打开数据库、WAL、等锁超时、迁移、备份、Windows 占用重试与驱动选择 | §5.10 |
| D9 | **微信插件放独立仓库** | `bkms-workbench-wechat` 单独建仓库；工作台导出渠道接口类型（`bkms-workbench/channel`），微信仓库依赖并固定版本 | §3、§4.1 |
| D10 | **版本不匹配只提示升级，不做兼容** | 渠道注册时只比较 `CHANNEL_API_VERSION` 是否相等；不相等即拒绝加载，并在设置页提示升级落后的一方（微信插件或工作台） | §3、§4.1 |
| D11 | **从 SQLite 版本开始，升级靠迁移脚本保留数据，不支持降级** | 表结构变化一律写迁移脚本；旧版本插件遇到更新的数据库只提示升级。实施时 `CLAUDE.md` 的“数据兼容”约定改为这条规则 | §5.9 |

### 0.2 要点

1. **先在单插件内抽出“渠道接口”（Channel），邮件、微信都实现为渠道**。核心（入库、队列、分拣、方案匹配、Agent 准备、审核、自动发送、简报/主题）只认渠道接口。工作台本身（含内置邮件渠道）就是一个完整的产品；之后微信再拆成独立 DSH 插件 `bkms-workbench-wechat`，以可选渠道挂上来。
2. **只拆微信不够**：邮件逻辑同样深嵌在核心里（草稿、自动发送、IMAP 读原件、Message-ID 关联、活动记录里写死的 `source: 'email'`）。邮件也要退到渠道接口后面，核心才真正与渠道无关，第三个渠道（飞书、企微）也才能接上。
3. **存储换成按业务操作的仓储接口，直接配 SQLite**：把 65 处 `store.read()` / `store.mutate(doc => …)` 整文档读写换成仓储接口（13 组、约 55 个方法，清单见 §5.3，逐调用点对照见附录 A），实现直接是 SQLite（D4，不写过渡用的 JSON 实现）。乐观锁沿用现有 `revision`。
4. **查询层用 Kysely**：一套 TypeScript 查询，现在编译到 SQLite，以后同一套代码可编译到 PostgreSQL 或 MySQL；方言差异集中在少数几处（§5.7）。**全文搜索单独一个接口**，推荐“应用层中文二元切分 + 数据库内置全文索引”，不依赖扩展，换数据库后结果一致（§5.6）。
5. **“仓储契约测试”**：现在跑 SQLite，以后的服务器数据库实现跑同一套——这是解决“本地与服务器逻辑不兼容”担心的根本办法。
6. **旧数据不迁移**：新版本不读旧的 `workbench-v1.json`，首次启动为空库；从 SQLite 版本开始，升级靠迁移脚本保留数据（D4、D11，§5.9）。
7. **多插件共用 SQLite 的方式**：各插件各自一个库文件，基础设施放公共基础包（D8，§5.10）。
8. **Web 版（暂缓）**：已记录多用户隔离、授权码加密、轮询单实例、AI 脱离 DSH 的初步方案，供以后参考（§6）。

## 1. 背景与目标

### 1.1 现状数据点

| 项目 | 现状 | 位置 |
| --- | --- | --- |
| 存储 | 单文件 `<数据目录>/bkms-workbench/workbench-v1.json`。`Store.read()`：整读 + `JSON.parse` + `validateState` 全量校验；`Store.mutate(fn)`：文件锁 → 整读 → 同步修改 → 全量校验 → 整体序列化 → fsync → rename | `src/store.ts:69-108` |
| 规模 | 用户数据 1.4 MB / 98 个任务，约 14 KB/任务（正文、`bodyHtml` ≤256 KiB、`history` ≤100 条、微信消息 ≤100 条）。上限 5000 任务 / 100 方案 / 64 MiB；按 14 KB/任务估算，约 4600 个任务就会先撞上 64 MiB | `src/store.ts:12,97,100` |
| 读频率 | 工作台页面每 8 秒 `snapshot`；DSH 任意页面每 8 秒 `preferences`（同样整读）；后台每轮 `tick` 整读一次，轮间隔约 5 秒 | `client/index.tsx:35,130`；`src/engine.ts:97,103` |
| 写频率 | 后台开启时，`processNext` 每轮都用 `store.mutate` 找下一个排队任务；没有任务也会 `revision+1` 并整文件重写。按代码推断约每 5 秒重写一次 1.4 MB（可在用户环境观察文件修改时间确认） | `src/engine.ts:407`、`src/store.ts:94-105` |
| 页面数据量 | `snapshot` 返回全部任务，仅去掉 `workspace`、`rule`，正文、`bodyHtml`、历史、微信消息都在内，每 8 秒一次 | `src/api.ts:76-91` |
| 邮件正文 | 分拣/准备时读入任务（`body`、`bodyHtml` 等副本），原件按需走 IMAP | `src/engine.ts:122-128,205-211` |
| 微信 | 每次轮询由 Python 桥从微信加密库解密读取；水位与未成段消息存在 `State.wechat` | `src/wechat.ts`、`wechat/bridge.py` |
| 账号与草稿 | 邮件模块自有文件：`mail/accounts.json`（0600）、`mail/drafts/drafts-v1.json`，不在工作台文档内 | `src/mail/service.ts:82-83` |
| 全文搜索 | 没有。主题匹配是内存子串包含；对其他插件的 `workbenchMail.search` 走 IMAP SEARCH | `src/digest.ts:56-61` |

### 1.2 目标

- **G1 邮件版独立成立**：只装工作台（内置邮件渠道）即可完整运行。以后可能做 Web 服务，目前暂缓（D3）。
- **G2 微信是可选渠道插件**：装上即多一个来源，卸载后核心不受影响，已有微信任务仍可查看。
- **G3 存储与数据库解耦**：业务代码只依赖仓储接口；本地用 SQLite，以后服务器版（PostgreSQL 或 MySQL）共用同一套查询和契约测试。
- **G4 升级不丢数据**：不兼容旧 `workbench-v1.json`（D4）；从 SQLite 版本开始，升级经迁移脚本保留数据（D11）。
- **G5 安全边界不变**：没有人工确认不发送；微信只读；来源内容是数据不是指令；密码不进工作台数据、不返回页面。

### 1.3 非目标

- 不改变现有界面交互和任务状态集合。
- 本期不做 Web 版（D3）；将来做时也不接微信（微信读取依赖本机微信客户端）。
- 不设计计费、团队权限等 SaaS 功能（共享邮箱问题随 Web 版暂缓，见 §8）。

## 2. 现状耦合盘点

### 2.1 数量

按 `grep -Ei 'wechat|微信'` 统计含微信内容的**行数**：

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `src/engine.ts` | 74 | 轮询、建任务、准备、分拣与队列里的分支，健康状态 |
| `src/wechat.ts` | 35 | 已相对独立（见 §2.4） |
| `src/types.ts` | 31 | 微信类型、`Task.wechat`、`Settings.wechat`、`State.wechat` |
| `src/api.ts` | 27 | `wechat*` 动作、只读拦截、`saveReply` / `markHandled`、快照 |
| `src/digest.ts` | 6 | 偏好键、学习例子、会话关联 |
| `src/store.ts` | 5 | 校验与 `validateWechatSettings` |
| `src/index.ts` | 5 | 构造 `WechatConnector` 并注入引擎 |
| `src/agent.ts` | 3 | 微信写作规范、Agent 输入 |
| `src/rules.ts` | 3 | 方案按来源匹配 |
| `src/sources.ts` | 3 | 连接状态 |
| `src/triage.ts` | 1 | 分拣提示补充 |
| `client/wechat.tsx` | 42 | 整个文件都是微信界面 |
| `client/workspace.tsx` | 21 | 任务详情里的建议回复、聊天记录 |
| `client/lib.ts` | 16 | 类型、`sourceOf` / `taskTitle` / `counterpart` |
| `client/views.tsx` | 6 | “按会话”查看切换 |
| `client/settings.tsx` | 6 | 微信设置卡片 |
| `client/plans.tsx` | 2 | 方案来源可选性 |
| `client/store.ts` | 2 | 设置类型 |

按 `kind === 'wechat'` 的分支：`src/api.ts` 5、`src/digest.ts` 4、`src/engine.ts` 4（另有局部变量 `wechat` 在 347、352、388 行参与分支）、`src/agent.ts` 2、`src/rules.ts` 1、`client/lib.ts` 3、`client/plans.tsx` 1、`client/workspace.tsx` 1。

### 2.2 后端逐处

**`src/types.ts`**
- `SourceKind` / `SOURCE_KINDS`（6-7）：声明了 email、feishu、wecom、wechat、meeting。
- `Source`（37-38）：微信段落复用邮件坐标：`account = 'wechat'`、`folder = 会话 id`、`uid = 段落最后一条 seq`、`uidValidity = 1`、`kind = 'wechat'`，目的是让旧版本还能读数据。`Cursor`（36）就是 IMAP 的 `{uidValidity, lastUid}`。
- 微信类型 `WechatMessage` … `WechatService`（39-77）。
- `Task.wechat`（102）、`Settings.wechat`（134）、`State.wechat`（145）、`TriageInput.mail.channel`（171）。

**`src/engine.ts`**
- 导入（12-13）；构造参数 `wechat`（77）；内存缓存字段 `wechatPolling` / `wechatInfo` / `wechatChatList` / `wechatError` / `wechatSeen` / `wechatSweepAt`（60-66）；`health()` / `wechatHealth()`（79-84）；`tick` 里的微信轮询（106）；`stop` 等待 `wechatPolling`（115）。
- `wechatService` / `wechatStatus` / `wechatChats` / `wechatChanged` / `wechatEligible`（213-244）。
- `pollWechat`（246-303）：会话筛选、建基线、按最后消息时间增量读取、拼段落、到期成段后建任务。
- `createWechatTask`（304-323）：与邮件 `poll` 里的建任务逻辑（177-187）几乎重复。
- `prepareWechat`（325-343）：与邮件准备结果写入（448-464）几乎重复。
- `runTriage` 分支（346-354）：微信不读原件、不拆引用；不静默归档（388 `!wechat`）。
- `processNext`：取任务条件 `t.source.kind === 'wechat' || emailReady`（409），准备阶段分派到 `prepareWechat`（418）。

**`src/api.ts`**
- 导入（8-9）；`snapshot` 的 `sources` 与顶层 `wechat` 块（99-100）。
- `saveSettings` 的 `wechat` 键白名单与校验（190、192），保存后 `wechatChanged()`（205）。
- `testRule`（220）、`trialRule`（258）按来源匹配。
- `wechatStatus` / `wechatChats` / `wechatSearch` / `wechatHistory` / `clearWechatCache`（283-304）。
- 只读拦截：微信任务拒绝 `loadMail` / `saveDraft` / `previewSend` / `send` / `resolveSend`（314）。
- `saveReply`（315-324）、`markHandled`（325-328）、`rejectRule` 清除建议回复（386）。

**其他后端**
- `src/rules.ts`：`matches` 按 `kind` 分支（50-51），`ruleSources` 默认 `['email']`（46），`validateRule` 校验 `sources`（34-38）。
- `src/digest.ts`：`exampleText`（18-21）、`senderKey`（22）、`relations` 同会话关联（37-40）并跳过微信的同主题推测（43）。
- `src/agent.ts`：`IM_WRITING_GUIDELINES`（25），系统提示按来源选写作规范（209），Agent 输入 `conversation` / `mail` 二选一（218）。
- `src/triage.ts`：微信时追加提示（71）。
- `src/store.ts`：`validateState` 中设置、状态、任务三处（42、48、49），`validateWechatSettings`（51-66，api 也用）。
- `src/sources.ts`：`sourceStatuses` 的参数写死了微信（19-27）。`SourceAdapter`（9-15）已定义，但没有任何实现或调用。
- `src/index.ts`：构造 `WechatConnector` 并注入引擎（11、30-32），卸载时关闭（43）。

### 2.3 前端逐处

- `client/lib.ts`：`SourceKind`（6）、微信类型（14-17）、`Task.source.kind` / `Task.wechat`（29-31）、`Snapshot.health.wechat` / `Snapshot.wechat`（51-52）、来源名称（86）、`sourceOf` / `taskTitle` / `counterpart`（110-115）。
- `client/workspace.tsx`：导入 `ChatHistory` / `SegmentConversation`（8）；建议回复状态（59-61、74）；`saveReply` / `copyReply` / `markHandled`（102-104）；快捷键（118）；标题区 @我、群聊/私聊（134-138）；建议回复区（219-224）；对话段落（226）；操作按钮（292-295）；原文页签换成聊天记录（331-336）；相关往来“同一聊天”（364）。
- `client/views.tsx`：导入 `ChatsView`（7）；全部事项里“按会话”切换（205-210）。
- `client/settings.tsx`：`WechatSettingsCard`（8、59）；后台开关在只有微信时也可开（45-46）。
- `client/plans.tsx`：方案来源里微信是否可选（153-155）。
- `client/store.ts`：设置类型含 `wechat`（2、6）。
- `client/wechat.tsx`（219 行）：`WechatSettingsCard`、`ChatsView`、`ChatHistory`、`SegmentConversation`、`Bubbles`，以及前端版 `chatAllowed`。

### 2.4 已相对独立的部分

- `src/wechat.ts`（185 行）：会话分类、设置默认值、名单判断、段落拼接/到期/判定、转写文本、Python 桥进程管理（`WechatBridge`）与连接器（`WechatConnector`）。只依赖 `types.ts` 里的微信类型，可整体迁出。
- `wechat/`：Python 桥（JSON 行协议：`status` / `chats` / `search` / `latest` / `poll` / `history`）与移植的 `wxread/`。
- `src/mail/`：`MailService` 提供给引擎的 `EmailService`、给其他插件的只读 `external()`（`ctx.workbenchMail`）、草稿路由。移植代码，按 `NOTICE.md` 约定尽量不改。

### 2.5 嵌在核心里的邮件逻辑（容易被忽略）

- **任务类型里的邮件字段**（`types.ts:92-98`）：`account`、`from`、`subject`、`body`、`bodyHtml`、`to`、`cc`、`mailDate`、`mailSize`、`messageId`、`references`、`replyTo`、`attachments`、`mailLoaded`、`hasAttachments`、`draftId`、`draft`。
- **来源坐标即 IMAP 坐标**，并被校验强制：`source.uid ≥ 1`、`source.account === task.account`（`store.ts:19`）。
- **方案的范围条件** `Rule.account` / `Rule.folder`（`types.ts:14`）只对邮件有意义。
- **引擎**：`readOriginal`（122-128）、`attachment`（129-149）、`poll`（152-204）、`loadForProcessing`（205-211）、准备阶段创建草稿（419-445）、`autoSendDecision`（29-41，按“单一邮箱地址”判定）、`sendDue`（479-537）；活动记录 `source: 'email'` 写死（391、454、461、489、520）。
- **API**：快照里逐任务对账草稿状态（67-91）；`mailSettings`、`*MailAccount`、`folders`、`generateRule`（要求已配置邮箱，177-179）、`resetBaseline`、`loadMail`、`saveDraft`、`previewSend`、`send`、`resolveSend`；`/attachment` 路由（498-504）；撤回自动发送以 `replyTo` 作联系人键（468-469）。
- **简报与关联**：`relations` 用 Message-ID / References 与“同发件人同主题”（`digest.ts:26-52`）；`topicMatches` 按邮箱地址（56-61）。
- **AI 提示**：`EMAIL_WRITING_GUIDELINES`（`agent.ts:14-15`）、系统提示里 `mail.body` / `mail.quotedHistory` 的说明（209）、`mailInput`（9-13）；分拣提示以邮件为主（`triage.ts:63-71`），`heuristicTriage` 按邮件特征（30-45）。

### 2.6 归类

| 类别 | 现状位置 | 对应渠道接口（§4） |
| --- | --- | --- |
| 采集与游标 | `poll`、`pollWechat`、`State.cursors`、`State.wechat` | `poll()`、游标、渠道状态 |
| 内容装载 | `readOriginal`、`loadForProcessing`；微信 `body = transcript` | `load()` |
| 转成 AI 输入 | `runTriage` 拼装 `mail`；Agent 输入 `mail` / `conversation`；分拣提示补充；写作规范 | `ai.*` |
| 回复与发送 | 草稿、自动发送、`sendDue`、只读拦截、`saveReply` / `markHandled` | `capabilities`、`reply` |
| 关联与偏好 | `relations`、`senderKey`、`exampleText`、`topicMatches` | `relations.*` |
| 设置 | `validateWechatSettings`、`saveSettings` 白名单、`snapshot.wechat` | `settings.*` |
| 界面 | §2.3 | 前端扩展点（§4.6） |

## 3. 目标结构

```text
┌──────────────────────────────── 核心（与渠道无关） ────────────────────────────────┐
│ 入库去重 → 队列/重试 → 分拣 → 方案匹配 → Agent 准备 → 审核（发送/复制/标记）         │
│ → 自动发送（撤回窗口）→ 简报 / 周报 / 主题 → 活动记录                                │
└──────────────▲──────────────────────────┬───────────────────────────┬─────────────┘
               │ Channel 接口              │ Repository 接口            │ AI 端口
   ┌───────────┴────────────────┐ ┌────────┴──────────────────┐ ┌─────────┴────────────────┐
   │ email（内置在工作台）        │ │ SQLite（本地，D1）          │ │ DSH 实现（现有）          │
   │ wechat（渠道插件，可选）     │ │ PostgreSQL/MySQL（以后）    │ │ 直连模型 API（Web，暂缓）  │
   │ feishu / wecom（渠道插件，以后）│ │                           │ │                          │
   └────────────────────────────┘ └───────────────────────────┘ └──────────────────────────┘
```

**插件与仓库划分（D5、D6、D8、D9）**

| 插件 / 包 | 仓库 | 内容 | 依赖 |
| --- | --- | --- | --- |
| `bkms-workbench`（工作台） | 现仓库 | 核心、存储、AI 端口、**内置邮件渠道**（`src/mail/` 不拆出）；数据库 `<数据目录>/bkms-workbench/workbench.sqlite` | `zq-sqlite`；无渠道插件依赖，只装它就是完整的邮件工作台 |
| `bkms-workbench-wechat` | **独立仓库**（D9） | 微信渠道：`src/wechat.ts`、`wechat/` Python 桥与 `wxread/`、`client/wechat.tsx`、自己的中英文字典 | 运行时依赖工作台提供的 `workbenchChannels`；开发时依赖工作台导出的渠道接口类型 `bkms-workbench/channel`（固定版本）；工作台不依赖它 |
| 以后的 `bkms-workbench-feishu` 等 | 各自仓库 | 各自的渠道实现 | 同上 |
| `zq-sqlite`（公共基础包，暂名） | 待定（独立仓库或 `zq-plugins` 下） | 打开数据库、驱动、WAL、迁移、备份、Windows 占用重试（§5.10） | `kysely` 与 SQLite 驱动 |
| 其他功能插件（如合同编写、合同评审） | 各自仓库 | 各自的业务与各自的 SQLite 库文件 | `zq-sqlite`；要用邮件数据时调用 `ctx.workbenchMail`，不读工作台的库 |

渠道插件不自建数据库：任务、游标、渠道状态都通过渠道接口交给工作台，存在工作台的数据库里并按渠道区分；卸载渠道插件不丢数据。渠道插件自己的缓存（如微信解密副本 `wechat-cache/`）仍放在自己的目录。

建议的目录（落地时可调整）：

```text
src/core/              引擎编排（队列、调度）、分拣、方案匹配、审核动作、快照组装、简报
src/channels/types.ts  Channel 接口；registry.ts 渠道注册表
src/channels/email/    内置邮件渠道：包装 src/mail，迁入 engine/api 里的邮件逻辑
src/storage/           仓储接口；sql/（Kysely + zq-sqlite，现为 SQLite）；迁移脚本
src/channel.ts         对外导出渠道接口类型（package.json exports 的 ./channel），供独立仓库的渠道插件使用
src/ai/                AI 端口的 DSH 实现（现 agent.ts、structured.ts、writer.ts 等）
src/mail/              不动（移植代码）
bkms-workbench-wechat  渠道插件：src/wechat.ts、wechat/、client/wechat.tsx 迁入
```

**挂接方式**
- 工作台 `ctx.provide('workbenchChannels', registry)`（与现有 `ctx.provide('workbenchMail')` 同一机制）。微信插件 `inject: ['workbenchChannels']`，`apply` 中 `const off = ctx.workbenchChannels.register(wechatChannel)`，并用 `ctx.effect` 在卸载时注销。内置邮件渠道在工作台启动时直接注册。
- **版本检查（D10）**：注册时只比较渠道的 `apiVersion` 与工作台的 `CHANNEL_API_VERSION` 是否相等，不做兼容。渠道版本较旧时拒绝加载并在设置页提示“请升级微信插件”；渠道版本较新时提示“请升级工作台”。被拒绝的渠道按“渠道缺席”处理。
- 这套跨插件挂接尚未在真实 DSH 验证过，拆插件前先用最小示例插件验证（D7，§7 阶段 0）。
- **渠道缺席时**（微信插件已卸载）：该渠道的任务保留，用通用方式显示（标题、对方、正文）；需要渠道的动作返回 `channel-unavailable`（503）；游标和渠道状态原样保留；只选了 `sources: ['wechat']` 的方案不再命中任何信息。

## 4. 渠道接口草案

### 4.1 TypeScript 草案

```ts
// src/channels/types.ts（草案；经 bkms-workbench/channel 导出给独立仓库的渠道插件）
/** 接口有任何不兼容改动就加一；与渠道插件声明的 apiVersion 不相等即拒绝加载并提示升级（D10）。 */
export const CHANNEL_API_VERSION = 1
export type ChannelKind = 'email' | 'wechat' | 'feishu' | 'wecom' | (string & {})
export type Lang = 'zh' | 'en'

/** 一条来源信息在渠道内的坐标。核心只用它去重与定位，不解释含义。 */
export interface ItemRef {
  channel: ChannelKind
  /** 游标作用域。邮件：JSON.stringify([account, folder])；微信：会话 id */
  scope: string
  /** 作用域内唯一。邮件：`${uidValidity}:${uid}`；微信：段落最后一条消息的 seq */
  key: string
}

/** 方案字面条件的输入。scope 只对声明了范围条件的渠道有意义（邮件：account、folder）。 */
export interface MatchFacets { from: string; subject: string; hasAttachments: boolean; scope?: Record<string, string> }

/** 渠道交给核心入库的一条新信息。 */
export interface IncomingItem {
  ref: ItemRef
  receivedAt: string
  title: string                 // 列表标题
  counterpart: string           // 对方：发件人 / 会话里最后发言的人
  subject: string               // 邮件主题 / 会话名称
  body?: string                 // 入库时已知的内容（微信有；邮件留空，处理时再装载）
  hasAttachments: boolean
  facets: MatchFacets
  data?: unknown                // 渠道私有数据，核心原样保存（如微信段落）
}

/** 一次入库提交：游标比对与新任务在同一事务中写入（沿用现在“游标与新建任务同一事务”的保证）。 */
export interface PollBatch<C> {
  cursors: { scope: string; expected: C | undefined; next: C | null }[]   // null = 删除（会话移出名单）
  state?: { set?: Record<string, unknown>; remove?: string[] }            // 渠道私有状态（微信未成段消息）
  items: IncomingItem[]
  logs?: { message: string; level?: 'info' | 'error' }[]
}
export interface PollContext<S, C> {
  settings: S
  rules: readonly Rule[]                         // 已启用方案；邮件据此决定扫描哪些文件夹
  cursors: ReadonlyMap<string, C>
  state: ReadonlyMap<string, unknown>
  signal: AbortSignal
}

/** 处理前装载的完整内容。 */
export interface LoadedContent {
  body: string                                   // 本次内容（邮件含引用，由渠道拆分）
  attachments: { filename: string; size: number; contentType?: string; part?: string }[]
  data?: unknown                                 // 写回任务的渠道私有字段（邮件：messageId、references、replyTo、to、cc、bodyHtml…）
}

export interface ChannelCapabilities {
  reply: 'send' | 'copy' | 'none'   // send：草稿→预览→确认发送；copy：建议回复，人工复制到原应用
  autoSend: boolean                 // 是否允许方案自主发送
  archive: boolean                  // 分拣能否静默归档通知/营销
  attachments: boolean
  original: 'fetch' | 'inline'      // 原文按需拉取 / 已在任务中
}

export interface Channel<S = unknown, C = unknown> {
  apiVersion: typeof CHANNEL_API_VERSION
  kind: ChannelKind
  label: Record<Lang, string>
  capabilities: ChannelCapabilities

  settings?: {
    key: string                                  // 在 Settings 下的键，如 'wechat'
    defaults(): S
    validate(input: unknown): S                  // 抛 WorkbenchError；存储校验与 saveSettings 共用
    changed?(): void                             // 设置保存后清缓存
    view?(value: S): unknown                     // 返回页面的设置（不得含密钥）
  }
  status(settings: S, signal: AbortSignal): Promise<{ connected: boolean; detail: string; error?: string }>
  ready(): boolean                               // 队列据此决定是否取该渠道的任务
  /** 增量读取；每页产出一个批次，由核心事务提交。不得直接写存储。 */
  poll(ctx: PollContext<S, C>): AsyncIterable<PollBatch<C>>
  /** 返回值为 undefined 时表示到间隔前无需轮询（如邮件按 pollSeconds）。 */
  dueIn?(settings: S): number | undefined
  load(task: TaskRecord, signal: AbortSignal): Promise<LoadedContent>

  ai: {
    triageInput(task: TaskRecord, content: LoadedContent): TriageInput['mail']  // 含 channel 字段
    triageHint?(lang: Lang): string              // 追加到分拣系统提示
    agentInput(task: TaskRecord, content: LoadedContent): { key: 'mail' | 'conversation'; value: object }
    writingGuide(lang: Lang): string             // 回复写作规范
    exampleLabel(task: TaskRecord): string       // 学习例子前缀
  }
  relations: {
    threadKeys(task: TaskRecord): { self?: string; refs: string[] }  // 可靠关联
    possibleKey?(task: TaskRecord): string | undefined               // 弱关联（仅建议）
    counterpartKey(task: TaskRecord): string                         // 偏好键（“不再归档”）
    topicText(task: TaskRecord): string                              // 主题匹配用文本
  }
  reply?: ReplyCapability                        // 仅 capabilities.reply === 'send'
  attachments?: { download(task: TaskRecord, index: number, workspace: string, signal: AbortSignal): Promise<{ path: string; filename: string }> }
  /** 渠道自有动作，沿用原 action 名（如 wechatHistory），核心只做分发与鉴权。 */
  actions?: Record<string, (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>>
  snapshot?(settings: S): unknown                // 快照里 channels[kind] 的内容
  close?(): Promise<void>
}

export interface ReplyCapability {
  createDraft(task: TaskRecord, output: AgentOutput, prepareKey: string, signal: AbortSignal): Promise<{ draftId: string; draftRevision: number }>
  get(draftId: string): Promise<{ state: 'draft' | 'sending' | 'sent' | 'uncertain'; revision: number; error?: string; restored?: boolean }>
  list?(): Promise<{ id: string; state: string; revision: number }[]>   // 快照批量对账
  save(task: TaskRecord, draftId: string, revision: number, fields: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  preview(draftId: string, revision: number, signal: AbortSignal): Promise<{ planId?: string; blocked?: boolean }>
  send(draftId: string, planId: string, confirmed: true, signal: AbortSignal): Promise<{ state: 'draft' | 'sent' | 'uncertain'; error?: string }>
  resolve?(draftId: string, revision: number, outcome: 'sent' | 'not_sent', confirmed: true, signal: AbortSignal): Promise<{ state: string }>
  /** 自动发送的渠道侧边界；核心侧边界（待核实项、链接、长度、低风险）不变。 */
  autoSendGuard(task: TaskRecord, output: AgentOutput): { ok: true } | { ok: false; reason: string }
  recipientKey(task: TaskRecord): string | undefined   // “撤回过自动发送”的偏好键
}
```

`TaskRecord` 是核心视角的任务（见 §4.2）。所有发送仍只在审核动作或核心的撤回窗口中调用 `reply.send`，渠道自己不得发送；对话中不注册发送工具的约定不变。

### 4.2 任务数据形状

- 核心只依赖通用字段：`channel`、`ref`、`title`、`counterpart`（即现 `from`）、`subject`、`body`、`receivedAt`、`attachments`、`hasAttachments`，以及处理结果字段（`triage`、`match`、`rule`、`summary`、`checks`…）。渠道私有字段放 `channelData`（邮件：`messageId`、`references`、`replyTo`、`to`、`cc`、`bodyHtml`、`mailDate`、`mailSize`、`draftId`；微信：段落 `WechatSegment`，建议回复改为通用的 `suggestedReply`）。
- **不保留旧形状（D4）**：不需要照顾旧版本插件，复用邮件坐标的 `source`（`account = 'wechat'` 等）、顶层邮件字段与 `Task.wechat` 都可以直接去掉。
- **表结构一开始就按通用字段设计**（§5.5 的 `channel` / `scope` / `item_key` / `channel_data`）。存储阶段（§7 阶段 1）先由映射函数把现有 `Task` 类型转成这些列；渠道阶段（阶段 2）改 TypeScript 类型时只改映射函数，不需要数据迁移。

### 4.3 邮件渠道如何实现

| 接口 | 邮件实现（现有代码迁入） |
| --- | --- |
| 能力 | `reply: 'send'`、`autoSend: true`、`archive: true`、`attachments: true`、`original: 'fetch'` |
| 设置 | 无 `settings.key`：账号在 `mail/accounts.json`，由 `mailAccounts` 等动作管理；`pollSeconds` 留在核心设置 |
| 状态 / 就绪 | `sourceStatuses` 的邮件项；`ready()` = 已配置账号（现 `emailSource()`） |
| `poll` | `engine.ts:152-204` 原样迁入：作用域 = 每个账号收件箱 + 已启用方案的文件夹（159-163）；每页 50 封、最多 10 页；`batch.reset` 报 UIDVALIDITY 变化；`dueIn` 按 `pollSeconds` |
| 游标 | `{uidValidity, lastUid}`，作用域键沿用 `JSON.stringify([account, folder])`，与现 `State.cursors` 键一致 |
| `load` | `readOriginal` + `loadForProcessing`（122-128、205-211）、`originalMailFields`；继续核对 UIDVALIDITY |
| `ai.triageInput` | `runTriage` 中 `splitQuoted` / `historyForPrompt` 的拼装（352-354） |
| `ai.agentInput` | `mailInput`（`agent.ts:9-13`），`key: 'mail'` |
| `ai.writingGuide` | `EMAIL_WRITING_GUIDELINES` 及系统提示里关于 `mail.body` / `quotedHistory` 的段落（`agent.ts:209`） |
| `reply` | 建草稿（`engine.ts:437-445`）；`sendDue` 的 `preview` / `send`（498-531）；`saveDraft` / `previewSend` / `send` / `resolveSend`（`api.ts:395-444`）；快照对账（67-91）。`autoSendGuard` = `autoSendDecision` 的 34、37 两条（单一邮箱地址、不提其他地址）；`recipientKey` = `replyTo` |
| `relations` | Message-ID / References（`digest.ts:26-36`）；`possibleKey` = 发件人 + 规范化主题（41-52）；`counterpartKey` = `senderAddress` |
| `attachments` | `engine.attachment`（129-149）与 `/attachment` 路由 |
| `actions` | `mailAccounts`、`testMailAccount`、`saveMailAccount`、`removeMailAccount`、`defaultMailAccount`、`folders`、`resetBaseline`、`loadMail`（保持原 action 名） |
| 其他 | `ctx.workbenchMail`（`external()`）仍由邮件渠道提供；`generateRule` 的“邮箱 + 文件夹”范围选择成为邮件渠道的方案范围编辑器 |

### 4.4 微信渠道如何实现

| 接口 | 微信实现 |
| --- | --- |
| 能力 | `reply: 'copy'`、`autoSend: false`、`archive: false`（真人消息不静默消失）、`attachments: false`、`original: 'inline'` |
| 设置 | `key: 'wechat'`；`validate` = `validateWechatSettings`（`store.ts:51-66`）+ 名单去重（`api.ts:192`）；`defaults` = `wechatSettingsOf`；`changed` = `wechatChanged` |
| 状态 / 就绪 | `wechatStatus` / `wechatHealth`（`engine.ts:80-84、220-225`）；`ready()` 恒为真（任务内容已在库中，处理不需要微信在线） |
| `poll` | `pollWechat` + `wechatEligible`（233-303）；`wechatInfo`、`wechatChatList`、`wechatSeen`、`wechatSweepAt` 等内存缓存移入渠道对象 |
| 游标 | 每会话水位 `seq`（现 `State.wechat.watermarks`），作用域 = 会话 id；移出名单的会话产出 `next: null` |
| 渠道状态 | 未成段消息（现 `State.wechat.pending`），键 = 会话 id |
| 入库条目 | `createWechatTask`（304-323）：`key = toSeq`，`body = transcript`，`data = WechatSegment` |
| `load` | 直接返回已存的转写文本，无 IO |
| `ai` | `triageHint` = `triage.ts:71` 的补充；`agentInput` = `conversation`（`agent.ts:218`）；`writingGuide` = `IM_WRITING_GUIDELINES`（`agent.ts:25`）；`exampleLabel` = “微信 会话名”（`digest.ts:20`） |
| `reply` | 无。核心的 copy 模式通用动作 `saveReply` / `markHandled`（`api.ts:315-328`）按 `capabilities.reply === 'copy'` 放行 |
| `relations` | `threadKeys` = `chat:<会话 id>`（同会话即可靠关联，`digest.ts:37-40`）；无 `possibleKey`；`counterpartKey` = `wechat:<会话 id>`（`digest.ts:22`） |
| `actions` | `wechatStatus`、`wechatChats`、`wechatSearch`、`wechatHistory`（校验 `chatAllowed`）、`clearWechatCache`（`api.ts:283-304`） |
| 依赖 | Python 桥 `wechat/` 与 `wechat/wxread/`（移植代码，`NOTICE.md` 随迁） |

### 4.5 核心如何做到与渠道无关

- **入库**：`ingest.commit(batch)`（§5.3）在一个事务里比对游标、按 `(channel, scope, key)` 唯一键去重插入、写渠道状态与日志；分拣开启时设 `triage.state = pending`，关闭时 `chooseRule(rules, facets)`。取代 `poll`（171-193）与 `pollWechat`（276-301）两份逻辑，以及 `createWechatTask`（314-320）与 `poll`（180-186）的重复。
- **队列**：取任务条件 `t.source.kind === 'wechat' || emailReady`（409）改为 `registry.ready(channelOf(t))`。
- **分拣**：`wechat ? … : loadForProcessing`（347）改为 `channel.load()`；`mail` 拼装改为 `channel.ai.triageInput()`；提示补充来自 `channel.ai.triageHint()`；静默归档条件 `!wechat`（388）改为 `capabilities.archive`。`TriageInput.mail` 的形状不变，分拣模型的提示词与 `parseTriage` 不受影响。
- **方案匹配**：`matches`（`rules.ts:47-57`）先判 `ruleSources(rule).includes(channel)`，再把 `facets.scope` 交给该渠道的范围条件；`Rule.account` / `Rule.folder` 在 v1 中保留含义“只约束邮件”。以后新渠道的范围条件放可选新字段 `Rule.scope?: Record<ChannelKind, Record<string, string>>`。
- **准备**：`processNext` 的两条路径（418 分派 `prepareWechat`、419-464 邮件）合并为一条：`load` →（按方案授权下载附件）→ `agent.run`（输入与写作规范来自渠道）→ `reply === 'send'` 时 `reply.createDraft`，`copy` 时写 `suggestedReply`，报告类直接完成。结果写入合并为 `tasks.completePreparation`。
- **自动发送**：`autoSendDecision` 拆为核心检查（自主级别、待核实项、链接、长度、低风险，即 30-33、36、38-39 行）+ `reply.autoSendGuard`；`sendDue` 只处理 `capabilities.autoSend` 的渠道。
- **审核**：只读拦截（`api.ts:314`）改为“`capabilities.reply !== 'send'` 时拒绝草稿类动作”，文案由渠道提供（微信：“请复制建议回复，在微信中发送”）。
- **简报、主题、关联**：`relations()` 改为按 `threadKeys` / `possibleKey` 建索引，不再判断 kind；`senderKey` / `exampleText` 改调渠道；活动记录 `source` 取 `channelOf(task)`，不再写死。
- **状态与快照**：`sourceStatuses` 遍历注册表，并为已声明未接入的渠道（飞书、企微、会议）返回占位；快照顶层 `wechat` 块改为 `channels: { [kind]: channel.snapshot() }`，过渡期两者同时返回，前端分步切换。

### 4.6 前端扩展点

```ts
// client/channels.ts（草案）
export interface ClientChannel {
  kind: string
  label: () => string                                   // 经 t()
  titleOf?(task: Task): string                          // 现 lib.ts taskTitle
  counterpartOf?(task: Task): string                    // 现 lib.ts counterpart
  SettingsPanel?: Component<{ value: unknown; disabled: boolean; save(value: unknown, message?: string): Promise<void> }>  // 现 WechatSettingsCard，settings.tsx:59
  TaskTags?: Component<{ task: Task }>                  // 现 workspace.tsx:134-138（@我、群聊/私聊）
  TaskBody?: Component<{ task: Task }>                  // 现 SegmentConversation，workspace.tsx:226
  ReplyPanel?: Component<{ task: Task }>                // 现 workspace.tsx:219-224 建议回复 + 复制 + 已处理
  SourceTab?: { label: () => string; Component: Component<{ task: Task }> }  // 现 ChatHistory，workspace.tsx:331-335
  ViewMode?: { label: () => string; Component: Component }                   // 现 ChatsView，views.tsx:205-210
  ruleSourceAvailable?(data: Snapshot): boolean         // 现 plans.tsx:155
}
```

- **注册**：单插件阶段用静态注册表；拆插件后，核心前端提供客户端注册服务（`ctx.provide` 或插件自定义插槽，如 `bkms-workbench.channel`），微信插件前端注册自己的 `ClientChannel`。**DSH 客户端运行时是否支持插件间 provide/自定义插槽需在真实 DSH 验证**（D7）；不支持时的退路：微信界面代码暂留工作台前端，只在微信渠道已注册时显示——后端拆开、前端暂不完全拆开。
- **渠道前端缺席**：任务按通用方式显示，只保留“忽略、重新处理、选择方案”等核心动作。
- **i18n 与样式**：渠道插件自带 `en.json` / `system-en.json`，在自己的命名空间注册；`test/i18n.test.mjs` 的规则同样适用；只用核心 `styles.css` 的颜色变量，深色模式与 ≤1000px 单栏要求不变。

## 5. 存储接口

### 5.1 现状问题

- 65 处整文档读写：`src/api.ts` 33 处（read 9、mutate 24），`src/engine.ts` 32 处（read 12、mutate 20）。逐处见附录 A。
- 任何读都整读整校验；任何写都整文件重写、全量校验并 fsync。页面、全局提醒、后台各自每 5–8 秒整读一次；后台开启时每轮还整写一次（§1.1）。
- 无法分页或索引；快照每 8 秒把全部任务（含正文）发给页面。
- 调用方自己找任务、比 revision、写日志与活动记录，事务边界散落在业务代码里；换数据库时无法逐处改写。
- 以后若做多用户服务器版，整文档模型也不成立。

### 5.2 设计原则

1. **按业务操作建接口**：方法名就是业务动作（`claimNext`、`completeTriage`），不暴露整文档，也不做通用 CRUD；状态前置条件、历史、日志、活动记录在方法内部一并写入。
2. **一个方法一个事务，事务内不做网络 IO**：IMAP、SMTP、AI 都在事务外，延续现在“存储修改必须是同步事务”的约束（`store.ts:93`）。
3. **乐观锁沿用三种 revision**：任务 `revision`、配置 `configRevision`、草稿 `draftRevision`（邮件模块）。文档级 `revision` 变为每用户的“变更序号”`changeSeq`，只用于页面判断是否需要刷新（`preferences.stateRevision` 已在用）。冲突继续返回 `409 conflict`，前端无需改动。
4. **用户范围隐含在实例里**：`openRepository({ userId })` 返回绑定用户的实例，方法签名不出现 `user_id`，避免漏传；本地固定 `userId = 'local'`。
5. **读写模型分开**：列表用摘要投影（不含 `body`、`bodyHtml`、历史），详情按 id 取全文。
6. **实现可替换**：现在只有 `SqlRepository`（Kysely + SQLite），不写过渡用的 JSON 实现（D4）；以后的服务器数据库实现跑同一套契约测试。

### 5.3 接口清单

| 仓储 | 方法 | 事务内容 | 主要替代 |
| --- | --- | --- | --- |
| **config** | `get()` | 设置、方案、`configRevision`（可按 revision 缓存） | engine 103、158、215、598；api 139 |
| | `saveSettings(patch, expected)` | 合并设置、`configRevision+1`、日志；渠道设置经 `channel.settings.validate` | api 199 |
| | `saveRule(rule, expected)` / `deleteRule(id, expected)` | 方案增改删；删除时一并删学习例子 | api 209、217 |
| | `checkRevision(expected)` | 只校验 | api 306 |
| **tasks** | `get(id, expectedRevision?)` | 不存在 404、版本不符 409（现 `findTask`） | api 219、313、499 |
| | `list(query)` | 摘要分页：状态、需关注、渠道、时间范围、方案、游标 | api 62 |
| | `attention()` | 需关注任务的 id 与状态 | api 134 |
| | `recent(n)` / `inRange(from, to)` / `forDigest(since)` | 试运行、周报、简报所需的摘要 | api 254；engine 549、562 |
| | `byThreadKeys(keys)` / `related(id)` | 同一往来的任务、相关与可能相关 | engine 348；api 93 |
| | `recoverAfterRestart()` | `running → queued`、`sending → uncertain` 并记录 | engine 87 |
| | `claimNext({ now, agentReady, readyChannels })` | 取一个可处理任务置为 `running`、`attempts+1`、`prepareKey ??=`；**没有任务时不写入** | engine 407 |
| | `saveLoaded(id, expected?, content, note)` | 写回装载的原文与渠道字段 | engine 431；api 332 |
| | `completeTriage(id, result)` | 分拣结果、方案指派或建议、归档及活动记录；任务已不在 `running` 时不改 | engine 369 |
| | `completePreparation(id, result, autoSend?)` | 摘要、待核实、草稿或建议回复、状态、报告与自动发送活动 | engine 335、448 |
| | `failAttempt(id, error, policy)` | 重试或失败 | engine 468 |
| | `findDueAutoSend(now)` | 到期且未取消的自动发送 | engine 481 |
| | `cancelAutoSend(id, expected?, reason, kind, byUser?)` | 取消、活动记录；用户撤回时写联系人偏好 `neverAutoSend` | engine 485；api 464 |
| | `claimSend(id, expected, note)` | `review → sending`，条件不满足返回 false；人工发送同时 `takeOver` | engine 505；api 416 |
| | `recordSendResult(id, outcome)` | 发送结果、回执、核对结果 | engine 515、525；api 419、423、436 |
| | `reconcileDraft(id, draftState)` | 快照对账草稿状态 | api 85 |
| | `requeue(id, expected, { ruleId?, configExpected?, supplement? })` | 重新排队、选择方案、补充资料；需要时写正例 | api 343 |
| | `rejectRule(id, expected)` | 移出方案、写反例 | api 378 |
| | `ignore` / `restoreArchived` / `takeOver` / `saveSuggestedReply` / `markHandled` | 对应人工动作；恢复归档时写 `neverArchive` 并标记活动已撤回 | api 392、450、401、318、327 |
| **ingest** | `cursors(channel)` / `channelState(channel)` | 读游标与渠道状态 | engine 168、248 |
| | `commit(channel, batch, triageOn)` | 游标比对、去重插入、渠道状态、日志 | engine 171、276 |
| | `resetCursor(channel, scope, cursor, configExpected)` | 人工重建基线 | api 309 |
| **examples** | `list(ruleIds)` / `delete(ruleId, id)` | 学习例子（写入在 `requeue` / `rejectRule` 事务内） | engine 348；api 211、254 |
| **contacts** | `get(keys)` | 联系人偏好（现 `senders`；写入在相关任务事务内） | engine 348、448 |
| **activity** | `recent(n)` / `since(at)` / `get(id)` | 活动记录（写入在相关事务内） | api 62、277；engine 549 |
| **logs** | `append(message, level?, taskId?)` / `recent(n)` | 日志（保留最近 1000 条） | engine 110、198、363；api 302 |
| **topics** | `list()`（含匹配数）/ `save` / `delete` / `saveSummary(id, summary, report?)` | 主题与主题报告 | api 62、236、247；engine 575、582 |
| **reports** | `list()` / `insert(report, activity?)` / `update` / `delete` / `existsForPeriod(kind, start, topicId?)` | 报告（保留最近 200 份） | api 250、252；engine 566、598 |
| **briefs** | `get()` / `save(brief, activity?)` | 今日简报 | engine 552、598 |
| **meta** | `uiLanguage()` / `setUiLanguage(lang)` / `changeSeq()` | 界面语言、变更序号 | engine 72、73；api 134 |
| **changes** | `since(seq)` | 自某序号以来变化的任务 id、配置是否变化 | 新增：增量快照 |
| **worker** | `acquire(onLost)` | 后台单实例锁（本地文件锁；以后 Web 版用租约，§6.3） | engine 86 |
| **search** | 见 §5.6 | | 新增 |

说明：
- 人工动作中“读后判断再写”的地方（如 `ignore` 前判断状态）放进方法内部，避免现在 `exclusive` + 先读后写的两步之间被后台改动。`WorkbenchApi.exclusive`（同任务串行）保留，作为进程内的第二道保护。
- `snapshot` 不再由一次整读组成，而是 `config.get + tasks.list + activity.recent(300) + topics.list + reports.list + briefs.get + logs.recent + examples.list` 拼装；页面带上次的 `changeSeq` 时，未变化直接返回 `unchanged`。
- 引擎里的 AI 判断、IMAP 读取都在两次仓储调用之间，和现在两次 `mutate` 之间的位置相同，事务边界不变。

### 5.4 乐观锁与并发

- **任务**：`UPDATE tasks SET …, revision = revision + 1 WHERE user_id = ? AND id = ? AND revision = ?`，影响 0 行时再查一次区分 404 / 409。
- **配置**：`UPDATE workbench SET …, config_revision = config_revision + 1 WHERE user_id = ? AND config_revision = ?`。方案表写入与之同事务。
- **游标比对**：`channel_cursors` 带 `revision`；`commit` 时 `expected` 与库中值不符则整批放弃（现 `engine.ts:172` 的语义）。新任务靠唯一键 `(user_id, channel, scope, item_key)` 去重，`ON CONFLICT DO NOTHING`。
- **取任务**：SQLite 单写者，`UPDATE … WHERE id = (SELECT id … LIMIT 1) AND status = 'queued' RETURNING *` 即可；PostgreSQL 用 `SELECT … FOR UPDATE SKIP LOCKED`，多个后台实例不会取到同一任务。这是少数需要方言分支的地方。
- **变更序号**：每个写事务把 `workbench.change_seq` 加一并写到受影响任务的 `changed_seq` 列，`changes.since(seq)` 据此查询。同一用户的写入因此串行化；单用户写入频率很低，可以接受。
- **草稿**：`draftRevision` 与发送锁仍由邮件模块负责（本地是 `drafts-v1.json` + `send-<id>` 文件锁；Web 见 §6.5）。

### 5.5 表结构草案

以 PostgreSQL 写法表示；SQLite 差异见表后说明。所有表主键以 `user_id` 开头，本地固定为 `'local'`。

```sql
CREATE TABLE users (id text PRIMARY KEY, created_at text NOT NULL);

-- 每用户一行：原 State 的顶层标量
CREATE TABLE workbench (
  user_id text PRIMARY KEY REFERENCES users(id),
  change_seq bigint NOT NULL,          -- 原 revision
  config_revision bigint NOT NULL,     -- 原 configRevision
  settings jsonb NOT NULL,             -- 原 settings，只存用户保存过的值（含渠道设置，如 settings.wechat）
  ui_language text,                    -- 原 uiLanguage
  brief jsonb,                         -- 原 brief
  updated_at text NOT NULL
);

CREATE TABLE rules (
  user_id text NOT NULL, id text NOT NULL,
  position integer NOT NULL,           -- 保持原数组顺序
  data jsonb NOT NULL,                 -- validateRule 的输出原样
  PRIMARY KEY (user_id, id)
);

CREATE TABLE rule_examples (
  user_id text NOT NULL, rule_id text NOT NULL, id text NOT NULL,
  match boolean NOT NULL, text text NOT NULL, task_id text, at text NOT NULL,
  PRIMARY KEY (user_id, rule_id, id)
);

CREATE TABLE tasks (
  user_id text NOT NULL, id text NOT NULL,
  revision bigint NOT NULL, changed_seq bigint NOT NULL,
  channel text NOT NULL, scope text NOT NULL, item_key text NOT NULL,   -- 去重坐标
  status text NOT NULL,
  attention boolean NOT NULL,          -- needsAttention() 的结果，写入时计算
  title text NOT NULL, counterpart text NOT NULL, subject text NOT NULL,
  received_at text NOT NULL, updated_at text NOT NULL,
  rule_id text, rule_name text,
  triage_state text, category text, urgency text,
  attempts integer NOT NULL, next_attempt_at text,
  auto_send_at text,                   -- 未取消的自动发送时间
  summary text,
  body text NOT NULL,
  detail jsonb NOT NULL,               -- 其余通用字段：rule 快照、triage、match、checks、autoSend、informationGaps、supplement、prepareKey、workspace、attachments、error…
  channel_data jsonb,                  -- 渠道私有：邮件 messageId/references/replyTo/to/cc/bodyHtml/mailDate/mailSize/uidValidity/draftId；微信段落与建议回复
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, channel, scope, item_key)
);
CREATE INDEX tasks_queue     ON tasks (user_id, status, next_attempt_at);
CREATE INDEX tasks_received  ON tasks (user_id, received_at DESC);
CREATE INDEX tasks_changed   ON tasks (user_id, changed_seq);
CREATE INDEX tasks_attention ON tasks (user_id, received_at) WHERE attention;
CREATE INDEX tasks_auto_send ON tasks (user_id, auto_send_at) WHERE auto_send_at IS NOT NULL;

CREATE TABLE task_history (            -- 每任务保留最近 100 条
  user_id text NOT NULL, task_id text NOT NULL, seq integer NOT NULL, at text NOT NULL, message text NOT NULL,
  PRIMARY KEY (user_id, task_id, seq)
);
CREATE TABLE task_links (              -- 关联键：self = 本条 Message-ID / chat:<id>；ref = 引用；possible = 弱关联键
  user_id text NOT NULL, task_id text NOT NULL, role text NOT NULL, key text NOT NULL,
  PRIMARY KEY (user_id, task_id, role, key)
);
CREATE INDEX task_links_key ON task_links (user_id, key);

CREATE TABLE channel_cursors (
  user_id text NOT NULL, channel text NOT NULL, scope text NOT NULL,
  value jsonb NOT NULL, revision bigint NOT NULL, updated_at text NOT NULL,
  PRIMARY KEY (user_id, channel, scope)
);
CREATE TABLE channel_state (
  user_id text NOT NULL, channel text NOT NULL, key text NOT NULL,
  value jsonb NOT NULL, revision bigint NOT NULL,
  PRIMARY KEY (user_id, channel, key)
);
CREATE TABLE contact_prefs (           -- 原 senders
  user_id text NOT NULL, key text NOT NULL, never_archive boolean, never_auto_send boolean,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE activity (
  user_id text NOT NULL, id text NOT NULL, at text NOT NULL, kind text NOT NULL, title text NOT NULL,
  detail text, task_id text, rule_name text, autonomy text, channel text, undo_until text, undone_at text,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX activity_at ON activity (user_id, at DESC);
CREATE TABLE logs (
  user_id text NOT NULL, id text NOT NULL, at text NOT NULL, level text NOT NULL, message text NOT NULL, task_id text,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX logs_at ON logs (user_id, at DESC);
CREATE TABLE topics (
  user_id text NOT NULL, id text NOT NULL, data jsonb NOT NULL, schedule text NOT NULL, updated_at text NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE reports (
  user_id text NOT NULL, id text NOT NULL, kind text NOT NULL, topic_id text,
  period_start text NOT NULL, period_end text NOT NULL, title text NOT NULL, text text NOT NULL,
  by text NOT NULL, generated_at text NOT NULL, updated_at text NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE schema_migrations (version integer PRIMARY KEY, applied_at text NOT NULL);
```

以后若做 Web 版（暂缓，§6）另加：`mail_accounts`（加密授权码）、`mail_drafts` 与草稿附件元数据、`mailbox_leases`、任务队列表。

**取舍说明**
- **常查询的字段成列，其余放 JSON**：任务约 40 个字段，多数可选且还在演进（如进行中的 `feat/mail-dispatch` 分支新增 `classification`、`dispatch`、`backfill`）。新增可选字段不需要改表；需要按它查询时再用迁移脚本提成列（D11）。列由一个共用的 `toRow` / `fromRow` 映射函数从 JSON 派生，两种方言共用。
- **`body` 单独成列**：列表查询不取它，搜索索引从它生成。
- **时间统一存 ISO-8601 UTC 文本**：现有代码大量直接比较 ISO 字符串（如 `t.nextAttemptAt <= now()`），两种方言行为一致，也避开驱动把 `timestamptz` 转成 `Date` 带来的差异。以后需要数据库端时间函数时再在 PostgreSQL 改用 `timestamptz` 加映射。
- **保留上限**：日志、活动 1000 条，报告 200 份，任务历史 100 条，在写入事务内或定期清理时执行，与现状一致；任务总数不再受 64 MiB 限制。
- **`feat/mail-dispatch` 分支的新数据**：`classifiers`（配置，保存时增加 `configRevision`）建与 `rules` 同构的表；`categoryExamples` 可并入 `rule_examples` 加 `kind` 列；`backfills` 放 `channel_state`（`email`，键为文件夹作用域）；`profile` 在 `settings` 内；任务上的新字段进 `detail`，“待人工分类”视图需要时把 `classification.state` 提成列。

**落到 SQLite（D1）时的写法**：上面用 PostgreSQL 写法便于对照服务器数据库，实际先落地的是 SQLite：`jsonb` → `TEXT`、`boolean` → `INTEGER 0/1`、`bigint` → `INTEGER`；部分索引（`WHERE`）与 `ON CONFLICT`、`RETURNING`（3.35+）都支持；启用 WAL 日志模式（读写互不阻塞，写入只追加日志文件）。迁移文件用 Kysely schema builder 编写，同一份定义可生成 SQLite 与以后服务器数据库的 DDL。

### 5.6 全文搜索接口

```ts
export interface SearchIndex {
  /** 与任务写入同一事务更新 */
  upsert(doc: SearchDoc): Promise<void>
  remove(taskId: string): Promise<void>
  search(q: { text: string; channel?: string; status?: Status[]; from?: string; to?: string; limit: number; cursor?: string }):
    Promise<{ hits: { taskId: string; snippet?: string }[]; next?: string }>
  rebuild(): Promise<void>
}
export interface SearchDoc { taskId: string; title: string; counterpart: string; subject: string; summary: string; text: string /* body 前 20000 字 */; receivedAt: string; channel: string; status: Status }
```

难点是中文：常用词多为两个字（报价、合同、发票），而 SQLite FTS5 `trigram` 分词与 PostgreSQL `pg_trgm` 都需要 3 个字符以上才能用上索引；`unicode61` 分词不切分中文。方案对比：

| 方案 | SQLite（现在） | 以后的服务器数据库 | 评价 |
| --- | --- | --- | --- |
| **A 应用层二元切分（推荐）** | 写入与查询前用同一个 TS 函数把连续中文切成重叠二元组（“合同条款” → “合同 同条 条款”），英文按词；FTS5 `unicode61` 索引；查询用短语匹配保证相邻 | PostgreSQL：同一函数切分后存入 `tsvector`（`simple` 配置，内置）+ GIN，查询用 `phraseto_tsquery('simple', …)`；MySQL：同一函数切分后用 InnoDB `FULLTEXT` 短语查询 | 换数据库后结果一致，不依赖扩展；两字词有索引。索引体积约为原文两倍 |
| B 三元组 | FTS5 `tokenize='trigram'`；短于 3 字退回 `LIKE` 全表扫描 | PostgreSQL `pg_trgm` + GIN，同样短词退化 | 实现最简单，但两字查询慢；不同数据库的排序和边界不同 |
| C 数据库自带的中文切分 | 无对应 | PostgreSQL 扩展 `zhparser`（SCWS 分词）或 `pg_bigm`（二元组索引）；MySQL 内置 `ngram` 全文解析器（默认二元） | 质量好、省去应用层切分，但 PostgreSQL 扩展要看托管云是否提供；与本地 SQLite 结果不同 |

- 主题匹配数（`api.ts:95` 每次快照对所有主题扫描全部任务）改为通过搜索接口按关键词查询，结果按 `changeSeq` 缓存。
- 契约测试只断言“固定语料中应命中的一定命中、不应命中的不命中”，不断言排序。

### 5.7 查询层：Kysely（现为 SQLite，可换服务器数据库）

**为什么是 Kysely**：只是类型安全的 SQL 构造器，表结构用一个 TypeScript `Database` 接口描述，各方言共用；官方支持 SQLite（`better-sqlite3`）、PostgreSQL（`pg`）与 MySQL（`mysql2`），`node:sqlite` 有社区方言；不隐藏 SQL，少数需要方言分支的地方可以直接写。现在只实现 SQLite；以后做服务器版时新增 PostgreSQL 或 MySQL 实现，业务代码和仓储接口不变。

| 备选 | 不选的原因 |
| --- | --- |
| Drizzle | 表定义按方言分开写（`sqliteTable` / `pgTable`），同一张表要维护两份——正是担心的“不一致”来源 |
| Prisma | 需要查询引擎与代码生成，安装包和 DSH 插件打包都更重 |
| TypeORM / MikroORM | 实体模型较重，与现在的纯对象数据风格差别大 |
| 直接写 SQL | 没有类型检查，两种方言各写一遍 |

**方言差异与处理**

| 差异 | SQLite | PostgreSQL | 处理 |
| --- | --- | --- | --- |
| JSON | `TEXT` | `jsonb`（驱动返回对象） | 映射函数统一解析/序列化；不在 SQL 里做 JSON 查询，需要查的字段已经成列 |
| 布尔 | `0/1` | `boolean` | 映射函数 |
| 时间 | ISO 文本 | ISO 文本 | 统一 |
| upsert / RETURNING | 支持 | 支持 | Kysely `onConflict`、`returning` 通用 |
| 取任务加锁 | 单写者；事务用 `BEGIN IMMEDIATE` | `FOR UPDATE SKIP LOCKED` | `claimNext` 方言分支 |
| 隔离级别 | 单写者，等同串行 | 默认 read committed | 一律用“条件更新 + 检查影响行数”，两种隔离级别下都成立 |
| 全文搜索 | FTS5 虚表 | `tsvector` + GIN | `SearchIndex` 两个实现，切分函数共用 |
| 迁移 DDL | 类型名不同 | | 迁移用 Kysely schema builder，加 `json()`、`bool()` 两个按方言出类型的小函数 |

以后若服务器版选 MySQL 8，额外差异：upsert 用 `ON DUPLICATE KEY UPDATE`（Kysely `onDuplicateKeyUpdate`）；没有 `RETURNING`，`claimNext` 等改为“条件更新后按 id 再读”；`SKIP LOCKED` 8.0 起支持；`JSON` 类型由映射函数处理；全文搜索见 §5.6。这些都封装在仓储实现里，契约测试保证行为一致。

**本地驱动（D2）**：本插件目前**没有任何原生模块**依赖（`package.json`：imapflow、mailparser、nodemailer、proper-lockfile、yaml）。
- 首选 `better-sqlite3`：最常用、最快，同步 API 与现在“同步事务”的写法最接近；但它是原生模块，需要按平台和 DSH 内置 Node 的 ABI 提供预编译文件。
- 退路 `node:sqlite`：Node 自带（22.13 起无需参数），底层同样是 SQLite C 库，性能相近，不用打包；但仍标为实验性（会打印一条警告），需要社区 Kysely 方言。
- 驱动只在公共基础包里选定（D8，§5.10），各插件不各自处理；选定方法见 §5.8 第 1 项。

**仓储契约测试（关键）**：一套测试函数 `repositoryContract(makeRepo)`，覆盖每个仓储方法的结果、409/404 错误码、游标比对、去重、`claimNext` 互斥、保留上限、搜索命中。`pnpm test` 跑 SQLite 实现（临时库）；以后有服务器数据库实现时，设置 `DATABASE_URL` 再跑同一套测试。各实现行为一致由这套测试保证，而不是靠人工对照。

### 5.8 SQLite 落地前需实测（PGlite 不采用）

**不采用 PGlite 的原因（D1）**：PGlite 是把 PostgreSQL 编译成 WebAssembly 在进程内运行，好处是与服务器 PostgreSQL 同一方言；但多一层 WASM、只有一个连接，查询更慢、启动更慢、常驻内存几十 MB 起，项目也较新（2024 年起），数据目录还绑定 PostgreSQL 大版本。性能优先时 SQLite 更合适；方言差异由 Kysely 与契约测试吸收。

**需实测**（在用户的 Windows 机器与 DSH 内运行；第 1、9 项在阶段 0 先做，其余在阶段 1 开始时做）：

| # | 项目 | 通过标准 |
| --- | --- | --- |
| 1 | `better-sqlite3` 预编译文件能否随插件安装（`pnpm run pack:plugin` 的 tgz 与 `启动工作台.cmd`），并在 DSH 内置 Node 中加载；Windows x64 必测，macOS 可在有设备时测 | 能加载即用 `better-sqlite3`；不能则改用 `node:sqlite`，并确认 DSH 的 Node 版本（`^22.19 \|\| >=24`）可用 |
| 2 | 1 万任务（约 150 MB）下：摘要分页、`claimNext`、单任务更新 | p95 分别 < 10、10、20 毫秒 |
| 3 | 冷启动打开上述数据库 | < 1 秒 |
| 4 | 处理中强杀 DSH 进程 100 次（WAL 模式） | 每次都能打开，数据完整 |
| 5 | Windows Defender 实时扫描下连续写入 | 无失败，或短暂重试后恢复（`WinError 5/32`） |
| 6 | 第二个进程打开同一数据库并尝试写入 | 等待或明确报错，不损坏数据；后台单实例仍由 `ownWorker` 锁保证 |
| 7 | 中文搜索（方案 A）：固定语料的两字、三字、英文查询 | 搜索契约测试通过 |
| 8 | 备份恢复：用 SQLite 在线备份接口导出，再从备份打开 | 能恢复 |
| 9 | 两个插件各自依赖 `zq-sqlite`、同时加载驱动，各写自己的库 | 都能加载，互不阻塞 |

### 5.9 旧数据与升级规则

1. **不迁移旧数据（D4）**：新版本不读取 `workbench-v1.json`，首次启动是空库。连接邮箱后按现有逻辑先建立基线，只处理之后的新邮件，不会把历史邮件当新邮件处理；微信会话同样先建基线。
2. **旧文件由用户清理**：`workbench-v1.json` 与 `tasks/` 任务目录，新版本既不读取也不删除。
3. **去掉的旧代码**：`src/store.ts` 的 `Store.read()` / `mutate()`、`validateState`、整文档文件锁与 64 MiB 上限；整文档类型 `State` 拆成各表的类型。后台单实例锁 `ownWorker` 保留。测试里 83 处直接操作 `Store` 的地方改为走仓储接口或 API。
4. **邮件模块的文件不在范围内**：`mail/accounts.json`（授权码，0600）保持原样，邮箱不用重新配置；`mail/drafts/`（草稿与附件，移植代码）保持原样——清理旧任务后其中的旧草稿成为孤立数据，可一并删除整个 `mail/drafts/` 目录；微信解密缓存 `wechat-cache/` 不受影响。
5. **升级规则（D11）**：从 SQLite 版本开始，表结构变化一律写迁移脚本，由公共基础包在执行迁移前自动备份；数据库版本比插件新（装回了旧版本）时不启动后台，只提示升级，不支持降级。
6. **`CLAUDE.md` 同步修改**（阶段 1 合并时一起改）：“数据兼容”一节（`version: 1`、新字段可选、旧版本可读、在 `src/store.ts` 校验）替换为第 5 条；“目录”表里 `src/store.ts` 的说明同步更新。
7. **进行中的 `feat/mail-dispatch` 分支**：若在阶段 1 之前合并，它新增的数据随阶段 1 一起落表（§5.5 取舍说明）；若之后合并，其存储部分需按仓储接口重写。

### 5.10 多插件使用 SQLite（D8）

**每个插件一个库文件**：放在插件自己的数据目录，如 `<数据目录>/bkms-workbench/workbench.sqlite`、`<数据目录>/contract-review/contract-review.sqlite`；每个库有自己的 `schema_migrations`。

不共用一个库的原因：
- SQLite 同一文件同一时刻只有一个写入者，多个插件写同一个库会互相排队，一个插件的慢事务会卡住其他插件。
- 各插件独立升级、安装、卸载：迁移脚本只管自己的表；卸载插件删它自己的文件即可。
- 出问题不连坐：一个插件的迁移失败或文件损坏只影响它自己；备份恢复也按插件进行。
- 保持解耦：插件间需要对方的数据时调用对方的服务接口（现有 `ctx.workbenchMail`，以后按需增加只读接口），不直接打开别人的库文件，也不用 SQLite `ATTACH` 跨库查询。

**公共基础包 `zq-sqlite`（暂名）**，各插件依赖它，基础设施只写一遍：

```ts
// zq-sqlite（草案）
export interface OpenOptions<DB> {
  dir: string                                   // 插件数据目录，不存在时以 0700 创建
  name: string                                  // 库文件名，如 'workbench'
  migrations: Record<string, Migration>         // Kysely 迁移，按名称顺序执行
  durability?: 'full' | 'normal'                // synchronous 级别；工作台用 'full'（发送状态不能丢）
  busyTimeoutMs?: number                        // 等锁超时，默认 5000
}
export function openDatabase<DB>(options: OpenOptions<DB>): Promise<{
  db: Kysely<DB>
  backup(target: string): Promise<void>         // SQLite 在线备份
  check(): Promise<{ ok: boolean; detail?: string }>   // quick_check
  close(): Promise<void>
}>
```

- 打开时：WAL、`busy_timeout`、`foreign_keys = ON`、`synchronous` 按 `durability` 设置。
- 迁移：执行前自动备份（保留最近几份）；失败整体回滚并拒绝启动；数据库版本比插件新时报“请升级插件”（D11）。
- Windows 文件被占用（`WinError 5/32`、`SQLITE_BUSY`）时短暂重试，超出后给出明确错误。
- 驱动选择（D2）只在这里实现；对外只暴露 Kysely 实例。
- 测试辅助：临时库、契约测试工具。
- 打包：每个插件把 `zq-sqlite` 作为依赖安装；若用 `better-sqlite3`，每个插件各带一份原生文件，体积有重复，但互不影响（§5.8 第 9 项验证）。
- 放在哪里（独立仓库，或 `zq-plugins` 下的共享包）待定（§8）；工作台是第一个使用者，阶段 1 开始时决定。

## 6. Web 版额外问题（暂缓）

> 2026-10-22 决定 Web 版暂不做（D3），本节只作为以后的参考，不在当前计划内。当前设计为它保留的只有两点：每张表带 `user_id`（本地固定 `'local'`）；仓储接口与 AI 端口不依赖 DSH 的具体实现。下文中的 PostgreSQL 写法同样适用于以后选 MySQL 的情况，具体差异届时再定。

### 6.1 多用户隔离

- **数据**：所有表主键以 `user_id` 开头；仓储实例在请求进入时按会话中的用户创建，`user_id` 只来自鉴权结果，不来自请求体。
- **第二道防线**：PostgreSQL 行级安全（RLS）。每个事务 `SET LOCAL app.user_id = …`，策略 `USING (user_id = current_setting('app.user_id'))`；应用使用无 `BYPASSRLS` 权限的数据库角色。
- **文件**：任务目录、附件副本、草稿上传改存对象存储，路径以用户 id 为前缀；Agent 的临时工作目录按任务创建、用完删除。
- **后台**：每个任务、每次 AI 调用都带用户 id；日志、活动、错误信息不跨用户；按用户限流（AI 调用、IMAP 连接数）。
- **请求防护**：沿用 `x-bkms-workbench: 1`、同来源、256 KiB 上限等检查（`api.ts:480-497`），另加会话 Cookie 的 `SameSite` 与 CSRF 令牌。
- **测试**：契约测试加“跨用户不可见”用例；RLS 单独测试（故意漏掉 user 条件的查询也查不到他人数据）。

### 6.2 邮箱授权码加密存放

- **信封加密**：每条授权码用随机数据密钥（AES-256-GCM，96 位随机 nonce，附加数据 = `user_id | account_id | 用途`）加密；数据密钥由主密钥加密后与密文同存。主密钥放 KMS（云厂商 KMS 或 Vault Transit），自托管时用环境变量注入。
- **表**：`mail_accounts(user_id, id, address, provider, config jsonb, secret_ct, secret_nonce, wrapped_dek, key_id, revision)`；`key_id` 支持轮换（后台逐条重新加密）。
- **使用**：只在收发 worker 建立 IMAP/SMTP 连接时解密，明文只在连接池生命周期内驻留内存；接口只返回“是否已设置授权码”（与本地版一致）；日志继续经 `safe()` 与邮件模块的密钥脱敏。
- 预留的 OAuth2（Outlook / Microsoft 365）刷新令牌同样处理。
- 本地版不变：`accounts.json` 权限 0600；以后可选 Windows DPAPI / macOS 钥匙串。

### 6.3 IMAP 轮询的单实例占用

问题：多个 Web 实例同时轮询同一邮箱，会重复拉取（唯一键能防重复任务，但浪费连接）、撞上服务商并发连接上限（如腾讯企业邮箱、QQ 邮箱），并可能重复处理。

- **邮箱租约**：`mailbox_leases(account_key PRIMARY KEY, owner, expires_at)`。worker 用条件更新抢占过期租约，定时续租；持有租约的 worker 才对该邮箱建立 IMAP 连接。不选会话级 `pg_advisory_lock`：它绑定数据库会话，经 PgBouncer 事务池时不可靠，连接断开也难察觉。
- **任务处理**：分拣与准备走 PostgreSQL 队列（pg-boss 或 graphile-worker），或直接用 `claimNext` 的 `SKIP LOCKED`；不同 worker 不会取到同一任务。
- **进程角色**：API 进程只处理请求；收信 worker 按租约分摊邮箱；处理 worker 消费队列。可以先单进程部署，结构不变。
- **发送幂等**：本地靠 `send-<id>` 文件锁与草稿回执；Web 改为草稿行上的状态机（`draft → sending → sent | uncertain`）加唯一发送尝试 id，保留“待核实不自动重发”的语义。
- 本地版的 `ownWorker` 文件锁保留，对应仓储接口的 `worker.acquire`。

### 6.4 AI 调用脱离 DSH

现有接缝已经在 `types.ts:169-179`：`AgentRunner`、`TriageRunner`、`WriterRunner`、`RuleAssistant`、`InstructionOptimizer`。DSH 实现依赖的宿主服务：`agents.create`（工具限制、执行守卫、系统提示、结果工具）、`agentDefaultModel`、`llm`、`tools.schemas`、`skills`、`sessions`（`agent.ts:47-72,117-236`，`structured.ts`，`rule-assistant.ts`，`instruction-optimizer.ts`）。

Web 实现：

- **结构化调用**（分拣、简报/周报/主题、试运行、方案生成、要求优化）：直接调用模型 API，强制调用一个结果工具拿到结构化输出；继续用现有的 `parseTriage`、`readOutput` 等校验，提示词原样复用。
- **准备 Agent**：第一版不开放 DSH 工具与技能；附件由服务端先提取文本（PDF、DOCX 等）放进输入；以后需要工具时只提供工作台自己实现的只读工具（读附件文本、查本人历史邮件），带用户鉴权。方案里的“技能”在 Web 版改为方案附带的参考资料文本。`getCapabilities` 返回 Web 可用的能力目录，方案校验按运行环境进行。
- **不变的安全约定**：来源内容是数据不是指令；不注册任何发送工具；结果只经结果工具提交。
- **新增问题**：模型密钥与按用户的用量配额、超时与重试、调用日志脱敏；邮件内容发送给模型服务商需要用户同意并符合数据合规要求。

### 6.5 其他差异

| 方面 | 本地（DSH） | Web |
| --- | --- | --- |
| 登录 | DSH 宿主负责 | 自建会话或 OIDC |
| 前端外壳 | DSH 插槽（`client/index.tsx` 的 `apply(ctx)`） | 独立单页应用，复用各视图组件；`api()` 改为可替换的传输层 |
| 任务目录与附件 | `<数据目录>/bkms-workbench/tasks/<id>` | 对象存储 + 临时目录 |
| 草稿 | 移植的 `drafts-v1.json`（不改，见 `NOTICE.md`） | `mail_drafts` 表，复用 `draft-store.ts` 的状态机与校验逻辑 |
| 时区 | `localDate()` 用主机时区（`digest.ts:10`） | 按用户时区（`feat/mail-dispatch` 的 `profile.timezone` 可复用） |
| 定时简报/周报 | 引擎 `scheduled()` | 按用户的定时任务（队列延迟任务） |
| 待办提醒 | DSH `shell.overlay` | 网页通知或邮件 |
| 后台单实例 | `ownWorker` 文件锁 | 租约 + 队列 |

## 7. 分阶段落地

**用户确认之前不进入开发**；以下是确认后的执行顺序。每个阶段一个功能分支、一个 PR，用户本地验证后合并。阶段 1 与阶段 2 都大量改动 `engine.ts`、`api.ts`，应**依次进行**，不要并行。

| 阶段 | 目标与主要改动 | 验证方式 | 主要风险 |
| --- | --- | --- | --- |
| **0 护栏与小验证** | 行为测试：补充经 `WorkbenchApi` / `Engine` 的测试（不直接操作 `Store`），阶段 1 换存储后原样复用，作为“行为不变”的依据；性能基线脚本（读写耗时、快照大小）；“核心不得引用微信”的检查（先以白名单记录现状）。在真实 DSH 中的小验证：① `better-sqlite3` 能否随插件安装并加载，两个插件同时加载是否正常（§5.8 第 1、9 项，决定驱动，D2）；② 用最小示例插件验证跨插件挂接——后端 `ctx.provide` / `inject`，前端由另一插件扩展工作台界面（D7） | `pnpm test`；基线数据与验证结果记录在 PR | 低；验证结论可能改变阶段 3、4 的做法（见各自退路） |
| **1 公共基础包 + 仓储接口 + SQLite** | 确定 `zq-sqlite` 放在哪并实现（§5.10）；65 处调用换成 §5.3 的方法，实现直接是 SQLite（Kysely）；表结构按 §5.5；搜索（方案 A）；快照拆为摘要列表 + 详情，`changeSeq` 不变时返回 `unchanged`；`claimNext` 无任务时不写入；删除 `workbench-v1.json` 逻辑（§5.9）；同步修改 `CLAUDE.md` | 阶段 0 的行为测试与现有测试通过（测试里 83 处直接用 `Store` 的改为走仓储接口）；契约测试；§5.8 其余实测（性能、强杀、Defender、搜索、备份）；用户清理旧数据后在真实邮箱上收信、分拣、起草、发送一轮 | 一次改动较大（不做 JSON 过渡）：靠阶段 0 的行为测试与附录 A 逐处对照；原生模块打包（退路 `node:sqlite`） |
| **2 渠道接口（单插件内）** | `Channel` 接口与注册表；内置邮件、微信两个实现；核心去掉 kind 分支；`Task` 类型改为通用字段（只改映射函数，不迁移数据，§4.2）；导出 `bkms-workbench/channel` | 现有 `wechat`、`workbench`、`redesign` 等测试通过；新增“假渠道”测试证明核心不改就能接第三个渠道；静态检查 `src/core` 不含微信 | 分拣/准备分支合并引入回归：先原样搬迁，再合并重复逻辑 |
| **3 前端扩展点** | `ClientChannel` 注册；微信界面迁入 `client/channels/wechat/` | `test/i18n.test.mjs`；`scripts/seed-visual-qa.mjs` 生成数据后截图检查中英文、深色、≤1000px | 本阶段先用静态注册；若阶段 0 验证出前端不能跨插件扩展，微信界面按退路暂留工作台前端 |
| **4 微信渠道插件（独立仓库）** | 新建 `bkms-workbench-wechat` 仓库（D9）：渠道实现、Python 桥与 `wxread/`（`NOTICE.md` 随迁）、前端注册、自己的中英文字典；工作台提供 `workbenchChannels` 服务并做版本检查（D10） | 真实 DSH 中安装/卸载微信插件；卸载后微信任务仍可查看；版本不相等时设置页提示升级正确的一方；只装工作台时邮件功能完整 | 两个仓库协同发布：渠道接口一变就要两边同时升级（D10 不做兼容） |
| ~~Web 版~~ | **暂缓（D3）**，内容见 §6 | | |

阶段 1 完成后，本地的读写放大问题解决，数据已在 SQLite；阶段 2 完成后，工作台（内置邮件）在 DSH 内已能独立成立，微信只是一个可不启用的渠道；阶段 4 才是物理拆分。

## 8. 问题状态

**已决（2026-10-22，见 §0.1）**
- 本地数据库：SQLite（D1）；驱动 `better-sqlite3` 优先、`node:sqlite` 退路，阶段 0 验证后定（D2）。
- Web 版：暂缓（D3）；随之暂缓的问题——用哪家模型服务、准备阶段是否需要工具与技能（§6.4）、是否支持多人共用邮箱（需要的话表上加 `workspace_id`）。
- 旧 JSON 数据：不兼容、不迁移，也不写过渡用的 JSON 实现（D4）。
- 渠道形态：每个渠道一个插件，邮件内置（D5）；渠道数据存在工作台数据库（D6）；拆分前先验证跨插件挂接（D7）。
- 多插件用 SQLite：各插件各自一个库文件，共用公共基础包（D8）。
- 微信插件：独立仓库（D9）。
- 渠道接口版本：不相等即拒绝加载并提示升级，不做兼容（D10）。
- 升级：从 SQLite 版开始靠迁移脚本保留数据，不支持降级（D11）。

**仍待决定**
1. **公共基础包 `zq-sqlite` 放在哪**：独立仓库，还是 `zq-plugins` 下的共享包；包名。阶段 1 开始时决定。
2. **阶段 0 验证的结论**：决定 SQLite 驱动，以及微信界面能否随插件一起拆出。

## 附录 A：65 处整文档读写的对照

**`src/engine.ts`（32 处）**

| 行 | 类型 | 用途 | 新方法 |
| --- | --- | --- | --- |
| 72 | read | `setLanguage` 比对 | `meta.uiLanguage` |
| 73 | mutate | 保存界面语言 | `meta.setUiLanguage` |
| 87 | mutate | 启动恢复与日志 | `tasks.recoverAfterRestart` |
| 103 | read | `tick` 读后台开关 | `config.get` |
| 110 | mutate | 定时生成失败日志 | `logs.append` |
| 158 | read | `poll` 读方案 | `config.get` |
| 168 | read | 扫描前的游标 | `ingest.cursors` |
| 171 | mutate | 新邮件建任务 + 游标 | `ingest.commit` |
| 198 | mutate | 检查失败日志 | `logs.append` |
| 215 | read | 微信设置 | `config.get` |
| 248 | read | 微信水位与待成段消息 | `config.get` + `ingest.channelState` |
| 276 | mutate | 微信水位、段落、建任务 | `ingest.commit` |
| 335 | mutate | 微信准备结果 | `tasks.completePreparation` |
| 348 | read | 分拣：方案、例子、同往来任务、联系人偏好 | `config.get` + `examples.list` + `tasks.byThreadKeys` + `contacts.get` |
| 363 | mutate | AI 分拣失败日志 | `logs.append` |
| 369 | mutate | 分拣结果 | `tasks.completeTriage` |
| 407 | mutate | 取下一个任务 | `tasks.claimNext` |
| 431 | mutate | 写回原邮件 | `tasks.saveLoaded` |
| 448 | mutate | 准备结果与自动发送 | `tasks.completePreparation` |
| 468 | mutate | 失败与重试 | `tasks.failAttempt` |
| 481 | read | 到期自动发送 | `tasks.findDueAutoSend` + `config.get` |
| 485 | mutate | 取消自动发送 | `tasks.cancelAutoSend` |
| 505 | mutate | 认领发送 | `tasks.claimSend` |
| 515 | mutate | 发送结果 | `tasks.recordSendResult` |
| 525 | mutate | 发送异常 | `tasks.recordSendResult` |
| 549 | read | 简报数据 | `tasks.forDigest` + `activity.since` |
| 552 | mutate | 保存简报 | `briefs.save` |
| 562 | read | 周报数据 | `tasks.inRange` + `activity.since` |
| 566 | mutate | 保存周报 | `reports.insert` |
| 575 | read | 主题数据 | `topics.list` + `search` |
| 582 | mutate | 主题概括与报告 | `topics.saveSummary` |
| 598 | read | 定时生成判断 | `config.get` + `briefs.get` + `reports.existsForPeriod` + `topics.list` |

**`src/api.ts`（33 处）**

| 行 | 类型 | 用途 | 新方法 |
| --- | --- | --- | --- |
| 62 | read | 快照 | `config.get` + `tasks.list` + `activity.recent` + `topics.list` + `reports.list` + `briefs.get` + `logs.recent` + `examples.list` |
| 85 | mutate | 草稿状态对账 | `tasks.reconcileDraft` |
| 134 | read | 全局偏好与提醒 | `config.get` + `tasks.attention` + `meta.changeSeq` |
| 139 | read | 邮件设置页 | `config.get` |
| 199 | mutate | 保存设置 | `config.saveSettings` |
| 209 | mutate | 保存方案 | `config.saveRule` |
| 211 | mutate | 删除学习例子 | `examples.delete` |
| 217 | mutate | 删除方案 | `config.deleteRule` |
| 219 | read | 测试方案 | `tasks.get` |
| 236 | mutate | 保存主题 | `topics.save` |
| 247 | mutate | 删除主题 | `topics.delete` |
| 250 | mutate | 编辑报告 | `reports.update` |
| 252 | mutate | 删除报告 | `reports.delete` |
| 254 | read | 方案试运行 | `tasks.recent` + `examples.list` |
| 277 | read | 撤回活动 | `activity.get` |
| 302 | mutate | 清除微信缓存日志 | `logs.append` |
| 306 | read | 重建基线前校验 | `config.checkRevision` |
| 309 | mutate | 重建基线 | `ingest.resetCursor` |
| 313 | read | 任务动作前置读取 | `tasks.get` |
| 318 | mutate | 保存建议回复 | `tasks.saveSuggestedReply` |
| 327 | mutate | 标记已在微信处理 | `tasks.markHandled` |
| 332 | mutate | 人工读取原邮件 | `tasks.saveLoaded` |
| 343 | mutate | 重试、补充、选择方案 | `tasks.requeue` |
| 378 | mutate | 不是这个方案 | `tasks.rejectRule` |
| 392 | mutate | 忽略 | `tasks.ignore` |
| 401 | mutate | 编辑草稿后接管 | `tasks.takeOver` |
| 416 | mutate | 人工发送认领 | `tasks.claimSend` |
| 419 | mutate | 人工发送结果 | `tasks.recordSendResult` |
| 423 | mutate | 人工发送异常 | `tasks.recordSendResult` |
| 436 | mutate | 核对发送结果 | `tasks.recordSendResult` |
| 450 | mutate | 恢复归档 | `tasks.restoreArchived` |
| 464 | mutate | 撤回自动发送 | `tasks.cancelAutoSend` |
| 499 | read | 下载附件 | `tasks.get` |

## 附录 B：现有 `State` 字段在新表中的去向

设计参考，用于确认没有遗漏数据；不做数据迁移（D4）。

| `State` 字段 | 表 |
| --- | --- |
| `version` | 不再使用（数据库版本由 `schema_migrations` 记录） |
| `revision` | `workbench.change_seq` |
| `configRevision` | `workbench.config_revision` |
| `settings` | `workbench.settings` |
| `rules[]` | `rules`（`position` 保持顺序） |
| `tasks[]` | `tasks`；`history` → `task_history`；`messageId` / `references` / 微信会话 → `task_links`；邮件与微信私有字段 → `channel_data`；其余 → `detail` |
| `cursors` | `channel_cursors`（`email`） |
| `logs[]` | `logs` |
| `activity[]` | `activity`（`source` → `channel`） |
| `topics[]` | `topics` |
| `reports[]` | `reports` |
| `brief` | `workbench.brief` |
| `senders` | `contact_prefs` |
| `wechat.watermarks` / `wechat.pending` | `channel_cursors` / `channel_state`（`wechat`） |
| `ruleExamples` | `rule_examples` |
| `uiLanguage` | `workbench.ui_language` |
