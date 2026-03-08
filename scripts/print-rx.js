/**
 * print-rx.js  常駐型・会計モーダル自動処理
 *
 * 通常プロファイルの Chrome を起動し、
 * digikar.jp の会計モーダルを監視。
 * 会計保存後の PDF について、ブラウザ上で選んだモードに応じて
 * 「処方箋のみ」または「全ページ」を印刷する。
 *
 * 起動: node scripts/print-rx.js
 * 停止: Ctrl+C
 */

const fs = require("fs");
const { chromium } = require("playwright");
const { PDFParse } = require("pdf-parse");
const { PDFDocument } = require("pdf-lib");
const { execSync, spawn } = require("child_process");

// ── 設定 ─────────────────────────────────────────
const CDP_URL = "http://127.0.0.1:9222";
const DEBUG_PORT = 9222;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CHROME_USER_DATA = "C:\\Users\\ykimu\\AppData\\Local\\Google\\Chrome\\User Data";
const CHROME_PROFILE_DIRECTORY = "Default";
const DIGIKAR_URL = "https://digikar.jp/reception/";
const PATIENT_NAME = "木村友哉";
const DEFAULT_PRINT_MODE = "rx_only";
const POLL_INTERVAL_MS = 2_000;
const CDP_RETRY_INTERVAL_MS = 10_000;
const PDF_TAB_TIMEOUT_MS = 15_000;
const PDF_READY_WAIT_MS = 2_000;
const PRINT_PANEL_ID = "__print_rx_mode_panel";
const PRINT_PANEL_STYLE_ID = "__print_rx_mode_panel_style";
const PRINT_MODE_STORAGE_KEY = "__print_rx_mode";
// ─────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toLocaleTimeString("ja-JP");
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactText(text) {
  return String(text || "").replace(/\s+/g, "");
}

function formatPrintMode(mode) {
  return mode === "all_pages" ? "全部印刷" : "処方箋のみ";
}

