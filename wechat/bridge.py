# -*- coding: utf-8 -*-
"""工作台微信只读桥。

由工作台后台以子进程启动，经标准输入/输出逐行交换 JSON：
    请求 {"id": 1, "method": "poll", "params": {...}}
    响应 {"id": 1, "ok": true, "result": ...} 或 {"id": 1, "ok": false, "error": "...", "code": "..."}

只读：只调用 wechatauto 的数据库读取接口（WeChatDB），从不导入或调用发送、
界面自动化相关能力。哪些会话可以读取由工作台按白名单/黑名单决定，本进程只
返回被请求的会话的数据；会话列表只返回名称和类型，不返回消息摘要。

--fixture <file> 使用 JSON 样例代替真实数据库，用于测试和演示。
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections import ChainMap
from datetime import datetime, timezone

PROTOCOL = 1
SYSTEM_USERS = {
    "filehelper", "weixin", "fmessage", "floatbottle", "medianote", "notifymessage", "newsapp",
    "brandsessionholder", "brandservicesessionholder", "qqmail", "qmessage", "tmessage", "qqsync",
    "notification_messages", "opencustomerservicemsg", "@placeholder_foldgroup", "lbsapp", "shakeapp",
    "voicevoipapp", "voiceinputapp", "linkedinplugin", "masssendapp", "feedsapp", "facebookapp",
    "readerapp", "blogapp", "meishiapp", "officialaccounts", "helper_entry", "exmail_tool",
}
GROUP_PREFIX = re.compile(r"^([A-Za-z0-9_\-@.]{3,80}):\n")
MAX_TEXT = 4000


def kind_of(username: str) -> str:
    """会话类型：person / group / official / system。企业微信联系人（@openim）按个人处理。"""
    u = (username or "").strip()
    if not u or u in SYSTEM_USERS or u.startswith("@") or u.endswith("@placeholder_foldgroup"):
        return "system"
    if u.endswith("@chatroom"):
        return "group"
    if u.startswith("gh_"):
        return "official"
    return "person"


def iso(ts) -> str:
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


def _find(node, path):
    found = node.find(path) if node is not None else None
    return (found.text or "").strip() if found is not None and found.text else ""


def _xml(content: str):
    """解析消息里的 XML（可能前面带杂项字节或被转义）。解析失败返回 None。"""
    if not content:
        return None
    text = content
    if "&lt;msg" in text[:200] and "<msg" not in text[:200]:
        text = html.unescape(text)
    start = text.find("<msg")
    if start < 0:
        start = text.find("<?xml")
    if start < 0:
        return None
    text = text[start:]
    end = text.rfind("</msg>")
    if end >= 0:
        text = text[:end + 6]
    try:
        return ET.fromstring(text)
    except ET.ParseError:
        return None


def _strip_tags(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


def render(mtype, content: str):
    """把一条消息变成可读文本；返回 (text, quote)。quote 为被引用消息 {sender, text}。"""
    content = content or ""
    if mtype == "文本":
        return content.strip(), None
    simple = {"图片": "[图片]", "语音": "[语音]", "视频": "[视频]", "动画表情": "[表情]", "音视频通话": "[通话]", "红包": "[红包]"}
    if mtype in simple:
        return simple[mtype], None
    if mtype == "位置":
        node = _xml(content)
        loc = node.find("location") if node is not None else None
        label = (loc.get("poiname") or loc.get("label") or "") if loc is not None else ""
        return ("[位置] " + label).strip(), None
    if mtype == "系统消息":
        node = _xml(content)
        if node is not None:
            return _strip_tags("".join(node.itertext()))[:MAX_TEXT] or "[系统消息]", None
        return _strip_tags(content)[:MAX_TEXT] or "[系统消息]", None
    if mtype == "文件/链接/卡片":
        node = _xml(content)
        app = node.find("appmsg") if node is not None else None
        if app is None:
            return "[分享]", None
        title, kind = _find(app, "title"), _find(app, "type")
        if kind == "57":
            ref = app.find("refermsg")
            quoted = _find(ref, "content")
            inner = _xml(quoted)
            if inner is not None:
                inner_app = inner.find("appmsg")
                quoted = _find(inner_app, "title") if inner_app is not None else "[消息]"
            quoted = GROUP_PREFIX.sub("", quoted)
            return title, {"sender": _find(ref, "displayname"), "text": quoted[:500]}
        labels = {"6": "[文件]", "5": "[链接]", "33": "[小程序]", "36": "[小程序]", "19": "[聊天记录]", "51": "[视频号]", "4": "[链接]", "3": "[音乐]"}
        if kind == "2000":
            return "[转账]", None
        if kind == "2001":
            return "[红包]", None
        return (labels.get(kind, "[分享]") + " " + title).strip(), None
    return "[消息]", None


def mentions(msg_source: str, self_wxid: str) -> bool:
    """群消息是否 @ 了我（含 @所有人）。"""
    if not msg_source or not self_wxid:
        return False
    m = re.search(r"<atuserlist>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</atuserlist>", msg_source, re.S)
    if not m:
        return False
    users = {u.strip() for u in m.group(1).split(",") if u.strip()}
    return self_wxid in users or "notify@all" in users


def normalize(row: dict, chat: str, self_wxid: str, self_names, names: dict) -> dict:
    sender = str(row.get("sender_username") or "").strip()
    if sender.isdigit():
        sender = ""
    content = row.get("content")
    content = content if isinstance(content, str) else ("" if content is None else str(content))
    group = chat.endswith("@chatroom")
    if group:
        m = GROUP_PREFIX.match(content)
        if m:
            sender = sender or m.group(1)
            content = content[m.end():]
    mtype = row.get("type")
    if mtype == "系统消息":
        sender = ""
    elif not sender and not group:
        # 私聊里解析不到发送者时视为对方；自己发出的消息都能解析到本人 wxid。
        sender = chat
    is_self = bool(self_wxid) and sender == self_wxid
    text, quote = render(mtype, content)
    out = {
        "seq": int(row.get("sort_seq") or 0),
        "at": iso(row.get("create_time")),
        "sender": sender,
        "senderName": (self_names[0] if is_self and self_names else names.get(sender) or sender) if sender else "",
        "self": is_self,
        "type": mtype if isinstance(mtype, str) else "其他",
        "text": (text or "")[:MAX_TEXT],
    }
    if quote:
        out["quote"] = quote
    if group and not is_self:
        at_me = mentions(row.get("msg_source") or "", self_wxid)
        if not at_me and self_names and "@" in text:
            at_me = any(("@" + n) in text for n in self_names if n)
        if not at_me and quote and self_names and quote.get("sender") in self_names:
            at_me = True
        if at_me:
            out["mentionsMe"] = True
    return out


class FixtureDB:
    """--fixture 用的内存数据库，接口与 WeChatDB 中本桥用到的部分一致。"""

    def __init__(self, path: str):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.data = data
        self._self = data["self"]

    def get_self_info(self):
        return dict(self._self)

    def get_sessions(self, limit=100):
        return list(self.data.get("sessions", []))[:limit]

    def nickname_map(self, refresh=False):
        return {u: (c.get("remark") or c.get("nick_name") or u) for u, c in self.data.get("contacts", {}).items()}

    def search_contact(self, keyword):
        out = []
        for u, c in self.data.get("contacts", {}).items():
            if keyword in u or keyword in (c.get("nick_name") or "") or keyword in (c.get("remark") or ""):
                out.append({"username": u, "nick_name": c.get("nick_name", ""), "remark": c.get("remark", "")})
        return out[:50]

    def get_group_members(self, chat):
        return list(self.data.get("groups", {}).get(chat, []))

    def _rows(self, chat):
        return sorted(self.data.get("messages", {}).get(chat, []), key=lambda r: r["sort_seq"])

    def get_messages(self, chat, limit=20, offset=0):
        rows = list(reversed(self._rows(chat)))
        return [dict(r) for r in rows[offset:offset + limit]]

    def get_new_messages(self, chat, since_seq=0, limit=200):
        return [dict(r) for r in self._rows(chat) if r["sort_seq"] > since_seq][:limit]

    def append(self, chat, row):
        self.data.setdefault("messages", {}).setdefault(chat, []).append(row)


def open_real_db(workdir: str):
    """打开真实微信数据库。本进程的标准输出留给协议，库的打印改到标准错误。"""
    from wechatauto.db import WeChatDB  # noqa: 只读接口

    original = WeChatDB._msg_row_to_dict

    def with_source(self, r, maps=None):
        # 库已经查出了 source 列（群聊 @ 列表在其中），只是没有返回；这里补上，不改其他字段。
        d = original(self, r, maps)
        try:
            src = r["source"]
        except (KeyError, IndexError):
            src = None
        if isinstance(src, bytes):
            src = WeChatDB._friendly_content(src, "文本")
            if src == "[文本]":
                src = ""
        d["msg_source"] = src or ""
        return d

    WeChatDB._msg_row_to_dict = with_source
    os.makedirs(workdir, exist_ok=True)
    return WeChatDB(workdir=workdir)


class Bridge:
    def __init__(self, opener):
        self._opener = opener
        self._db = None
        self._names = {}
        self._names_at = 0.0
        self._members = {}

    @property
    def db(self):
        if self._db is None:
            self._db = self._opener()
        return self._db

    def _self(self):
        info = self.db.get_self_info()
        wxid = info.get("username") or ""
        names = [n for n in (info.get("nick_name"), info.get("remark")) if n]
        return wxid, names

    def names(self):
        if time.time() - self._names_at > 600 or not self._names:
            self._names = self.db.nickname_map(refresh=True)
            self._names_at = time.time()
        return self._names

    def _chat_names(self, chat):
        if not chat.endswith("@chatroom"):
            return self.names()
        cached = self._members.get(chat)
        if cached is None or time.time() - cached[0] > 600:
            members = {}
            for m in self.db.get_group_members(chat):
                members[m["username"]] = m.get("remark") or m.get("nick_name") or m["username"]
            cached = (time.time(), members)
            self._members[chat] = cached
        # 我给联系人设的备注优先，其次是群成员名。
        return ChainMap(self.names(), cached[1])

    def _normalize(self, rows, chat):
        wxid, self_names = self._self()
        names = self._chat_names(chat)
        return [normalize(r, chat, wxid, self_names, names) for r in rows]

    # -- methods --------------------------------------------------------
    def status(self, params):
        wxid, names = self._self()
        try:
            import wechatauto  # noqa
            version = getattr(wechatauto, "__version__", "")
        except Exception:
            version = "fixture" if isinstance(self._db, FixtureDB) else ""
        return {"protocol": PROTOCOL, "wxid": wxid, "name": names[0] if names else wxid, "library": version}

    def chats(self, params):
        limit = max(1, min(int(params.get("limit", 500)), 2000))
        names = self.names()
        out = []
        for s in self.db.get_sessions(limit=limit):
            u = s.get("username") or ""
            k = kind_of(u)
            if k in ("system", "official"):
                continue
            out.append({"id": u, "name": names.get(u) or u, "kind": k, "lastAt": iso(s.get("last_time"))})
        return out

    def search(self, params):
        q = str(params.get("q", "")).strip()[:50]
        if not q:
            return []
        out = []
        for c in self.db.search_contact(q):
            u = c.get("username") or ""
            k = kind_of(u)
            if k in ("system", "official"):
                continue
            out.append({"id": u, "name": c.get("remark") or c.get("nick_name") or u, "kind": k})
        return out[:50]

    def latest(self, params):
        out = {}
        for chat in params.get("chats", [])[:500]:
            rows = self.db.get_messages(chat, limit=1)
            out[chat] = int(rows[0]["sort_seq"]) if rows else 0
        return out

    def poll(self, params):
        limit = max(1, min(int(params.get("limit", 100)), 500))
        out = {}
        for chat, seq in (params.get("watermarks") or {}).items():
            rows = self.db.get_new_messages(chat, int(seq or 0), limit)
            if rows:
                out[chat] = self._normalize(rows, chat)
        return out

    def history(self, params):
        chat = str(params.get("chat", ""))
        limit = max(1, min(int(params.get("limit", 50)), 200))
        offset = max(0, int(params.get("offset", 0)))
        rows = self.db.get_messages(chat, limit=limit + 1, offset=offset)
        more = len(rows) > limit
        rows = list(reversed(rows[:limit]))
        return {"messages": self._normalize(rows, chat), "more": more}

    def fixture_append(self, params):
        if not isinstance(self._db, FixtureDB):
            raise RuntimeError("only available with --fixture")
        self._db.append(params["chat"], params["row"])
        return True


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", default=os.path.join(os.path.expanduser("~"), ".dsh", "wechat-cache"))
    parser.add_argument("--fixture")
    args = parser.parse_args(argv)
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    out = sys.stdout
    sys.stdout = sys.stderr  # 库内的 print 不得混入协议
    bridge = Bridge(lambda: FixtureDB(args.fixture) if args.fixture else open_real_db(args.workdir))
    methods = {"status": bridge.status, "chats": bridge.chats, "search": bridge.search, "latest": bridge.latest,
               "poll": bridge.poll, "history": bridge.history, "fixture_append": bridge.fixture_append}
    out.write(json.dumps({"event": "ready", "protocol": PROTOCOL}) + "\n")
    out.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            fn = methods.get(req.get("method"))
            if fn is None:
                raise KeyError("unknown method")
            reply = {"id": rid, "ok": True, "result": fn(req.get("params") or {})}
        except Exception as exc:  # noqa: 把错误交给工作台展示
            reply = {"id": rid, "ok": False, "error": str(exc)[:500] or exc.__class__.__name__, "code": exc.__class__.__name__}
        out.write(json.dumps(reply, ensure_ascii=False) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
