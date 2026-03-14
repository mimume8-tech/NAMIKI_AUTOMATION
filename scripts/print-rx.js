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
const pdfParse = require("pdf-parse");
const { PDFDocument } = require("pdf-lib");
const { spawn } = require("child_process");
const { startCertificateDialogHelper } = require("./certificate_dialog_helper");
const { setupUserscriptInjection } = require("./userscript_injector");

// ── PC別設定ファイル読み込み ─────────────────────
const PC_CONFIG_PATH = path.join(__dirname, "..", "config", "pc-config.json");
const PC_CONFIG = JSON.parse(fs.readFileSync(PC_CONFIG_PATH, "utf8"));

// ── 設定 ─────────────────────────────────────────
const CDP_URL = "http://127.0.0.1:9222";
const DEBUG_PORT = 9222;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEFAULT_CHROME_USER_DATA = "C:\\Users\\ykimu\\AppData\\Local\\Google\\Chrome\\User Data";
const DEFAULT_CHROME_PROFILE_DIRECTORY = "Default";
const DIGIKAR_USER_DATA = "C:\\ChromeDebugProfile";
const DIGIKAR_PROFILE_DIRECTORY = "Default";
const DIGIKAR_URL = "https://digikar.jp/reception/";
const PATIENT_NAME = "木村友哉";
const LOGIN_ID = PC_CONFIG.digikar.loginId;
const LOGIN_PASSWORDS = PC_CONFIG.digikar.passwords;
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

    // ユーザースクリプト自動注入（Tampermonkey 不要）
    try {
      const ctx = browser.contexts()[0];
      if (ctx) {
        await setupUserscriptInjection(ctx, { log });
      }
    } catch (err) {
      log(`userscript注入セットアップ失敗: ${err.message}`);
    }

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
    throw new Error("Chrome を ChromeDebugProfile で起動できませんでした。");
  }
  log("Chrome 起動OK");
}

