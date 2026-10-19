# -*- coding: utf-8 -*-
"""纯 Python 的 Zstandard 解压（RFC 8878），仅用于没有安装 zstandard 时兜底。

微信 4.x 把较长的消息正文（长文本、引用、链接卡片等 XML）存成 zstd 帧，单条一般
不超过几十 KB，纯 Python 足够快。只实现解压；不支持字典（微信消息未使用字典），
不校验内容校验和。接口与 zstandard 的 ZstdDecompressor 子集一致。
"""
from __future__ import annotations

MAGIC = 0xFD2FB528


class ZstdError(ValueError):
    pass


# ---- 预定义 FSE 分布（RFC 8878 3.1.1.3.2.2） ---------------------------------
LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1]
ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1]
OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1]
LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]
LL_BITS = [0] * 16 + [1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
ML_BASE = list(range(3, 35)) + [35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539]
ML_BITS = [0] * 32 + [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]


class _ForwardBits:
    """小端、从低位读起的前向位流（用于 FSE 表头）。"""

    def __init__(self, data: bytes, pos: int):
        self.data, self.bitpos = data, pos * 8

    def read(self, n: int) -> int:
        value = 0
        for i in range(n):
            byte = self.data[(self.bitpos + i) >> 3] if (self.bitpos + i) >> 3 < len(self.data) else 0
            value |= ((byte >> ((self.bitpos + i) & 7)) & 1) << i
        self.bitpos += n
        return value

    def peek(self, n: int) -> int:
        save = self.bitpos
        value = self.read(n)
        self.bitpos = save
        return value

    def byte_pos(self) -> int:
        return (self.bitpos + 7) >> 3


class _BackwardBits:
    """从流末尾往前读的位流（FSE/Huffman 编码数据）。最后一个字节的最高 1 位是哨兵。

    ``bits`` 是尚未读取的位数；读过头时低位按 0 补齐（规范允许，调用方据此判断结束）。
    """

    def __init__(self, data: bytes):
        if not data or data[-1] == 0:
            raise ZstdError("corrupt bitstream")
        self.data = data
        self.bits = len(data) * 8 - (8 - data[-1].bit_length()) - 1

    def peek(self, n: int) -> int:
        if n == 0:
            return 0
        start = self.bits - n
        if start >= 0:
            lo, hi = start >> 3, (self.bits - 1) >> 3
            return (int.from_bytes(self.data[lo:hi + 1], "little") >> (start - lo * 8)) & ((1 << n) - 1)
        if self.bits <= 0:
            return 0
        lo, hi = 0, (self.bits - 1) >> 3
        return ((int.from_bytes(self.data[lo:hi + 1], "little") & ((1 << self.bits) - 1)) << -start) & ((1 << n) - 1)

    def read(self, n: int) -> int:
        value = self.peek(n)
        self.bits -= n
        return value


def _fse_table(norm, log):
    """按归一化分布构建 FSE 解码表：每项 (symbol, nbits, baseline)。"""
    size = 1 << log
    table = [None] * size
    high = size - 1
    symbol_next = [0] * len(norm)
    for s, c in enumerate(norm):
        if c == -1:
            table[high] = s
            high -= 1
            symbol_next[s] = 1
        else:
            symbol_next[s] = c
    step = (size >> 1) + (size >> 3) + 3
    mask = size - 1
    pos = 0
    for s, c in enumerate(norm):
        for _ in range(max(c, 0)):
            table[pos] = s
            pos = (pos + step) & mask
            while pos > high:
                pos = (pos + step) & mask
    if pos != 0:
        raise ZstdError("bad FSE table")
    out = []
    for i in range(size):
        s = table[i]
        nxt = symbol_next[s]
        symbol_next[s] += 1
        nbits = log - (nxt.bit_length() - 1)
        out.append((s, nbits, (nxt << nbits) - size))
    return out


def _read_fse(data: bytes, pos: int, max_symbol: int):
    """读取压缩的 FSE 分布；返回 (table, accuracy_log, new_pos)。"""
    bits = _ForwardBits(data, pos)
    log = bits.read(4) + 5
    remaining = (1 << log) + 1
    threshold = 1 << log
    nbits = log + 1
    norm = []
    previous_zero = False
    while remaining > 1 and len(norm) <= max_symbol:
        if previous_zero:
            while True:
                repeat = bits.read(2)
                norm.extend([0] * repeat)
                if repeat != 3:
                    break
            previous_zero = False
            continue
        maximum = (2 * threshold - 1) - remaining
        low = bits.peek(nbits - 1)
        if low < maximum:
            value = low
            bits.read(nbits - 1)
        else:
            value = bits.peek(nbits)
            if value >= threshold:
                value -= maximum
            bits.read(nbits)
        count = value - 1
        remaining -= -count if count < 0 else count
        norm.append(count)
        previous_zero = count == 0
        while remaining < threshold:
            nbits -= 1
            threshold >>= 1
    if remaining != 1 or len(norm) > max_symbol + 1:
        raise ZstdError("bad FSE distribution")
    return _fse_table(norm, log), log, bits.byte_pos()


def _huffman_from_weights(weights):
    total = sum((1 << (w - 1)) for w in weights if w)
    max_bits = total.bit_length()
    last = (1 << max_bits) - total
    if last & (last - 1):
        raise ZstdError("bad Huffman weights")
    weights = weights + [last.bit_length()]
    # 码长 = max_bits + 1 - weight；按码长、符号序分配
    size = 1 << max_bits
    table = [None] * size
    rank_start = {}
    pos = 0
    for w in range(1, max_bits + 1):
        rank_start[w] = pos
        pos += sum(1 for x in weights if x == w) << (w - 1)
    for s, w in enumerate(weights):
        if not w:
            continue
        length = max_bits + 1 - w
        n = 1 << (w - 1)
        start = rank_start[w]
        for i in range(start, start + n):
            table[i] = (s, length)
        rank_start[w] += n
    return table, max_bits


def _read_huffman(data: bytes, pos: int):
    header = data[pos]
    pos += 1
    if header >= 128:
        count = header - 127
        weights = []
        for i in range((count + 1) // 2):
            byte = data[pos + i]
            weights += [byte >> 4, byte & 15]
        pos += (count + 1) // 2
        weights = weights[:count]
    else:
        end = pos + header
        table, log, p = _read_fse(data[:end], pos, 255)
        stream = _BackwardBits(data[p:end])
        s1 = stream.read(log)
        s2 = stream.read(log)
        weights = []
        # 两个交错的 FSE 状态解码权重，直到位流读完
        while True:
            sym, nb, base = table[s1]
            weights.append(sym)
            s1 = base + stream.read(nb)
            if stream.bits < 0:
                weights.append(table[s2][0])
                break
            sym, nb, base = table[s2]
            weights.append(sym)
            s2 = base + stream.read(nb)
            if stream.bits < 0:
                weights.append(table[s1][0])
                break
            if len(weights) > 255:
                raise ZstdError("too many Huffman weights")
        pos = end
    return _huffman_from_weights(weights), pos


def _huffman_stream(src: bytes, table, max_bits: int, count: int, out: bytearray):
    stream = _BackwardBits(src)
    for _ in range(count):
        sym, length = table[stream.peek(max_bits)]
        out.append(sym)
        stream.bits -= length
    if stream.bits != 0:
        raise ZstdError("corrupt Huffman stream")


class _State:
    def __init__(self, window: int):
        self.huffman = None
        self.tables = {"ll": None, "of": None, "ml": None}
        self.rep = [1, 4, 8]
        self.window = window


def _literals(data: bytes, pos: int, st: _State):
    b0 = data[pos]
    ltype, sf = b0 & 3, (b0 >> 2) & 3
    if ltype in (0, 1):
        if sf in (0, 2):
            size, pos = b0 >> 3, pos + 1
        elif sf == 1:
            size, pos = (b0 >> 4) + (data[pos + 1] << 4), pos + 2
        else:
            size, pos = (b0 >> 4) + (data[pos + 1] << 4) + (data[pos + 2] << 12), pos + 3
        if ltype == 0:
            return bytes(data[pos:pos + size]), pos + size
        return bytes([data[pos]]) * size, pos + 1
    if sf == 0 or sf == 1:
        streams = 1 if sf == 0 else 4
        h = int.from_bytes(data[pos:pos + 3], "little")
        regen, comp, pos = (h >> 4) & 0x3FF, (h >> 14) & 0x3FF, pos + 3
    elif sf == 2:
        streams = 4
        h = int.from_bytes(data[pos:pos + 4], "little")
        regen, comp, pos = (h >> 4) & 0x3FFF, (h >> 18) & 0x3FFF, pos + 4
    else:
        streams = 4
        h = int.from_bytes(data[pos:pos + 5], "little")
        regen, comp, pos = (h >> 4) & 0x3FFFF, (h >> 22) & 0x3FFFF, pos + 5
    end = pos + comp
    if ltype == 2:
        st.huffman, pos = _read_huffman(data, pos)
    elif st.huffman is None:
        raise ZstdError("treeless literals without a table")
    table, max_bits = st.huffman
    out = bytearray()
    if streams == 1:
        _huffman_stream(data[pos:end], table, max_bits, regen, out)
    else:
        s1, s2, s3 = (int.from_bytes(data[pos + i:pos + i + 2], "little") for i in (0, 2, 4))
        p = pos + 6
        each = (regen + 3) // 4
        bounds = [(p, p + s1), (p + s1, p + s1 + s2), (p + s1 + s2, p + s1 + s2 + s3), (p + s1 + s2 + s3, end)]
        for i, (a, b) in enumerate(bounds):
            _huffman_stream(data[a:b], table, max_bits, each if i < 3 else regen - 3 * each, out)
    return bytes(out), end


def _seq_table(data, pos, mode, kind, st):
    defaults = {"ll": (LL_DEFAULT, 6, 35), "of": (OF_DEFAULT, 5, 31), "ml": (ML_DEFAULT, 6, 52)}
    norm, log, max_symbol = defaults[kind]
    if mode == 0:
        table = _fse_table(norm, log)
    elif mode == 1:
        table = [(data[pos], 0, 0)]
        pos += 1
    elif mode == 2:
        table, _, pos = _read_fse(data, pos, max_symbol)
    else:
        table = st.tables[kind]
        if table is None:
            raise ZstdError("repeat mode without a table")
    st.tables[kind] = table
    return table, pos


def _sequences(data: bytes, pos: int, end: int, literals: bytes, out: bytearray, st: _State, frame_floor: int = 0):
    n = data[pos]
    if n == 0:
        out += literals
        return
    if n < 128:
        pos += 1
    elif n < 255:
        n, pos = ((n - 128) << 8) + data[pos + 1], pos + 2
    else:
        n, pos = data[pos + 1] + (data[pos + 2] << 8) + 0x7F00, pos + 3
    modes = data[pos]
    pos += 1
    ll_t, pos = _seq_table(data, pos, modes >> 6, "ll", st)
    of_t, pos = _seq_table(data, pos, (modes >> 4) & 3, "of", st)
    ml_t, pos = _seq_table(data, pos, (modes >> 2) & 3, "ml", st)
    bits = _BackwardBits(data[pos:end])
    log = lambda t: max(1, len(t).bit_length() - 1) if len(t) > 1 else 0
    ll = bits.read(log(ll_t))
    of = bits.read(log(of_t))
    ml = bits.read(log(ml_t))
    lit = 0
    rep = st.rep
    for i in range(n):
        of_code, ml_code, ll_code = of_t[of][0], ml_t[ml][0], ll_t[ll][0]
        if of_code > 31 or ll_code > 35 or ml_code > 52:
            raise ZstdError("bad sequence code")
        offset_value = (1 << of_code) + bits.read(of_code)
        match_len = ML_BASE[ml_code] + bits.read(ML_BITS[ml_code])
        lit_len = LL_BASE[ll_code] + bits.read(LL_BITS[ll_code])
        if offset_value > 3:
            offset = offset_value - 3
            rep[:] = [offset, rep[0], rep[1]]
        else:
            idx = offset_value - 1 + (1 if lit_len == 0 else 0)
            if idx == 0:
                offset = rep[0]
            elif idx == 3:
                offset = rep[0] - 1
                rep[:] = [offset, rep[0], rep[1]]
            else:
                offset = rep[idx]
                rep[:] = [offset] + [r for j, r in enumerate(rep) if j != idx][:2]
        if offset <= 0:
            raise ZstdError("bad offset")
        out += literals[lit:lit + lit_len]
        lit += lit_len
        start = len(out) - offset
        if start < frame_floor:
            raise ZstdError("offset beyond output")
        if offset >= match_len:
            out += out[start:start + match_len]
        else:
            for k in range(match_len):
                out.append(out[start + k])
        if i != n - 1:
            ll = ll_t[ll][2] + bits.read(ll_t[ll][1])
            ml = ml_t[ml][2] + bits.read(ml_t[ml][1])
            of = of_t[of][2] + bits.read(of_t[of][1])
    if lit > len(literals):
        raise ZstdError("literals overrun")
    out += literals[lit:]


def decompress(data: bytes, max_output_size: int = 0) -> bytes:
    data = bytes(data)
    out = bytearray()
    pos = 0
    while pos < len(data):
        if pos + 5 > len(data):
            raise ZstdError("truncated frame")
        magic = int.from_bytes(data[pos:pos + 4], "little")
        if magic & 0xFFFFFFF0 == 0x184D2A50:  # 可跳过帧
            pos += 8 + int.from_bytes(data[pos + 4:pos + 8], "little")
            continue
        if magic != MAGIC:
            raise ZstdError("not a zstd frame")
        pos += 4
        fhd = data[pos]
        pos += 1
        single = (fhd >> 5) & 1
        checksum = (fhd >> 2) & 1
        dict_size = [0, 1, 2, 4][fhd & 3]
        fcs_size = [1 if single else 0, 2, 4, 8][fhd >> 6]
        window = 0
        if not single:
            wd = data[pos]
            pos += 1
            exponent, mantissa = wd >> 3, wd & 7
            base = 1 << (10 + exponent)
            window = base + (base // 8) * mantissa
        if dict_size and int.from_bytes(data[pos:pos + dict_size], "little"):
            raise ZstdError("dictionaries are not supported")
        pos += dict_size + fcs_size
        frame_start = len(out)
        st = _State(window)
        if pos > len(data):
            raise ZstdError("truncated frame header")
        while True:
            if pos + 3 > len(data):
                raise ZstdError("truncated block header")
            header = int.from_bytes(data[pos:pos + 3], "little")
            pos += 3
            last, btype, size = header & 1, (header >> 1) & 3, header >> 3
            # 块最大 128 KiB；原始块与压缩块的内容必须完整在输入内
            if size > 1 << 17 or (btype != 1 and pos + size > len(data)) or (btype == 1 and pos >= len(data)):
                raise ZstdError("truncated or oversized block")
            if btype == 0:
                out += data[pos:pos + size]
                pos += size
            elif btype == 1:
                out += bytes([data[pos]]) * size
                pos += 1
            elif btype == 2:
                end = pos + size
                literals, p = _literals(data, pos, st)
                # 序列直接接在已有输出后执行，偏移可以指向本帧前面的块
                before = len(out)
                _sequences(data, p, end, literals, out, st, frame_start)
                if len(out) - before > 1 << 17:
                    raise ZstdError("block too large")
                pos = end
            else:
                raise ZstdError("reserved block type")
            if max_output_size and len(out) > max_output_size:
                raise ZstdError("output too large")
            if last:
                break
        if checksum:
            pos += 4
    return bytes(out)


class ZstdDecompressor:
    """与 zstandard.ZstdDecompressor 的 decompress 接口兼容。"""

    def decompress(self, data: bytes, max_output_size: int = 0) -> bytes:
        return decompress(data, max_output_size)
