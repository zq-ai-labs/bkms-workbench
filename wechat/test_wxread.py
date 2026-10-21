# -*- coding: utf-8 -*-
"""内置读取组件 wxread 的测试：python -m unittest wechat/test_wxread.py

不依赖微信：用标准 AES 按微信页面格式加密一页，验证移植后的解密路径；
用 zstandard（若已安装）生成压缩帧，验证纯 Python 解压与库的结果一致。
"""
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from wxread import _crypto, _zstd  # noqa: E402
from wxread import db  # noqa: E402

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except Exception:  # pragma: no cover
    Cipher = None
try:
    import zstandard
except Exception:  # pragma: no cover
    zstandard = None


@unittest.skipIf(Cipher is None, "需要 cryptography 生成加密样本")
class PageDecryptTest(unittest.TestCase):
    def encrypt(self, key, iv, data):
        enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
        return enc.update(data) + enc.finalize()

    def test_pages_decrypt_to_a_readable_sqlite_database(self):
        # 生成一个真实的两页以上 SQLite 库，按微信格式逐页加密，再用移植代码解密并打开。
        with tempfile.TemporaryDirectory() as tmp:
            plain = os.path.join(tmp, "plain.db")
            conn = sqlite3.connect(plain)
            conn.execute("PRAGMA page_size=4096")
            conn.execute("PRAGMA auto_vacuum=0")
            conn.execute("CREATE TABLE t(x TEXT)")
            conn.executemany("INSERT INTO t VALUES (?)", [("消息 %d" % i * 20,) for i in range(400)])
            conn.commit(); conn.execute("VACUUM"); conn.close()
            raw = open(plain, "rb").read()
            # SQLCipher 页面保留 80 字节尾部（IV + HMAC），这里用 reserve 为 80 的库来模拟
            conn = sqlite3.connect(plain)
            pages = len(raw) // db.PAGE_SZ
            conn.close()
            key, salt = os.urandom(32), os.urandom(16)
            encrypted = bytearray()
            for pgno in range(1, pages + 1):
                page = raw[(pgno - 1) * db.PAGE_SZ: pgno * db.PAGE_SZ]
                iv = os.urandom(16)
                body = page[16: db.PAGE_SZ - db.RESERVE_SZ] if pgno == 1 else page[: db.PAGE_SZ - db.RESERVE_SZ]
                cipher = self.encrypt(key, iv, body)
                head = salt if pgno == 1 else b""
                encrypted += head + cipher + iv + b"\0" * 64
            for pgno in range(1, pages + 1):
                page = bytes(encrypted[(pgno - 1) * db.PAGE_SZ: pgno * db.PAGE_SZ])
                out = db._decrypt_page(key, page, pgno)
                expected = raw[(pgno - 1) * db.PAGE_SZ: pgno * db.PAGE_SZ - db.RESERVE_SZ]
                if pgno == 1:
                    expected = b"SQLite format 3\x00" + raw[16: db.PAGE_SZ - db.RESERVE_SZ]
                self.assertEqual(out[: db.PAGE_SZ - db.RESERVE_SZ], expected, pgno)

    def test_known_answer(self):
        self.assertEqual(_crypto.aes_cbc_decrypt(_crypto._KAT_KEY, _crypto._KAT_IV, _crypto._KAT_CT), _crypto._KAT_PT)


