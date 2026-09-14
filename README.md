# 淬火炉保温段验收

上传温度记录 JSON，判定工件是否经历了足够长的有效保温段，避免把“短暂到温”
或“采样断档”误判为合格。

## 判定规则

- 有效保温段由**连续记录**构成：每条温度都落在闭区间 **840–860 °C**，且任意
  相邻记录时间差不超过 **60 秒**；一次越界或超间隔立即切段。
- 段持续时间 = 末项 `t` − 首项 `t`，达到 **1800 秒**即合格。
- 页面只显示**唯一结论**：
  - 合格 → 给出**最早达标段**的起止时间；
  - 不合格 → 给出**最长有效段**的时长。

## 上传文件要求（任一不满足即整份拒绝并清除旧结果）

- JSON 文件，根必须是数组；每项含整数秒时间戳 `t` 与摄氏温度 `temp`。
- 记录数 **2–10000**；时间戳**严格递增**；温度必须为**有限数值**
  （拒绝 `NaN` / `Infinity` / 溢出值）。
- 文件大小上限 **2 MiB**。

示例（合格）：

```json
[{"t": 0, "temp": 850}, {"t": 30, "temp": 851}, {"t": 60, "temp": 849}]
```

## 文件结构

```
compose.yaml          # 一键启动：api + web + verify
api/                  # FastAPI 后端
  app/soak.py         #   解析校验 + 保温段判定（纯函数）
  app/main.py         #   POST /api/analyze、GET /api/health
  tests/              #   pytest：解析与区间判定判据
web/                  # React (Vite) 前端
  src/lib/verdict.js  #   分析结果 → 唯一结论视图模型
  src/lib/verdict.test.js  # Vitest：结论判定判据
  nginx.conf          #   生产环境 /api 反代到内部 api 服务
e2e/                  # Playwright：浏览器真实上传链路判据
verify/               # 一次性验收服务（pytest → vitest → playwright）
```

## 运行

```bash
# 启动应用（默认 http://localhost:8080，可用 WEB_PORT 覆盖宿主端口）
WEB_PORT=9000 docker compose up --build api web

# 一次性验收：构建并运行 verify，全部判据通过后容器退出
docker compose up --build --exit-code-from verify verify
```

`api` 不发布宿主端口，浏览器只访问 `web`，由 nginx 将 `/api/*` 代理到内部
`api:8000`。

## 本地开发（不用 Docker）

```bash
# 后端：http://localhost:8000
cd api && pip install -r requirements-dev.txt
uvicorn app.main:app --reload          # 测试：python -m pytest

# 前端：http://localhost:5173（/api 已代理到 8000）
cd web && npm ci
npm run dev                            # 测试：npm test

# 端到端（需 web 与 api 均在运行）
cd e2e && npm ci && npx playwright install chromium
WEB_PORT=8080 npx playwright test
```

## API

`POST /api/analyze`（multipart 字段名 `file`）

- `200`：`{ qualified, earliestQualifyingSegment, longestSegment, recordCount, ... }`
- `422`：`{ detail: { code, message } }` —— 格式错误、缺字段、乱序、非有限值、
  记录数或文件大小超限等，整份拒绝。
