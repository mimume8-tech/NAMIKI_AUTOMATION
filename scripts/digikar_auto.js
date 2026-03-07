/**
 * デジカル カルテ下書き一括保存スクリプト
 *
 * 使い方:
 *   cd C:\NAMIKI_AUTOMATION
 *   node scripts/digikar_auto.js
 *
 *   Chrome は自動で起動されます（事前に閉じておく必要あり）
 */

const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// ===== 設定 =====
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// デバッグモードには専用プロファイルが必須（Chrome の仕様）
// ログインは初回のみ。2回目以降はログイン状態が保持される
const DIGIKAR_PROFILE = 'C:\\Users\\ykimu\\AppData\\Local\\Google\\Chrome\\DigikarAuto';
const DEBUG_PORT = 9222;
const PROCESSED_FILE = path.join(__dirname, 'processed.json');

// ===== ユーティリティ =====

function prompt(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(msg, (answer) => { rl.close(); resolve(answer); })
  );
}

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf-8'));
      console.log(`処理済みデータ読み込み: ${data.length} 件`);
      return new Set(data);
    }
  } catch (e) {
    console.warn('processed.json の読み込みに失敗:', e.message);
  }
  return new Set();
}

function saveProcessed(set) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...set], null, 2), 'utf-8');
}

async function waitForStable(page, ms = 1500) {
  await page.waitForTimeout(ms);
}

// ===== メイン処理 =====

