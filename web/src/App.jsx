import { useRef, useState } from "react";

import { buildVerdict, validateFile } from "./lib/verdict";

export default function App() {
  const [file, setFile] = useState(null);
  const [verdict, setVerdict] = useState(null); // 唯一结论
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  async function handleSubmit(event) {
    event.preventDefault();
    // 每次提交都先清除旧结果与旧错误，避免误读过期结论
    setVerdict(null);
    setError(null);

    const problem = validateFile(file);
    if (problem) {
      setError(problem.message);
      return;
    }

    setLoading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch("/api/analyze", { method: "POST", body: form });
      const body = await resp.json().catch(() => null);
      if (!resp.ok) {
        // 整份拒绝：仅显示错误，旧结果已清除
        const message = body?.detail?.message ?? `服务器拒绝（HTTP ${resp.status}）`;
        setError(message);
        return;
      }
      setVerdict(buildVerdict(body));
    } catch {
      setError("无法连接分析服务，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <h1>淬火炉保温段验收</h1>
      <p className="hint">
        上传温度记录 JSON（根为数组，每项含整数秒时间戳 <code>t</code> 与摄氏温度{" "}
        <code>temp</code>）。判定标准：温度连续落在 840–860&nbsp;°C、相邻采样间隔不超过
        60 秒、段持续时长达到 1800 秒。
      </p>

      <form onSubmit={handleSubmit} className="upload">
        <label htmlFor="record-file">温度记录文件</label>
        <input
          id="record-file"
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button type="submit" disabled={loading}>
          {loading ? "分析中…" : "上传并分析"}
        </button>
      </form>

      {error && (
        <div role="alert" className="banner error" data-testid="error">
          <strong>文件被拒绝：</strong>
          {error}
        </div>
      )}

      {verdict && (
        <section
          className={`banner verdict ${verdict.status}`}
          data-testid="verdict"
          aria-live="polite"
        >
          <h2 data-testid="verdict-headline">{verdict.headline}</h2>
          <dl>
            {verdict.rows.map((row) => (
              <div key={row.label} className="row">
                <dt>{row.label}</dt>
                <dd>
                  {row.value}
                  {row.raw !== undefined && <span className="raw">（t = {row.raw}）</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </main>
  );
}
