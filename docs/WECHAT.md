# 微信接入（只读）

微信已拆成独立的渠道插件 [workbench-weixin](https://github.com/zq-ai-labs/workbench-weixin)：读取方式、安装、名单、隐私与开发说明都在那个仓库的 README 里。

工作台这边只提供渠道接口（`src/channels/types.ts`，服务 `ctx.workbenchChannels`）和页面插槽（`client/slots.tsx`）。微信的设置（`settings.channels.wechat`）、读取进度和微信事项仍保存在工作台数据库里，卸载插件不会删除它们。

从内置版本升级：装上 workbench-weixin 后设置照常可用；早期的解密缓存 `<数据目录>/bkms-workbench/wechat-cache` 不再使用，可以手动删除，新缓存在 `<数据目录>/workbench-weixin/cache`。