(async () => {
  // ----- 1. Chrome を終了 → デバッグモードで再起動 -----
  console.log('Chrome を終了中...');
  try { execSync('taskkill /F /T /IM chrome.exe', { stdio: 'ignore' }); } catch {}
  await new Promise(r => setTimeout(r, 3000));

  console.log('Chrome をデバッグモードで起動中...');
  const child = spawn(CHROME_PATH, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    `--user-data-dir=${DIGIKAR_PROFILE}`,
    'https://digikar.jp/reception/',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  // 接続待ち
  let connected = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) { connected = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!connected) {
    console.error('Chrome に接続できません。');
    process.exit(1);
  }
  console.log('Chrome 起動OK！\n');

  // ----- 2. Playwright 接続 -----
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0];

  // デジカルのページを探す（Chrome内部ページを避ける）
  let page = null;
  const allPages = context.pages();
  console.log(`開いているタブ: ${allPages.length} 個`);
  for (const p of allPages) {
    const u = p.url();
    console.log(`  - ${u}`);
    if (u.includes('digikar.jp')) {
      page = p;
    }
  }
  if (!page) {
    // digikar.jp が見つからない場合、chrome:// 以外のページを使う
    page = allPages.find(p => !p.url().startsWith('chrome://')) || allPages[0];
  }
  await waitForStable(page, 1500);

  // 現在のURLを表示
  console.log(`接続先ページ: ${page.url()}`);

  // ログインが必要か判定
  const isReception = page.url().includes('/reception');
  if (!isReception) {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  ログインが必要です                          ║');
    console.log('║                                              ║');
    console.log('║  Chrome画面で以下を行ってください:           ║');
    console.log('║  1. 証明書ダイアログが出たら OK              ║');
    console.log('║  2. IDとパスワードを入力してログイン         ║');
    console.log('║  3. 受付一覧ページが表示されるまで待つ       ║');
    console.log('║                                              ║');
    console.log('║  （2回目以降はログイン状態が保持されます）   ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('受付一覧ページへの遷移を待機中...');
    try {
      await page.waitForURL(url => url.includes('/reception'), { timeout: 300000 });
      console.log('受付ページを検出しました！');
      await waitForStable(page, 1500);
    } catch {
      console.error('タイムアウト（5分経過）。');
      try { await browser.close(); } catch {}
      process.exit(1);
    }
  }

  // 受付ページの読み込み待ち
  console.log('受付ページの読み込みを確認中...');
  await waitForStable(page, 1500);

  // 日付確認
  const currentDate = page.url().match(/reception\/(\d{8})/)?.[1];
  if (currentDate) {
    console.log(`対象日: ${currentDate.slice(0,4)}/${currentDate.slice(4,6)}/${currentDate.slice(6,8)}`);
  } else {
    console.log('対象日: 今日');
  }
  const dateInput = await prompt('>>> この日付でOKなら Enter / 変更なら日付入力 (例: 20260305): ');
  if (dateInput.trim() && /^\d{8}$/.test(dateInput.trim())) {
    await page.goto(`https://digikar.jp/reception/${dateInput.trim()}`, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await waitForStable(page, 2000);
  }

  // ----- 3. 患者リンク収集 -----
  console.log('\n患者リンクを収集中...');
  console.log('  患者一覧の読み込みを待機中...');
  try {
    await page.waitForSelector('a[href*="/karte/patients/"]', { timeout: 30000 });
  } catch {
    console.error('患者リンクが見つかりません。受付一覧に患者が表示されているか確認してください。');
    await prompt('>>> Enter で終了: ');
    try { await browser.close(); } catch { process.exit(1); }
    process.exit(1);
  }
  await page.waitForTimeout(800);

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

  console.log(`患者リンク: ${patientLinks.length} 件`);
  if (patientLinks.length === 0) {
    console.error('患者リンクが見つかりません。');
    await prompt('>>> Enter で終了: ');
    try { await browser.close(); } catch { process.exit(1); }
    process.exit(1);
  }

  // ----- 4. 途中再開 -----
  const processed = loadProcessed();
  const toProcess = patientLinks.filter(p => !processed.has(p.href));
  console.log(`未処理: ${toProcess.length} 件（スキップ: ${patientLinks.length - toProcess.length} 件）`);

  if (toProcess.length === 0) {
    console.log('全件処理済みです。processed.json を削除すれば最初からやり直せます。');
    try { await browser.close(); } catch {}
    return;
  }

  await prompt(`>>> Enter で ${toProcess.length} 件の処理を開始（Ctrl+C で終了）: `);

  // ----- 5. 各患者を処理 -----
  let savedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const errors = [];

  for (let i = 0; i < toProcess.length; i++) {
    const { href, name } = toProcess[i];
    const fullUrl = new URL(href, 'https://digikar.jp').href;
    const label = `[${i + 1}/${toProcess.length}] ${name || href}`;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(label);

    try {
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitForStable(page, 1500);

      const result = await processOneKarte(page, fullUrl);

      processed.add(href);
      saveProcessed(processed);

      if (result === 'skipped') {
        skippedCount++;
      } else {
        savedCount++;
      }
    } catch (err) {
      console.error(`  ⚠ エラー: ${err.message}`);
      errors.push({ patient: label, error: err.message });
      errorCount++;
    }
  }

  // ----- 6. サマリー -----
  console.log(`\n${'═'.repeat(60)}`);
  console.log('処理完了');
  console.log(`  下書き保存: ${savedCount} 件`);
  console.log(`  複写済みスキップ: ${skippedCount} 件`);
  console.log(`  前回処理済み: ${patientLinks.length - toProcess.length} 件`);
  console.log(`  エラー: ${errorCount} 件`);
  if (errors.length > 0) {
    console.log('\nエラー詳細:');
    errors.forEach(e => console.log(`  - ${e.patient}: ${e.error}`));
  }

  try { await browser.close(); } catch {}
  console.log('完了。Chrome は開いたままです。');
})();

// ===== 関数 =====

async function processOneKarte(page, fullUrl) {
  // モーダルオーバーレイを除去
  await page.evaluate(() => {
    document.querySelectorAll('[class*="modal-flag"]').forEach(el => el.remove());
  });

  // ===== 判定: 右パネルに既に文字があるか =====
  const alreadyHasContent = !(await checkEditingAreaEmpty(page));
  if (alreadyHasContent) {
    console.log('  → 複写済み（右パネルに内容あり）→ スキップ');
    return 'skipped';
  }

  // ===== 右パネルが空 → 複写を試みる =====
  await doCopyButtons(page);

  // 複写後に内容が入ったかチェック
  const stillEmpty = await checkEditingAreaEmpty(page);

  if (stillEmpty) {
    // 空の下書きが邪魔している → ×で削除して再試行
    console.log('  ⚠ 複写後も空 → 空の下書きを削除して再試行');

    // カルテタブの×を押して閉じる
    try {
      await clickTabCloseButton(page);
      await page.waitForTimeout(800);

      // 確認ダイアログがあれば対応
      await handleConfirmDialog(page);
      await page.waitForTimeout(800);
    } catch (e) {
      console.warn(`    ⚠ タブ閉じ失敗: ${e.message}`);
    }

    // カルテを再度開く
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForStable(page, 1500);

    await page.evaluate(() => {
      document.querySelectorAll('[class*="modal-flag"]').forEach(el => el.remove());
    });

    // 再度複写
    await doCopyButtons(page);
  }

  // ===== ￥ボタン（下書き保存） =====
  try {
    await clickYenButton(page);
    console.log('  ✓ ￥ 下書き保存');
  } catch (e) { console.warn(`  ⚠ ￥ボタン: ${e.message}`); }
  await page.waitForTimeout(800);
  return 'saved';
}

/**
 * 主訴・所見 + 処置・行為 の複写ボタンをクリック
 */
async function doCopyButtons(page) {
  try {
    await clickSectionCopyButton(page, '主訴・所見');
    console.log('  ✓ 主訴・所見 複写');
  } catch (e) { console.warn(`  ⚠ 主訴・所見: ${e.message}`); }
  await page.waitForTimeout(800);

  try {
    await clickSectionCopyButton(page, '処置・行為');
    console.log('  ✓ 処置・行為 複写');
  } catch (e) { console.warn(`  ⚠ 処置・行為: ${e.message}`); }
  await page.waitForTimeout(800);
}

/**
 * 右パネル（編集エリア）の主訴・所見が空かチェック
 */
async function checkEditingAreaEmpty(page) {
  return await page.evaluate(() => {
    // 右パネル（left >= 530）で「主訴・所見」ヘッダーの下のテキストエリアを確認
    // 編集エリアのテキスト入力部分が空かどうか
    const editArea = document.querySelector('[class*="editor"], [contenteditable="true"], textarea');
    if (editArea) {
      const text = editArea.textContent || editArea.value || '';
      return text.trim().length === 0;
    }
    // フォールバック: 右パネル全体でテキスト量をチェック
    // 「主訴・所見」「処置・行為」「キーワード」等のラベル以外にテキストがあるか
    const allText = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    const ignoreLabels = ['主訴・所見', '処置・行為', 'キーワード', '下書き', '未承認',
      'シェーマ追加', '処方箋備考', '適応症追加', '心療内科', '木村友哉'];
    while (node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      // 右パネルの編集エリア（大体 left > 530, top > 100）
      if (rect.left < 530 || rect.top < 100 || rect.top > 800) continue;
      if (rect.width === 0 || rect.height === 0) continue;
      const t = node.textContent.trim();
      if (t.length > 2 && !ignoreLabels.some(l => t.includes(l))) {
        allText.push(t);
      }
    }
    // 右パネルに実質的なテキストがなければ空
    return allText.length === 0;
  });
}

/**
 * カルテタブの×ボタン（SVGパス M19 7.333...）をクリック
 */
async function clickTabCloseButton(page) {
  const pos = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button[data-variant="iconOnly"][data-size="sm"]');
    for (const btn of buttons) {
      const pathEl = btn.querySelector('svg path');
      if (!pathEl) continue;
      const d = pathEl.getAttribute('d') || '';
      if (d.startsWith('M19 7.333')) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // タブバーエリア（画面上部、top < 80）にあるもの
        if (rect.top > 80) continue;
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      }
    }
    return null;
  });

  if (!pos) throw new Error('カルテタブの×が見つかりません');
  console.log(`    → タブ×クリック: (${pos.x}, ${pos.y})`);
  await page.mouse.click(pos.x, pos.y);
}

