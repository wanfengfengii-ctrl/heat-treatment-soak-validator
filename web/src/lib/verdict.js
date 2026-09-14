// 纯函数：把 API 分析结果映射为页面上的“唯一结论”视图模型，
// 以及上传前的本地预检。判定本身由后端完成，这里只做呈现决策。

export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 与后端 2 MiB 上限一致

/** 上传前预检；返回 null 表示可以提交，否则返回 { code, message }。 */
export function validateFile(file) {
  if (!file) {
    return { code: "no_file", message: "请先选择要上传的 JSON 文件" };
  }
  if (file.size === 0) {
    return { code: "empty_file", message: "文件为空，请重新选择" };
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      code: "file_too_large",
      message: `文件大小 ${file.size} 字节超过上限 ${MAX_FILE_BYTES} 字节 (2 MiB)`,
    };
  }
  return null;
}

/** 秒级时间戳 → "2026-09-14 08:30:00 UTC"。 */
export function formatTimestamp(t) {
  const iso = new Date(t * 1000).toISOString(); // 2026-09-14T08:30:00.000Z
  return `${iso.slice(0, 19).replace("T", " ")} UTC`;
}

/** 时长（秒）→ "1800 秒（30 分钟）"。 */
export function formatDuration(seconds) {
  const minutes = seconds / 60;
  const minuteText = Number.isInteger(minutes)
    ? `${minutes} 分钟`
    : `约 ${minutes.toFixed(1)} 分钟`;
  return `${seconds} 秒（${minuteText}）`;
}

/**
 * 由 API 分析结果生成唯一结论：
 * - 合格：给出最早达标段的起止时间；
 * - 不合格：给出最长有效段时长（无任何有效段时长为 0）。
 */
export function buildVerdict(analysis) {
  if (analysis.qualified && analysis.earliestQualifyingSegment) {
    const seg = analysis.earliestQualifyingSegment;
    return {
      status: "qualified",
      headline: "保温合格",
      rows: [
        { label: "达标段开始", value: formatTimestamp(seg.startT), raw: seg.startT },
        { label: "达标段结束", value: formatTimestamp(seg.endT), raw: seg.endT },
        { label: "达标段时长", value: formatDuration(seg.duration) },
      ],
    };
  }
  const longest = analysis.longestSegment;
  const duration = longest ? longest.duration : 0;
  const rows = [{ label: "最长有效段时长", value: formatDuration(duration) }];
  if (longest) {
    rows.push({
      label: "最长有效段区间",
      value: `${formatTimestamp(longest.startT)} 至 ${formatTimestamp(longest.endT)}`,
    });
  }
  return { status: "unqualified", headline: "保温不合格", rows };
}
