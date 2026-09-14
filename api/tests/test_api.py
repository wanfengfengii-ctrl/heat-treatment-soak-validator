"""API 层判据：真实上传链路，合格/不合格/拒绝三种走向。"""

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def upload(records, filename="data.json"):
    body = json.dumps(records).encode("utf-8")
    return client.post(
        "/api/analyze", files={"file": (filename, body, "application/json")}
    )


def qualified_series():
    return [{"t": i * 30, "temp": 850} for i in range(61)]  # 0..1800


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_qualified_upload():
    resp = upload(qualified_series())
    assert resp.status_code == 200
    data = resp.json()
    assert data["qualified"] is True
    assert data["earliestQualifyingSegment"]["startT"] == 0
    assert data["earliestQualifyingSegment"]["endT"] == 1800
    assert data["recordCount"] == 61


def test_unqualified_upload_reports_longest():
    resp = upload([{"t": i * 30, "temp": 850} for i in range(10)])  # 时长 270
    assert resp.status_code == 200
    data = resp.json()
    assert data["qualified"] is False
    assert data["longestSegment"]["duration"] == 270


def test_invalid_payload_rejected_with_code():
    resp = upload([{"t": 1, "temp": 850}, {"t": 1, "temp": 851}])
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "timestamps_not_strictly_increasing"
    assert "message" in detail


def test_missing_field_rejected():
    resp = upload([{"t": 0, "temp": 850}, {"t": 1}])
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "missing_field"


def test_non_finite_rejected():
    body = b'[{"t": 0, "temp": 850}, {"t": 1, "temp": NaN}]'
    resp = client.post(
        "/api/analyze", files={"file": ("data.json", body, "application/json")}
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "non_finite_value"


def test_oversize_file_rejected():
    big = b"[" + b",".join(
        b'{"t": %d, "temp": 850}' % i for i in range(200_000)
    ) + b"]"
    assert len(big) > 2 * 1024 * 1024
    resp = client.post(
        "/api/analyze", files={"file": ("big.json", big, "application/json")}
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "file_too_large"


def test_missing_file_field_rejected():
    resp = client.post("/api/analyze")
    assert resp.status_code == 422
