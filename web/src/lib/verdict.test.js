import { describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  buildVerdict,
  formatDuration,
  formatTimestamp,
  formatTimestampOrRaw,
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

  it("超出 JS Date 范围的超大合法时间戳返回 null 而非抛异常", () => {
    // 10^13 秒 × 1000 = 10^16 毫秒 > 8.64e15，toISOString 会抛 RangeError
    expect(formatTimestamp(10_000_000_000_000)).toBeNull();
    expect(formatTimestamp(-10_000_000_000_000)).toBeNull();
    expect(formatTimestamp(Infinity)).toBeNull();
  });

  it("formatTimestampOrRaw 对超大时间戳退回原始秒数", () => {
    expect(formatTimestampOrRaw(10_000_000_000_000)).toBe("t = 10000000000000");
    expect(formatTimestampOrRaw(1800)).toBe("1970-01-01 00:30:00 UTC");
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

  it("超大整数时间戳的合格段不抛异常，起止退回原始秒数", () => {
    const base = 10_000_000_000_000;
    const verdict = buildVerdict({
      qualified: true,
      earliestQualifyingSegment: {
        startT: base,
        endT: base + 1800,
        duration: 1800,
        points: 61,
      },
      longestSegment: null,
    });
    expect(verdict.status).toBe("qualified");
    const start = verdict.rows.find((r) => r.label === "达标段开始");
    const end = verdict.rows.find((r) => r.label === "达标段结束");
    expect(start.value).toBe("t = 10000000000000");
    expect(start.raw).toBeUndefined();
    expect(end.value).toBe("t = 10000000001800");
  });

  it("超大整数时间戳的不合格区间同样安全降级", () => {
    const base = 10_000_000_000_000;
    const verdict = buildVerdict({
      qualified: false,
      earliestQualifyingSegment: null,
      longestSegment: { startT: base, endT: base + 270, duration: 270, points: 10 },
    });
    expect(verdict.status).toBe("unqualified");
    const range = verdict.rows.find((r) => r.label === "最长有效段区间");
    expect(range.value).toBe("t = 10000000000000 至 t = 10000000000270");
  });
});
