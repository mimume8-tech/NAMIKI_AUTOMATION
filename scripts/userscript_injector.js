/**
 * userscript_injector.js
 *
 * Tampermonkey に依存せず、Playwright の CDP 接続経由で
 * ユーザースクリプト (.user.js) をページに自動注入する。
 *
 * 使い方:
 *   const { setupUserscriptInjection } = require('./userscript_injector');
 *   // browser = await chromium.connectOverCDP(...)
 *   const context = browser.contexts()[0];
 *   await setupUserscriptInjection(context, { log });
 */

const fs = require("fs");
const path = require("path");

const SCRIPTS_DIR = __dirname;
const TAMPERMONKEY_DIR = path.join(__dirname, "tampermonkey");

/**
 * .user.js ファイルから @match パターンを抽出する
 */
function parseUserscriptMetadata(content) {
  const meta = {};
  const headerMatch = content.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!headerMatch) return null;

  const lines = headerMatch[1].split("\n");
  meta.matches = [];
  meta.name = "";
  meta.runAt = "document-end";

  for (const line of lines) {
    const m = line.match(/\/\/\s*@(\S+)\s+(.*)/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "match") meta.matches.push(value.trim());
    if (key === "name") meta.name = value.trim();
    if (key === "run-at") meta.runAt = value.trim();
  }

  return meta.matches.length > 0 ? meta : null;
}

/**
 * @match パターンを正規表現に変換
 * 例: "https://digikar.jp/*" → /^https:\/\/digikar\.jp\/.*$/
 *     "https://*.adhd-vcdcs.jp/*" → /^https:\/\/[^/]*\.adhd-vcdcs\.jp\/.*$/
 */
function matchPatternToRegex(pattern) {
  // まず * をプレースホルダーに置換してからエスケープ
  let re = pattern.replace(/\*/g, "<<WILDCARD>>");
  re = re.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

  // *.domain → 任意サブドメイン
  re = re.replace(/<<WILDCARD>>\\\./g, "[^/]*\\.");

  // 残りの * → 任意文字列
  re = re.replace(/<<WILDCARD>>/g, ".*");

  return new RegExp("^" + re + "$");
}

/**
 * 全ユーザースクリプトを読み込む
 */
function loadUserscripts() {
  const scripts = [];
  const dirs = [SCRIPTS_DIR, TAMPERMONKEY_DIR];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".user.js"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, "utf8");
      const meta = parseUserscriptMetadata(content);
      if (!meta) continue;

      const regexes = meta.matches.map(matchPatternToRegex);
      scripts.push({
        name: meta.name,
        file,
        content,
        regexes,
        runAt: meta.runAt,
      });
    }
  }

  return scripts;
}

/**
 * BrowserContext に全ユーザースクリプトの自動注入を設定する。
 * addInitScript で新規ドキュメントに注入し、
 * 既存ページにも即時注入する。
 */
async function setupUserscriptInjection(context, { log } = {}) {
  const logger = typeof log === "function" ? log : () => {};
  const scripts = loadUserscripts();

  if (scripts.length === 0) {
    logger("userscript_injector: スクリプトが見つかりません");
    return;
  }

  logger(`userscript_injector: ${scripts.length}個のスクリプトを登録`);

  // 各スクリプトをURL判定付きで addInitScript に登録
  for (const script of scripts) {
    const patterns = script.regexes.map((r) => r.source);
    const wrappedCode = `
(function() {
  var __patterns = ${JSON.stringify(patterns)};
  var __matched = false;
  for (var i = 0; i < __patterns.length; i++) {
    if (new RegExp(__patterns[i]).test(location.href)) {
      __matched = true;
      break;
    }
  }
  if (!__matched) return;
  // --- userscript: ${script.name} ---
  ${script.content}
})();
`;
    try {
      await context.addInitScript(wrappedCode);
      logger(`  登録: ${script.name} (${script.file})`);
    } catch (err) {
      logger(`  登録失敗: ${script.name} — ${err.message}`);
    }
  }

  // 既存ページにも注入
  const pages = context.pages();
  for (const page of pages) {
    await injectIntoPage(page, scripts, logger);
  }
}

/**
 * 単一ページに、URLが一致するスクリプトを注入する
 */
async function injectIntoPage(page, scripts, logger) {
  let url;
  try {
    url = page.url();
  } catch {
    return;
  }

  if (!url || url === "about:blank" || url.startsWith("chrome")) return;

  for (const script of scripts) {
    const matched = script.regexes.some((r) => r.test(url));
    if (!matched) continue;

    try {
      // 二重注入防止: スクリプト固有のフラグをチェック
      const flagName = `__userscript_injected_${script.file.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const alreadyInjected = await page.evaluate((flag) => !!window[flag], flagName);
      if (alreadyInjected) continue;

      await page.evaluate(
        ({ code, flag }) => {
          window[flag] = true;
          const fn = new Function(code);
          fn();
        },
        { code: script.content, flag: flagName }
      );
      logger(`  注入: ${script.name} → ${url.substring(0, 60)}`);
    } catch (err) {
      logger(`  注入失敗: ${script.name} → ${err.message}`);
    }
  }
}

module.exports = {
  setupUserscriptInjection,
  loadUserscripts,
  injectIntoPage,
};