async function isDebugPortReady() {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDebugPort(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isDebugPortReady()) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

// ══════════════════════════════════════════════════
// メインループ（常駐）
// ══════════════════════════════════════════════════

async function mainLoop() {
  log("print-rx 常駐開始");

  while (true) {
    let browser;

    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch {
      log("CDP 未検出 → Chrome を起動します...");
      await launchChrome();

      try {
        browser = await chromium.connectOverCDP(CDP_URL);
      } catch {
        log("Chrome 起動待ち...");
        await sleep(CDP_RETRY_INTERVAL_MS);
        continue;
      }
    }

    log("Chrome 接続OK");

    try {
      await watchLoop(browser);
    } catch (err) {
      log(`接続切断: ${err.message}`);
    }

    try {
      browser.close();
    } catch {}

    log("再接続を試みます...");
    await sleep(CDP_RETRY_INTERVAL_MS);
  }
}

// ══════════════════════════════════════════════════
// Chrome 起動
// ══════════════════════════════════════════════════

async function launchChrome() {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Chrome が見つかりません: ${CHROME_PATH}`);
  }

  if (await isDebugPortReady()) {
    log("既存の Chrome デバッグポートを再利用します。");
    return;
  }

  startChromeProcess();
  if (await waitForDebugPort(8_000)) {
    log("Chrome 起動OK");
    return;
  }

  if (hasChromeProcess()) {
    log("既存の Chrome が通常起動していたため、デバッグ付きで開き直します...");
    killChromeProcesses();
    await sleep(2_000);
    startChromeProcess();
  }

  const ready = await waitForDebugPort(30_000);
  if (!ready) {
    throw new Error("Chrome を remote-debugging-port=9222 付きで起動できませんでした。");
  }
  log("Chrome 起動OK");
}

function startChromeProcess() {
  const child = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--new-window",
      "--kiosk-printing",
      `--user-data-dir=${CHROME_USER_DATA}`,
      `--profile-directory=${CHROME_PROFILE_DIRECTORY}`,
      DIGIKAR_URL,
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
}

function hasChromeProcess() {
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq chrome.exe"', {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return output.toLowerCase().includes("chrome.exe");
  } catch {
    return false;
  }
}

function killChromeProcesses() {
  try {
    execSync("taskkill /F /T /IM chrome.exe", { stdio: "ignore" });
  } catch {}
}

// ══════════════════════════════════════════════════
// モーダル監視ループ
// ══════════════════════════════════════════════════

async function watchLoop(browser) {
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("コンテキストなし");
  }

  log("会計モーダルを監視中... (画面右上の印刷モードを選んでください)");

  while (true) {
    const kartePage = await getDigikarPage(context);

    if (!kartePage) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    await ensurePrintModePanel(kartePage).catch(() => {});

    const modalOpen = await isAccountingModalOpen(kartePage);
    if (!modalOpen) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    log("会計モーダルを検知！処理開始...");

    try {
      await processModal(context, kartePage);
      log("処理完了。次のモーダルを待機中...");
    } catch (err) {
      log(`処理エラー: ${err.message}`);
    }

    await sleep(5_000);
  }
}

async function getDigikarPage(context) {
  const pages = context.pages();
  const page =
    pages.find((candidate) => /digikar\.jp\/(karte|reception)/.test(candidate.url())) ||
    pages.find(
      (candidate) => candidate.url().includes("digikar.jp") && !candidate.url().includes("/pdf/")
    );
  if (page) {
    return page;
  }

  const blankPage = pages.find((candidate) => candidate.url() === "about:blank");
  if (blankPage) {
    try {
      await blankPage.goto(DIGIKAR_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return blankPage;
    } catch {}
  }

  return null;
}

async function isAccountingModalOpen(page) {
  return page
    .evaluate(() => {
      for (const label of document.querySelectorAll("label")) {
        const text = label.textContent.trim();
        if (text.includes("デジスマ") || text.includes("現金等払い")) {
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

async function ensurePrintModePanel(page) {
  await page.evaluate(
    ({ panelId, styleId, storageKey, defaultMode }) => {
      if (!document.body) {
        return;
      }

      const readMode = () => localStorage.getItem(storageKey) || defaultMode;
      const writeMode = (mode) => {
        localStorage.setItem(storageKey, mode);
        window.__printRxMode = mode;
      };

      const updatePanel = (panel) => {
        const mode = readMode();
        panel.dataset.mode = mode;

        const status = panel.querySelector('[data-role="status"]');
        if (status) {
          status.textContent = mode === "all_pages" ? "現在: 全部印刷" : "現在: 処方箋のみ";
        }

        for (const button of panel.querySelectorAll("button[data-mode]")) {
          button.classList.toggle("is-active", button.dataset.mode === mode);
        }
      };

      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          #${panelId} {
            position: fixed;
            top: 84px;
            right: 16px;
            z-index: 2147483647;
            width: 220px;
            padding: 12px;
            border-radius: 14px;
            background: rgba(15, 23, 42, 0.95);
            color: #f8fafc;
            box-shadow: 0 12px 30px rgba(15, 23, 42, 0.35);
            font-family: "Yu Gothic UI", "Segoe UI", sans-serif;
            backdrop-filter: blur(8px);
          }
          #${panelId} .print-rx-title {
            margin: 0 0 8px;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.02em;
          }
          #${panelId} .print-rx-status {
            margin: 0 0 10px;
            font-size: 12px;
            color: #cbd5e1;
          }
          #${panelId} .print-rx-actions {
            display: grid;
            grid-template-columns: 1fr;
            gap: 8px;
          }
          #${panelId} button[data-mode] {
            border: 1px solid rgba(148, 163, 184, 0.35);
            border-radius: 10px;
            padding: 9px 10px;
            font-size: 13px;
            font-weight: 700;
            color: #e2e8f0;
            background: rgba(30, 41, 59, 0.9);
            cursor: pointer;
          }
          #${panelId} button[data-mode].is-active {
            background: #0f766e;
            border-color: #5eead4;
            color: #f0fdfa;
          }
          #${panelId} .print-rx-note {
            margin-top: 10px;
            font-size: 11px;
            color: #94a3b8;
            line-height: 1.45;
          }
        `;
        document.head.appendChild(style);
      }

      let panel = document.getElementById(panelId);
      if (!panel) {
        panel = document.createElement("aside");
        panel.id = panelId;
        panel.innerHTML = `
          <div class="print-rx-title">印刷モード</div>
          <div class="print-rx-status" data-role="status"></div>
          <div class="print-rx-actions">
            <button type="button" data-mode="rx_only">処方箋のみ</button>
            <button type="button" data-mode="all_pages">全部印刷</button>
          </div>
          <div class="print-rx-note">次に開く会計PDFへ適用します。</div>
        `;

        panel.addEventListener("click", (event) => {
          const button = event.target.closest("button[data-mode]");
          if (!button) {
            return;
          }
          writeMode(button.dataset.mode);
          updatePanel(panel);
        });

        document.body.appendChild(panel);
      }

      writeMode(readMode());
      updatePanel(panel);
    },
    {
      panelId: PRINT_PANEL_ID,
      styleId: PRINT_PANEL_STYLE_ID,
      storageKey: PRINT_MODE_STORAGE_KEY,
      defaultMode: DEFAULT_PRINT_MODE,
    }
  );
}