@unittest.skipIf(zstandard is None, "需要 zstandard 生成压缩样本")
class ZstdTest(unittest.TestCase):
    def test_matches_reference_on_message_like_data(self):
        samples = [
            b"", b"a", "短消息".encode(), ("<msg><appmsg><title>回复</title><type>57</type><refermsg><content>原话</content></refermsg></appmsg></msg>" * 30).encode(),
            os.urandom(3000), ("长文本" * 40000).encode(), bytes(range(256)) * 600,
        ]
        for level in (1, 3, 9, 19, 22, -3):
            for data in samples:
                for checksum in (False, True):
                    frame = zstandard.ZstdCompressor(level=level, write_checksum=checksum).compress(data)
                    self.assertEqual(_zstd.decompress(frame), data, (level, len(data), checksum))

    def test_reader_uses_fallback_for_compressed_messages(self):
        frame = zstandard.ZstdCompressor(level=19).compress(("<msg><appmsg><title>链接</title><type>5</type></appmsg></msg>" * 10).encode())
        saved = db._ZSTD_MODULE
        try:
            db._ZSTD_MODULE = _zstd
            self.assertTrue(db.WeChatDB._friendly_content(frame, "文件/链接/卡片").startswith("<msg><appmsg><title>链接"))
        finally:
            db._ZSTD_MODULE = saved

    def test_rejects_garbage(self):
        with self.assertRaises(_zstd.ZstdError):
            _zstd.decompress(b"\x28\xb5\x2f\xfd\x00\x00\x00\x00\xff")


if __name__ == "__main__":
    unittest.main()


# 真实的 rel 来自 os.path.relpath，Windows 上是反斜杠
REL = os.path.join("contact", "contact.db")


class LockedCopyTest(unittest.TestCase):
    """Windows 上解密副本被占用（另一读取进程、杀毒扫描）时，读取不应报错。"""

    def reader(self, tmp, plain):
        import shutil
        r = db.WeChatDB.__new__(db.WeChatDB)
        r._keys = {REL: b"k" * 32}
        r.workdir = tmp
        src = os.path.join(tmp, "src-contact.db")
        shutil.copyfile(plain, src)
        r._db_path = lambda rel: src
        r._decrypt_file = lambda s, d, k: shutil.copyfile(plain, d)
        return r, src

    def plain_db(self, tmp, value):
        path = os.path.join(tmp, "plain-%s.db" % value)
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE t(x TEXT)")
        conn.execute("INSERT INTO t VALUES (?)", (value,))
        conn.commit(); conn.close()
        return path

    def test_locked_copy_is_read_from_a_fresh_file_and_replaced_later(self):
        real = os.replace
        locked = {"on": True, "calls": 0}

        def replace(src, dst):
            if locked["on"] and dst.endswith("contact__contact.db"):
                locked["calls"] += 1
                raise PermissionError(5, "拒绝访问")
            return real(src, dst)

        with tempfile.TemporaryDirectory() as tmp:
            r, src = self.reader(tmp, self.plain_db(tmp, "新"))
            dst = os.path.join(tmp, "contact__contact.db")
            db.os.replace, db.time.sleep = replace, (lambda s: None)
            try:
                conn = r._open(REL)
                self.assertEqual(conn.execute("SELECT x FROM t").fetchone()[0], "新")
                conn.close()
                self.assertGreater(locked["calls"], 1, "retries before giving up")
                self.assertFalse(os.path.exists(dst))
                self.assertFalse(os.path.exists(dst + ".stamp"), "no stamp, so the next read retries the replace")
                # The lock is gone: the next read installs the copy normally.
                locked["on"] = False
                conn = r._open(REL)
                self.assertEqual(conn.execute("SELECT x FROM t").fetchone()[0], "新")
                conn.close()
                self.assertTrue(os.path.exists(dst) and os.path.exists(dst + ".stamp"))
            finally:
                db.os.replace = real
                import time as _time
                db.time.sleep = _time.sleep

    def test_short_lock_is_retried(self):
        real, calls = os.replace, {"n": 0}

        def replace(src, dst):
            calls["n"] += 1
            if calls["n"] < 3:
                raise PermissionError(32, "另一个程序正在使用此文件")
            return real(src, dst)

        with tempfile.TemporaryDirectory() as tmp:
            a, b = os.path.join(tmp, "a"), os.path.join(tmp, "b")
            open(a, "w").close()
            db.os.replace = replace
            try:
                self.assertTrue(db._replace_retry(a, b))
            finally:
                db.os.replace = real
            self.assertTrue(os.path.exists(b))
