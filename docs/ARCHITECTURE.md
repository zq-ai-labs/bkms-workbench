# 架构与接口

## 插件职责

`dsh-email` 保持独立，提供 `ctx.emailWorkbench` v1 服务，复用账号、连接池、草稿、收件人策略和 SMTP 回执。`bkms-workbench` 消费服务，拥有规则、持久化任务、队列及前端。无核心源码修改；无重复邮箱凭据。

## 主要模块

| 文件 | 职责 |
| --- | --- |
| src/index.ts | Cordis 服务生命周期、依赖注入、鉴权 Connection 路由 |
| src/store.ts | 格式校验、文件锁、原子存储、worker 所有权 |
| src/rules.ts | 规则输入校验、条件匹配、优先级 |
| src/engine.ts | 增量收件、去重、排队、重试、生成草稿 |
| src/agent.ts | 隔离 DSH Agent、技能加载、精确工具授权、文件路径约束、结构化结果 |
| src/rule-assistant.ts | 自然语言方案草稿生成、能力目录校验与受限生成 Agent |
| src/api.ts | 快照、配置、人工操作、草稿审核发送、冲突校验 |
| client/index.tsx | 标准 main/sidebar/settings 插槽、交互界面 |

## 2026-10 重构概览

| 文件 | 职责 |
| --- | --- |
| src/triage.ts | AI 分拣（类别、紧急度、下一步、选择方案）与无模型时的规则判断 |
| src/structured.ts | 无工具、只提交一个结构化结果的隔离 Agent 运行 |
| src/writer.ts | 每日简报、周报草稿、主题概括和方案试运行的生成 |
| src/digest.ts | 待办判定、会话关联、主题匹配，以及简报/周报/主题的输入数据与模板 |
| src/sources.ts | 信息源适配器约定与连接状态 |
| client/index.tsx | 插件入口、工作台外壳、路由与共享状态 |
| client/views.tsx, workspace.tsx, topics.tsx, plans.tsx, settings.tsx | 各视图；workspace 为审核与详情共用的 AI 产出 + 原始信息两栏 |
| client/lib.ts, ui.tsx, store.ts, context.ts | 接口、类型、通用组件、偏好与提醒状态、视图上下文 |

数据仍为版本 `1`，任务状态集合不变。新增字段全部可选：任务的 `triage`、`checks`、`autoSend`；方案的 `semantic`、`exclude`、`autonomy`、`sources`；顶层 `activity`、`topics`、`reports`、`brief`、`senders`；设置中的 `triage`、`undoMinutes`、`briefEnabled/briefTime`、`weeklyEnabled/weeklyDay/weeklyTime`、`meetingBriefMinutes`。默认值在读取时计算，不写回存储，旧数据无需迁移；旧版本插件仍能读取新数据（会忽略新增字段）。方案只在设置了非默认值时才写入新字段。

处理链路：`poll` 新建任务时，分拣开启则为 `queued` + `triage.state = pending`；`processNext` 先读取原邮件并分拣，命中方案后回到 `queued` 再准备，未命中时归档（`ignored` + `triage.archived`）或 `unmatched`。分拣失败最多重试 2 次，手动重试会重新分拣。准备完成后若方案自主级别允许且通过 `autoSendDecision` 检查，写入 `autoSend`；`sendDue` 在撤回窗口结束后经 `drafts.preview` 和 `drafts.send` 发送，草稿版本变化、收件人被禁止或预览失败时取消并转人工。人工保存草稿、发送、忽略、重新处理均通过 `takeOver` 取消自动发送。

新增动作：`restore`、`cancelAutoSend`、`undoActivity`、`generateBrief`、`generateReport`、`refreshTopic`、`saveTopic`、`deleteTopic`、`saveReport`、`deleteReport`、`trialRule`。`snapshot` 额外返回 `activity`、`topics`（含匹配数量）、`reports`、`brief`、`defaults`、`sources`，以及每个任务的 `relatedIds`（Message-ID 引用）、`possibleIds`（同发件人同主题，仅建议）、`topicIds`、`attention`。请求可附带 `uiLanguage`，用于定时生成的语言。

## 数据和状态

数据版本为 `1`；全局写版本与配置版本分开，后台任务更新不会让正在编辑的规则无故冲突。任务有独立 revision、规则快照、收件 UID/UIDVALIDITY、执行次数、来源键和历史。

任务主链路为 `queued → running → review → sending → sent`；报告为 `completed`。另有 `needs_info`、`failed`、`uncertain`、`unmatched`、`ignored`。邮箱游标与新建任务同一事务保存。新邮件按账号、文件夹、UIDVALIDITY、UID 去重，不依赖未读状态。

自动重试复用准备来源键；同一准备执行创建草稿后即使中断，也不会重复创建草稿。人工重新生成则分配新来源键，保留此前草稿。

## HTTP

