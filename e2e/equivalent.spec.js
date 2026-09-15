import { expect, test } from "@playwright/test";

/** 生成从 startT 起、每 step 秒一点、恒定 temp 的 count 条记录 */
function series(startT, count, step, temp) {
  return Array.from({ length: count }, (_, i) => ({
    t: startT + i * step,
    temp,
  }));
}

async function selectMode(page, label) {
  await page.getByLabel(label).check();
}

async function uploadPayload(page, name, records) {
  await page.locator("#record-file").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(records)),
  });
  await page.getByRole("button", { name: "上传并分析" }).click();
}

// 命名卷会在多次 compose up 之间保留记录，按炉次号过滤并取倒序首位
function heatItem(page, heatNo) {
  return page
    .getByTestId("history-item")
    .filter({ hasText: heatNo })
    .first();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("等效模式：低温穿入后达标，页面显示等效判据", async ({ page }) => {
  // t=0 为 830 °C，线性升温在 t=30 穿入 840 °C，其后恒温 850 °C
  const records = [{ t: 0, temp: 830 }, ...series(60, 31, 60, 850)];
  await selectMode(page, "线性曲线等效保温");
  await uploadPayload(page, "ramp.json", records);

  const verdict = page.getByTestId("verdict");
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温合格");
  await expect(page.getByTestId("verdict-mode")).toHaveText(
    "判定方式：线性曲线等效保温",
  );
  await expect(verdict).toContainText("达标段开始");
  await expect(verdict).toContainText("首次达标时刻");
  // 首次达标时刻 = 锚点 1800 + (60 - 15/ln2) ≈ 38.360 秒偏移
  await expect(verdict).toContainText("+ 38.360 秒");
  await expect(verdict).toContainText("累计等效秒");
  await expect(verdict).toContainText("1800.000 秒");
  await expect(page.getByTestId("error")).toHaveCount(0);
});

test("等效模式：单线段穿越双边界，只计 840–860 °C 时间片", async ({ page }) => {
  // 830 → 870 °C 一条线段：片 [15,45]，解析积分 22.5/ln2 ≈ 32.461 等效秒
  await selectMode(page, "线性曲线等效保温");
  await uploadPayload(page, "cross.json", [
    { t: 0, temp: 830 },
    { t: 60, temp: 870 },
  ]);

  const verdict = page.getByTestId("verdict");
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温不合格");
  await expect(page.getByTestId("verdict-mode")).toHaveText(
    "判定方式：线性曲线等效保温",
  );
  await expect(verdict).toContainText("最长段累计等效秒");
  await expect(verdict).toContainText("32.461 秒");
});

test("等效模式：60 秒间隔连成线段，超 60 秒间隔切段", async ({ page }) => {
  await selectMode(page, "线性曲线等效保温");

  // 恰好 60 秒间隔：31 点覆盖 0..1800，恒温片常量积分恰达 1800 等效秒
  await uploadPayload(page, "gap60.json", series(0, 31, 60, 850));
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温合格");
  await expect(page.getByTestId("verdict")).toContainText("1800.000 秒");

  // 中间一处 61 秒间隔：断成两段各 900 等效秒，判不合格
  const halves = [...series(0, 16, 60, 850), ...series(961, 16, 60, 850)];
  await uploadPayload(page, "gap61.json", halves);
  const verdict = page.getByTestId("verdict");
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温不合格");
  await expect(verdict).toContainText("最长段累计等效秒");
  await expect(verdict).toContainText("900.000 秒");
});

test("回看旧记录标明记录模式，且不改动上传用的模式选择", async ({ page }) => {
  // 默认严格判定上传一条合格记录
  await page.locator("#record-file").setInputFiles({
    name: "strict.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(series(0, 61, 30, 850))),
  });
  await page.locator("#heat-no").fill("H-MODE-KEEP");
  await page.getByRole("button", { name: "上传并分析" }).click();
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温合格");
  await expect(page.getByTestId("verdict-mode")).toHaveText("判定方式：严格判定");
  await expect(heatItem(page, "H-MODE-KEEP")).toContainText("严格判定");

  // 切换上传模式为线性等效（不影响已落库记录）
  await selectMode(page, "线性曲线等效保温");
  await expect(page.getByLabel("线性曲线等效保温")).toBeChecked();

  // 回看严格判定的旧记录：结论标明记录模式，上传选择保持线性等效不变
  await heatItem(page, "H-MODE-KEEP").click();
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温合格");
  await expect(page.getByTestId("verdict-mode")).toHaveText("判定方式：严格判定");
  await expect(page.getByTestId("verdict-source")).toContainText("H-MODE-KEEP");
  await expect(page.getByLabel("线性曲线等效保温")).toBeChecked();
  await expect(page.getByLabel("严格判定（默认）")).not.toBeChecked();
});

test("等效模式上传后，历史摘要标明判定方式", async ({ page }) => {
  await selectMode(page, "线性曲线等效保温");
  await page.locator("#record-file").setInputFiles({
    name: "equiv-heat.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([{ t: 0, temp: 830 }, ...series(60, 31, 60, 850)]),
    ),
  });
  await page.locator("#heat-no").fill("H-EQUIV-LIST");
  await page.getByRole("button", { name: "上传并分析" }).click();
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温合格");

  await expect(heatItem(page, "H-EQUIV-LIST")).toContainText("线性等效");
});

test("等效模式：850 °C 附近极小波动，足额等效保温不少算", async ({ page }) => {
  // 每 30 秒一点，在 850±1e-9 间交替：速率≈1，等效秒应≈1800 判合格
  const records = Array.from({ length: 61 }, (_, i) => ({
    t: 30 * i,
    temp: 850 + (i % 2 ? 1e-9 : -1e-9),
  }));
  await selectMode(page, "线性曲线等效保温");
  await uploadPayload(page, "tiny-fluctuation.json", records);

  const verdict = page.getByTestId("verdict");
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温合格");
  await expect(verdict).toContainText("1800.000 秒");
  await expect(page.getByTestId("error")).toHaveCount(0);
});

test("等效模式：极低到极高有限温度，返回有限结论且记录可回看", async ({ page }) => {
  // -1e308 → 1e308 单线段：穿越窗口约 6e-307 秒，等效秒≈0，判不合格
  await selectMode(page, "线性曲线等效保温");
  await page.locator("#record-file").setInputFiles({
    name: "extreme.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([
        { t: 0, temp: -1e308 },
        { t: 60, temp: 1e308 },
      ]),
    ),
  });
  await page.locator("#heat-no").fill("H-EXTREME");
  await page.getByRole("button", { name: "上传并分析" }).click();

  // 页面显示有限的唯一结论，而不是服务错误
  const verdict = page.getByTestId("verdict");
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温不合格");
  await expect(verdict).toContainText("最长段累计等效秒");
  await expect(verdict).toContainText("0.000 秒");
  await expect(page.getByTestId("error")).toHaveCount(0);

  // 落库记录可回看：点击后恢复同一结论
  await heatItem(page, "H-EXTREME").click();
  await expect(page.getByTestId("verdict-headline")).toHaveText("保温不合格");
  await expect(page.getByTestId("verdict-source")).toContainText("H-EXTREME");
  await expect(page.getByTestId("verdict")).toContainText("0.000 秒");
});
