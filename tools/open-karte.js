/**
 * open-karte.js
 *
 * デバッグモードの Chrome に CDP 接続し、
 * デジカルに自動ログインしてカルテ画面（受付画面）が
 * 表示されるまで自動実行する。
 *
 * 使い方: node tools/open-karte.js
 * 前提: Chrome が --remote-debugging-port=9222 で起動済み
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ── 設定 ─────────────────────────────────────────
const CDP_URL = "http://127.0.0.1:9222";
const DIGIKAR_URL = "https://digikar.jp/reception/";

// PC別設定ファイル
const PC_CONFIG_PATH = path.join(__dirname, "..", "config", "pc-config.json");
let LOGIN_ID = "";
let LOGIN_PASSWORDS = [];

try {
  const config = JSON.parse(fs.readFileSync(PC_CONFIG_PATH, "utf8"));
  LOGIN_ID = config.digikar.loginId;
  LOGIN_PASSWORDS = config.digikar.passwords;
} catch (err) {
  console.error(`[エラー] 設定ファイルが読めません: ${PC_CONFIG_PATH}`);
  console.error("config/pc-config.json を確認してください。");
  process.exit(1);
}

const MAX_LOGIN_ATTEMPTS = 5;
const KARTE_WAIT_TIMEOUT_MS = 60_000; // カルテ表示待ち最大60秒

// ── ユーティリティ ──────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleTimeString("ja-JP");
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── メイン処理 ──────────────────────────────────
async function main() {
  log("CDP 接続中...");

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error(`[エラー] Chrome に接続できません: ${err.message}`);
    console.error(`Chrome が http://127.0.0.1:9222 でデバッグモード起動しているか確認してください。`);
    process.exit(1);
  }

  log("Chrome 接続OK");

  const context = browser.contexts()[0];
  if (!context) {
    console.error("[エラー] ブラウザコンテキストが取得できません。");
    process.exit(1);
  }

  // digikar.jp のページを探す。なければ新しいタブで開く
  let page = context.pages().find((p) => p.url().includes("digikar.jp"));
  if (!page) {
    log("デジカルのタブが見つかりません。新しいタブで開きます...");
    page = await context.newPage();
    await page.goto(DIGIKAR_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(2000);
  }

  // ログイン → カルテ表示のループ
  let attempts = 0;
  const startTime = Date.now();

  while (Date.now() - startTime < KARTE_WAIT_TIMEOUT_MS) {
    const currentUrl = page.url();

    // カルテ画面（受付画面）に到達したか判定
    if (isKarteScreen(currentUrl)) {
      log("カルテ画面（受付画面）の表示を確認しました！");
      break;
    }

    // ログインページの場合は自動ログイン
    if (isLoginPage(currentUrl)) {
      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        log("[警告] ログイン試行回数の上限に達しました。手動でログインしてください。");
        break;
      }
      attempts++;
      log(`ログインページを検知 → 自動ログイン試行 (${attempts}/${MAX_LOGIN_ATTEMPTS})`);
      await tryAutoLogin(page);
      await sleep(3000);
      continue;
    }

    // Google認証画面の場合
    if (isGoogleAuthPage(currentUrl)) {
      log("Google認証画面を検知 → 自動入力します...");
      await handleGoogleAuth(page);
      await sleep(3000);
      continue;
    }

    // それ以外のページ（リダイレクト中など）
    await sleep(1000);
  }

  if (Date.now() - startTime >= KARTE_WAIT_TIMEOUT_MS) {
    log("[警告] タイムアウト。現在のページを確認してください: " + page.url());
  }

  log("処理完了。Chrome はそのまま開いたままです。");

  // browser.close() はしない（CDPの場合、closeするとChromeが閉じる）
  // disconnect だけする
  try {
    browser.close();
  } catch {}

  process.exit(0);
}

// ── ページ判定 ──────────────────────────────────

function isKarteScreen(url) {
  // 受付画面・カルテ画面のURLパターン
  return (
    url.includes("digikar.jp/reception") ||
    url.includes("digikar.jp/karte") ||
    url.includes("digikar.jp/patient") ||
    url.includes("digikar.jp/dashboard")
  ) && !url.includes("/login") && !url.includes("/sign_in");
}

function isLoginPage(url) {
  return (
    url.includes("/login") ||
    url.includes("/sign_in") ||
    url.includes("/signin")
  );
}

function isGoogleAuthPage(url) {
  return url.includes("accounts.google.com");
}

// ── 自動ログイン ────────────────────────────────

async function tryAutoLogin(page) {
  const loginState = await page.evaluate(() => {
    const emailInput = document.querySelector(
      'input[type="email"], input[type="text"][name*="mail"], input[type="text"][name*="login"], input[type="text"][name*="user"], input[type="text"][autocomplete="email"], input[type="text"][autocomplete="username"]'
    );
    const passInput = document.querySelector('input[type="password"]');

    if (emailInput && passInput) return "both_visible";
    if (emailInput && !passInput) return "email_only";
    if (!emailInput && passInput) return "password_only";
    return "unknown";
  }).catch(() => "error");

  log(`ログイン状態: ${loginState}`);

  if (loginState === "both_visible") {
    await fillAndSubmit(page, LOGIN_ID, LOGIN_PASSWORDS[0]);
    await sleep(3000);
    // 失敗していたら2番目のパスワードを試す
    if (isLoginPage(page.url()) && LOGIN_PASSWORDS.length > 1) {
      log("パスワード1 失敗 → パスワード2 を試します...");
      await fillAndSubmit(page, LOGIN_ID, LOGIN_PASSWORDS[1]);
    }
  } else if (loginState === "email_only") {
    await fillEmail(page, LOGIN_ID);
    await sleep(500);
    await clickSubmitButton(page);
    await sleep(2000);
    await fillPasswordField(page, LOGIN_PASSWORDS[0]);
    await sleep(3000);
    if (isLoginPage(page.url()) && LOGIN_PASSWORDS.length > 1) {
      log("パスワード1 失敗 → パスワード2 を試します...");
      await fillPasswordField(page, LOGIN_PASSWORDS[1]);
    }
  } else if (loginState === "password_only") {
    await fillPasswordField(page, LOGIN_PASSWORDS[0]);
    await sleep(3000);
    if (isLoginPage(page.url()) && LOGIN_PASSWORDS.length > 1) {
      log("パスワード1 失敗 → パスワード2 を試します...");
      await fillPasswordField(page, LOGIN_PASSWORDS[1]);
    }
  }
}

// ── Google認証ハンドリング ───────────────────────

async function handleGoogleAuth(page) {
  const authState = await page.evaluate(() => {
    const emailInput = document.querySelector('input[type="email"]');
    const passInput = document.querySelector('input[type="password"]');
    if (emailInput) return "email";
    if (passInput) return "password";
    return "unknown";
  }).catch(() => "error");

  if (authState === "email") {
    log("Googleメールアドレスを入力...");
    await page.evaluate((email) => {
      const input = document.querySelector('input[type="email"]');
      if (input) {
        input.focus();
        input.value = email;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, LOGIN_ID);
    await sleep(500);
    // 「次へ」ボタン
    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const t = btn.textContent.trim();
        if (t === "次へ" || t === "Next") {
          btn.click();
          return;
        }
      }
      // IDが "identifierNext" のdivをクリック
      const next = document.querySelector("#identifierNext");
      if (next) next.click();
    });
  } else if (authState === "password") {
    log("Googleパスワードを入力...");
    await fillPasswordField(page, LOGIN_PASSWORDS[0]);
    await sleep(3000);
    // 失敗していたら2番目
    if (isGoogleAuthPage(page.url()) && LOGIN_PASSWORDS.length > 1) {
      log("パスワード1 失敗 → パスワード2 を試します...");
      await fillPasswordField(page, LOGIN_PASSWORDS[1]);
    }
  }
}

// ── フォーム操作ヘルパー ────────────────────────

async function fillEmail(page, email) {
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
  }, email);
}

async function fillPasswordField(page, password) {
  await page.evaluate((pw) => {
    const input = document.querySelector('input[type="password"]');
    if (input) {
      input.focus();
      input.value = pw;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, password);
  await sleep(500);
  await clickSubmitButton(page);
  log("パスワードを入力して送信しました");
}

async function fillAndSubmit(page, email, password) {
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
}

async function clickSubmitButton(page) {
  await page.evaluate(() => {
    // submit ボタン
    const submit = document.querySelector('button[type="submit"], input[type="submit"]');
    if (submit && submit.offsetParent !== null) {
      submit.click();
      return;
    }
    // テキストでログイン系ボタンを探す
    for (const btn of document.querySelectorAll("button")) {
      const t = btn.textContent.trim();
      if (
        (t.includes("ログイン") || t.includes("サインイン") || t === "次へ" || t === "Next") &&
        btn.offsetParent !== null
      ) {
        btn.click();
        return;
      }
    }
    // Google の #passwordNext
    const next = document.querySelector("#passwordNext");
    if (next) next.click();
  });
}

// ── 実行 ────────────────────────────────────────
main().catch((err) => {
  console.error(`[エラー] ${err.message}`);
  process.exit(1);
});