function startChromeProcess() {
  startCertificateDialogHelper({ log });
  const child = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--new-window",
      "--kiosk-printing",
      "--auto-ssl-client-auth",
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
// 自動ログイン
// ══════════════════════════════════════════════════

let lastLoginAttempt = 0;
const LOGIN_COOLDOWN_MS = 30_000; // 連続試行防止

async function tryAutoLogin(page) {
  // ログインページかどうか判定（URLまたはフォームの有無）
  const loginState = await page.evaluate(() => {
    const url = location.href;
    // ログインページのURLパターン
    if (url.includes("/login") || url.includes("/sign_in") || url.includes("/signin")) {
      // ID入力欄を探す
      const emailInput = document.querySelector(
        'input[type="email"], input[type="text"][name*="mail"], input[type="text"][name*="login"], input[type="text"][name*="user"], input[type="text"][autocomplete="email"], input[type="text"][autocomplete="username"]'
      );
      const passInput = document.querySelector('input[type="password"]');

      if (emailInput && passInput) return "both_visible";
      if (emailInput && !passInput) return "email_only";
      if (!emailInput && passInput) return "password_only";
    }
    return "not_login";
  }).catch(() => "error");

  if (loginState === "not_login" || loginState === "error") return false;

  // クールダウン
  if (Date.now() - lastLoginAttempt < LOGIN_COOLDOWN_MS) return false;
  lastLoginAttempt = Date.now();

  log(`ログインページを検知 (${loginState}) → 自動入力します...`);

  if (loginState === "both_visible") {
    // ID + パスワードが両方見える場合
    await fillLoginForm(page, LOGIN_ID, LOGIN_PASSWORDS[0]);
    return true;
  }

  if (loginState === "email_only") {
    // メール入力 → 次へ → パスワード入力 の2段階
    await page.evaluate((email) => {
      const input = document.querySelector(
        'input[type="email"], input[type="text"][name*="mail"], input[type="text"][name*="login"], input[type="text"][name*="user"], input[type="text"][autocomplete="email"], input[type="text"][autocomplete="username"]'
      );
      if (input) {
        input.focus();
        input.value = email;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, LOGIN_ID);
    await sleep(500);
    // 次へ/ログインボタンを押す
    await clickSubmitButton(page);
    await sleep(2000);
    // パスワード入力
    await fillPassword(page, LOGIN_PASSWORDS[0]);
    return true;
  }

  if (loginState === "password_only") {
    await fillPassword(page, LOGIN_PASSWORDS[0]);
    return true;
  }

  return false;
}

async function fillLoginForm(page, email, password) {
  await page.evaluate(({ email, password }) => {
    const emailInput = document.querySelector(
      'input[type="email"], input[type="text"][name*="mail"], input[type="text"][name*="login"], input[type="text"][name*="user"], input[type="text"][autocomplete="email"], input[type="text"][autocomplete="username"]'
    );
    const passInput = document.querySelector('input[type="password"]');

    if (emailInput) {
      emailInput.focus();
      emailInput.value = email;
      emailInput.dispatchEvent(new Event("input", { bubbles: true }));
      emailInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (passInput) {
      passInput.focus();
      passInput.value = password;
      passInput.dispatchEvent(new Event("input", { bubbles: true }));
      passInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { email, password });

  await sleep(500);
  await clickSubmitButton(page);
  log("ログイン情報を入力して送信しました");

  // ログイン成功を待つ（URLが変わるか確認）
  await sleep(3000);
  const success = await checkLoginSuccess(page);
  if (!success) {
    // パスワードが違った場合、2番目を試す
    log("パスワード1 失敗 → パスワード2 を試します...");
    await page.evaluate((password) => {
      const passInput = document.querySelector('input[type="password"]');
      if (passInput) {
        passInput.focus();
        passInput.value = password;
        passInput.dispatchEvent(new Event("input", { bubbles: true }));
        passInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, LOGIN_PASSWORDS[1]);
    await sleep(500);
    await clickSubmitButton(page);
    await sleep(3000);
  }
}

async function fillPassword(page, password, isRetry = false) {
  await page.evaluate((pw) => {
    const passInput = document.querySelector('input[type="password"]');
    if (passInput) {
      passInput.focus();
      passInput.value = pw;
      passInput.dispatchEvent(new Event("input", { bubbles: true }));
      passInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, password);
  await sleep(500);
  await clickSubmitButton(page);
  log("パスワードを入力して送信しました");

  await sleep(3000);
  const success = await checkLoginSuccess(page);
  if (!success && !isRetry && LOGIN_PASSWORDS.length > 1) {
    log("パスワード1 失敗 → パスワード2 を試します...");
    await fillPassword(page, LOGIN_PASSWORDS[1], true);
  }
}

async function clickSubmitButton(page) {
  await page.evaluate(() => {
    // submit ボタン
    const submit = document.querySelector('button[type="submit"], input[type="submit"]');
    if (submit && submit.offsetParent !== null) { submit.click(); return; }
    // テキストでログイン系ボタンを探す
    for (const btn of document.querySelectorAll("button")) {
      const t = btn.textContent.trim();
      if ((t.includes("ログイン") || t.includes("サインイン") || t === "次へ" || t === "Next") && btn.offsetParent !== null) {
        btn.click();
        return;
      }
    }
  });
}

async function checkLoginSuccess(page) {
  const url = page.url();
  // ログインページから離れたら成功
  return !url.includes("/login") && !url.includes("/sign_in") && !url.includes("/signin");
}

// ══════════════════════════════════════════════════
// モーダル監視ループ
// ══════════════════════════════════════════════════

async function watchLoop(browser) {
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("コンテキストなし");
  }

  log(`${PC_CONFIG.pcName} - 会計モーダルを監視中...`);

  while (true) {
    const pages = context.pages();
    const digikarPage = pages.find((p) => p.url().includes("digikar.jp"));

    // ログインページなら自動ログイン
    if (digikarPage) {
      const loggedIn = await tryAutoLogin(digikarPage);
      if (loggedIn) {
        await sleep(5000);
        continue;
      }
    }

    // 全 digikar タブにパネルを注入
    const allDigikarPages = getAllDigikarPages(context);
    for (const dp of allDigikarPages) {
      await ensurePrintModePanel(dp).catch(() => {});
    }

    const kartePage = await getDigikarPage(context);

    if (!kartePage) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // 下書き一括保存フラグチェック
    const draftSaveRequested = await kartePage
      .evaluate(() => {
        const val = localStorage.getItem("__draft_save_requested");
        if (val === "1") {
          localStorage.removeItem("__draft_save_requested");
          return true;
        }
        return false;
      })
      .catch(() => false);

    if (draftSaveRequested) {
      log("下書き一括保存 開始 → 別ウィンドウで実行します...");
      const nodePath = process.execPath;
      const scriptPath = path.join(__dirname, "..", "tools", "draft-save.js");
      try {
        const draftChild = spawn(
          "cmd",
          ["/c", "start", '"DraftSave"', "cmd", "/k",
           `"${nodePath}" "${scriptPath}"`],
          { cwd: path.join(__dirname, ".."), detached: true, stdio: "ignore" }
        );
        draftChild.unref();
        log(`下書き保存プロセス起動: ${scriptPath}`);
      } catch (err) {
        log(`下書き保存起動エラー: ${err.message}`);
        // 起動失敗時はボタンをリセット
        await kartePage.evaluate(() => {
          localStorage.setItem("__draft_save_completed", "1");
        }).catch(() => {});
      }
      // 5分後にボタンが戻っていなければ強制リセット
      setTimeout(async () => {
        try {
          const page = await getDigikarPage(context);
          if (page) {
            await page.evaluate(() => {
              const btn = document.querySelector('[data-role="draft-save"].is-running');
              if (btn) {
                localStorage.setItem("__draft_save_completed", "1");
              }
            });
          }
        } catch {}
      }, 5 * 60 * 1000);
      await sleep(2000);
      continue;
    }

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

function getAllDigikarPages(context) {
  const pages = context.pages();
  return pages.filter(
    (candidate) => candidate.url().includes("digikar.jp") && !candidate.url().includes("/pdf/")
  );
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
    ({ panelId, styleId, storageKey, defaultMode, positionKey, yenSvgPathPrefix }) => {
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
          /* ── 展開状態 ── */
          #${panelId} {
            position: fixed;
            top: 84px;
            right: 16px;
            z-index: 2147483647;
            width: 200px;
            padding: 0;
            background: transparent;
            border: none;
            font-family: "Yu Gothic UI", "Segoe UI", sans-serif;
            transition: width 0.3s, height 0.3s, border-radius 0.3s;
          }
          #${panelId} .print-rx-header {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 4px 0 6px;
            cursor: move;
            user-select: none;
            opacity: 0.35;
            transition: opacity 0.2s;
          }
          #${panelId} .print-rx-header:hover {
            opacity: 0.7;
          }
          #${panelId} .print-rx-grip {
            font-size: 11px;
            color: #64748b;
            letter-spacing: 0.15em;
          }
          #${panelId} .print-rx-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          #${panelId} button[data-mode] {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 56px;
            border: none;
            border-radius: 16px;
            font-size: 16px;
            font-weight: 700;
            letter-spacing: 0.06em;
            cursor: pointer;
            color: #fff;
            background: linear-gradient(145deg, rgba(51, 65, 85, 0.7), rgba(30, 41, 59, 0.85));
            backdrop-filter: blur(12px);
            box-shadow:
              0 6px 16px rgba(15, 23, 42, 0.3),
              0 2px 4px rgba(15, 23, 42, 0.15),
              inset 0 1px 0 rgba(255,255,255,0.18),
              inset 0 -2px 0 rgba(0,0,0,0.12);
            transition: transform 0.15s, box-shadow 0.15s, background 0.2s;
          }
          #${panelId} button[data-mode]:hover {
            transform: translateY(-2px);
            box-shadow:
              0 10px 24px rgba(15, 23, 42, 0.35),
              0 3px 6px rgba(15, 23, 42, 0.2),
              inset 0 1px 0 rgba(255,255,255,0.22),
              inset 0 -2px 0 rgba(0,0,0,0.1);
          }
          #${panelId} button[data-mode]:active {
            transform: translateY(1px) scale(0.97);
            box-shadow:
              0 2px 6px rgba(15, 23, 42, 0.3),
              inset 0 2px 4px rgba(0,0,0,0.15);
          }
          #${panelId} button[data-mode="rx_only"] {
            background: linear-gradient(145deg, rgba(59, 130, 246, 0.85), rgba(29, 78, 216, 0.92));
          }
          #${panelId} button[data-mode="all_pages"] {
            background: linear-gradient(145deg, rgba(100, 116, 139, 0.7), rgba(71, 85, 105, 0.82));
          }
          #${panelId} button[data-mode].is-active {
            box-shadow:
              0 0 0 2.5px rgba(255,255,255,0.55),
              0 6px 20px rgba(15, 23, 42, 0.3),
              inset 0 1px 0 rgba(255,255,255,0.2),
              inset 0 -2px 0 rgba(0,0,0,0.1);
          }
          #${panelId} button[data-mode].is-active::after {
            content: "";
            position: absolute;
            inset: -3px;
            border-radius: 19px;
            border: 2px solid rgba(255,255,255,0.45);
            pointer-events: none;
          }
          #${panelId} .print-rx-footer {
            display: flex;
            justify-content: center;
            margin-top: 6px;
          }
          #${panelId} button[data-role="reset-pos"] {
            border: none;
            background: transparent;
            padding: 4px 8px;
            font-size: 10px;
            color: rgba(100, 116, 139, 0.5);
            cursor: pointer;
            transition: color 0.2s;
          }
          #${panelId} button[data-role="reset-pos"]:hover {
            color: rgba(100, 116, 139, 0.9);
          }
          #${panelId} .print-rx-draft-btn {
            width: 100%;
            height: 48px;
            border: none;
            border-radius: 14px;
            font-size: 15px;
            font-weight: 700;
            letter-spacing: 0.06em;
            cursor: pointer;
            color: #fff;
            background: linear-gradient(145deg, rgba(34, 197, 94, 0.85), rgba(22, 163, 74, 0.92));
            backdrop-filter: blur(12px);
            box-shadow:
              0 6px 16px rgba(15, 23, 42, 0.3),
              0 2px 4px rgba(15, 23, 42, 0.15),
              inset 0 1px 0 rgba(255,255,255,0.18),
              inset 0 -2px 0 rgba(0,0,0,0.12);
            transition: transform 0.15s, box-shadow 0.15s;
          }
          #${panelId} .print-rx-draft-btn:hover {
            transform: translateY(-2px);
            box-shadow:
              0 10px 24px rgba(15, 23, 42, 0.35),
              0 3px 6px rgba(15, 23, 42, 0.2),
              inset 0 1px 0 rgba(255,255,255,0.22);
          }
          #${panelId} .print-rx-draft-btn:active {
            transform: translateY(1px) scale(0.97);
          }
          #${panelId} .print-rx-draft-btn.is-running {
            background: linear-gradient(145deg, rgba(234, 179, 8, 0.85), rgba(202, 138, 4, 0.92));
            cursor: wait;
          }
          #${panelId} .print-rx-status,
          #${panelId} .print-rx-note {
            display: none;
          }

          /* ── 折り畳みボタン (常に表示) ── */
          #${panelId} .print-rx-collapse-btn {
            position: absolute;
            top: -2px;
            right: 0;
            width: 22px;
            height: 22px;
            border: none;
            border-radius: 50%;
            background: rgba(51, 65, 85, 0.6);
            color: #fff;
            font-size: 13px;
            line-height: 22px;
            text-align: center;
            cursor: pointer;
            opacity: 0.4;
            transition: opacity 0.2s, transform 0.2s, background 0.2s;
            z-index: 1;
          }
          #${panelId} .print-rx-collapse-btn:hover {
            opacity: 0.9;
            background: rgba(51, 65, 85, 0.85);
            transform: scale(1.1);
          }

          /* ── 畳んだ状態 ── */
          #${panelId}.is-collapsed .print-rx-header,
          #${panelId}.is-collapsed .print-rx-actions,
          #${panelId}.is-collapsed .print-rx-footer,
          #${panelId}.is-collapsed .print-rx-status,
          #${panelId}.is-collapsed .print-rx-note {
            display: none !important;
          }
          #${panelId}.is-collapsed {
            width: 44px !important;
            height: 44px !important;
            overflow: hidden;
          }
          #${panelId}.is-collapsed .print-rx-collapse-btn {
            position: static;
            width: 44px;
            height: 44px;
            border-radius: 50%;
            font-size: 20px;
            line-height: 44px;
            opacity: 0.75;
            background: linear-gradient(145deg, rgba(59, 130, 246, 0.8), rgba(29, 78, 216, 0.9));
            box-shadow:
              0 4px 14px rgba(15, 23, 42, 0.3),
              inset 0 1px 0 rgba(255,255,255,0.2),
              inset 0 -2px 0 rgba(0,0,0,0.12);
          }
          #${panelId}.is-collapsed .print-rx-collapse-btn:hover {
            opacity: 1;
            transform: scale(1.08);
            box-shadow:
              0 6px 20px rgba(37, 99, 235, 0.4),
              inset 0 1px 0 rgba(255,255,255,0.25),
              inset 0 -2px 0 rgba(0,0,0,0.1);
          }
        `;
        document.head.appendChild(style);
      }

      let panel = document.getElementById(panelId);
      if (!panel) {
        panel = document.createElement("aside");
        panel.id = panelId;
        panel.innerHTML = `
          <button type="button" class="print-rx-collapse-btn" data-role="collapse" title="折り畳み / 展開">−</button>
          <div class="print-rx-header" data-role="drag-handle">
            <div class="print-rx-grip">⋮⋮</div>
          </div>
          <div class="print-rx-status" data-role="status"></div>
          <div class="print-rx-actions">
            <button type="button" data-mode="rx_only">処方箋のみ</button>
            <button type="button" data-mode="all_pages">全部印刷</button>
          </div>
          <div class="print-rx-draft-section" style="display:none">
            <div style="height:1px;background:rgba(255,255,255,0.1);margin:10px 0 8px"></div>
            <button type="button" data-role="draft-save" class="print-rx-draft-btn">下書き一括保存</button>
          </div>
          <div class="print-rx-footer">
            <button type="button" data-role="reset-pos">位置リセット</button>
          </div>
          <div class="print-rx-note"></div>
        `;

        const findYenButton = () => {
          for (const btn of document.querySelectorAll('button[data-variant="primary"][data-size="xl"]')) {
            const pathEl = btn.querySelector("svg path");
            if (pathEl && (pathEl.getAttribute("d") || "").startsWith(yenSvgPathPrefix)) {
              return btn;
            }
          }
          return null;
        };

        // 折り畳み状態を復元
        const collapseKey = positionKey + "_collapsed";
        const collapseBtn = panel.querySelector('[data-role="collapse"]');
        if (localStorage.getItem(collapseKey) === "1") {
          panel.classList.add("is-collapsed");
          collapseBtn.textContent = "🖨";
        }

        panel.addEventListener("click", (event) => {
          // 折り畳みトグル
          const collapse = event.target.closest('[data-role="collapse"]');
          if (collapse) {
            const collapsed = panel.classList.toggle("is-collapsed");
            collapse.textContent = collapsed ? "🖨" : "−";
            localStorage.setItem(collapseKey, collapsed ? "1" : "0");
            return;
          }

          const button = event.target.closest("button[data-mode]");
          if (button) {
            writeMode(button.dataset.mode);
            updatePanel(panel);
            // ￥ボタンを自動クリック → モーダルが開く → 常駐スクリプトが自動処理
            const yenBtn = findYenButton();
            if (yenBtn) {
              yenBtn.click();
            }
            return;
          }

          const draftBtn = event.target.closest('button[data-role="draft-save"]');
          if (draftBtn) {
            if (draftBtn.classList.contains("is-running")) {
              // 実行中に再クリック → 強制リセット
              draftBtn.classList.remove("is-running");
              draftBtn.textContent = "下書き一括保存";
              localStorage.removeItem("__draft_save_requested");
              return;
            }
            draftBtn.classList.add("is-running");
            draftBtn.textContent = "実行中...";
            localStorage.setItem("__draft_save_requested", "1");
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

      // 受付ページなら下書きボタンを表示
      const draftSection = panel.querySelector(".print-rx-draft-section");
      if (draftSection) {
        const isReception = location.href.includes("/reception");
        draftSection.style.display = isReception ? "block" : "none";
      }
      // 下書き完了フラグがあればボタンを戻す
      if (localStorage.getItem("__draft_save_completed") === "1") {
        localStorage.removeItem("__draft_save_completed");
        const dBtn = panel.querySelector('[data-role="draft-save"]');
        if (dBtn) {
          dBtn.classList.remove("is-running");
          dBtn.textContent = "下書き一括保存";
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
      yenSvgPathPrefix: "M4.65 4h4.905l2.46",
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
  await sleep(500); // React state反映待ち

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

  await printRxPagesOnly(context, kartePage, pdfPage, pdfUrl);
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
  // dk-accounts-modal 内の submit ボタン or テキスト「保存」のボタンをクリック
  const clicked = await page.evaluate(() => {
    // 優先: submit ボタン
    const submit = document.querySelector('button[type="submit"]');
    if (submit && submit.offsetParent !== null) {
      submit.click();
      return "submit";
    }
    // フォールバック: テキストが「保存」のボタン
    for (const btn of document.querySelectorAll("button")) {
      if (btn.textContent.trim() === "保存" && btn.offsetParent !== null) {
        btn.click();
        return "text";
      }
    }
    return null;
  });
  if (!clicked) throw new Error("保存ボタンが見つかりません");
  log(`  保存ボタンクリック (${clicked})`);
}

// ── 印刷処理 ────────────────────────────────────

async function printAllPages(pdfPage) {
  log("全ページを印刷します...");
  await triggerPrint(pdfPage);
}

async function printRxPagesOnly(context, kartePage, pdfPage, pdfUrl) {
  log("PDF をダウンロード・解析中...");
  const pdfBuffer = await downloadPdf(kartePage, pdfUrl);
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

  // 一時ファイルに保存して file:// で開く（data: URL では印刷が効かないため）
  const os = require("os");
  const tmpPath = path.join(os.tmpdir(), `print-rx-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, Buffer.from(outputBytes));
  log(`処方箋PDF を一時ファイルに保存: ${tmpPath}`);

  const outputPage = await context.newPage();
  await outputPage.goto(`file:///${tmpPath.replace(/\\/g, "/")}`, { waitUntil: "load" });
  await sleep(PDF_READY_WAIT_MS);

  await triggerPrint(outputPage);

  // 印刷後に一時ファイル削除
  setTimeout(() => {
    try { fs.unlinkSync(tmpPath); } catch {}
  }, 30_000);
}

