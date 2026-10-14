# 本地验证记录

日期：2026-10-14。状态：开发交付，未发布，未建立生产 Baseline。

## 组件

| 组件 | 实际来源与状态 |
| --- | --- |
| bkms-workbench | 0.1.1，独立私有源码仓库 `https://github.com/zq-ai-labs/bkms-workbench`，版本以实际检出的 Git commit 为准 |
| dsh-email | 0.16.2，基于 `43dc6367de1ee17408769ba44a7ec4bd7199df79`；工作台接口及配套改动保存为 `patches/dsh-email-workbench.patch`，恢复见 `docs/RESTORE.md` |
| 主 DSH | 0.2.0-rc.2，`b2d152caa7a14b75d56771f2cdd130d5505bbe69`；核心已有用户品牌改动，本次未修改 |
| BKMS DSH | 0.1.6-alpha.2，`6079a921d0d4d66169102ec2b0903439d23e2a22`，额外验证 Agent 接口兼容 |
| 构建工具 | Node 22.23.1、pnpm 11.7.0；DSH Profile 安装器自行使用内置 pnpm 12.3.4 |

## 自动检查

- `pnpm run check`：后端与前端严格 TypeScript 检查通过；前端检查同时纳入 build。
- 主核心下 `DSH_SOURCE_ROOT=<主核心目录> pnpm test`：27 项通过，0 失败，0 跳过。
- 配套邮件插件 `pnpm test`：364 项通过，0 失败，0 跳过（包含标准邮件排版与文件夹目录回归）。
- 两套核心分别运行 `test/agent.integration.test.mjs` 与 `test/rule-assistant.integration.test.mjs`：通过。
- 邮件仓库与控制仓库 `git diff --check`：通过。

工作台测试覆盖增量基线、已读新邮件接收、去重、多规则匹配、任务/草稿版本、恢复和重试、来源键去重、草稿编辑、明确确认发送、发送不确定保护、存储锁与损坏文件保护、请求来源和大小限制、UIDVALIDITY 变化、原邮件及附件读取、真实 Cordis 服务加载/卸载、认证载体和后台排空。

真实 Agent 框架测试使用模型替身，验证结构化结果提交、所选技能、精确工具授权、任务目录边界、取消与卸载。`email_draft`、`email_watch`、`email_attachment` 不开放为后台规则工具；原附件由 Engine 通过邮件服务下载，避免模型改变其他草稿和游标。

## 实际浏览器

使用独立开发 HOME、Profile `bkms-workbench`、端口 9186 启动真实 DSH：侧栏入口、规则编辑和保存成功，示例规则保持禁用，后台保持暂停。

另在 `runtime/poc/bkms-workbench-visual-qa-20261014` 创建合成演示数据，使用端口 9187 验证待审核/待补充详情、人工修改并保存草稿（持久化 revision 增加）。演示邮箱均为 `.test`，`visual-demo` 账号未配置，不可真实发送。演示数据未写入日常开发 HOME。

已检查 1440×1000 宽屏、520×850 窄屏、浅色和深色。窄屏实际 `document.documentElement.scrollWidth === innerWidth === 520`，列表与详情纵向排列。

实际页面截图保存在工作区 `runtime/dev/bkms-workbench/validation/`，仅作本机验收，不含真实邮件与凭据。

## 交付与限制

### GitHub 源码交付

按用户要求建立独立私有仓库 `zq-ai-labs/bkms-workbench`，保留原本地目录。源码、依赖锁、测试、文档和配套邮件补丁进入版本控制；编译产物及运行数据由 `.gitignore` 排除。提交身份采用该 GitHub 账号的 noreply 邮箱，仅设置本项目，不改全局 Git 身份。

`patches/dsh-email-workbench.patch` 已在独立 POC 目录从邮件上游精确 commit 的干净归档恢复，通过 `git apply --check`、实际应用、离线 frozen-lockfile 安装和全部 364 项测试。工作台交付前再次完成主核心下 27 项测试，0 失败、0 跳过。恢复说明见 `RESTORE.md`；源码推送不等于正式生产发布。

### 全局中英文切换

注册并订阅 DSH LocaleRuntime，界面使用同一全局语言偏好。新增 3 项检查覆盖界面翻译缺漏、占位符一致性、动态业务内容不被改写、历史提示的双向翻译、订阅清理以及真实 DSH 语言服务与第三方语言 fallback。API 与 Agent 集成测试追加英文界面偏好传递与业务语言、筛选字面值保留。主核心全部 27 项通过；旧 BKMS 核心的语言、Agent 与方案生成 5 项通过。

隔离端口 9191，使用真实工作台前端、真实 WorkbenchApi 和真实 DSH LocaleRuntime，邮箱与 AI 生成使用替身。浏览器验收中英文即时切换、任务状态筛选、方案及草稿未保存编辑保留、历史与运行记录、文件夹下拉、AI 失败提示及测试匹配结果重新翻译、英文高级设置和发送审核弹窗。没有连接真实邮箱、模型或发送邮件，也没有更改日常客户端语言偏好。

英文 520×850 验收无横向溢出（`scrollWidth === innerWidth === 520`）；正文和文件夹中的中文业务数据按原文显示。截图 `runtime/dev/bkms-workbench/validation/workbench-en.png`、`workbench-en-narrow.png` 和 `workbench-send-en.png`。未知第三方错误、模型自定义内容及 SMTP 响应仍保留原语言，避免隐藏原始信息。已编译本地链接源码，日常 DSH2 首次加载更新需完整退出含托盘再重开。

