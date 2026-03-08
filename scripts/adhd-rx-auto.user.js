// ==UserScript==
// @name         ADHD適正流通 処方登録 半自動化
// @namespace    https://adhd-vcdcs.jp/
// @version      3.0.0
// @description  Login→TOP→患者検索→患者詳細→施設確認→処方登録を半自動化
// @match        https://www.adhd-vcdcs.jp/*
// @match        https://adhd-vcdcs.jp/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
  'use strict';

  if (window.__ADHD_RX_AUTO__) return;
  window.__ADHD_RX_AUTO__ = true;

  const LOG = '[ADHD-RX]';
  const log = (...a) => console.log(LOG, ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── 認証情報 ───────────────────────────────────
  const LOGIN_ID = 'adhd491995';
  const LOGIN_PW = 'Ykimura1183';

  // ── ステータスバッジ ──────────────────────────
  let badge = null;
  function show(msg, bg) {
    if (!badge) {
      badge = document.createElement('div');
      Object.assign(badge.style, {
        position: 'fixed', bottom: '12px', right: '12px',
        padding: '8px 14px', color: '#fff', fontSize: '13px',
        fontWeight: 'bold', borderRadius: '8px', zIndex: '2147483000',
        fontFamily: '"Yu Gothic UI","Meiryo",sans-serif',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)', maxWidth: '500px',
      });
      document.body.appendChild(badge);
    }
    badge.textContent = msg;
    badge.style.opacity = '1';
    badge.style.background = bg || 'rgba(25,118,210,0.92)';
    log(msg);
  }
  function fade() { if (badge) setTimeout(() => { badge.style.opacity = '0.4'; }, 4000); }
  const BLUE = 'rgba(25,118,210,0.92)';
  const GREEN = 'rgba(46,125,50,0.92)';
  const RED = 'rgba(211,47,47,0.92)';
  const ORANGE = 'rgba(255,152,0,0.92)';

  // ── ユーティリティ ─────────────────────────────
  function setVal(input, value) {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function click(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }

  // ── 前回処方データ(sessionStorage) ─────────────
  const SKEY = 'adhd_rx_prev';
  function savePrev(d) { sessionStorage.setItem(SKEY, JSON.stringify(d)); }
  function loadPrev() {
    try { const r = sessionStorage.getItem(SKEY); return r ? JSON.parse(r) : null; }
    catch { return null; }
  }

  // ── ページ判定 ─────────────────────────────────
  const path = location.pathname;
  log('path:', path);

  // ══════════════════════════════════════════════
  // 1. ログイン
  // ══════════════════════════════════════════════
  async function doLogin() {
    show('ログイン中...', BLUE);
    await sleep(1500);

    const form = document.querySelector('form');
    if (!form) { show('ERROR: form not found', RED); return; }

    // input一覧をログ
    const inputs = [...form.querySelectorAll('input')];
    inputs.forEach((inp, i) => log(`input[${i}] type=${inp.type} name=${inp.name} id=${inp.id}`));

    const idF = inputs.find(i => i.type === 'text');
    const pwF = inputs.find(i => i.type === 'password');
    if (!idF || !pwF) { show('ERROR: ID/PW field not found', RED); return; }

    setVal(idF, LOGIN_ID);
    await sleep(200);
    setVal(pwF, LOGIN_PW);
    await sleep(200);

    log(`ID="${idF.value}" PW_len=${pwF.value.length}`);
    if (!idF.value || !pwF.value) { show('ERROR: value set failed', RED); return; }

    // ボタン探索
    const btns = [...form.querySelectorAll('button, input[type="submit"]')];
    btns.forEach((b, i) => log(`btn[${i}] tag=${b.tagName} type=${b.type} text="${(b.textContent||b.value||'').trim()}" formaction=${b.getAttribute('formaction')}`));

    const loginBtn =
      btns.find(b => b.getAttribute('formaction')?.includes('login')) ||
      btns.find(b => b.type === 'submit') ||
      btns.find(b => /login/i.test(b.textContent || b.value || ''));

    if (!loginBtn) { show('ERROR: Login button not found', RED); return; }

    log('Clicking:', loginBtn.textContent?.trim());
    show('ログイン送信中...', BLUE);
    loginBtn.click();
  }

  // ══════════════════════════════════════════════
  // 2. TOPページ → 処方登録
  // ══════════════════════════════════════════════
  async function doTop() {
    show('TOP → 処方登録へ...', BLUE);
    await sleep(800);

    // formaction で探す
    let btn = document.querySelector('button[formaction*="prescription_registration"]');
    if (btn) { click(btn); show('処方登録クリック', GREEN); return; }

    // aタグで探す
    for (const a of document.querySelectorAll('a')) {
      if (a.textContent.includes('処方登録') || a.href?.includes('prescription_registration')) {
        a.click(); show('処方登録リンク', GREEN); return;
      }
    }

    // テキストで探す
    for (const b of document.querySelectorAll('button')) {
      if (b.textContent.includes('処方登録')) { click(b); show('処方登録クリック', GREEN); return; }
    }

    show('処方登録ボタンが見つかりません', RED);
  }

  // ══════════════════════════════════════════════
  // 3. 患者検索 (手動入力→検索→自動選択)
  // ══════════════════════════════════════════════
  async function doSearch() {
    show('選択ボタンを待機中...', BLUE);

    // ボタンが出現するまで最大15秒ポーリング（0.5秒間隔×30回）
    let btns = [];
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      btns = [
        ...document.querySelectorAll('#searchTable > tbody > tr > td:nth-child(1) > button'),
      ];
      if (btns.length === 0) btns = [...document.querySelectorAll('button[name="patId"]')];
      if (btns.length === 0) btns = [...document.querySelectorAll('button[formaction*="detail"]')];

      if (btns.length > 0) {
        log(`ポーリング${i+1}回目で選択ボタン発見: ${btns.length}個`);
        break;
      }
    }

    btns.forEach((b, i) => log(`  [${i}] formaction=${b.getAttribute('formaction')} value=${b.value}`));

    if (btns.length === 1) {
      show('患者を自動選択中...', BLUE);
      await sleep(300);
      click(btns[0]);
      show('選択完了', GREEN);
    } else if (btns.length > 1) {
      show(`${btns.length}件: 患者を選択してください`, ORANGE);
      fade();
    } else {
      show('患者IDを入力して検索してください', ORANGE);
      fade();
    }
  }

  // ══════════════════════════════════════════════
  // 4. 患者詳細 → 前回処方を保存 → 処方入力クリック
  // ══════════════════════════════════════════════
  async function doDetail() {
    show('患者詳細 → 処方データ取得中...', BLUE);
    await sleep(800);

    // 前回処方を抽出
    let prevData = null;
    for (const row of document.querySelectorAll('table tr')) {
      const txt = row.textContent || '';
      if (/コンサータ|concerta/i.test(txt)) {
        const mg = txt.match(/(\d+mg\([^)]+\))/);
        const days = txt.match(/(\d+)\s*日分/);
        if (mg || days) {
          prevData = { mgPattern: mg?.[1] || null, days: days?.[1] || null, raw: txt.trim().slice(0, 200) };
          log('前回処方:', prevData);
        }
      }
    }
    if (!prevData) {
      // テキストからも探す
      for (const line of (document.body.innerText || '').split('\n')) {
        if (/コンサータ|concerta/i.test(line)) {
          const mg = line.match(/(\d+mg\([^)]+\))/);
          const days = line.match(/(\d+)\s*日分/);
          const smg = line.match(/(\d+)\s*mg/i);
          if (mg || days || smg) {
            prevData = { mgPattern: mg?.[1] || null, days: days?.[1] || null, simpleMg: smg?.[1] || null, raw: line.slice(0, 200) };
            log('前回処方(text):', prevData);
            break;
          }
        }
      }
    }
    if (prevData) { savePrev(prevData); log('保存:', prevData); }
    else { log('前回処方なし'); }

    // 処方入力ボタン
    let btn = document.querySelector('button[formaction*="select_facility"]');
    if (!btn) {
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.includes('処方入力') || b.textContent.includes('処方登録')) { btn = b; break; }
      }
    }
    if (btn) { await sleep(300); click(btn); show('処方入力クリック', GREEN); }
    else { show('処方入力ボタンが見つかりません', RED); }
  }

  // ══════════════════════════════════════════════
  // 5. 施設確認 → 選択
  // ══════════════════════════════════════════════
  async function doFacility() {
    show('施設確認 → 自動選択中...', BLUE);
    await sleep(800);

    let btn = document.querySelector('button[formaction*="prescription_registration/create"]');
    if (!btn) {
      for (const b of document.querySelectorAll('button')) {
        const t = b.textContent.trim();
        if (t.includes('選択') && !t.includes('戻')) { btn = b; break; }
      }
    }
    if (btn) { click(btn); show('施設選択完了', GREEN); }
    else { show('選択ボタンが見つかりません', RED); }
  }

  // ══════════════════════════════════════════════
  // 6. 処方登録 → 処方日 + 日分入力
  // ══════════════════════════════════════════════
  async function doCreate() {
    show('処方登録 → 自動入力中...', BLUE);
    await sleep(1000);

    // ── 処方日を入力 ──
    const today = new Date();
    const todaySlash = `${today.getFullYear()}/${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`;
    const todayDash  = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    let dateSet = false;
    for (const inp of document.querySelectorAll('input[type="date"], input[type="text"]')) {
      const ctx = inp.closest('tr, div, td, label')?.textContent || '';
      if (/処方日/.test(ctx)) {
        setVal(inp, inp.type === 'date' ? todayDash : todaySlash);
        log('処方日設定:', todaySlash);
        dateSet = true;
        break;
      }
    }
    if (!dateSet) {
      const fb = document.querySelector('input[name*="date"], input[name*="prescri"]');
      if (fb) { setVal(fb, todaySlash); dateSet = true; }
    }

    // ── 日分を入力 ──
    await sleep(500);
    const prev = loadPrev();
    log('前回処方データ:', prev);

    if (!prev || !prev.days) {
      show(dateSet ? '処方日設定済。日分は手動で入力してください' : '手動で入力してください', ORANGE);
      fade();
      return;
    }

    // ページ内の全inputをスキャンして「日分」テキストの近くにあるものを探す
    const dayFields = [];
    for (const inp of document.querySelectorAll('input')) {
      if (['hidden','submit','button','checkbox','radio','date','password'].includes(inp.type)) continue;

      // 方法A: 親要素のテキストに「日分」
      const parent = inp.closest('tr, td, div, li, fieldset');
      const pText = parent?.textContent || '';
      if (/日分/.test(pText) && !/処方日/.test(pText)) {
        dayFields.push({ input: inp, ctx: pText });
        continue;
      }

      // 方法B: 直後のテキストに「日分」
      const after = (inp.nextSibling?.textContent || '') + (inp.nextElementSibling?.textContent || '');
      if (/日分/.test(after)) {
        dayFields.push({ input: inp, ctx: pText + after });
      }
    }

    log(`日分フィールド数: ${dayFields.length}`);
    dayFields.forEach((f, i) => log(`  [${i}] name=${f.input.name} ctx="${f.ctx.slice(0,80)}"`));

    if (dayFields.length === 1) {
      setVal(dayFields[0].input, prev.days);
      show(`処方日+日分(${prev.days})を自動入力しました`, GREEN);
      fade();
      return;
    }

    if (dayFields.length > 1) {
      // mgパターンまたは「コンサータ」でマッチ
      let filled = false;
      for (const f of dayFields) {
        if (
          (prev.mgPattern && f.ctx.includes(prev.mgPattern)) ||
          (prev.simpleMg && new RegExp(prev.simpleMg + '\\s*mg', 'i').test(f.ctx)) ||
          /コンサータ|concerta/i.test(f.ctx)
        ) {
          setVal(f.input, prev.days);
          log(`日分入力: ${prev.days}`);
          filled = true;
          break;
        }
      }
      // マッチしなければ全部に入力
      if (!filled) {
        for (const f of dayFields) setVal(f.input, prev.days);
      }
      show(`処方日+日分(${prev.days})を自動入力しました`, GREEN);
      fade();
      return;
    }

    // name属性フォールバック
    const nbInputs = document.querySelectorAll('input[name*="day"], input[name*="nichi"], input[name*="nissu"]');
    if (nbInputs.length > 0) {
      for (const inp of nbInputs) setVal(inp, prev.days);
      show(`処方日+日分(${prev.days})を自動入力しました`, GREEN);
      fade();
      return;
    }

    show(`処方日設定済。日分(${prev.days})は手動で入力してください`, ORANGE);
    fade();
  }

  // ══════════════════════════════════════════════
  // メインルーター
  // ══════════════════════════════════════════════
  async function main() {
    // DOMが確実に使えるよう少し待つ
    await sleep(300);

    log(`path="${path}" href="${location.href}"`);

    if (path.includes('/login')) {
      log('→ ログインページ');
      await doLogin();
    } else if (path === '/top' || path === '/top/') {
      log('→ TOPページ');
      await doTop();
    } else if (path.includes('/prescription_registration/index')) {
      log('→ 患者検索ページ');
      await doSearch();
    } else if (path.includes('/prescription_registration/detail')) {
      log('→ 患者詳細ページ');
      await doDetail();
    } else if (path.includes('/prescription_registration/select_facility')) {
      log('→ 施設確認ページ');
      await doFacility();
    } else if (path.includes('/prescription_registration/create')) {
      log('→ 処方登録ページ');
      await doCreate();
    } else {
      log('対象外:', path);
    }
  }

  main();
})();
