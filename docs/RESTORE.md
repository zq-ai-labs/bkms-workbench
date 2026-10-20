# 从 GitHub 恢复工作台

工作台源码独立维护于私有仓库 `https://github.com/zq-ai-labs/bkms-workbench.git`。构建产物、安装包和运行数据不进入源码仓库。该仓库不是正式生产 Baseline；当前验证使用替身邮箱与模型，没有真实 SMTP 发送。

## 布局与源码

默认启动脚本使用总工作区布局：

```text
<工作区>/
  sources/deepseek-harness/
  sources/plugins/bkms-workbench/
  runtime/dev/bkms-workbench/
```

工作台检出后先记录 `git rev-parse HEAD`，按该完整 commit 恢复，不以浮动分支名作为生产版本锁定。

主 DSH 兼容验证基点为 `b2d152caa7a14b75d56771f2cdd130d5505bbe69`（0.2.0-rc.2），Fork 地址由总工作区映射。还验证过 BKMS 核心 `6079a921d0d4d66169102ec2b0903439d23e2a22`（0.1.6-alpha.2）。主核心需要按其 README 安装及构建，提供已构建 CLI、Agent 和客户端服务。

## 邮件模块

邮件收发已内置在 `src/mail/`（移植自 dsh-email，来源和修改见 `src/mail/NOTICE.md`），不再需要克隆 dsh-email 或应用补丁。依赖（imapflow、mailparser、nodemailer、yaml）随 `pnpm install --frozen-lockfile` 安装。

## 构建及启动

在工作台目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run pack:plugin
```

需检查真实 DSH 框架兼容时，先设置 `DSH_SOURCE_ROOT` 为已构建核心的绝对路径再执行测试；未设置时对应集成测试会跳过。

双击 `启动工作台.cmd`，或执行 `powershell -File scripts/start-workbench.ps1`。默认使用独立 HOME 和 `bkms-workbench` Profile，账号及模型由用户在实例内配置。日常客户端安装编译后的本地插件后，需要完全退出含托盘再重开。

真实邮箱、密钥、草稿、待办及其他运行数据不在 GitHub 源码内。迁移运行数据时备份同一 HOME 下的 `data/bkms-workbench/`（含 `mail/` 中的邮箱账号和草稿），并按 README 核对恢复边界。
