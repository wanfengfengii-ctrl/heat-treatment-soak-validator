"""FastAPI 入口：接收 JSON 文件上传，返回保温段分析结论。"""

from __future__ import annotations

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

from .soak import MAX_FILE_BYTES, Rejection, analyze, parse_payload

app = FastAPI(title="淬火炉保温判定 API")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/analyze")
async def analyze_file(file: UploadFile = File(...)):
    # 多读 1 字节以识别超限文件，避免无界读取
    raw = await file.read(MAX_FILE_BYTES + 1)
    try:
        records = parse_payload(raw)
    except Rejection as rej:
        return JSONResponse(
            status_code=422,
            content={"detail": {"code": rej.code, "message": rej.message}},
        )
    return analyze(records)