async function getSelectedPrintMode(page) {
  return page
    .evaluate(
      ({ storageKey, defaultMode }) => localStorage.getItem(storageKey) || defaultMode,
      { storageKey: PRINT_MODE_STORAGE_KEY, defaultMode: DEFAULT_PRINT_MODE }
    )
    .catch(() => DEFAULT_PRINT_MODE);
}

// ══════════════════════════════════════════════════
// モーダル処理（1回分）
// ══════════════════════════════════════════════════

async function processModal(context, kartePage) {
  const isCash = await detectPaymentMethod(kartePage);
  const selectedMode = await getSelectedPrintMode(kartePage);

  log(`-> 支払い方法: ${isCash ? "現金等払い" : "デジスマ払い"}`);
  log(`-> 印刷モード: ${formatPrintMode(selectedMode)}`);

  log("チェックボックスを設定中...");
  await checkPrintOptions(kartePage);

  log("保存ボタンをクリック...");
  const [pdfPage] = await Promise.all([
    context.waitForEvent("page", { timeout: PDF_TAB_TIMEOUT_MS }),
    clickSaveButton(kartePage),
  ]);

  log("PDF タブを待機中...");
  await pdfPage.waitForLoadState("load");
  await sleep(PDF_READY_WAIT_MS);
  await pdfPage.bringToFront().catch(() => {});
  const pdfUrl = pdfPage.url();
  log(`PDF URL: ${pdfUrl}`);

  if (selectedMode === "all_pages") {
    await printAllPages(pdfPage);
    return;
  }

  await printRxPagesOnly(context, pdfPage, pdfUrl);
}

// ── 支払い方法の自動判定 ─────────────────────────

async function detectPaymentMethod(page) {
  return page.evaluate(() => {
    for (const label of document.querySelectorAll("label")) {
      const text = label.textContent.trim();
      const radio =
        label.querySelector('input[type="radio"]') ||
        document.getElementById(label.getAttribute("for"));

      if (!radio) {
        continue;
      }
      if (text.includes("デジスマ") && radio.checked) {
        return false;
      }
      if (text.includes("現金") && radio.checked) {
        return true;
      }
    }

    for (const radio of document.querySelectorAll('input[type="radio"]')) {
      if (!radio.checked) {
        continue;
      }

      const parent = radio.closest("label, div, span");
      if (!parent) {
        continue;
      }
      if (parent.textContent.includes("デジスマ")) {
        return false;
      }
      if (parent.textContent.includes("現金")) {
        return true;
      }
    }

    return true;
  });
}

// ── チェックボックス操作 ─────────────────────────

async function checkPrintOptions(page) {
  const labels = ["領収書", "診療明細書", "院外処方箋"];

  for (const label of labels) {
    const result = await page.evaluate((labelText) => {
      for (const lbl of document.querySelectorAll("label")) {
        if (!lbl.textContent.trim().includes(labelText)) {
          continue;
        }

        const checkbox =
          lbl.querySelector('input[type="checkbox"]') ||
          document.getElementById(lbl.getAttribute("for"));

        if (checkbox && !checkbox.checked) {
          checkbox.click();
          return "checked";
        }
        if (checkbox && checkbox.checked) {
          return "already";
        }
      }

      for (const checkbox of document.querySelectorAll('input[type="checkbox"]')) {
        const parent = checkbox.closest("div, label, span");
        if (!parent || !parent.textContent.includes(labelText)) {
          continue;
        }

        if (!checkbox.checked) {
          checkbox.click();
          return "checked";
        }
        return "already";
      }

      return "not_found";
    }, label);

    const status = result === "checked" ? "ON" : result === "already" ? "済" : "?";
    log(`  ${label}: ${status}`);
  }
}

// ── 保存ボタン ──────────────────────────────────

async function clickSaveButton(page) {
  const candidates = [
    page.locator('div[role="dialog"] button').filter({ hasText: /^保存$/ }),
    page.locator('div[role="dialog"] button').filter({ hasText: /保存/ }),
    page.locator("button").filter({ hasText: /^保存$/ }),
    page.locator("button").filter({ hasText: /会計/ }).filter({ hasText: /保存/ }),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const button = candidate.nth(i);
      const visible = await button.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await button.click({ timeout: 5_000 });
      return;
    }
  }

  throw new Error("保存ボタンが見つかりません");
}

