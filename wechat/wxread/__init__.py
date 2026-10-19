# -*- coding: utf-8 -*-
"""微信 4.x 本地数据库只读读取（移植自 wechatauto-replica，见 NOTICE.md）。"""
from .db import WeChatDB, auto_detect_db_dir, list_accounts  # noqa: F401

__version__ = "1.2.7.0+bkms"
