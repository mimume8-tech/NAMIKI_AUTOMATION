/**
 * デジカル レセプト保留患者の「含める」一括変更スクリプト
 *
 * 使い方:
 *   1. Chrome を完全に閉じる（タスクトレイも）
 *   2. node scripts/digikar-receipt-include.js
 *   3. 証明書ダイアログが出たら手動で OK をクリック
 *   4. ログインページが出たら手動でログイン
 *   5. 受付画面が表示されたら Enter を押す → 自動処理開始
 */

const { chromium } = require('playwright');
const XLSX = require('xlsx');
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const { startCertificateDialogHelper } = require('./certificate_dialog_helper');

// ===== 設定 =====
const EXCEL_PATH = 'C:/Users/ykimu/Desktop/②レセ保留管理(月遅れおよび返戻再請求予定).xlsx';
const SHEET_NAME = 'R8.2月ﾚｾﾌﾟﾄ含める';
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_USER_DATA = 'C:/Users/ykimu/AppData/Local/Google/Chrome/User Data';
const DEBUG_PORT = 9222;

function prompt(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(msg, () => { rl.close(); resolve(); }));
}

(async () => {
  // ===== 1. Excel読み込み =====
  console.log('Excel読み込み中...');
  const workbook = XLSX.readFile(EXCEL_PATH);

  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) {
    console.error(`シート "${SHEET_NAME}" が見つかりません。`);
    console.log('利用可能なシート:', workbook.SheetNames);
    process.exit(1);
  }

  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const targetPatientIds = new Set();
  const targetRows = [];

  for (let i = 3; i < data.length; i++) {
    const row = data[i];
    if (row && row[1] != null) {
      const patientNo = String(Math.floor(Number(row[1])));
      targetPatientIds.add(patientNo);
      targetRows.push({ patientNo, name: row[2] || '', rowNum: i + 1 });
    }
  }

  console.log(`Excel: ${targetRows.length} 件 (ユニーク ${targetPatientIds.size} 名)`);
  console.log('対象患者番号:', [...targetPatientIds].sort((a, b) => Number(a) - Number(b)).join(', '));

  // ===== 2. Chrome をデバッグポート付きで起動 =====
  const today = new Date();
  const dateStr = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('');
  const receptionUrl = `https://digikar.jp/reception/${dateStr}`;

  // 既存の Chrome を終了（同じプロファイルで2重起動できないため）
  console.log('\n既存の Chrome を終了中...');
  try { execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore' }); } catch {}
  // 終了を待つ
  await new Promise(r => setTimeout(r, 2000));

  console.log(`Chrome を起動します（デバッグポート: ${DEBUG_PORT}）...`);
  // Windows のパスにスペースが含まれるため shell: true + 引用符で起動
  startCertificateDialogHelper({ timeoutSeconds: 60, log: console.log });
  const child = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      '--disable-save-password-bubble',
      '--disable-password-generation',
      `--user-data-dir=${CHROME_USER_DATA}`,
      '--profile-directory=Default',
      receptionUrl,
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  // Chrome 起動待ち
  console.log('Chrome 起動待機中...');
  let connected = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) { connected = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!connected) {
    console.error('Chrome に接続できません。');
    console.error('手動で確認: ブラウザで http://127.0.0.1:9222/json/version を開いてみてください。');
    process.exit(1);
  }

  console.log('Chrome 起動OK。');
  console.log('');
  console.log('=== 手動操作が必要です ===');
  console.log('1. 証明書ダイアログ → OK をクリック');
  console.log('2. ログインページ → ログインボタンをクリック');
  console.log(`3. 受付画面 (${receptionUrl}) が表示されたら...`);
  await prompt('\n>>> 受付画面が表示されたら Enter を押してください: ');

  // ===== 3. Playwright で CDP 接続 =====
  console.log('\nPlaywright 接続中...');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();

  // 受付画面のタブを見つける
  let page = pages.find(p => p.url().includes('/reception/'));
  if (!page) {
    // 見つからない場合は最初のページを使う
    page = pages[0];
    console.log(`受付画面タブが見つからず、現在のタブを使用: ${page.url()}`);
    await page.goto(receptionUrl, { waitUntil: 'networkidle', timeout: 30000 });
  }
  console.log(`接続OK: ${page.url()}`);

  // ===== 4. レセプト作成ボタンをクリック =====
  console.log('\nレセプト作成ボタンを探しています...');
  const receiptButton = page.locator('button[data-variant="iconOnly"]').filter({
    has: page.locator('svg path[d*="M18 13a4.49"]'),
  });
  await receiptButton.waitFor({ state: 'visible', timeout: 15000 });
  await receiptButton.click();
  console.log('レセプト作成ボタンをクリックしました。');

  // ===== 5. 月遅れテーブル待機 =====
  console.log('モーダル読み込み待機中...');
  const table = page.locator('table').filter({
    has: page.locator('select.form-control'),
  });
  await table.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(2000);

  // ===== 6. テーブル行を処理 =====
  const rows = table.locator('tbody tr');
  const rowCount = await rows.count();
  console.log(`\n月遅れテーブル: ${rowCount} 行`);

  let changedCount = 0;
  const foundPatientIds = new Set();

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const cells = row.locator('td');
    const patientId = (await cells.nth(0).textContent()).trim();

    if (targetPatientIds.has(patientId)) {
      foundPatientIds.add(patientId);
      const patientName = (await cells.nth(1).textContent()).trim();
      const visitDate = (await cells.nth(2).textContent()).trim();
      const select = row.locator('select.form-control');

      if ((await select.count()) === 0) continue;

      const currentValue = await select.inputValue();
      if (currentValue === 'pending') {
        await row.scrollIntoViewIfNeeded();
        await select.selectOption('claim_all');
        changedCount++;
        console.log(`  [変更] ${patientId} ${patientName} (${visitDate})`);
        await page.waitForTimeout(500);
      } else {
        console.log(`  [skip] ${patientId} ${patientName} (${visitDate}) - 既に含める`);
      }
    }
  }

  // ===== 7. 結果レポート =====
  console.log(`\n${'='.repeat(50)}`);
  console.log(`変更完了: ${changedCount} 件`);
  console.log(`照合: Excel ${targetPatientIds.size} 名 → デジカル ${foundPatientIds.size} 名 一致`);

  const notFound = [...targetPatientIds].filter(id => !foundPatientIds.has(id));
  if (notFound.length > 0) {
    console.log(`\n*** デジカルに見つからなかった患者番号 (${notFound.length} 名) ***`);
    notFound.forEach(id => {
      const r = targetRows.find(x => x.patientNo === id);
      console.log(`  ${id} (${r ? r.name : '?'})`);
    });
  }

  // ===== 8. 手動確認待ち =====
  console.log('\n内容を確認し「点検用を作成」を手動クリックしてください。');
  await prompt('>>> 終了するには Enter を押してください: ');
  browser.disconnect();
  console.log('完了。Chrome は開いたままです。');
})();
