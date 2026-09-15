"""线性曲线等效保温判据：低温穿入、双边界穿越、间隔切段、边界拼接、
积分值与首次达标偏移的解析精度（误差不超过 0.001 秒）、模式分发与兼容。"""

import json
import math

from app.soak import (
    MIN_SOAK_SECONDS,
    Record,
    analyze,
    find_equivalent_segments,
)

LN2 = math.log(2.0)
TOL = 1e-3  # 积分值与首次达标偏移的允许误差


def equiv(records):
    return analyze(records, mode="linear_equivalent")


# ---------------------------------------------------------------------------
# 连续段切分
# ---------------------------------------------------------------------------


def test_low_temp_ramp_in_then_qualified():
    """低温穿入：从 830 °C 线性升温穿入 840 °C 后恒温 850 °C，累计等效秒达标。

    片1 [30,60] 温度 840→850，解析积分 = 15/ln2 ≈ 21.6404 等效秒；
    其后 850 °C 恒温速率为 1，首次达标时刻 = 1860 - 15/ln2 ≈ 1838.3596，
    落在锚点 1800 的片上，偏移 = 60 - 15/ln2 ≈ 38.3596。
    """
    records = [Record(t=0, temp=830.0)] + [
        Record(t=60 * i, temp=850.0) for i in range(1, 32)
    ]
    result = equiv(records)
    assert result["analysisMode"] == "linear_equivalent"
    assert result["qualified"] is True
    assert result["segmentCount"] == 1

    seg = result["earliestQualifyingSegment"]
    # 段起点：830→850 线性穿入 840 的中点 t=30（锚点 0 + 30 秒偏移）
    assert seg["startT"]["anchorT"] == 0
    assert abs(seg["startT"]["offsetSeconds"] - 30.0) <= TOL
    # 首次达标时刻：整数锚点 + 十进制秒偏移
    assert seg["endT"]["anchorT"] == 1800
    assert abs(seg["endT"]["offsetSeconds"] - (60.0 - 15.0 / LN2)) <= TOL
    assert abs(seg["equivalentSeconds"] - MIN_SOAK_SECONDS) <= TOL

    # 最长段为完整段：片1 积分 + 30 个恒温片 × 60 秒
    longest = result["longestSegment"]
    assert abs(longest["equivalentSeconds"] - (15.0 / LN2 + 1800.0)) <= TOL


def test_single_line_crossing_both_boundaries():
    """单线段穿越双边界：830→870 °C 只保留 840–860 °C 的时间片。

    片 [15,45] 温度 840→860，解析积分 = 22.5/ln2 ≈ 32.4606 等效秒。
    """
    result = equiv([Record(t=0, temp=830.0), Record(t=60, temp=870.0)])
    assert result["qualified"] is False
    assert result["segmentCount"] == 1
    longest = result["longestSegment"]
    assert longest["startT"] == {"anchorT": 0, "offsetSeconds": 15.0}
    assert longest["endT"] == {"anchorT": 0, "offsetSeconds": 45.0}
    assert abs(longest["equivalentSeconds"] - 22.5 / LN2) <= TOL


def test_single_line_crossing_both_boundaries_descending():
    """降温方向同样裁剪：870→830 °C 的片 [15,45] 积分与升温一致。"""
    result = equiv([Record(t=0, temp=870.0), Record(t=60, temp=830.0)])
    longest = result["longestSegment"]
    assert longest["startT"] == {"anchorT": 0, "offsetSeconds": 15.0}
    assert longest["endT"] == {"anchorT": 0, "offsetSeconds": 45.0}
    assert abs(longest["equivalentSeconds"] - 22.5 / LN2) <= TOL


def test_line_fully_out_of_band_produces_no_slice():
    """整条线段在带外：不产生片，也不连成段。"""
    result = equiv([Record(t=0, temp=700.0), Record(t=30, temp=800.0)])
    assert result["segmentCount"] == 0
    assert result["longestSegment"] is None
    assert result["qualified"] is False