标准 `ctx.connection.fetch.register` 注册 `POST /api/bkms-workbench`。宿主负责登录、Host/Origin 信任和传输；插件额外要求 JSON、`x-bkms-workbench: 1`、同来源及 256 KiB 请求上限。返回 `{ok:true,value}` 或 `{ok:false,error,code}`。

动作：`snapshot`、`saveSettings`、`saveRule`、`deleteRule`、`testRule`、`poll`、`resetBaseline`、`loadMail`、`runRule`、`retry`、`supplement`、`ignore`、`saveDraft`、`previewSend`、`send`。配置写入要求配置 revision，任务写入要求任务 revision，草稿写入和发送另需 draftRevision。发送必须提供服务端预览 planId 和 confirmed:true。

`folders` 按已配置邮箱读取文件夹，全部邮箱返回共同路径；`snapshot.accounts` 附加 `inboxFolder`，供新建默认值使用。`generateRule` 接受 `{ description, account, folder }`，返回 `{ rule, warnings }`，不修改配置或任务。描述上限 8000 字，每实例同时只接受一次生成，超时 120 秒；卸载取消生成并排空已接受请求。保存仍调用有配置版本校验的 `saveRule`。

方案生成使用独立 DSH Agent，仅开放 `bkms_workbench_rule_suggestion` 结果工具，无业务工具或技能执行权限。结果按同一 `validateRule` 校验，推荐的工具与技能必须属于当前可选目录，禁止发送/写入能力。邮箱及文件夹由服务端固定为用户选择，AI 不能改变范围；优先级和重试使用默认值。受限筛选要求写入 `warnings`，空条件强制补充全范围提醒。生成后不自动保存或开启全局处理。

`POST /api/bkms-workbench/attachment` 接受任务 ID、任务版本与零基附件索引，核对来源邮件及 UIDVALIDITY，复制到任务私有目录后下载。实际 IMAP 下载连接再次核对 UIDVALIDITY，防止重连后指向其他邮件。单附件上限 20 MiB；失败删除未完成副本。

草稿附件添加与预览下载复用邮件插件的认证路由，不维护第二份草稿附件。上传增加草稿 revision，使已有发送预览失效。前端同时比较任务版本和草稿版本，允许用户加载其他页面保存后的最新内容。

## Agent 权限

每次准备创建独立 root Agent，使用 DSH 默认模型和任务工作目录，不继承用户会话预设。邮件 source 使用单独类型，避免邮件中的 `$skill` 自动加载任意技能。规则选择的技能通过真实 skills 服务读取；工具使用精确授权和执行 guard。

结构化结果只能经 `bkms_workbench_result` 工具成功执行后提交。无结构化结果、Agent 非正常结束、超时或取消均失败，不用普通结束文本猜测草稿。文件工具只允许任务目录内实际路径，禁止编辑器写命令；第三方工具内部行为需管理员信任。

## 邮件正文展示

草稿继续只保存 `text`，不保存模型生成的 HTML。邮件插件 `src/email-format.ts` 对正文进行 HTML 转义并生成确定性、无外链资源的标准排版。预览附加 `bodyHtml` 和 `bodyFormat: standard-v1`；两个草稿界面在无脚本权限的 sandbox iframe 内显示，兼容旧服务时使用纯文本。`EmailPool.sendPrepared` 使用同一渲染器，交给 Nodemailer 生成 UTF-8 multipart/alternative 邮件。原有直接邮件工具的发送行为不变。

Agent 的默认写作规范强调短段落与真实署名；规则及人工补充可指定语言、语气和署名，不迁移或重写历史草稿。

## 全局语言

前端声明 `locale` 注入，在 `bkms-workbench` 命名空间向 DSH LocaleRuntime 注册双语字典并使用其 bind/subscribe/getSnapshot 接口。`useSyncExternalStore` 按语言和 revision 更新整棵工作台，不使用语言 key 重新挂载表单，也不保存第二份语言偏好。语言包沿用主服务的 fallback 链。

`client/en.json` 保存界面翻译，`client/system-en.json` 保存系统错误与历史记录模板。旧存储中的中文提示在显示层映射，不迁移任务数据；动态方案名称和邮箱路径保持原文。未知服务错误保留原文，避免丢失诊断细节。邮件正文、用户描述与方案字段不经过系统消息映射。

`generateRule` 可附带 `uiLanguage: zh | en`，仅影响新候选的名称与 AI warnings；筛选字面值、用户明确指定的邮件语言及处理要求保持原意。缺少字段的旧客户端请求仍兼容。

## 部署要求

源码由独立私有仓库 `zq-ai-labs/bkms-workbench` 维护，配套邮件改动以基于原上游精确 commit 的补丁保存，恢复见 `RESTORE.md`。提交源码不代表生产验证完成；生产准备仍需完成真实模型、真实邮箱和客户端验证，并锁定各组件及补丁的精确版本。
