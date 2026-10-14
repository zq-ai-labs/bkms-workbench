# 从 GitHub 恢复工作台

工作台源码独立维护于私有仓库 `https://github.com/zq-ai-labs/bkms-workbench.git`。构建产物、安装包和运行数据不进入源码仓库。该仓库不是正式生产 Baseline；当前验证使用替身邮箱与模型，没有真实 SMTP 发送。

## 布局与源码

默认启动脚本使用总工作区布局：

```text
<工作区>/
  sources/deepseek-harness/
  sources/plugins/bkms-workbench/
  sources/plugins/dsh-email/
  runtime/dev/bkms-workbench/
```

工作台检出后先记录 `git rev-parse HEAD`，按该完整 commit 恢复，不以浮动分支名作为生产版本锁定。

主 DSH 兼容验证基点为 `b2d152caa7a14b75d56771f2cdd130d5505bbe69`（0.2.0-rc.2），Fork 地址由总工作区映射。还验证过 BKMS 核心 `6079a921d0d4d66169102ec2b0903439d23e2a22`（0.1.6-alpha.2）。主核心需要按其 README 安装及构建，提供已构建 CLI、Agent 和客户端服务。

## 配套邮件插件

公开的 `dsh-email@0.16.2` 不提供工作台所需 `emailWorkbench` 服务。本仓库的 `patches/dsh-email-workbench.patch` 保存配套接口、新邮件弹窗接管、文件夹目录、草稿与标准 HTML 邮件排版改动及相关测试。补丁基于原作者仓库 `https://github.com/STARDUSTLC666/dsh-email.git` 的完整 commit `43dc6367de1ee17408769ba44a7ec4bd7199df79`，保留该项目的原始历史和许可证。

在新目录克隆并应用补丁，已有邮箱仓库不要直接覆盖：

```powershell
git clone https://github.com/STARDUSTLC666/dsh-email.git sources/plugins/dsh-email
git -C sources/plugins/dsh-email switch -c codex/workbench-integration 43dc6367de1ee17408769ba44a7ec4bd7199df79
git -C sources/plugins/dsh-email apply --check ../bkms-workbench/patches/dsh-email-workbench.patch
git -C sources/plugins/dsh-email apply ../bkms-workbench/patches/dsh-email-workbench.patch
```

`lib/client.js` 是邮件项目的手写前端源码，所以补丁包含这一文件；其他 `lib/` 文件由构建生成，不需要另行保存。补丁通过后，按照邮件项目 README 安装依赖，执行 `pnpm test`（包含构建）。

## 构建及启动

在工作台目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run pack:plugin
```

需检查真实 DSH 框架兼容时，先设置 `DSH_SOURCE_ROOT` 为已构建核心的绝对路径再执行测试；未设置时对应集成测试会跳过。

双击 `启动工作台.cmd`，或执行 `powershell -File scripts/start-workbench.ps1`。默认使用独立 HOME 和 `bkms-workbench` Profile，账号及模型由用户在实例内配置。日常客户端安装两个编译后的本地插件后，需要完全退出含托盘再重开。

真实邮箱、密钥、草稿、待办及其他运行数据不在 GitHub 源码内。迁移运行数据时需独立备份同一 HOME 下的工作台数据和邮件草稿，并按 README 核对恢复边界。