def test_gap_of_exactly_60_seconds_stays_connected():
    """相邻点间隔恰好 60 秒：仍连成线段，同一连续段。"""
    records = [Record(t=0, temp=850.0), Record(t=60, temp=850.0), Record(t=120, temp=850.0)]
    segments = find_equivalent_segments(records)
    assert len(segments) == 1
    result = equiv(records)
    assert result["segmentCount"] == 1
    assert abs(result["longestSegment"]["equivalentSeconds"] - 120.0) <= TOL


def test_gap_over_60_seconds_cuts_segment():
    """超 60 秒间隔：不连线段，连续段在此处断开。"""
    records = [
        Record(t=0, temp=850.0),
        Record(t=60, temp=850.0),
        Record(t=121, temp=850.0),
        Record(t=181, temp=850.0),
    ]
    result = equiv(records)
    assert result["segmentCount"] == 2
    assert abs(result["longestSegment"]["equivalentSeconds"] - 60.0) <= TOL


def test_out_of_band_interval_cuts_segment():
    """带外区间（两点之间温度越带）结束连续段，两侧各自成段。"""
    records = [
        Record(t=0, temp=850.0),
        Record(t=60, temp=850.0),
        Record(t=120, temp=800.0),  # 850→800 在 t=72 穿出 840
        Record(t=180, temp=850.0),  # 800→850 在 t=168 穿回 840
        Record(t=240, temp=850.0),
    ]
    result = equiv(records)
    assert result["segmentCount"] == 2
    # 段1 = 恒温片 60 秒 + 穿出片 [60,72] 的 6/ln2
    assert abs(result["longestSegment"]["equivalentSeconds"] - (60.0 + 6.0 / LN2)) <= TOL


def test_boundary_touch_joins_slices_without_double_counting():
    """落在边界的相邻片按同一时刻拼接：V 形触及 840 °C 不切段、不重复计时。

    两片各 60 秒（850→840、840→850），各积 30/ln2，合计 60/ln2。
    """
    records = [
        Record(t=0, temp=850.0),
        Record(t=60, temp=840.0),
        Record(t=120, temp=850.0),
    ]
    result = equiv(records)
    assert result["segmentCount"] == 1
    longest = result["longestSegment"]
    assert longest["startT"] == {"anchorT": 0, "offsetSeconds": 0.0}
    assert longest["endT"] == {"anchorT": 60, "offsetSeconds": 60.0}
    assert abs(longest["equivalentSeconds"] - 60.0 / LN2) <= TOL


def test_constant_slices_integrate_as_constant_rate():
    """恒温片按常量积分：850 °C 速率恰为 1，1800 秒恰好达标。"""
    records = [Record(t=30 * i, temp=850.0) for i in range(61)]  # 0..1800
    result = equiv(records)
    assert result["qualified"] is True
    seg = result["earliestQualifyingSegment"]
    assert seg["startT"] == {"anchorT": 0, "offsetSeconds": 0.0}
    assert seg["endT"] == {"anchorT": 1770, "offsetSeconds": 30.0}
    assert abs(seg["equivalentSeconds"] - MIN_SOAK_SECONDS) <= TOL


def test_earliest_qualifying_segment_reported():
    """两段都达标时取最早达标段。"""
    first = [Record(t=60 * i, temp=850.0) for i in range(31)]       # 0..1800
    gap = [Record(t=1900, temp=500.0)]                              # 带外切段
    second = [Record(t=2000 + 60 * i, temp=850.0) for i in range(31)]
    result = equiv(first + gap + second)
    assert result["qualified"] is True
    assert result["segmentCount"] == 2
    assert result["earliestQualifyingSegment"]["startT"] == {
        "anchorT": 0,
        "offsetSeconds": 0.0,
    }


def test_unqualified_reports_longest_by_equivalent_seconds():
    """不合格时最长有效段按累计等效秒比较。"""
    records = (
        [Record(t=0, temp=850.0), Record(t=60, temp=850.0)]         # 60 等效秒
        + [Record(t=200, temp=830.0), Record(t=260, temp=870.0)]    # 22.5/ln2
    )
    result = equiv(records)
    assert result["qualified"] is False
    longest = result["longestSegment"]
    assert longest["startT"] == {"anchorT": 0, "offsetSeconds": 0.0}
    assert abs(longest["equivalentSeconds"] - 60.0) <= TOL


