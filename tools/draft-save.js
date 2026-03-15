/**
 * draft-save.js - 非対話型 カルテ下書き一括保存
 *
 * 既に起動中のデバッグ Chrome に接続し、
 * 受付一覧の全患者について前回カルテを複写→下書き保存する。
 * 処理は新しいタブで行い、元の受付タブには触らない。
 *
 * 使い方: node tools/draft-save.js
 * 前提: Chrome が --remote-debugging-port=9222 で起動済み
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ── 設定 ─────────────────────────────────────────
const CDP_URL = "http://127.0.0.1:9222";
const PROCESSED_FILE = path.join(__dirname, "..", "scripts", "processed.json");

// ── ユーティリティ ──────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleTimeString("ja-JP");
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTodayDateStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf-8"));
      // 新形式: { date: "YYYY-MM-DD", items: [...] }
      if (raw && typeof raw === "object" && raw.date && Array.isArray(raw.items)) {
        if (raw.date === getTodayDateStr()) {
          log(`処理済みデータ読み込み: ${raw.items.length} 件 (${raw.date})`);
          return new Set(raw.items);
        } else {
          log(`前日分の処理済みデータを破棄 (${raw.date} → ${getTodayDateStr()})`);
          return new Set();
        }
      }
      // 旧形式: 配列のみ → 日付不明なので破棄
      if (Array.isArray(raw)) {
        log(`旧形式の processed.json を破棄（日付情報なし）`);
        return new Set();
      }
    }
  } catch (e) {
    console.warn("processed.json の読み込みに失敗:", e.message);
  }
  return new Set();
}

function saveProcessed(set) {
  const data = { date: getTodayDateStr(), items: [...set] };
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ── メイン処理 ──────────────────────────────────
async function main() {
  log("╔══════════════════════════════════════════╗");
  log("║    下書き一括保存（自動モード）          ║");
  log("╚══════════════════════════════════════════╝");
  log("");

  // Chrome に接続
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    log(`[エラー] Chrome に接続できません: ${err.message}`);
    process.exit(1);
  }
  log("Chrome 接続OK");

  const context = browser.contexts()[0];
  if (!context) {
    log("[エラー] ブラウザコンテキストなし");
    process.exit(1);
  }

  // 受付ページを探す
  const pages = context.pages();
  const receptionPage = pages.find((p) => p.url().includes("/reception"));
  if (!receptionPage) {
    log("[エラー] 受付ページが開かれていません。");
    notifyCompletion(pages);
    process.exit(1);
  }

  log(`受付ページ: ${receptionPage.url()}`);

  // 患者リンク収集
  log("患者リンクを収集中...");
  await sleep(1000);

  try {
    await receptionPage.waitForSelector('a[href*="/karte/patients/"]', { timeout: 15000 });
  } catch {
    log("[エラー] 患者リンクが見つかりません。受付一覧に患者が表示されていますか？");
    notifyCompletion(pages);
    process.exit(1);
  }
  await sleep(800);

  const patientLinks = await receptionPage.evaluate(() => {
    const anchors = document.querySelectorAll('a[href*="/karte/patients/"]');
    const results = [];
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (href && href.includes("visitId=") && !seen.has(href)) {
        seen.add(href);
        const row = a.closest("tr");
        const name = row ? (row.textContent || "").substring(0, 40).trim() : "";
        results.push({ href, name });
      }
    }
    return results;
  });

  log(`患者リンク: ${patientLinks.length} 件`);
  if (patientLinks.length === 0) {
    log("処理対象なし。");
    notifyCompletion(pages);
    process.exit(0);
  }

  // 途中再開
  const processed = loadProcessed();
  const toProcess = patientLinks.filter((p) => !processed.has(p.href));
  log(`未処理: ${toProcess.length} 件（スキップ: ${patientLinks.length - toProcess.length} 件）`);

  if (toProcess.length === 0) {
    log("全件処理済み。processed.json を削除すれば再実行可能です。");
    notifyCompletion(pages);
    process.exit(0);
  }

  // 新しいタブで処理（元のタブには触らない）
  let workPage = await context.newPage();
  log("作業用タブを新規作成");

  let savedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const errors = [];

  for (let i = 0; i < toProcess.length; i++) {
    const { href, name } = toProcess[i];
    const fullUrl = new URL(href, "https://digikar.jp").href;
    const label = `[${i + 1}/${toProcess.length}] ${name || href}`;

    console.log(`\n${"─".repeat(50)}`);
    log(label);

    try {
      await workPage.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1500);

      // モーダルオーバーレイを除去
      await workPage.evaluate(() => {
        document.querySelectorAll('[class*="modal-flag"]').forEach((el) => el.remove());
      });

      const result = await processOneKarte(workPage, fullUrl);

      if (result === "skipped") {
        processed.add(href);
        saveProcessed(processed);
        skippedCount++;
      } else if (result === "saved") {
        processed.add(href);
        saveProcessed(processed);
        savedCount++;
      } else {
        log(`  ✗ 下書き保存に失敗`);
        errors.push({ patient: label, error: "複写または保存に失敗" });
        errorCount++;
      }
    } catch (err) {
      log(`  ⚠ エラー: ${err.message}`);
      errors.push({ patient: label, error: err.message });
      errorCount++;

      // ページが閉じられた場合、再取得
      if (err.message.includes("closed") || err.message.includes("Target page")) {
        try {
          workPage = await context.newPage();
          log("  → 作業タブを再作成");
        } catch (reconnErr) {
          log(`  ✗ 再作成失敗: ${reconnErr.message}`);
          break;
        }
      }
    }
  }

  // 作業タブを閉じる
  try {
    await workPage.close();
  } catch {}

  // サマリー
  console.log(`\n${"═".repeat(50)}`);
  log("処理完了");
  log(`  下書き保存: ${savedCount} 件`);
  log(`  複写済みスキップ: ${skippedCount} 件`);
  log(`  前回処理済み: ${patientLinks.length - toProcess.length} 件`);
  log(`  エラー: ${errorCount} 件`);
  if (errors.length > 0) {
    log("\nエラー詳細:");
    errors.forEach((e) => log(`  - ${e.patient}: ${e.error}`));
  }

  // 完了フラグを設定（ボタン状態をリセットするため）
  notifyCompletion(pages);

  try {
    browser.close();
  } catch {}
  log("完了。");
}

function notifyCompletion(pages) {
  try {
    const digikarPage = pages.find((p) => p.url().includes("digikar.jp"));
    if (digikarPage) {
      digikarPage
        .evaluate(() => {
          localStorage.setItem("__draft_save_completed", "1");
        })
        .catch(() => {});
    }
  } catch {}
}

// ══════════════════════════════════════════════════
// カルテ処理（1件分）
// ══════════════════════════════════════════════════

async function processOneKarte(page, fullUrl) {
  // ── 1. 右パネルの現状確認 ──
  const shusoHas = await checkSectionHasContent(page, "主訴");
  const shochiHas = await checkSectionHasContent(page, "処置");

  if (shusoHas && shochiHas) {
    log("  → 両セクション複写済み → スキップ");
    return "skipped";
  }

  // ── 2. 不足セクションのみ複写（二重複写防止） ──
  const copyResult = await doCopyButtonsWithVerify(page);

  // ── 3. 両方の検証（￥を押す前に必ず確認） ──
  const shusoOk = await checkSectionHasContent(page, "主訴");
  const shochiOk = await checkSectionHasContent(page, "処置");

  if (!shusoOk || !shochiOk) {
    const failed = [];
    if (!shusoOk) failed.push("主訴・所見");
    if (!shochiOk) failed.push("処置・行為");
    log(`  ✗ 複写不完全（${failed.join(", ")}）→ 保存せずスキップ`);
    return "failed";
  }

  log("  ✓ 両セクション確認OK → ￥ボタンで保存");

  // ── 4. ￥ボタン（下書き保存） ──
  try {
    await clickYenButton(page);
  } catch (e) {
    log(`  ✗ ￥ボタン失敗: ${e.message}`);
    return "failed";
  }
  await sleep(1000);

  // エラーダイアログの確認
  const hasError = await page.evaluate(() => {
    const errorDialog = document.querySelector('[role="alertdialog"], [role="alert"]');
    if (errorDialog) {
      const text = errorDialog.textContent || "";
      if (text.includes("エラー") || text.includes("失敗")) return text.substring(0, 100);
    }
    return null;
  });
  if (hasError) {
    log(`  ✗ 保存後エラー: ${hasError}`);
    return "failed";
  }

  log("  ✓ ￥ 下書き保存 完了");
  return "saved";
}

// ══════════════════════════════════════════════════
// 複写ボタン操作
// ══════════════════════════════════════════════════

async function doCopyButtonsWithVerify(page) {
  const result = { shuso: false, shochi: false };

  // --- 主訴・所見 ---
  // 複写前に必ず内容チェック（二重複写を絶対防止）
  if (await checkSectionHasContent(page, "主訴")) {
    log("  → 主訴・所見: 既に入力あり → 複写しない");
    result.shuso = true;
  } else {
    try {
      await clickSectionCopyButton(page, "主訴・所見");
      await sleep(1500);
      if (await checkSectionHasContent(page, "主訴")) {
        log("  ✓ 主訴・所見 複写OK");
        result.shuso = true;
      } else {
        log("  ⚠ 主訴・所見 複写後も内容なし");
      }
    } catch (e) {
      log(`  ⚠ 主訴・所見: ${e.message}`);
    }
  }

  // --- 処置・行為 ---
  // 複写前に必ず内容チェック（二重複写を絶対防止）
  if (await checkSectionHasContent(page, "処置")) {
    log("  → 処置・行為: 既に入力あり → 複写しない");
    result.shochi = true;
  } else {
    try {
      await clickSectionCopyButton(page, "処置・行為");
      await sleep(1500);
      if (await checkSectionHasContent(page, "処置")) {
        log("  ✓ 処置・行為 複写OK");
        result.shochi = true;
      } else {
        log("  ⚠ 処置・行為 複写後も内容なし");
      }
    } catch (e) {
      log(`  ⚠ 処置・行為: ${e.message}`);
    }
  }

  return result;
}

// ══════════════════════════════════════════════════
// DOM 操作ヘルパー
// ══════════════════════════════════════════════════

async function checkEditingAreaEmpty(page) {
  return page.evaluate(() => {
    const editArea = document.querySelector(
      '[class*="editor"], [contenteditable="true"], textarea'
    );
    if (editArea) {
      const text = editArea.textContent || editArea.value || "";
      return text.trim().length === 0;
    }
    const allText = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    const ignoreLabels = [
      "主訴・所見", "処置・行為", "キーワード", "下書き", "未承認",
      "シェーマ追加", "処方箋備考", "適応症追加", "心療内科", "木村友哉",
    ];
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left < 530 || rect.top < 100 || rect.top > 800) continue;
      if (rect.width === 0 || rect.height === 0) continue;
      const t = node.textContent.trim();
      if (t.length > 2 && !ignoreLabels.some((l) => t.includes(l))) {
        allText.push(t);
      }
    }
    return allText.length === 0;
  });
}

async function checkSectionHasContent(page, keyword) {
  return page.evaluate((kw) => {
    const ignoreLabels = [
      "主訴・所見", "処置・行為", "キーワード", "下書き", "未承認",
      "シェーマ追加", "処方箋備考", "適応症追加", "心療内科", "木村友哉",
      "複写", "保存", "削除", "承認",
    ];

    let sectionTop = 0;
    let sectionBottom = 2000;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!el) continue;
      const text = node.textContent.trim();
      if (text.includes(kw) && text.length < 20) {
        const rect = el.getBoundingClientRect();
        if (rect.left >= 530 && rect.width > 0) {
          sectionTop = rect.top;
          sectionBottom = sectionTop + 400;
          break;
        }
      }
    }

    const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while ((node = walker2.nextNode())) {
      const el = node.parentElement;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left < 530 || rect.width === 0 || rect.height === 0) continue;
      if (rect.top < sectionTop + 20 || rect.top > sectionBottom) continue;
      const t = node.textContent.trim();
      if (t.length > 2 && !ignoreLabels.some((l) => t.includes(l))) {
        return true;
      }
    }
    return false;
  }, keyword);
}

async function clickSectionCopyButton(page, sectionTitle) {
  const pos = await page.evaluate((title) => {
    const titleNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() !== title) continue;
      const el = node.parentElement;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.left >= 530) continue;
      titleNodes.push({ el, top: rect.top, left: rect.left });
    }

    const matches = [];
    for (const tn of titleNodes) {
      const parent = tn.el.parentElement;
      if (!parent) continue;

      const buttons = parent.querySelectorAll('button[data-variant="iconOnly"]');
      for (const btn of buttons) {
        const pathEl = btn.querySelector("svg path");
        if (!pathEl) continue;
        const d = pathEl.getAttribute("d") || "";
        if (!d.startsWith("M15 18v-4.5H9")) continue;

        const bRect = btn.getBoundingClientRect();
        if (bRect.width === 0 || bRect.height === 0) continue;

        matches.push({
          x: Math.round(bRect.left + bRect.width / 2),
          y: Math.round(bRect.top + bRect.height / 2),
          top: tn.top,
        });
        break;
      }
    }

    matches.sort((a, b) => a.top - b.top);
    if (matches.length >= 1) return matches[0];
    return null;
  }, sectionTitle);

  if (!pos) throw new Error(`"${sectionTitle}" の複写ボタンが見つかりません`);

  log(`    → 複写クリック: (${pos.x}, ${pos.y})`);
  await page.mouse.click(pos.x, pos.y);
}

async function clickTabCloseButton(page) {
  const pos = await page.evaluate(() => {
    const buttons = document.querySelectorAll(
      'button[data-variant="iconOnly"][data-size="sm"]'
    );
    for (const btn of buttons) {
      const pathEl = btn.querySelector("svg path");
      if (!pathEl) continue;
      const d = pathEl.getAttribute("d") || "";
      if (d.startsWith("M19 7.333")) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.top > 80) continue;
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      }
    }
    return null;
  });

  if (!pos) throw new Error("カルテタブの×が見つかりません");
  log(`    → タブ×クリック: (${pos.x}, ${pos.y})`);
  await page.mouse.click(pos.x, pos.y);
}

async function handleConfirmDialog(page) {
  await sleep(300);
  const clicked = await page.evaluate(() => {
    const keywords = ["削除", "OK", "はい", "確認", "Yes"];
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      if (keywords.some((kw) => text.includes(kw))) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        if (
          Math.abs(rect.left + rect.width / 2 - centerX) < 400 &&
          Math.abs(rect.top + rect.height / 2 - centerY) < 300
        ) {
          btn.click();
          return text;
        }
      }
    }
    return null;
  });
  if (clicked) {
    log(`    → ダイアログ「${clicked}」クリック`);
    await sleep(500);
  }
}

async function clickYenButton(page) {
  const pos = await page.evaluate(() => {
    const elements = document.querySelectorAll("button, span");
    for (const el of elements) {
      const paths = el.querySelectorAll("svg path");
      for (const p of paths) {
        const d = p.getAttribute("d") || "";
        if (d.includes("M4.65") && d.includes("5.355")) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        }
      }
    }
    return null;
  });

  if (!pos) throw new Error("￥ボタンが見つかりません");

  const viewport = page.viewportSize();
  if (viewport && pos.y > viewport.height) {
    await page.mouse.wheel(0, pos.y - viewport.height + 100);
    await sleep(300);
    return clickYenButton(page);
  }

  log(`    → ￥クリック: (${pos.x}, ${pos.y})`);
  await page.mouse.click(pos.x, pos.y);
}

// ── 実行 ────────────────────────────────────────
main().catch((err) => {
  console.error(`[エラー] ${err.message}`);
  process.exit(1);
});
