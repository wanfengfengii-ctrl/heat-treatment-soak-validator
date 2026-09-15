"""淬火炉保温段判定核心逻辑。

严格判定（strict）：连续记录中每个温度都落在 [TEMP_LOW, TEMP_HIGH] 闭区间，
且任意相邻记录时间差不超过 MAX_GAP_SECONDS；一次越界或超间隔立即切段。
段持续时间 = 末项 t - 首项 t，达到 MIN_SOAK_SECONDS 即合格。

线性曲线等效保温（linear_equivalent）：把 60 秒内的相邻点连成线段，
裁剪 840–860 °C 的时间片，对片内 2^((温度-850)/10) 按时间积分；
带外区间或超限间隔结束连续段，落在边界的相邻片按同一时刻拼接且不重复计时。
连续段累计等效秒达到 MIN_SOAK_SECONDS 即合格，取最早达标段，
首次达标时刻用指数积分的解析反函数求得（恒温片按常量积分）。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass

TEMP_LOW = 840.0
TEMP_HIGH = 860.0
MAX_GAP_SECONDS = 60
MIN_SOAK_SECONDS = 1800

# 判定模式：旧请求/旧记录不带模式，一律按严格判定读取
MODE_STRICT = "strict"
MODE_LINEAR_EQUIVALENT = "linear_equivalent"
ANALYSIS_MODES = (MODE_STRICT, MODE_LINEAR_EQUIVALENT)
DEFAULT_MODE = MODE_STRICT

MAX_FILE_BYTES = 2 * 1024 * 1024  # 2 MiB
MIN_RECORDS = 2
MAX_RECORDS = 10_000


class Rejection(Exception):
    """整份文件被拒绝时抛出，携带机器可读 code 与人类可读 message。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Record:
    t: int
    temp: float


def _reject_constant(token: str) -> None:
    # JSON 中的 NaN / Infinity / -Infinity 字面量一律拒绝
    raise Rejection("non_finite_value", f"JSON 含非有限数值字面量: {token}")


def parse_payload(raw: bytes) -> list[Record]:
    """解析并校验上传内容，任何违规都整份拒绝（抛 Rejection）。"""
    if len(raw) == 0:
        raise Rejection("empty_file", "文件为空")
    if len(raw) > MAX_FILE_BYTES:
        raise Rejection(
            "file_too_large",
            f"文件大小 {len(raw)} 字节超过上限 {MAX_FILE_BYTES} 字节 (2 MiB)",
        )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise Rejection("invalid_encoding", "文件不是有效的 UTF-8 文本") from exc
    try:
        data = json.loads(text, parse_constant=_reject_constant)
    except Rejection:
        raise
    except json.JSONDecodeError as exc:
        raise Rejection("invalid_json", f"JSON 解析失败: {exc.msg} (行 {exc.lineno})") from exc

    if not isinstance(data, list):
        raise Rejection("root_not_array", "JSON 根节点必须是数组")
    if not MIN_RECORDS <= len(data) <= MAX_RECORDS:
        raise Rejection(
            "record_count_out_of_range",
            f"记录数 {len(data)} 不在允许范围 {MIN_RECORDS}~{MAX_RECORDS}",
        )

    records: list[Record] = []
    prev_t: int | None = None
    for i, item in enumerate(data):
        where = f"第 {i} 条记录"
        if not isinstance(item, dict):
            raise Rejection("record_not_object", f"{where}不是对象")
        if "t" not in item:
            raise Rejection("missing_field", f"{where}缺少字段 t")
        if "temp" not in item:
            raise Rejection("missing_field", f"{where}缺少字段 temp")
        t = item["t"]
        temp = item["temp"]
        # bool 是 int 的子类，必须显式排除
        if isinstance(t, bool) or not isinstance(t, int):
            raise Rejection("invalid_t", f"{where}的 t 必须是整数秒时间戳")
        if isinstance(temp, bool) or not isinstance(temp, (int, float)):
            raise Rejection("invalid_temp", f"{where}的 temp 必须是数值")
        temp = float(temp)
        if not math.isfinite(temp):
            raise Rejection("non_finite_temp", f"{where}的 temp 不是有限数值")
        if prev_t is not None and t <= prev_t:
            raise Rejection(
                "timestamps_not_strictly_increasing",
                f"{where}的时间戳 {t} 未严格大于前一条 {prev_t}",
            )
        prev_t = t
        records.append(Record(t=t, temp=temp))
    return records