def test_huge_timestamp_anchor_stays_exact():
    """超大时间戳：插值时刻用整数锚点 + 偏移表示，不丢失精度。"""
    base = 10**20
    records = [Record(t=base + 60 * i, temp=850.0) for i in range(31)]
    result = equiv(records)
    assert result["qualified"] is True
    seg = result["earliestQualifyingSegment"]
    assert seg["startT"] == {"anchorT": base, "offsetSeconds": 0.0}
    # 首次达标时刻 = base + 1800，恰为片 [base+1740, base+1800] 的末端；
    # 锚点与偏移分开断言：二者相加在浮点下本就会丢失精度，正是要避免的表示
    end = seg["endT"]
    assert end["anchorT"] == base + 1740
    assert end["offsetSeconds"] == 60.0
    assert isinstance(end["anchorT"], int)


# ---------------------------------------------------------------------------
# 数值稳定性：极小波动与极端有限温度
# ---------------------------------------------------------------------------


def test_tiny_fluctuation_around_850_not_undercounted():
    """850 °C 附近极小波动：速率差灾难性相消不得少算等效保温。

    每 30 秒一点、在 850±1e-9 间交替，真实等效秒 ≈ 1800（速率≈1）；
    直接对 (r(Tb)-r(Ta))/(Tb-Ta) 求差会丢精度，把足额保温判成不合格。
    """
    for eps in (1e-9, 1e-12):
        records = [
            Record(t=30 * i, temp=850.0 + (eps if i % 2 else -eps))
            for i in range(61)
        ]
        result = equiv(records)
        assert result["qualified"] is True, f"eps={eps}"
        longest = result["longestSegment"]
        assert abs(longest["equivalentSeconds"] - 1800.0) <= TOL
        seg = result["earliestQualifyingSegment"]
        assert abs(seg["equivalentSeconds"] - MIN_SOAK_SECONDS) <= TOL


def _assert_all_finite(value):
    """递归断言结论中的数值全部为有限值。"""
    if isinstance(value, dict):
        for item in value.values():
            _assert_all_finite(item)
    elif isinstance(value, list):
        for item in value:
            _assert_all_finite(item)
    elif isinstance(value, float):
        assert math.isfinite(value), f"非有限值: {value}"


def test_extreme_finite_temperatures_yield_finite_conclusion():
    """极低有限值跨到极高有限值：结论必须有限（无 NaN/inf 进入快照）。"""
    for temps in ((-1e308, 1e308), (1e308, -1e308)):
        records = [Record(t=0, temp=temps[0]), Record(t=60, temp=temps[1])]
        result = equiv(records)
        assert result["qualified"] is False
        _assert_all_finite(result)
        longest = result["longestSegment"]
        # 穿越 840–860 °C 的窗口约 6e-307 秒，等效秒≈0
        assert longest is not None
        assert abs(longest["equivalentSeconds"]) <= TOL


def test_one_sided_extreme_temperature_finite_slice():
    """单侧极端温度：片窗口极小但有限，结论全部有限。"""
    records = [Record(t=0, temp=850.0), Record(t=60, temp=1e308)]
    result = equiv(records)
    assert result["qualified"] is False
    _assert_all_finite(result)
    assert abs(result["longestSegment"]["equivalentSeconds"]) <= TOL


# ---------------------------------------------------------------------------
# 模式分发与旧行为兼容
# ---------------------------------------------------------------------------


def test_default_mode_is_strict():
    records = [Record(t=30 * i, temp=850.0) for i in range(61)]
    assert analyze(records)["analysisMode"] == "strict"


def test_strict_mode_unchanged_for_same_payload():
    """同一文件两种判定：严格模式按采样点切段，等效模式按曲线裁剪。"""
    # 首点 830 °C 越界：严格模式从 t=60 起算，等效模式从穿入点 t=30 起算
    records = [Record(t=0, temp=830.0)] + [
        Record(t=60 * i, temp=850.0) for i in range(1, 32)
    ]
    strict = analyze(records, mode="strict")
    assert strict["analysisMode"] == "strict"
    assert strict["earliestQualifyingSegment"]["startT"] == 60
    equivalent = equiv(records)
    assert equivalent["earliestQualifyingSegment"]["startT"]["offsetSeconds"] == 30.0