async function triggerPrint(page) {
  await page.bringToFront().catch(() => {});
  await sleep(1500);

  // 方法1: window.print()（--kiosk-printing でダイアログなし自動印刷）
  try {
    await page.evaluate(() => window.print());
    log("window.print() を実行しました。");
    await sleep(2000);
    return;
  } catch (err) {
    log(`window.print() 失敗: ${err.message}`);
  }

  // 方法2: Ctrl+P ショートカット
  try {
    await page.keyboard.press("Control+P");
    log("Ctrl+P を送信しました。");
    await sleep(2000);
    return;
  } catch (err) {
    log(`Ctrl+P 失敗: ${err.message}`);
  }

  // 方法3: CDP 経由で JavaScript 実行
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Runtime.evaluate", {
      expression: "window.print()",
      userGesture: true,
    });
    await cdp.detach().catch(() => {});
    log("CDP 経由で印刷を実行しました。");
  } catch (err) {
    log(`全ての印刷方法が失敗: ${err.message}`);
  }
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
  // カルテページ上で fetch（Cookieが自動的に付く）
  const base64 = await page.evaluate(async (pdfUrl) => {
    const resp = await fetch(pdfUrl, { credentials: "include" });
    if (!resp.ok) throw new Error("fetch failed: " + resp.status);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }, url);
  log("PDF ダウンロード成功");
  return Buffer.from(base64, "base64");
}

async function extractPageTexts(buffer) {
  const pageTexts = [];
  let currentPage = 0;

  await pdfParse(buffer, {
    pagerender: function (pageData) {
      return pageData.getTextContent().then((textContent) => {
        const text = textContent.items.map((item) => item.str).join(" ");
        pageTexts[currentPage] = text;
        currentPage++;
        return text;
      });
    },
  });

  return pageTexts;
}

// ── 起動 ─────────────────────────────────────────

mainLoop().catch((err) => {
  console.error("致命的エラー:", err.message);
  process.exit(1);
});
