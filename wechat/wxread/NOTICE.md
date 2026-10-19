# wxread 来源说明

`wxread` 是 [wechatauto-replica](https://github.com/zq-ai-labs/wechatauto-replica) 1.2.7.0（提交 `d322c4a`）中数据库读取部分的移植，使工作台不需要另外安装 wechatauto。原项目以 Apache License 2.0 发布，许可证全文见 `LICENSE`。

| 文件 | 来源 | 修改 |
| --- | --- | --- |
| `db.py` | `wechatauto/db.py` | 日志改用标准 `logging`（不再替换 `sys.stdout`）；AES 解密改调 `_crypto.py`；zstd 依次尝试 `zstandard`、Python 3.14 的 `compression.zstd`、`_zstd.py`；诊断提示文字。读取逻辑未改。 |
| `_crypto.py` | 新增 | AES-256-CBC：优先 `cryptography`，否则用 Windows 自带的 CNG（bcrypt.dll）；首次使用前做 NIST 已知答案自检。 |
| `_zstd.py` | 新增 | 纯 Python 的 Zstandard 解压（RFC 8878），只用于兜底。 |

只移植读取。原项目的发送、界面自动化、朋友圈、媒体下载等能力均未包含，工作台也不调用。

## 跟随上游升级

微信升级后若读不到（密钥提取依赖与版本相关的内存偏移），先升级上游项目验证，再把新版 `wechatauto/db.py` 复制到这里，重新应用上表中的几处修改（文件开头注释列出了位置），运行 `python -m unittest wechat/test_bridge.py` 和 `pnpm test`。

在上游修好但这里还没跟进之前，可以在工作台设置的「读取组件」里填写上游项目目录，桥会优先使用该目录中的 `wechatauto`。