// ── 印刷処理 ────────────────────────────────────

async function printAllPages(pdfPage) {
  log("全ページを印刷します...");
  await triggerPrint(pdfPage);
}

async function printRxPagesOnly(context, pdfPage, pdfUrl) {
  log("PDF をダウンロード・解析中...");
  const pdfBuffer = await downloadPdf(pdfPage, pdfUrl);
  const pageTexts = await extractPageTexts(pdfBuffer);
  log(`全 ${pageTexts.length} ページ`);

  const strongMatches = [];
  const weakMatches = [];

  for (let i = 0; i < pageTexts.length; i++) {
    const match = classifyPrescriptionPage(pageTexts[i]);

    if (match.exclude) {
      log(`  ページ ${i + 1}: 除外（${match.reason}）`);
      continue;
    }

    if (match.strong) {
      strongMatches.push(i + 1);
      log(`  ページ ${i + 1}: 処方箋ページ（${match.reason}）`);
      continue;
    }

    if (match.weak) {
      weakMatches.push(i + 1);
      log(`  ページ ${i + 1}: 候補ページ（${match.reason}）`);
      continue;
    }

    log(`  ページ ${i + 1}: スキップ`);
  }

  const rxPages = strongMatches.length > 0 ? strongMatches : weakMatches;
  if (rxPages.length === 0) {
    log("処方箋ページが見つかりません。全部印刷にフォールバックします。");
    await printAllPages(pdfPage);
    return;
  }

  log(`印刷対象: ページ ${rxPages.join(", ")}`);

  const sourceDoc = await PDFDocument.load(pdfBuffer);
  const outputDoc = await PDFDocument.create();
  const copiedPages = await outputDoc.copyPages(
    sourceDoc,
    rxPages.map((pageNo) => pageNo - 1)
  );

  for (const copiedPage of copiedPages) {
    outputDoc.addPage(copiedPage);
  }

  const outputBytes = await outputDoc.save();

  log("処方箋ページのみの PDF を新しいタブで開きます...");
  const base64 = Buffer.from(outputBytes).toString("base64");
  const outputPage = await context.newPage();
  await outputPage.goto(`data:application/pdf;base64,${base64}`, { waitUntil: "load" });
  await sleep(PDF_READY_WAIT_MS);

  await triggerPrint(outputPage);
}

async function triggerPrint(page) {
  await page.bringToFront().catch(() => {});
  await sleep(800);

  const isPdfViewer = await page
    .evaluate(() => !!document.querySelector('link[href*="pdf_embedder.css"]'))
    .catch(() => false);

  if (isPdfViewer) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+P" : "Control+P");
    log("PDF ビューアに印刷ショートカットを送信しました。");
    return;
  }

  await page.evaluate(() => window.print());
  log("印刷を開始しました。");
}

function classifyPrescriptionPage(text) {
  const original = String(text || "");
  const compact = compactText(original);
  const hasPrescriptionHeading = /処\s*方\s*箋/.test(original) || compact.includes("院外処方箋");
  const hasPatientName = compact.includes(compactText(PATIENT_NAME));
  const hasPrescriptionFee = compact.includes("処方箋料");

  if (hasPrescriptionFee) {
    return {
      exclude: true,
      strong: false,
      weak: false,
      reason: "処方箋料を含む",
    };
  }

  if (hasPrescriptionHeading && hasPatientName) {
    return {
      exclude: false,
      strong: true,
      weak: false,
      reason: `「処 方 箋」と「${PATIENT_NAME}」を検出`,
    };
  }

  if (hasPrescriptionHeading) {
    return {
      exclude: false,
      strong: false,
      weak: true,
      reason: "「処 方 箋」を検出",
    };
  }

  return {
    exclude: false,
    strong: false,
    weak: false,
    reason: "",
  };
}

// ── ヘルパー ─────────────────────────────────────

async function downloadPdf(page, url) {
  const response = await page.context().request.get(url);
  if (!response.ok()) {
    throw new Error(`PDF ダウンロード失敗: ${response.status()}`);
  }
  return Buffer.from(await response.body());
}

async function extractPageTexts(buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return result.pages
      .slice()
      .sort((a, b) => a.num - b.num)
      .map((page) => page.text || "");
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// ── 起動 ─────────────────────────────────────────

mainLoop().catch((err) => {
  console.error("致命的エラー:", err.message);
  process.exit(1);
});
