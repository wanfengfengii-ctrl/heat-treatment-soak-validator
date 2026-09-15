"""analysis_mode 接口判据：可选模式、未知模式 422、历史摘要标明判定方式、
旧请求与无模式旧记录按严格判定读取。"""

import json
import sqlite3

from app import storage


def ramp_series():
    """低温穿入后达标的炉次：严格与等效两种判定结论不同。"""
    return [{"t": 0, "temp": 830}] + [
        {"t": 60 * i, "temp": 850} for i in range(1, 32)
    ]


def upload(client_obj, records, filename="data.json", mode=None):
    body = json.dumps(records).encode("utf-8")
    data = {"analysis_mode": mode} if mode is not None else {}
    return client_obj.post(
        "/api/analyze", files={"file": (filename, body, "application/json")}, data=data
    )


def test_legacy_request_without_mode_defaults_to_strict(client):
    """旧请求（不带 analysis_mode）：按严格判定，结论快照记录模式。"""
    c, _ = client
    resp = upload(c, ramp_series())
    assert resp.status_code == 200
    data = resp.json()
    assert data["analysisMode"] == "strict"
    # 严格模式按采样点切段：首点 830 越界，段从 t=60 起
    assert data["earliestQualifyingSegment"]["startT"] == 60


def test_explicit_strict_mode_matches_legacy_behavior(client):
    c, _ = client
    resp = upload(c, ramp_series(), mode="strict")
    assert resp.status_code == 200
    assert resp.json()["analysisMode"] == "strict"


def test_linear_equivalent_mode_returns_equivalent_conclusion(client):
    c, _ = client
    resp = upload(c, ramp_series(), mode="linear_equivalent")
    assert resp.status_code == 200
    data = resp.json()
    assert data["analysisMode"] == "linear_equivalent"
    assert data["qualified"] is True
    seg = data["earliestQualifyingSegment"]
    # 插值时刻：整数锚点 + 十进制秒偏移
    assert seg["startT"] == {"anchorT": 0, "offsetSeconds": 30.0}
    assert seg["endT"]["anchorT"] == 1800
    assert abs(seg["endT"]["offsetSeconds"] - 38.3595743866656) <= 1e-3
    assert abs(seg["equivalentSeconds"] - 1800.0) <= 1e-3
    # 结论快照落库：模式与等效秒都可回看
    detail = c.get(f"/api/history/{data['historyId']}").json()
    saved = detail["conclusion"]
    assert saved["analysisMode"] == "linear_equivalent"
    assert saved["earliestQualifyingSegment"]["equivalentSeconds"] == 1800.0


def test_unknown_mode_rejected_before_file_parsing(client):
    """未知模式先于文件解析返回可识别的 422：坏文件也报模式错误。"""
    c, _ = client
    resp = c.post(
        "/api/analyze",
        files={"file": ("bad.json", b"not json at all", "application/json")},
        data={"analysis_mode": "polynomial"},
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "unknown_analysis_mode"
    assert "polynomial" in detail["message"]


def test_unknown_mode_leaves_no_history(client):
    c, db_path = client
    resp = upload(c, ramp_series(), mode="fuzzy")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_analysis_mode"
    with sqlite3.connect(db_path) as conn:
        count = conn.execute("SELECT COUNT(*) FROM analyses").fetchone()[0]
    assert count == 0


def test_history_summary_marks_analysis_mode(client):
    """历史摘要标明判定方式：两种模式各一条，倒序返回。"""
    c, _ = client
    upload(c, ramp_series(), "strict.json", mode="strict")
    upload(c, ramp_series(), "equiv.json", mode="linear_equivalent")
    items = c.get("/api/history").json()["items"]
    assert [i["analysisMode"] for i in items] == ["linear_equivalent", "strict"]


def test_legacy_record_without_mode_read_as_strict(client):
    """无模式的旧记录：摘要按严格判定读取。"""
    c, db_path = client
    conn = storage.connect(db_path)
    try:
        legacy = {
            "recordCount": 61,
            "segmentCount": 1,
            "qualified": True,
            "earliestQualifyingSegment": {
                "startT": 0, "endT": 1800, "duration": 1800, "points": 61,
            },
            "longestSegment": {
                "startT": 0, "endT": 1800, "duration": 1800, "points": 61,
            },
            "limits": {
                "tempLow": 840.0, "tempHigh": 860.0,
                "maxGapSeconds": 60, "minSoakSeconds": 1800,
            },
        }
        record_id = storage.insert_analysis(
            conn, heat_no="H-LEGACY", filename="legacy.json", conclusion=legacy
        )
    finally:
        conn.close()

    item = c.get("/api/history").json()["items"][0]
    assert item["analysisMode"] == "strict"
    detail = c.get(f"/api/history/{record_id}").json()
    assert "analysisMode" not in detail["conclusion"]  # 落库原文不变
    assert detail["conclusion"]["qualified"] is True