/**
 * 確認ダイアログ（削除確認等）があればOK/削除ボタンをクリック
 */
async function handleConfirmDialog(page) {
  await page.waitForTimeout(300);
  const clicked = await page.evaluate(() => {
    // ダイアログ内の「削除」「OK」「はい」ボタンを探す
    const keywords = ['削除', 'OK', 'はい', '確認', 'Yes'];
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      if (keywords.some(kw => text.includes(kw))) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // モーダル/ダイアログ上のボタン（画面中央付近）
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        if (Math.abs(rect.left + rect.width / 2 - centerX) < 400 &&
            Math.abs(rect.top + rect.height / 2 - centerY) < 300) {
          btn.click();
          return text;
        }
      }
    }
    return null;
  });
  if (clicked) {
    console.log(`    → ダイアログ「${clicked}」クリック`);
    await page.waitForTimeout(500);
  }
}

/**
 * 複写ボタン（矢印アイコン）をクリック
 *
 * SVGパス "M15 18v-4.5H9A4.5..." の矢印ボタンが
 * 各セクション（主訴・所見、処置・行為）の横にある。
 * 下書きエントリ（1番目）のボタンをクリックすると
 * 前回カルテの内容がコピーされる。
 */
async function clickSectionCopyButton(page, sectionTitle) {
  const pos = await page.evaluate((title) => {
    // セクションタイトル（左パネル内）を探す
    const titleNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.trim() !== title) continue;
      const el = node.parentElement;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.left >= 530) continue; // 左パネルのみ
      titleNodes.push({ el, top: rect.top, left: rect.left });
    }

    // 各タイトルの近くにある複写ボタン（SVGパス M15 18v-4.5H9A4.5）を探す
    const matches = [];
    for (const tn of titleNodes) {
      // タイトルの親 → 兄弟要素から button[data-variant="iconOnly"] を探す
      const parent = tn.el.parentElement;
      if (!parent) continue;

      // 親の中でボタンを探す（直接の子や孫レベル）
      const buttons = parent.querySelectorAll('button[data-variant="iconOnly"]');
      for (const btn of buttons) {
        const pathEl = btn.querySelector('svg path');
        if (!pathEl) continue;
        const d = pathEl.getAttribute('d') || '';
        if (!d.startsWith('M15 18v-4.5H9')) continue;

        const bRect = btn.getBoundingClientRect();
        if (bRect.width === 0 || bRect.height === 0) continue;

        matches.push({
          x: Math.round(bRect.left + bRect.width / 2),
          y: Math.round(bRect.top + bRect.height / 2),
          top: tn.top
        });
        break;
      }
    }

    // 上から順にソート（下書き → 前回 → 前々回...）
    matches.sort((a, b) => a.top - b.top);

    // 1番目 = 下書きエントリの複写ボタン（前回からインポート）
    if (matches.length >= 1) return matches[0];
    return null;
  }, sectionTitle);

  if (!pos) throw new Error(`"${sectionTitle}" の複写ボタンが見つかりません`);

  console.log(`    → 複写ボタンクリック: (${pos.x}, ${pos.y})`);
  await page.mouse.click(pos.x, pos.y);
}

/**
 * ￥ボタンを見つけて Playwright のマウスクリックで押す
 */
async function clickYenButton(page) {
  const pos = await page.evaluate(() => {
    // ¥ アイコン: SVGパスに "M4.65" と "5.355" を含む
    const elements = document.querySelectorAll('button, span');
    for (const el of elements) {
      const paths = el.querySelectorAll('svg path');
      for (const p of paths) {
        const d = p.getAttribute('d') || '';
        if (d.includes('M4.65') && d.includes('5.355')) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          };
        }
      }
    }
    return null;
  });

  if (!pos) throw new Error('￥ボタンが見つかりません');

  // ￥ボタンが画面外（下）にある場合はスクロール
  const viewport = await page.viewportSize();
  if (viewport && pos.y > viewport.height) {
    await page.mouse.wheel(0, pos.y - viewport.height + 100);
    await page.waitForTimeout(300);
    // 再取得
    return clickYenButton(page);
  }

  console.log(`    → ￥クリック位置: (${pos.x}, ${pos.y})`);
  await page.mouse.click(pos.x, pos.y);
}
