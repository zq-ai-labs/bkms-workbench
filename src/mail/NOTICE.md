# 内置邮件模块来源说明

`src/mail/` 中的邮件收发代码来自 [dsh-email](https://github.com/STARDUSTLC666/dsh-email)（MIT 许可，版权声明见同目录 `LICENSE`）：

- 上游版本：0.16.2，提交 `43dc6367de1ee17408769ba44a7ec4bd7199df79`
- 加上本仓库原 `patches/dsh-email-workbench.patch` 中的工作台接口改动（增量收信、工作台读信、文件夹目录、草稿、标准 HTML 排版）。该补丁不再需要单独保存，相关内容已包含在这些文件里。

## 文件对照

| 文件 | 来源 | 修改 |
| --- | --- | --- |
| `config.ts` `mail-client.ts` `parse.ts` `recipient-policy.ts` `email-format.ts` `types.ts` `oauth2.ts` `oauth2-storage.ts` `mailparser.d.ts` | 上游 + 补丁，原样复制 | 无 |
| `draft-store.ts` | 上游 + 补丁 | 构造函数增加存储目录参数（工作台放在 `<数据目录>/bkms-workbench/mail/drafts`） |
| `drafts.ts` | 上游 `draft-web.ts` | 账号和收件人规则改由工作台账号存储提供；去掉设置页规则编辑接口和插件路由安装；路由改为 `/api/bkms-workbench/drafts` |
| `service.ts` 中的 `createEmailWorkbenchService` | 上游 `workbench.ts` | 去掉新邮件弹窗相关接口 |
| `accounts.ts`、`service.ts` 其余部分 | 工作台新增 | 账号存储、连接池生命周期、连接测试、对其他插件的只读接口 |

未移植：对话中的邮件工具（`tools.ts`、`tool-contract.ts`）、对话发信审批（`approval.ts`）、DSH 设置页（`web.ts`、`settings.ts`、`client.js`）、新邮件弹窗与提醒图片、旧设置迁移（`legacy-settings.ts`）。

OAuth2 代码（`oauth2.ts`）保留但暂未启用：账号页目前只接受授权码方式，Outlook / Microsoft 365 登录在后续版本接入。

## 同步上游修复

上游修复了 IMAP/SMTP 兼容问题时，对比上表中“原样复制”的文件，直接替换后运行 `pnpm test`。`test/mail/` 中的测试移植自上游同名测试（去掉了对话工具和设置页相关用例），可用来确认替换后行为一致。
