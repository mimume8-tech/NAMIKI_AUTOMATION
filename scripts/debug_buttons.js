/**
 * カルテページのスクリーンショットを撮影 + ボタン位置を調査
 * Chrome がデバッグモードで起動済みの状態で実行:
 *   cd C:\NAMIKI_AUTOMATION
 *   node scripts/debug_buttons.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEBUG_PORT = 9222;

(async () => {
  console.log('Chrome に接続中...');
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  } catch {
    console.error('Chrome に接続できません。先に digikar_auto.js の Chrome 起動部分を実行してください。');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const allPages = context.pages();
  let page = null;
  for (const p of allPages) {
    if (p.url().includes('digikar.jp')) { page = p; break; }
  }
  if (!page) {
    page = allPages.find(p => !p.url().startsWith('chrome://')) || allPages[0];
  }
  console.log(`URL: ${page.url()}`);

  // 受付一覧なら最初の患者カルテへ遷移
  if (page.url().includes('/reception')) {
    console.log('受付一覧です。最初の患者カルテを開きます...');
    await page.waitForSelector('a[href*="/karte/patients/"]', { timeout: 15000 });
    await page.waitForTimeout(2000);
    const link = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/karte/patients/"][href*="visitId="]');
      return a ? a.getAttribute('href') : null;
    });
    if (!link) { console.error('リンクなし'); process.exit(1); }
    await page.goto(new URL(link, 'https://digikar.jp').href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
  }

  // スクリーンショット撮影
  const ssPath = path.join(__dirname, 'karte_screenshot.png');
  await page.screenshot({ path: ssPath, fullPage: false });
  console.log(`\nスクリーンショット保存: ${ssPath}`);

  // 全BUTTON要素の情報取得
  const buttons = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('button').forEach(btn => {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (rect.top < 0 || rect.top > window.innerHeight) return;

      const svgPaths = [];
      btn.querySelectorAll('svg path').forEach(p => {
        const d = p.getAttribute('d') || '';
        svgPaths.push(d.substring(0, 60));
      });

      results.push({
        tag: 'BUTTON',
        text: btn.textContent.trim().substring(0, 40),
        cls: (btn.className || '').toString().substring(0, 80),
        pos: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
        rect: { top: Math.round(rect.top), left: Math.round(rect.left), w: Math.round(rect.width), h: Math.round(rect.height) },
        variant: btn.getAttribute('data-variant') || '',
        title: btn.getAttribute('title') || '',
        ariaLabel: btn.getAttribute('aria-label') || '',
        svgPaths,
        disabled: btn.disabled
      });
    });
    return results;
  });

  console.log(`\n=== 全BUTTON要素: ${buttons.length} 個 ===\n`);
  for (const b of buttons) {
    const label = b.text || (b.svgPaths.length > 0 ? `[SVG: ${b.svgPaths[0].substring(0, 30)}...]` : '[empty]');
    const extra = [];
    if (b.variant) extra.push(`variant=${b.variant}`);
    if (b.title) extra.push(`title="${b.title}"`);
    if (b.ariaLabel) extra.push(`aria="${b.ariaLabel}"`);
    if (b.disabled) extra.push('DISABLED');
    console.log(`  center=(${b.pos.x}, ${b.pos.y}) ${b.rect.w}x${b.rect.h} "${label}" ${extra.join(' ')}`);
  }

  // セクション見出し付近の詳細
  console.log('\n=== セクション見出し周辺 ===\n');
  const sectionInfo = await page.evaluate(() => {
    const result = [];
    const targets = ['主訴・所見', '処置・行為'];
    for (const target of targets) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (!node.textContent.trim().includes(target)) continue;
        const el = node.parentElement;
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        // このテキスト要素の近く（同じ行、±50px）にあるBUTTONを全て取得
        const nearButtons = [];
        document.querySelectorAll('button').forEach(btn => {
          const bRect = btn.getBoundingClientRect();
          if (bRect.width === 0 || bRect.height === 0) return;
          if (Math.abs(bRect.top - rect.top) > 50) return;
          if (bRect.left - rect.left > 300 || bRect.left < rect.left - 50) return;

          const svgPaths = [];
          btn.querySelectorAll('svg path').forEach(p => {
            svgPaths.push((p.getAttribute('d') || '').substring(0, 60));
          });

          nearButtons.push({
            center: { x: Math.round(bRect.left + bRect.width / 2), y: Math.round(bRect.top + bRect.height / 2) },
            size: { w: Math.round(bRect.width), h: Math.round(bRect.height) },
            text: btn.textContent.trim().substring(0, 30),
            variant: btn.getAttribute('data-variant') || '',
            svgPaths,
            disabled: btn.disabled
          });
        });

        result.push({
          target,
          pos: { top: Math.round(rect.top), left: Math.round(rect.left) },
          nearButtons
        });
      }
    }
    return result;
  });

  for (const s of sectionInfo) {
    console.log(`"${s.target}" at (${s.pos.top}, ${s.pos.left}):`);
    if (s.nearButtons.length === 0) {
      console.log('  近くにボタンなし');
    }
    for (const b of s.nearButtons) {
      const label = b.text || (b.svgPaths.length > 0 ? `[SVG]` : '[empty]');
      console.log(`  → BUTTON center=(${b.center.x}, ${b.center.y}) ${b.size.w}x${b.size.h} "${label}" variant=${b.variant} svg=${b.svgPaths.length}個`);
      for (const sp of b.svgPaths) {
        console.log(`      path: ${sp}`);
      }
    }
  }

  const outFile = path.join(__dirname, 'debug_buttons_output.json');
  fs.writeFileSync(outFile, JSON.stringify({ buttons, sectionInfo }, null, 2), 'utf-8');
  console.log(`\n詳細: ${outFile}`);
  console.log(`スクリーンショット: ${ssPath}`);
  console.log('\n★ スクリーンショットを確認して、どのボタンが「前回カルテからのコピー」かを教えてください');
  try { await browser.close(); } catch {}
})();
