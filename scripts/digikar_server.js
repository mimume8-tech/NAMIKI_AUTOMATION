/**
 * デジカル カルテ下書き一括保存 - GUIサーバー
 *
 * ダブルクリックで起動: デジカル自動処理.bat
 * ブラウザで http://localhost:3456 が自動で開く
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { execSync, spawn, exec } = require('child_process');
const {
  CHROME_PATH,
  DIGIKAR_PROFILE_DIRECTORY,
  DIGIKAR_USER_DATA,
  prepareDigikarProfile,
} = require('./digikar_profile');

// ===== 設定 =====
const SERVER_PORT = 3456;
const DEBUG_PORT = 9222;
const PROCESSED_FILE = path.join(__dirname, 'processed.json');

// ===== 待ち時間設定（ms） =====
const WAIT = {
  pageLoad: 1500,      // ページ読み込み後
  afterCopy: 800,      // 複写ボタン後
  afterYen: 1000,      // ￥ボタン後
  afterTabClose: 1000, // タブ×後
  afterDialog: 800,    // ダイアログ後
};

// ===== 状態管理 =====
let state = {
  status: 'idle', // idle | running | stopping | done
  logs: [],
  savedCount: 0,
  skippedCount: 0,
  errorCount: 0,
  total: 0,
  current: 0,
  errors: [],
};
let sseClients = [];
let stopRequested = false;

function log(msg) {
  const line = `${new Date().toLocaleTimeString('ja-JP')} ${msg}`;
  state.logs.push(line);
  if (state.logs.length > 500) state.logs.shift();
  console.log(msg);
  broadcast({ type: 'log', data: line });
}

function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(data); return true; } catch { return false; }
  });
}

function updateStatus() {
  broadcast({
    type: 'status',
    data: {
      status: state.status,
      savedCount: state.savedCount,
      skippedCount: state.skippedCount,
      errorCount: state.errorCount,
      total: state.total,
      current: state.current,
    }
  });
}

// ===== ユーティリティ =====
function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf-8')));
    }
  } catch {}
  return new Set();
}

function saveProcessed(set) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...set], null, 2), 'utf-8');
}

async function waitFor(page, ms) {
  await page.waitForTimeout(ms);
}

// ===== Chrome 起動（サーバー起動時に実行） =====
async function launchChrome() {
  console.log('Chrome を終了中...');
  try { execSync('taskkill /F /T /IM chrome.exe', { stdio: 'ignore' }); } catch {}
  await new Promise(r => setTimeout(r, 3000));
  prepareDigikarProfile({ log });

  console.log('Chrome をデバッグモードで起動...');
  const child = spawn(CHROME_PATH, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--new-window',
    `--user-data-dir=${DIGIKAR_USER_DATA}`,
    `--profile-directory=${DIGIKAR_PROFILE_DIRECTORY}`,
    `http://localhost:${SERVER_PORT}`,
    'https://digikar.jp/reception/',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) { console.log('Chrome 起動OK'); return; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error('Chrome に接続できません');
}

// ===== メイン自動化処理 =====
async function runAutomation(targetDate) {
  state = { status: 'running', logs: [], savedCount: 0, skippedCount: 0, errorCount: 0, total: 0, current: 0, errors: [] };
  stopRequested = false;
  updateStatus();

  try {
    // 1. 既存 Chrome に接続
    log('Chrome に接続中...');
    let connected = false;
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) connected = true;
    } catch {}
    if (!connected) throw new Error('Chrome が起動していません。batを再実行してください');
    log('Chrome 接続OK');

    // 2. Playwright 接続（GUIタブを避けてデジカルページを探す）
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    let page = null;
    for (const p of context.pages()) {
      const u = p.url();
      if (u.includes('digikar.jp')) { page = p; break; }
    }
    if (!page) {
      // digikar.jp がなければ、localhost と chrome:// 以外を探す
      page = context.pages().find(p => {
        const u = p.url();
        return !u.startsWith('chrome://') && !u.includes('localhost');
      }) || context.pages()[0];
      // デジカルに遷移
      await page.goto('https://digikar.jp/reception/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await waitFor(page, WAIT.pageLoad);

    // ログイン待ち
    if (!page.url().includes('/reception')) {
      log('ログイン待ち中... Chrome でログインしてください');
      try {
        await page.waitForURL(url => url.includes('/reception'), { timeout: 300000 });
        log('ログイン検出');
        await waitFor(page, WAIT.pageLoad);
      } catch {
        throw new Error('ログインタイムアウト（5分）');
      }
    }

    // 日付移動
    if (targetDate && /^\d{8}$/.test(targetDate)) {
      log(`対象日: ${targetDate}`);
      await page.goto(`https://digikar.jp/reception/${targetDate}`, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await waitFor(page, 2000);
    } else {
      const d = page.url().match(/reception\/(\d{8})/)?.[1] || '今日';
      log(`対象日: ${d}`);
    }

    // 3. 患者リンク収集
    log('患者リンク収集中...');
    try {
      await page.waitForSelector('a[href*="/karte/patients/"]', { timeout: 30000 });
    } catch {
      throw new Error('患者リンクが見つかりません');
    }
    await waitFor(page, 1000);

    const patientLinks = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href*="/karte/patients/"]');
      const results = [];
      const seen = new Set();
      for (const a of anchors) {
        const href = a.getAttribute('href');
        if (href && href.includes('visitId=') && !seen.has(href)) {
          seen.add(href);
          const row = a.closest('tr');
          const name = row ? (row.textContent || '').substring(0, 40).trim() : '';
          results.push({ href, name });
        }
      }
      return results;
    });

    log(`患者: ${patientLinks.length} 件`);

    const processed = loadProcessed();
    const toProcess = patientLinks.filter(p => !processed.has(p.href));
    state.total = toProcess.length;
    log(`未処理: ${toProcess.length} 件（処理済み: ${patientLinks.length - toProcess.length} 件）`);
    updateStatus();

    if (toProcess.length === 0) {
      log('全件処理済みです');
      state.status = 'done';
      updateStatus();
      return;
    }

    // 4. 処理ループ
    for (let i = 0; i < toProcess.length; i++) {
      if (stopRequested) {
        log('停止しました');
        break;
      }

      const { href, name } = toProcess[i];
      const fullUrl = new URL(href, 'https://digikar.jp').href;
      state.current = i + 1;
      updateStatus();
      log(`[${i + 1}/${toProcess.length}] ${name || href}`);

      try {
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitFor(page, WAIT.pageLoad);

        const result = await processOneKarte(page, fullUrl);

        processed.add(href);
        saveProcessed(processed);

        if (result === 'skipped') {
          state.skippedCount++;
        } else {
          state.savedCount++;
        }
      } catch (err) {
        log(`  !! エラー: ${err.message}`);
        state.errors.push({ patient: name, error: err.message });
        state.errorCount++;
      }
      updateStatus();
    }

    // 5. 完了
    log(`--- 完了 ---`);
    log(`  保存: ${state.savedCount} / スキップ: ${state.skippedCount} / エラー: ${state.errorCount}`);
    state.status = 'done';
    updateStatus();

    try { await browser.close(); } catch {}

  } catch (err) {
    log(`致命的エラー: ${err.message}`);
    state.status = 'done';
    updateStatus();
  }
}

// ===== カルテ処理関数群 =====

async function processOneKarte(page, fullUrl) {
  await page.evaluate(() => {
    document.querySelectorAll('[class*="modal-flag"]').forEach(el => el.remove());
  });

  // 判定: 右パネルに既に文字があるか
  const alreadyHasContent = !(await checkEditingAreaEmpty(page));
  if (alreadyHasContent) {
    log('  -> 複写済み -> スキップ');
    return 'skipped';
  }

  // 複写を試みる
  await doCopyButtons(page);

  // 複写後チェック
  const stillEmpty = await checkEditingAreaEmpty(page);
  if (stillEmpty) {
    log('  -> 空の下書き検出 -> 削除して再試行');
    try {
      await clickTabCloseButton(page);
      await waitFor(page, WAIT.afterTabClose);
      await handleConfirmDialog(page);
      await waitFor(page, WAIT.afterDialog);
    } catch (e) {
      log(`    ! タブ閉じ失敗: ${e.message}`);
    }

    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(page, WAIT.pageLoad);

    await page.evaluate(() => {
      document.querySelectorAll('[class*="modal-flag"]').forEach(el => el.remove());
    });
    await doCopyButtons(page);
  }

  // ￥ボタン
  try {
    await clickYenButton(page);
    log('  [OK] 下書き保存');
  } catch (e) { log(`  ! ￥ボタン: ${e.message}`); }
  await waitFor(page, WAIT.afterYen);
  return 'saved';
}

async function doCopyButtons(page) {
  try {
    await clickSectionCopyButton(page, '主訴・所見');
    log('  [OK] 主訴・所見 複写');
  } catch (e) { log(`  ! 主訴・所見: ${e.message}`); }
  await waitFor(page, WAIT.afterCopy);

  try {
    await clickSectionCopyButton(page, '処置・行為');
    log('  [OK] 処置・行為 複写');
  } catch (e) { log(`  ! 処置・行為: ${e.message}`); }
  await waitFor(page, WAIT.afterCopy);
}

async function checkEditingAreaEmpty(page) {
  return await page.evaluate(() => {
    const editArea = document.querySelector('[class*="editor"], [contenteditable="true"], textarea');
    if (editArea) {
      const text = editArea.textContent || editArea.value || '';
      return text.trim().length === 0;
    }
    const allText = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    const ignoreLabels = ['主訴・所見', '処置・行為', 'キーワード', '下書き', '未承認',
      'シェーマ追加', '処方箋備考', '適応症追加', '心療内科', '木村友哉'];
    while (node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left < 530 || rect.top < 100 || rect.top > 800) continue;
      if (rect.width === 0 || rect.height === 0) continue;
      const t = node.textContent.trim();
      if (t.length > 2 && !ignoreLabels.some(l => t.includes(l))) {
        allText.push(t);
      }
    }
    return allText.length === 0;
  });
}

async function clickTabCloseButton(page) {
  const pos = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button[data-variant="iconOnly"][data-size="sm"]');
    for (const btn of buttons) {
      const pathEl = btn.querySelector('svg path');
      if (!pathEl) continue;
      if (pathEl.getAttribute('d').startsWith('M19 7.333')) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.top > 80) continue;
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      }
    }
    return null;
  });
  if (!pos) throw new Error('×ボタンなし');
  await page.mouse.click(pos.x, pos.y);
}

async function handleConfirmDialog(page) {
  await waitFor(page, 300);
  await page.evaluate(() => {
    const keywords = ['削除', 'OK', 'はい', '確認', 'Yes'];
    for (const btn of document.querySelectorAll('button')) {
      const text = btn.textContent.trim();
      if (keywords.some(kw => text.includes(kw))) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        if (Math.abs(rect.left + rect.width / 2 - cx) < 400 &&
            Math.abs(rect.top + rect.height / 2 - cy) < 300) {
          btn.click();
          return;
        }
      }
    }
  });
}

async function clickSectionCopyButton(page, sectionTitle) {
  const pos = await page.evaluate((title) => {
    const titleNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.trim() !== title) continue;
      const el = node.parentElement;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.left >= 530) continue;
      titleNodes.push({ el, top: rect.top });
    }
    const matches = [];
    for (const tn of titleNodes) {
      const parent = tn.el.parentElement;
      if (!parent) continue;
      for (const btn of parent.querySelectorAll('button[data-variant="iconOnly"]')) {
        const pathEl = btn.querySelector('svg path');
        if (!pathEl) continue;
        if (!pathEl.getAttribute('d').startsWith('M15 18v-4.5H9')) continue;
        const bRect = btn.getBoundingClientRect();
        if (bRect.width === 0 || bRect.height === 0) continue;
        matches.push({ x: Math.round(bRect.left + bRect.width / 2), y: Math.round(bRect.top + bRect.height / 2), top: tn.top });
        break;
      }
    }
    matches.sort((a, b) => a.top - b.top);
    return matches.length >= 1 ? matches[0] : null;
  }, sectionTitle);
  if (!pos) throw new Error(`"${sectionTitle}" の複写ボタンなし`);
  await page.mouse.click(pos.x, pos.y);
}

async function clickYenButton(page) {
  const pos = await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, span')) {
      for (const p of el.querySelectorAll('svg path')) {
        const d = p.getAttribute('d') || '';
        if (d.includes('M4.65') && d.includes('5.355')) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        }
      }
    }
    return null;
  });
  if (!pos) throw new Error('￥ボタンなし');
  const vp = await page.viewportSize();
  if (vp && pos.y > vp.height) {
    await page.mouse.wheel(0, pos.y - vp.height + 100);
    await waitFor(page, 300);
    return clickYenButton(page);
  }
  await page.mouse.click(pos.x, pos.y);
}

// ===== HTTP サーバー =====
const HTML_PATH = path.join(__dirname, 'digikar_panel.html');

const server = http.createServer((req, res) => {
  // GUI ページ
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(HTML_PATH, 'utf-8'));
    return;
  }

  // SSE（リアルタイムログ）
  if (req.method === 'GET' && req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseClients.push(res);
    // 現在の状態を送信
    res.write(`data: ${JSON.stringify({ type: 'status', data: { status: state.status, savedCount: state.savedCount, skippedCount: state.skippedCount, errorCount: state.errorCount, total: state.total, current: state.current } })}\n\n`);
    for (const l of state.logs.slice(-50)) {
      res.write(`data: ${JSON.stringify({ type: 'log', data: l })}\n\n`);
    }
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // 開始
  if (req.method === 'POST' && req.url === '/api/start') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (state.status === 'running') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '既に実行中' }));
        return;
      }
      const { date } = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      runAutomation(date);
    });
    return;
  }

  // 停止
  if (req.method === 'POST' && req.url === '/api/stop') {
    stopRequested = true;
    state.status = 'stopping';
    updateStatus();
    log('停止リクエスト受信...');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // リセット
  if (req.method === 'POST' && req.url === '/api/reset') {
    try { fs.unlinkSync(PROCESSED_FILE); } catch {}
    state = { status: 'idle', logs: [], savedCount: 0, skippedCount: 0, errorCount: 0, total: 0, current: 0, errors: [] };
    updateStatus();
    log('processed.json をリセットしました');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(SERVER_PORT, () => {
  console.log(`GUI: http://localhost:${SERVER_PORT}`);
  console.log('Chrome を起動中...');
  // Chrome を起動（GUIタブ + デジカルタブ）
  launchChrome();
});
