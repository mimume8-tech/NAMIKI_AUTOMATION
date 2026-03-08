/**
 * print-rx.js  常駐型・会計モーダル自動処理
 *
 * 専用プロファイルの Chrome を起動し、
 * 起動前に通常プロファイルからブックマークを同期する。
 * digikar.jp の会計モーダルを監視。
 * 会計保存後の PDF について、ブラウザ上で選んだモードに応じて
 * 「処方箋のみ」または「全ページ」を印刷する。
 *
 * 起動: node scripts/print-rx.js
 * 停止: Ctrl+C
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { PDFParse } = require("pdf-parse");
const { PDFDocument } = require("pdf-lib");
const { spawn } = require("child_process");

// ── 設定 ─────────────────────────────────────────
const CDP_URL = "http://127.0.0.1:9222";
const DEBUG_PORT = 9222;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEFAULT_CHROME_USER_DATA = "C:\\Users\\ykimu\\AppData\\Local\\Google\\Chrome\\User Data";
const DEFAULT_CHROME_PROFILE_DIRECTORY = "Default";
const DIGIKAR_USER_DATA = "C:\\Users\\ykimu\\AppData\\Local\\Google\\Chrome\\DigikarAuto";
const DIGIKAR_PROFILE_DIRECTORY = "Default";
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
const PRINT_PANEL_POSITION_KEY = "__print_rx_mode_panel_position";
const ROOT_SYNC_FILES = ["Local State", "Last Version", "Last Browser"];
const PROFILE_SYNC_FILES = [
  "Bookmarks",
  "Bookmarks.bak",
  "Preferences",
  "Secure Preferences",
  "Login Data",
  "Login Data-journal",
  "Login Data For Account",
  "Login Data For Account-journal",
  "Web Data",
  "Web Data-journal",
  "Account Web Data",
  "Account Web Data-journal",
  "Affiliation Database",
  "Affiliation Database-journal",
  "Extension Cookies",
  "Extension Cookies-journal",
  "Favicons",
  "Favicons-journal",
  "History",
  "History-journal",
  "PreferredApps",
  "Shortcuts",
  "Shortcuts-journal",
  "Top Sites",
  "Top Sites-journal",
  "trusted_vault.pb",
  "Google Profile Picture.png",
  "Google Profile.ico",
];
const PROFILE_SYNC_DIRS = [
  "Accounts",
  "Extension Rules",
  "Extension Scripts",
  "Extension State",
  "Extensions",
  "Local Extension Settings",
  "Local Storage",
  "IndexedDB",
  "Managed Extension Settings",
  "Network",
  "Service Worker",
  "Session Storage",
  "Sessions",
  "Storage",
  "Sync App Settings",
  "Sync Data",
  "Sync Extension Settings",
  "Web Applications",
  "WebStorage",
];
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

  prepareDigikarProfile();
  startChromeProcess();
  const ready = await waitForDebugPort(30_000);
  if (!ready) {
    throw new Error("Chrome を DigikarAuto プロファイルで起動できませんでした。");
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
      "--show-bookmark-bar",
      `--user-data-dir=${DIGIKAR_USER_DATA}`,
      `--profile-directory=${DIGIKAR_PROFILE_DIRECTORY}`,
      DIGIKAR_URL,
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
}

function prepareDigikarProfile() {
  fs.mkdirSync(DIGIKAR_USER_DATA, { recursive: true });
  fs.mkdirSync(getDigikarProfilePath(), { recursive: true });

  syncRootFiles();
  syncProfileFiles();
  ensureBookmarkBarVisible();
}

function getDefaultProfilePath() {
  return path.join(DEFAULT_CHROME_USER_DATA, DEFAULT_CHROME_PROFILE_DIRECTORY);
}

function getDigikarProfilePath() {
  return path.join(DIGIKAR_USER_DATA, DIGIKAR_PROFILE_DIRECTORY);
}

function syncRootFiles() {
  for (const fileName of ROOT_SYNC_FILES) {
    const sourcePath = path.join(DEFAULT_CHROME_USER_DATA, fileName);
    const targetPath = path.join(DIGIKAR_USER_DATA, fileName);
    copyPath(sourcePath, targetPath, fileName === "Local State");
  }
}

function syncProfileFiles() {
  const sourceProfile = getDefaultProfilePath();
  const targetProfile = getDigikarProfilePath();

  for (const fileName of PROFILE_SYNC_FILES) {
    const sourcePath = path.join(sourceProfile, fileName);
    const targetPath = path.join(targetProfile, fileName);
    copyPath(sourcePath, targetPath, ["Bookmarks", "Bookmarks.bak", "Preferences"].includes(fileName));
  }

  for (const dirName of PROFILE_SYNC_DIRS) {
    const sourcePath = path.join(sourceProfile, dirName);
    const targetPath = path.join(targetProfile, dirName);
    copyPath(sourcePath, targetPath, dirName === "Extensions");
  }
}

function copyPath(sourcePath, targetPath, verbose = false) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  try {
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }

    if (verbose) {
      log(`同期: ${path.basename(sourcePath)}`);
    }
  } catch (err) {
    if (verbose) {
      log(`同期失敗: ${path.basename(sourcePath)} (${err.message})`);
    }
  }
}

function ensureBookmarkBarVisible() {
  const targetProfile = getDigikarProfilePath();
  const prefsPath = path.join(targetProfile, "Preferences");
  const defaultPrefsPath = path.join(getDefaultProfilePath(), "Preferences");

  const basePrefs = readJsonFile(prefsPath) || readJsonFile(defaultPrefsPath) || {};
  basePrefs.bookmark_bar = {
    ...(basePrefs.bookmark_bar || {}),
    show_on_all_tabs: true,
  };
  basePrefs.account_values = {
    ...(basePrefs.account_values || {}),
    bookmark_bar: {
      ...((basePrefs.account_values || {}).bookmark_bar || {}),
      show_on_all_tabs: true,
    },
  };

  writeJsonFile(prefsPath, basePrefs);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
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
    ({ panelId, styleId, storageKey, defaultMode, positionKey }) => {
      if (!document.body) {
        return;
      }

      const readMode = () => localStorage.getItem(storageKey) || defaultMode;
      const readPosition = () => {
        try {
          return JSON.parse(localStorage.getItem(positionKey) || "null");
        } catch {
          return null;
        }
      };
      const writeMode = (mode) => {
        localStorage.setItem(storageKey, mode);
        window.__printRxMode = mode;
      };
      const writePosition = (position) => {
        localStorage.setItem(positionKey, JSON.stringify(position));
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
            background: rgba(255, 255, 255, 0.18);
            border: 1px solid rgba(15, 23, 42, 0.35);
            color: #0f172a;
            box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
            font-family: "Yu Gothic UI", "Segoe UI", sans-serif;
            backdrop-filter: blur(6px);
          }
          #${panelId} .print-rx-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 8px;
            cursor: move;
            user-select: none;
          }
          #${panelId} .print-rx-title {
            margin: 0;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.02em;
          }
          #${panelId} .print-rx-grip {
            font-size: 12px;
            color: rgba(15, 23, 42, 0.55);
          }
          #${panelId} .print-rx-status {
            margin: 0 0 10px;
            font-size: 12px;
            color: rgba(15, 23, 42, 0.72);
          }
          #${panelId} .print-rx-actions {
            display: grid;
            grid-template-columns: 1fr;
            gap: 8px;
          }
          #${panelId} button[data-mode],
          #${panelId} button[data-role="reset-pos"] {
            border: 1px solid rgba(15, 23, 42, 0.24);
            border-radius: 9px;
            padding: 8px 10px;
            font-size: 13px;
            font-weight: 600;
            color: #0f172a;
            background: rgba(255, 255, 255, 0.24);
            cursor: pointer;
          }
          #${panelId} button[data-mode].is-active {
            background: rgba(15, 23, 42, 0.12);
            border-color: rgba(15, 23, 42, 0.45);
          }
          #${panelId} .print-rx-footer {
            margin-top: 8px;
            display: flex;
            justify-content: flex-end;
          }
          #${panelId} button[data-role="reset-pos"] {
            padding: 5px 8px;
            font-size: 11px;
            background: transparent;
          }
          #${panelId} .print-rx-note {
            margin-top: 10px;
            font-size: 11px;
            color: rgba(15, 23, 42, 0.62);
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
          <div class="print-rx-header" data-role="drag-handle">
            <div class="print-rx-title">印刷モード</div>
            <div class="print-rx-grip">移動</div>
          </div>
          <div class="print-rx-status" data-role="status"></div>
          <div class="print-rx-actions">
            <button type="button" data-mode="rx_only">処方箋のみ</button>
            <button type="button" data-mode="all_pages">全部印刷</button>
          </div>
          <div class="print-rx-footer">
            <button type="button" data-role="reset-pos">位置を戻す</button>
          </div>
          <div class="print-rx-note">次に開く会計PDFへ適用します。</div>
        `;

        panel.addEventListener("click", (event) => {
          const button = event.target.closest("button[data-mode]");
          if (button) {
            writeMode(button.dataset.mode);
            updatePanel(panel);
            return;
          }

          const resetButton = event.target.closest('button[data-role="reset-pos"]');
          if (resetButton) {
            panel.style.top = "84px";
            panel.style.right = "16px";
            panel.style.left = "auto";
            writePosition({ top: 84, right: 16, left: null });
          }
        });

        document.body.appendChild(panel);

        const handle = panel.querySelector('[data-role="drag-handle"]');
        if (handle) {
          handle.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) {
              return;
            }

            const rect = panel.getBoundingClientRect();
            const offsetX = event.clientX - rect.left;
            const offsetY = event.clientY - rect.top;
            handle.setPointerCapture(event.pointerId);

            const onMove = (moveEvent) => {
              const left = Math.min(
                Math.max(8, moveEvent.clientX - offsetX),
                window.innerWidth - rect.width - 8
              );
              const top = Math.min(
                Math.max(8, moveEvent.clientY - offsetY),
                window.innerHeight - rect.height - 8
              );
              panel.style.left = `${left}px`;
              panel.style.top = `${top}px`;
              panel.style.right = "auto";
            };

            const onUp = () => {
              handle.removeEventListener("pointermove", onMove);
              handle.removeEventListener("pointerup", onUp);
              handle.removeEventListener("pointercancel", onUp);
              if (handle.hasPointerCapture(event.pointerId)) {
                handle.releasePointerCapture(event.pointerId);
              }
              const finalRect = panel.getBoundingClientRect();
              writePosition({
                left: Math.round(finalRect.left),
                top: Math.round(finalRect.top),
                right: null,
              });
            };

            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onUp);
            handle.addEventListener("pointercancel", onUp);
          });
        }
      }

      const savedPosition = readPosition();
      if (savedPosition) {
        if (typeof savedPosition.left === "number") {
          panel.style.left = `${savedPosition.left}px`;
          panel.style.right = "auto";
        } else if (typeof savedPosition.right === "number") {
          panel.style.right = `${savedPosition.right}px`;
        }

        if (typeof savedPosition.top === "number") {
          panel.style.top = `${savedPosition.top}px`;
        }
      }

      writeMode(readMode());
      updatePanel(panel);
    },
    {
      panelId: PRINT_PANEL_ID,
      styleId: PRINT_PANEL_STYLE_ID,
      storageKey: PRINT_MODE_STORAGE_KEY,
      defaultMode: DEFAULT_PRINT_MODE,
      positionKey: PRINT_PANEL_POSITION_KEY,
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