def find_segments(records: list[Record]) -> list[list[Record]]:
    """按温度区间与相邻间隔切分有效保温段，段按时间顺序返回。"""
    segments: list[list[Record]] = []
    current: list[Record] = []
    for rec in records:
        if not (TEMP_LOW <= rec.temp <= TEMP_HIGH):
            if current:
                segments.append(current)
                current = []
            continue
        if current and rec.t - current[-1].t > MAX_GAP_SECONDS:
            segments.append(current)
            current = []
        current.append(rec)
    if current:
        segments.append(current)
    return segments


def _segment_info(segment: list[Record]) -> dict:
    start, end = segment[0].t, segment[-1].t
    return {
        "startT": start,
        "endT": end,
        "duration": end - start,
        "points": len(segment),
    }


def _analyze_strict(records: list[Record]) -> dict:
    """严格判定：是否合格、最早达标段、最长有效段。"""
    infos = [_segment_info(seg) for seg in find_segments(records)]
    earliest = next(
        (info for info in infos if info["duration"] >= MIN_SOAK_SECONDS), None
    )
    longest = max(infos, key=lambda info: info["duration"], default=None)
    return {
        "analysisMode": MODE_STRICT,
        "recordCount": len(records),
        "segmentCount": len(infos),
        "qualified": earliest is not None,
        "earliestQualifyingSegment": earliest,
        "longestSegment": longest,
        "limits": _limits(),
    }


# ---------------------------------------------------------------------------
# 线性曲线等效保温
#
# 片（slice）：线段与温度带 [TEMP_LOW, TEMP_HIGH] 交集的时间区间，表示为
# (anchor_t, offset_a, offset_b, temp_a, temp_b)：
#   anchor_t   线段左端记录的整数秒时间戳（精确，不经浮点舍入）
#   offset_*   片端点相对锚点的十进制秒偏移（落在 [0, 60] 内）
#   temp_*     片端点温度
# 插值时刻以「整数锚点 + 十进制秒偏移」表示，超大时间戳不会丢失精度。
# ---------------------------------------------------------------------------

_LN2 = math.log(2.0)


def _rate(temp: float) -> float:
    """等效速率 2^((temp-850)/10)：850 °C 时为 1，每偏离 10 °C 减半/翻倍。"""
    return 2.0 ** ((temp - 850.0) / 10.0)


def _line_slice(
    t0: int, temp0: float, t1: int, temp1: float
) -> tuple[int, float, float, float, float] | None:
    """线段 (t0,temp0)-(t1,temp1) 裁剪温度带，返回片；无交集返回 None。"""
    lo, hi = (temp0, temp1) if temp0 <= temp1 else (temp1, temp0)
    if hi < TEMP_LOW or lo > TEMP_HIGH:
        return None
    gap = t1 - t0  # 调用方保证 0 < gap <= MAX_GAP_SECONDS
    if temp0 == temp1:
        # 恒温线段且温度在带内：整段成片
        return (t0, 0.0, float(gap), temp0, temp1)
    # 温度关于偏移线性：T(o) = temp0 + (temp1 - temp0) * o / gap
    oa, ob = 0.0, float(gap)
    if lo < TEMP_LOW:
        o_low = (TEMP_LOW - temp0) * gap / (temp1 - temp0)
        if temp0 < temp1:
            oa = o_low
        else:
            ob = o_low
    if hi > TEMP_HIGH:
        o_high = (TEMP_HIGH - temp0) * gap / (temp1 - temp0)
        if temp0 < temp1:
            ob = o_high
        else:
            oa = o_high
    temp_a = temp0 + (temp1 - temp0) * oa / gap
    temp_b = temp0 + (temp1 - temp0) * ob / gap
    return (t0, oa, ob, temp_a, temp_b)


def _integrate_slice(duration: float, temp_a: float, temp_b: float) -> float:
    """片内 2^((T-850)/10) 对时间的积分（等效秒），温度线性变化。"""
    if duration <= 0.0:
        return 0.0
    if temp_a == temp_b:
        # 恒温片按常量积分
        return _rate(temp_a) * duration
    # 解析积分：T 线性 ⇒ 被积函数为指数函数
    return (
        duration
        / (temp_b - temp_a)
        * (10.0 / _LN2)
        * (_rate(temp_b) - _rate(temp_a))
    )


def _offset_to_reach(
    oa: float, ob: float, temp_a: float, temp_b: float, need: float
) -> float:
    """从片头累计 need 等效秒的时刻偏移（指数积分的解析反函数）。"""
    if temp_a == temp_b:
        return oa + need / _rate(temp_a)
    duration = ob - oa
    coeff = duration / (temp_b - temp_a) * (10.0 / _LN2)
    rate_target = _rate(temp_a) + need / coeff
    temp_target = 850.0 + 10.0 * math.log2(rate_target)
    return oa + (temp_target - temp_a) * duration / (temp_b - temp_a)