### 邮件处理方案与一句话创建

界面统一改名「邮件处理方案」，规则存储结构保持兼容。新增真实 DSH 模型替身集成测试：自然语言通过单一结果工具生成草稿、当前模型选择、筛选限制说明、能力目录校验、拒绝不可用或危险工具/技能、无有效结果、取消与 Agent 清理。API 测试验证生成不保存、不启动处理、不发送，描述/账号/文件夹校验、单实例生成互斥及卸载取消排空。

文件夹测试覆盖真实 EmailPool LIST 映射、中文层级路径、`\\Noselect` 容器排除、账号校验、跨邮箱共同目录、旧邮件服务缺少接口时的错误提示。生成方案使用默认优先级100、重试1次和邮箱配置收件箱。

独立 `runtime/poc/bkms-workbench-visual-plan-*` 下使用真实插件前端与 WorkbenchApi、合成邮箱及生成替身（9191端口）检查新建默认值、下拉选择中文层级文件夹、一句话生成及核对保存、保存后再次加载、生成失败保留描述并转手动、高级设置。检查1280×720和520×850，窄屏 `scrollWidth === innerWidth === 520`。生成和文件夹数据均为替身；未调用用户真实模型或邮箱，不能作为真实模型生成质量的证明。

截图：`runtime/dev/bkms-workbench/validation/mail-plan-ai-review.png` 与 `mail-plan-ai-narrow.png`。完整重启用户 DSH2 客户端后，两个本地源码链接会载入新接口和前端；未修改用户邮箱、已有方案或待办。

### 标准邮件格式补充验收

新回复的 Agent 指令加入称呼、短段落、紧凑事项编号及真实署名要求；真实 DSH 替身模型收到这些规范的检查通过。已验证中文/CRLF、连续空白行收敛、编号与段内换行、HTML 转义、空正文、草稿内容不变，以及从实际草稿预览到 mock SMTP 的 HTML 一致性。Nodemailer 内存传输生成 UTF-8 multipart/alternative，MIME 解析后的主题、HTML 与中文正文均通过。

在独立 localhost 示例页视觉检查新邮件布局：白底、中文无衬线字体、紧凑段落与编号列表。合成示例保存在 `runtime/dev/bkms-workbench/validation/email-format-standard-v1.html`。没有向真实收件人发信；不同收件客户端可能对字体进行替换。

已确认用户 DSH2 的 `desktop` Profile 对两个插件使用本地源码 `link:`；构建更新后需要完全退出客户端含托盘再打开，以刷新后端模块。未更改真实邮箱、规则或历史草稿。新写作规范作用于后续生成；新排版作用于之后通过人工草稿发送的邮件。

`dist/bkms-workbench-0.1.1.tgz` 与 `dist/dsh-email-0.16.2.tgz` 为本地编译安装包，配套 SHA256SUMS.txt。邮件包版本号沿用上游，但内容已扩展，必须使用这份本地包或对应源码；公开 npm 同版本不包含工作台接口。

尚未连接真实邮箱、真实模型或执行真实 SMTP 发送，不能据此声明真实投递成功。上线前需要用专用测试邮箱完成一封新邮件的完整验证，并核对模型和工具权限。启动默认暂停，用户配置账号、模型与规则后自行开启。

单封邮件一个任务；补充邮件自动归并、多人分派、ERP 写入和流程画布不在本版。附件下载副本暂不自动清理，备份归档需连同邮件草稿目录处理。源码提交与推送按用户授权执行，未发布发行版，也未更新生产基线。

### 工作台设置与待办提醒（2026-10-14）

设置菜单改为独立「工作台设置」，保留工作台业务页面在侧栏。新增实例持久化的 `showWorkbench` 和 `notifyNewTodo`，默认显示入口、关闭提醒。旧版数据读入时补齐默认值；API 使用原有配置版本控制和局部更新，避免偏好保存误改后台启停、检测间隔或方案。轻量 `preferences` 接口只返回设置及需处理任务的 ID/状态，不读取邮箱或草稿正文。

工作台顶部移除 `BKMS WORKBENCH` 字样及其样式，只显示「任务工作台」标题；已重新构建并确认前端产物不包含该字样。提交前使用主核心重新执行完整测试，31 项通过，0 skip。

主核心 `DSH_SOURCE_ROOT` 下 31 项测试通过，0 skip，覆盖原流程、配置迁移/重载、开关独立性、非法字段与间隔、冲突保护、提醒接口数据范围及提醒基线/去重。没有启动真实邮箱或发送邮件。

隔离 `runtime/poc/bkms-workbench-settings-qa` 使用真实工作台前端、WorkbenchApi/Store 与合成任务，浏览器验收设置页与业务页分开、即时隐藏/恢复侧栏、开启后新增任务提醒、关闭立即移除提醒、重开/刷新后历史待办静默，以及中英文实时切换。英文 520×850 DOM 检查 `scrollWidth === innerWidth === 520`；窄屏截图接口无法捕获，因此没有把它声明为窄屏截图验收。中文桌面布局与深色卡片/文字样式也已检查。当前客户端为本地 `link:`，构建后需完全退出客户端含托盘再启动；未强制关闭用户进程，也未改用户真实偏好。
