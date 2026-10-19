# -*- coding: utf-8 -*-
"""AES-256-CBC 解密（无填充），用于解密微信数据库页面。

优先使用已安装的 ``cryptography``；没有时在 Windows 上调用系统自带的 CNG（bcrypt.dll），
因此不需要额外安装任何 Python 包。两种实现都在首次使用前用 NIST 已知答案向量自检，
不正确时直接报错而不是解出乱码。
"""
from __future__ import annotations

import ctypes
import sys
from typing import Callable, Optional

# NIST SP 800-38A F.2.6 CBC-AES256.Decrypt（首块）
_KAT_KEY = bytes.fromhex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4")
_KAT_IV = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
_KAT_CT = bytes.fromhex("f58c4c04d6e5f1ba779eabfb5f7bfbd69cfc4e967edb808d679f777bc6702c7d")
_KAT_PT = bytes.fromhex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51")


def _with_cryptography() -> Optional[Callable[[bytes, bytes, bytes], bytes]]:
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except Exception:
        return None

    def decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
        dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        return dec.update(data) + dec.finalize()
    return decrypt


def _with_cng() -> Optional[Callable[[bytes, bytes, bytes], bytes]]:
    if sys.platform != "win32":
        return None
    from ctypes import wintypes
    bcrypt = ctypes.WinDLL("bcrypt")
    handle = ctypes.c_void_p
    ulong = wintypes.ULONG
    bcrypt.BCryptOpenAlgorithmProvider.argtypes = [ctypes.POINTER(handle), wintypes.LPCWSTR, wintypes.LPCWSTR, ulong]
    bcrypt.BCryptSetProperty.argtypes = [handle, wintypes.LPCWSTR, ctypes.c_void_p, ulong, ulong]
    bcrypt.BCryptGenerateSymmetricKey.argtypes = [handle, ctypes.POINTER(handle), ctypes.c_void_p, ulong, ctypes.c_void_p, ulong, ulong]
    bcrypt.BCryptDecrypt.argtypes = [handle, ctypes.c_void_p, ulong, ctypes.c_void_p, ctypes.c_void_p, ulong, ctypes.c_void_p, ulong, ctypes.POINTER(ulong), ulong]
    bcrypt.BCryptDestroyKey.argtypes = [handle]
    for fn in (bcrypt.BCryptOpenAlgorithmProvider, bcrypt.BCryptSetProperty, bcrypt.BCryptGenerateSymmetricKey, bcrypt.BCryptDecrypt, bcrypt.BCryptDestroyKey):
        fn.restype = ctypes.c_long  # NTSTATUS，0 表示成功

    def check(status: int, what: str) -> None:
        if status != 0:
            raise OSError("CNG %s 失败（0x%08X）" % (what, status & 0xFFFFFFFF))

    algorithm = handle()
    check(bcrypt.BCryptOpenAlgorithmProvider(ctypes.byref(algorithm), "AES", None, 0), "打开 AES")
    mode = ctypes.create_unicode_buffer("ChainingModeCBC")
    check(bcrypt.BCryptSetProperty(algorithm, "ChainingMode", mode, ctypes.sizeof(mode), 0), "设置 CBC")
    keys = {}  # 同一数据库的页面共用一个密钥句柄

    def key_handle(key: bytes):
        h = keys.get(key)
        if h is None:
            if len(keys) > 64:
                for old in keys.values():
                    bcrypt.BCryptDestroyKey(old)
                keys.clear()
            h = handle()
            secret = ctypes.create_string_buffer(key, len(key))
            check(bcrypt.BCryptGenerateSymmetricKey(algorithm, ctypes.byref(h), None, 0, secret, len(key), 0), "导入密钥")
            keys[key] = h
        return h

    def decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
        if len(data) % 16:
            raise ValueError("数据长度不是 16 的整数倍")
        source = ctypes.create_string_buffer(data, len(data))
        vector = ctypes.create_string_buffer(iv, 16)  # CNG 会改写 IV，每次用新缓冲区
        output = ctypes.create_string_buffer(len(data))
        written = ulong(0)
        check(bcrypt.BCryptDecrypt(key_handle(key), source, len(data), None, vector, 16, output, len(data), ctypes.byref(written), 0), "解密")
        return output.raw[:written.value]
    return decrypt


_IMPL: Optional[Callable[[bytes, bytes, bytes], bytes]] = None
BACKEND = ""


def aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    global _IMPL, BACKEND
    if _IMPL is None:
        for name, factory in (("cryptography", _with_cryptography), ("windows-cng", _with_cng)):
            impl = factory()
            if impl is None:
                continue
            if impl(_KAT_KEY, _KAT_IV, _KAT_CT) != _KAT_PT:
                raise RuntimeError("AES 自检失败（%s），已停止解密以免读出错误数据" % name)
            _IMPL, BACKEND = impl, name
            break
        else:
            raise RuntimeError("没有可用的 AES 实现：请在 Windows 上运行，或安装 cryptography")
    return _IMPL(key, iv, data)