def find_equivalent_segments(
    records: list[Record],
) -> list[list[tuple[int, float, float, float, float]]]:
    """切分等效模式的连续段（段为片的有序列表，按时间返回）。

    60 秒内的相邻点连成线段并裁剪出片；带外区间（线段整体越带，或
    相邻片之间隔着正长度的带外时间）与超限间隔都结束连续段；落在一
    个采样点两侧的相邻片若该点温度在带内（含边界），按同一时刻拼接。
    """
    segments: list[list[tuple[int, float, float, float, float]]] = []
    current: list[tuple[int, float, float, float, float]] = []
    for left, right in zip(records, records[1:]):
        if right.t - left.t > MAX_GAP_SECONDS:
            # 超限间隔：不连线段，结束连续段
            if current:
                segments.append(current)
                current = []
            continue
        piece = _line_slice(left.t, left.temp, right.t, right.temp)
        if piece is None:
            # 整条线段在带外：带外区间结束连续段
            if current:
                segments.append(current)
                current = []
            continue
        if current and not (TEMP_LOW <= left.temp <= TEMP_HIGH):
            # 上一片结束于 left.t 之前、本片开始于 left.t 之后，
            # 两点之间是带外区间，结束连续段（点温度在带内则同一时刻拼接）
            segments.append(current)
            current = []
        current.append(piece)
    if current:
        segments.append(current)
    return segments


def _time_point(anchor_t: int, offset: float) -> dict:
    """插值时刻的线外表示：整数锚点 + 十进制秒偏移。"""
    return {"anchorT": anchor_t, "offsetSeconds": offset}


def _equiv_segment_info(segment: list[tuple[int, float, float, float, float]]) -> dict:
    total = 0.0
    for _, oa, ob, temp_a, temp_b in segment:
        total += _integrate_slice(ob - oa, temp_a, temp_b)
    first, last = segment[0], segment[-1]
    return {
        "startT": _time_point(first[0], first[1]),
        "endT": _time_point(last[0], last[2]),
        "equivalentSeconds": total,
        "slices": len(segment),
    }


def _qualifying_segment_info(
    segment: list[tuple[int, float, float, float, float]],
) -> dict | None:
    """最早达标段：在累计等效秒首次达到 MIN_SOAK_SECONDS 的时刻截断。"""
    acc = 0.0
    for anchor, oa, ob, temp_a, temp_b in segment:
        piece = _integrate_slice(ob - oa, temp_a, temp_b)
        if acc + piece >= MIN_SOAK_SECONDS:
            offset = _offset_to_reach(oa, ob, temp_a, temp_b, MIN_SOAK_SECONDS - acc)
            first = segment[0]
            return {
                "startT": _time_point(first[0], first[1]),
                "endT": _time_point(anchor, offset),
                "equivalentSeconds": float(MIN_SOAK_SECONDS),
                "slices": len(segment),
            }
        acc += piece
    return None


def _analyze_linear_equivalent(records: list[Record]) -> dict:
    """线性曲线等效保温判定：是否合格、最早达标段、最长有效段（按等效秒）。"""
    segments = find_equivalent_segments(records)
    infos = [_equiv_segment_info(seg) for seg in segments]
    earliest = None
    for segment, info in zip(segments, infos):
        if info["equivalentSeconds"] >= MIN_SOAK_SECONDS:
            earliest = _qualifying_segment_info(segment)
            break
    longest = max(infos, key=lambda info: info["equivalentSeconds"], default=None)
    return {
        "analysisMode": MODE_LINEAR_EQUIVALENT,
        "recordCount": len(records),
        "segmentCount": len(infos),
        "qualified": earliest is not None,
        "earliestQualifyingSegment": earliest,
        "longestSegment": longest,
        "limits": _limits(),
    }


def _limits() -> dict:
    return {
        "tempLow": TEMP_LOW,
        "tempHigh": TEMP_HIGH,
        "maxGapSeconds": MAX_GAP_SECONDS,
        "minSoakSeconds": MIN_SOAK_SECONDS,
    }


def analyze(records: list[Record], mode: str = DEFAULT_MODE) -> dict:
    """返回整份分析结果；mode 取 strict 或 linear_equivalent。"""
    if mode == MODE_LINEAR_EQUIVALENT:
        return _analyze_linear_equivalent(records)
    return _analyze_strict(records)
