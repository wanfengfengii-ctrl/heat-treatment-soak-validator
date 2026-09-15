import { describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  analysisModeOf,
  buildVerdict,
  formatDuration,
  formatEquivalentSeconds,
  formatTimePoint,
  formatTimestamp,
  formatTimestampOrRaw,
  parseJsonPreserveBigInts,
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

describe("parseJsonPreserveBigInts 大整数解析", () => {
  it("超出安全整数的时间戳还原为精确 BigInt", () => {
    const parsed = parseJsonPreserveBigInts(
      '{"startT": 100000000000000000000, "endT": 100000000000000001800, "duration": 1800, "temp": 840.5}',
    );
    expect(parsed.startT).toBe(100000000000000000000n);
    expect(parsed.endT).toBe(100000000000000001800n);
    // 朴素 JSON.parse 会把这两个值舍入成同一个数
    expect(parsed.endT - parsed.startT).toBe(1800n);
  });

  it("安全整数与普通浮点保持 number 不变", () => {
    const parsed = parseJsonPreserveBigInts(
      '{"t": 1800, "temp": 840.5, "low": 840.0, "ok": true, "s": "x"}',
    );
    expect(parsed.t).toBe(1800);
    expect(typeof parsed.t).toBe("number");
    expect(parsed.temp).toBe(840.5);
    expect(parsed.low).toBe(840);
    expect(parsed.ok).toBe(true);
    expect(parsed.s).toBe("x");
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

  it("BigInt 时间戳精确保留原始值", () => {
    expect(formatTimestamp(100000000000000000000n)).toBeNull();
    expect(formatTimestampOrRaw(100000000000000000000n)).toBe(
      "t = 100000000000000000000",
    );
  });

  it("BigInt 时长精确格式化", () => {
    expect(formatDuration(1800n)).toBe("1800 秒（30 分钟）");
    expect(formatDuration(90n)).toBe("90 秒（约 1.5 分钟）");
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

  it("超出安全整数的 BigInt 起止保留相差 1800 秒的原始值", () => {
    const base = 100000000000000000000n; // 10^20，朴素 JSON.parse 会舍入碰撞
    const verdict = buildVerdict({
      qualified: true,
      earliestQualifyingSegment: {
        startT: base,
        endT: base + 1800n,
        duration: 1800,
        points: 61,
      },
      longestSegment: null,
    });
    expect(verdict.status).toBe("qualified");
    const start = verdict.rows.find((r) => r.label === "达标段开始");
    const end = verdict.rows.find((r) => r.label === "达标段结束");
    expect(start.value).toBe("t = 100000000000000000000");
    expect(end.value).toBe("t = 100000000000000001800");
    expect(start.value).not.toBe(end.value);
  });
});

describe("analysisModeOf 判定模式识别", () => {
  it("缺省与未知模式一律按严格判定读取（旧记录兼容）", () => {
    expect(analysisModeOf({})).toBe("strict");
    expect(analysisModeOf({ analysisMode: "strict" })).toBe("strict");
    expect(analysisModeOf({ analysisMode: "fuzzy" })).toBe("strict");
    expect(analysisModeOf(null)).toBe("strict");
    expect(analysisModeOf(undefined)).toBe("strict");
  });

  it("线性等效模式原样识别", () => {
    expect(analysisModeOf({ analysisMode: "linear_equivalent" })).toBe(
      "linear_equivalent",
    );
  });
});

describe("formatTimePoint 插值时刻（整数锚点 + 十进制秒偏移）", () => {
  it("零偏移等同普通整数时刻", () => {
    expect(formatTimePoint({ anchorT: 1800, offsetSeconds: 0 })).toBe(
      "1970-01-01 00:30:00 UTC",
    );
  });

  it("非零偏移以 + X.XXX 秒附加", () => {
    expect(formatTimePoint({ anchorT: 1800, offsetSeconds: 38.359574 })).toBe(
      "1970-01-01 00:30:00 UTC + 38.360 秒",
    );
  });

  it("超大锚点退回原始秒数且不丢精度", () => {
    expect(
      formatTimePoint({ anchorT: 10_000_000_000_000, offsetSeconds: 12.5 }),
    ).toBe("t = 10000000000000 + 12.500 秒");
    expect(
      formatTimePoint({ anchorT: 100000000000000000000n, offsetSeconds: 0 }),
    ).toBe("t = 100000000000000000000");
  });

  it("普通整数时刻与空值安全通过", () => {
    expect(formatTimePoint(1800)).toBe("1970-01-01 00:30:00 UTC");
    expect(formatTimePoint(null)).toBe("—");
  });
});

describe("formatEquivalentSeconds 等效秒", () => {
  it("保留三位小数", () => {
    expect(formatEquivalentSeconds(1800)).toBe("1800.000 秒");
    expect(formatEquivalentSeconds(32.46063842)).toBe("32.461 秒");
  });

  it("非法输入安全降级", () => {
    expect(formatEquivalentSeconds(undefined)).toBe("0.000 秒");
    expect(formatEquivalentSeconds(NaN)).toBe("0.000 秒");
  });
});

describe("buildVerdict 线性曲线等效保温", () => {
  const qualifiedAnalysis = {
    analysisMode: "linear_equivalent",
    qualified: true,
    earliestQualifyingSegment: {
      startT: { anchorT: 0, offsetSeconds: 30 },
      endT: { anchorT: 1800, offsetSeconds: 38.3595743866656 },
      equivalentSeconds: 1800,
      slices: 31,
    },
    longestSegment: null,
  };

  it("合格时给出达标段开始、首次达标时刻与累计等效秒", () => {
    const verdict = buildVerdict(qualifiedAnalysis);
    expect(verdict.status).toBe("qualified");
    expect(verdict.headline).toBe("保温合格");
    expect(verdict.mode).toBe("linear_equivalent");
    expect(verdict.modeText).toBe("线性曲线等效保温");
    const start = verdict.rows.find((r) => r.label === "达标段开始");
    const reach = verdict.rows.find((r) => r.label === "首次达标时刻");
    const equiv = verdict.rows.find((r) => r.label === "累计等效秒");
    expect(start.value).toBe("1970-01-01 00:00:00 UTC + 30.000 秒");
    expect(reach.value).toBe("1970-01-01 00:30:00 UTC + 38.360 秒");
    expect(equiv.value).toBe("1800.000 秒");
  });

  it("不合格时给出最长段累计等效秒与插值区间", () => {
    const verdict = buildVerdict({
      analysisMode: "linear_equivalent",
      qualified: false,
      earliestQualifyingSegment: null,
      longestSegment: {
        startT: { anchorT: 0, offsetSeconds: 15 },
        endT: { anchorT: 0, offsetSeconds: 45 },
        equivalentSeconds: 32.46063842000167,
        slices: 1,
      },
    });
    expect(verdict.status).toBe("unqualified");
    expect(verdict.modeText).toBe("线性曲线等效保温");
    const equiv = verdict.rows.find((r) => r.label === "最长段累计等效秒");
    expect(equiv.value).toBe("32.461 秒");
    const range = verdict.rows.find((r) => r.label === "最长有效段区间");
    expect(range.value).toBe(
      "1970-01-01 00:00:00 UTC + 15.000 秒 至 1970-01-01 00:00:00 UTC + 45.000 秒",
    );
  });

  it("无任何有效段时等效秒为 0", () => {
    const verdict = buildVerdict({
      analysisMode: "linear_equivalent",
      qualified: false,
      earliestQualifyingSegment: null,
      longestSegment: null,
    });
    expect(verdict.rows[0].value).toBe("0.000 秒");
  });

  it("无模式的旧记录按严格判定读取", () => {
    const verdict = buildVerdict({
      qualified: true,
      earliestQualifyingSegment: { startT: 0, endT: 1800, duration: 1800, points: 61 },
      longestSegment: null,
    });
    expect(verdict.mode).toBe("strict");
    expect(verdict.modeText).toBe("严格判定");
    expect(verdict.rows.map((r) => r.label)).toContain("达标段时长");
  });
});
