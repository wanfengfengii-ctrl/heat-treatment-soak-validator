import { describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  buildVerdict,
  formatDuration,
  formatTimestamp,
  validateFile,
} from "./verdict";

describe("validateFile 上传预检", () => {
  it("无文件时拒绝", () => {
    expect(validateFile(null).code).toBe("no_file");
  });

  it("空文件拒绝", () => {
    expect(validateFile({ size: 0 }).code).toBe("empty_file");
  });

  it("超过 2 MiB 拒绝", () => {
    const result = validateFile({ size: MAX_FILE_BYTES + 1 });
    expect(result.code).toBe("file_too_large");
  });

  it("恰好 2 MiB 放行", () => {
    expect(validateFile({ size: MAX_FILE_BYTES })).toBeNull();
  });
});

describe("formatTimestamp / formatDuration", () => {
  it("时间戳格式化为 UTC 文本", () => {
    expect(formatTimestamp(0)).toBe("1970-01-01 00:00:00 UTC");
    expect(formatTimestamp(1800)).toBe("1970-01-01 00:30:00 UTC");
  });

  it("整分钟时长不带“约”", () => {
    expect(formatDuration(1800)).toBe("1800 秒（30 分钟）");
  });

  it("非整分钟时长带“约”", () => {
    expect(formatDuration(270)).toBe("270 秒（约 4.5 分钟）");
    expect(formatDuration(0)).toBe("0 秒（0 分钟）");
  });
});

describe("buildVerdict 唯一结论", () => {
  it("合格时给出最早达标段的起止时间", () => {
    const verdict = buildVerdict({
      qualified: true,
      earliestQualifyingSegment: { startT: 0, endT: 1800, duration: 1800, points: 61 },
      longestSegment: { startT: 2000, endT: 3900, duration: 1900, points: 64 },
    });
    expect(verdict.status).toBe("qualified");
    expect(verdict.headline).toBe("保温合格");
    const start = verdict.rows.find((r) => r.label === "达标段开始");
    const end = verdict.rows.find((r) => r.label === "达标段结束");
    expect(start.value).toBe("1970-01-01 00:00:00 UTC");
    expect(end.value).toBe("1970-01-01 00:30:00 UTC");
  });

  it("不合格时给出最长有效段时长", () => {
    const verdict = buildVerdict({
      qualified: false,
      earliestQualifyingSegment: null,
      longestSegment: { startT: 300, endT: 570, duration: 270, points: 10 },
    });
    expect(verdict.status).toBe("unqualified");
    expect(verdict.headline).toBe("保温不合格");
    expect(verdict.rows[0].label).toBe("最长有效段时长");
    expect(verdict.rows[0].value).toBe("270 秒（约 4.5 分钟）");
  });

  it("短时到温（无有效段）时长为 0", () => {
    const verdict = buildVerdict({
      qualified: false,
      earliestQualifyingSegment: null,
      longestSegment: null,
    });
    expect(verdict.status).toBe("unqualified");
    expect(verdict.rows[0].value).toBe("0 秒（0 分钟）");
  });

  it("qualified 但缺段数据时按不合格兜底", () => {
    const verdict = buildVerdict({
      qualified: true,
      earliestQualifyingSegment: null,
      longestSegment: null,
    });
    expect(verdict.status).toBe("unqualified");
  });
});
