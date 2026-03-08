// ==UserScript==
// @name         ADHD適正流通 処方登録 半自動化
// @namespace    https://adhd-vcdcs.jp/
// @version      4.0.0
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

  // submit ボタンを確実にクリック（formaction対応）
  function submitClick(btn) {
    if (!btn) return;
    btn.scrollIntoView({ block: 'center' });
    log(`submitClick: tag=${btn.tagName} type=${btn.type} formaction=${btn.getAttribute('formaction')}`);

    // 方法1: form.requestSubmit(btn) — formaction を正しく処理する
    const form = btn.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit(btn);
        log('requestSubmit 成功');
        return;
      } catch (e) {
        log('requestSubmit 失敗:', e);
      }
    }

    // 方法2: MouseEvent をディスパッチ
    btn.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window
    }));
    log('MouseEvent dispatch 完了');
  }

  // ── 前回処方データ(sessionStorage) ─────────────
  const SKEY = 'adhd_rx_prev';
  function savePrev(d) { sessionStorage.setItem(SKEY, JSON.stringify(d)); }
  function loadPrev() {
    try { return JSON.parse(sessionStorage.getItem(SKEY)); }
    catch { return null; }
  }

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

    const inputs = [...form.querySelectorAll('input')];
    inputs.forEach((inp, i) => log(`input[${i}] type=${inp.type} name=${inp.name}`));

    const idF = inputs.find(i => i.type === 'text');
    const pwF = inputs.find(i => i.type === 'password');
    if (!idF || !pwF) { show('ERROR: ID/PW not found', RED); return; }

    setVal(idF, LOGIN_ID);
    await sleep(200);
    setVal(pwF, LOGIN_PW);
    await sleep(200);
    if (!idF.value || !pwF.value) { show('ERROR: value set failed', RED); return; }

    const loginBtn =
      form.querySelector('button[formaction*="login"]') ||
      form.querySelector('button[type="submit"]') ||
      form.querySelector('input[type="submit"]');
    if (!loginBtn) { show('ERROR: Login btn not found', RED); return; }

    show('ログイン送信中...', BLUE);
    submitClick(loginBtn);
  }

  // ══════════════════════════════════════════════
  // 2. TOPページ → 処方登録
  // ══════════════════════════════════════════════
  async function doTop() {
    show('TOP → 処方登録へ...', BLUE);
    await sleep(800);

    const btn = document.querySelector('button[formaction*="prescription_registration"]');
    if (btn) { submitClick(btn); show('処方登録クリック', GREEN); return; }

    for (const a of document.querySelectorAll('a')) {
      if (a.textContent.includes('処方登録') || a.href?.includes('prescription_registration')) {
        a.click(); show('処方登録リンク', GREEN); return;
      }
    }
    for (const b of document.querySelectorAll('button')) {
      if (b.textContent.includes('処方登録')) { submitClick(b); show('処方登録クリック', GREEN); return; }
    }
    show('処方登録ボタンが見つかりません', RED);
  }

  // ══════════════════════════════════════════════
  // 3. 患者検索 → 自動選択
  // ══════════════════════════════════════════════
  async function doSearch() {
    show('選択ボタンを待機中...', BLUE);

    // ボタン出現まで最大15秒ポーリング
    let btns = [];
    for (let i = 0; i < 30; i++) {
      await sleep(500);

      // 3つのセレクタで探す
      btns = [...document.querySelectorAll('#searchTable > tbody > tr > td:nth-child(1) > button')];
      if (!btns.length) btns = [...document.querySelectorAll('button[name="patId"]')];
      if (!btns.length) btns = [...document.querySelectorAll('button[formaction*="detail"]')];

      if (btns.length > 0) {
        log(`ポーリング${i+1}回目: ${btns.length}個発見`);
        break;
      }
    }

    btns.forEach((b, i) => log(`btn[${i}] formaction=${b.getAttribute('formaction')} value=${b.value}`));

    if (btns.length === 1) {
      show('患者を自動選択中...', BLUE);
      await sleep(300);
      submitClick(btns[0]);
      show('選択完了', GREEN);
    } else if (btns.length > 1) {
      show(`${btns.length}件: 患者を選択してください`, ORANGE); fade();
    } else {
      show('患者IDを入力して検索してください', ORANGE); fade();
    }
  }

  // ══════════════════════════════════════════════
  // 4. 患者詳細 → 前回処方を全て保存 → 処方入力
  // ══════════════════════════════════════════════
  async function doDetail() {
    show('患者詳細 → 処方データ取得中...', BLUE);
    await sleep(800);

    // 前回処方を全行抽出（コンサータ以外も含め薬剤名+日分のペアを保存）
    const allPrescriptions = [];
    for (const row of document.querySelectorAll('table tr')) {
      const txt = row.textContent || '';
      // 「日分」を含む行を処方データとして取得
      const daysMatch = txt.match(/(\d+)\s*日分/);
      if (!daysMatch) continue;

      const days = daysMatch[1];
      // 薬剤名パターン: コンサータ、ビバンセ等
      const drugMatch = txt.match(/(コンサータ|ビバンセ|concerta|vyvanse)/i);
      // mg詳細パターン: "72mg(18mg×1錠・27mg×2錠)"
      const mgDetail = txt.match(/(\d+mg\([^)]+\))/);
      // シンプルmg: "72mg"
      const simpleMg = txt.match(/(\d+)\s*mg/i);

      allPrescriptions.push({
        drug: drugMatch?.[1] || null,
        mgDetail: mgDetail?.[1] || null,
        simpleMg: simpleMg?.[1] || null,
        days: days,
        raw: txt.trim().slice(0, 300),
      });
    }

    log(`処方履歴 ${allPrescriptions.length}件:`, allPrescriptions);

    if (allPrescriptions.length > 0) {
      savePrev(allPrescriptions);
      log('保存完了');
    } else {
      log('処方履歴が見つかりませんでした');
    }

    // 処方入力ボタン
    let btn = document.querySelector('button[formaction*="select_facility"]');
    if (!btn) {
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.includes('処方入力') || b.textContent.includes('処方登録')) { btn = b; break; }
      }
    }
    if (btn) { await sleep(300); submitClick(btn); show('処方入力クリック', GREEN); }
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
    if (btn) { submitClick(btn); show('施設選択完了', GREEN); }
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

    // ── 日分を入力 ──
    await sleep(500);
    const prevList = loadPrev(); // 配列で保存されている
    log('前回処方データ:', prevList);

    if (!prevList || !Array.isArray(prevList) || prevList.length === 0) {
      show(dateSet ? '処方日設定済。日分は手動入力してください' : '手動で入力してください', ORANGE);
      fade();
      return;
    }

    // ページ内の全inputと周辺テキストをログ出力（デバッグ用）
    const allInputs = document.querySelectorAll('input');
    log(`ページ内input数: ${allInputs.length}`);
    allInputs.forEach((inp, i) => {
      if (['hidden','submit','button'].includes(inp.type)) return;
      const ctx = inp.closest('tr, td, div')?.textContent?.slice(0, 100) || '';
      log(`  input[${i}] type=${inp.type} name=${inp.name} ctx="${ctx.replace(/\s+/g,' ').trim()}"`);
    });

    // 処方登録画面の各行に対して、前回処方から一致するものを探して日分を入力
    let filledCount = 0;
    const rows = document.querySelectorAll('tr');
    for (const row of rows) {
      const rowText = row.textContent || '';
      // この行にinputがあるか？
      const rowInputs = row.querySelectorAll('input[type="text"], input[type="number"]');
      if (rowInputs.length === 0) continue;

      // 行のテキストに「日分」が含まれるinputを探す
      let dayInput = null;
      for (const inp of rowInputs) {
        const after = (inp.nextSibling?.textContent || '') + (inp.nextElementSibling?.textContent || '');
        if (/日分/.test(after)) { dayInput = inp; break; }
      }
      // 行全体のコンテキストでも探す
      if (!dayInput && /日分/.test(rowText)) {
        for (const inp of rowInputs) {
          // 既に値が入っているものは除外（処方日等）
          if (inp.value && inp.value.includes('/')) continue;
          dayInput = inp;
          break;
        }
      }
      if (!dayInput) continue;

      // この行に対応する前回処方を探す
      for (const prev of prevList) {
        let matched = false;

        // mgDetailでマッチ（例: "72mg(18mg×1錠・27mg×2錠)"）
        if (prev.mgDetail && rowText.includes(prev.mgDetail)) matched = true;
        // 薬剤名でマッチ
        if (!matched && prev.drug && rowText.includes(prev.drug)) matched = true;
        // simpleMgでマッチ
        if (!matched && prev.simpleMg) {
          const re = new RegExp(prev.simpleMg + '\\s*mg', 'i');
          if (re.test(rowText)) matched = true;
        }

        if (matched && prev.days) {
          setVal(dayInput, prev.days);
          log(`日分入力: ${prev.days}日分 (${prev.drug || prev.mgDetail || 'unknown'})`);
          filledCount++;
          break; // この行は完了、次の行へ
        }
      }
    }

    if (filledCount > 0) {
      show(`処方日+日分(${filledCount}件)を自動入力しました`, GREEN);
    } else {
      show('処方日設定済。日分は手動で入力してください', ORANGE);
    }
    fade();
  }

  // ══════════════════════════════════════════════
  // メインルーター
  // ══════════════════════════════════════════════
  async function main() {
    await sleep(300);
    log(`path="${path}" href="${location.href}"`);

    if (path.includes('/login')) {
      log('→ ログイン'); await doLogin();
    } else if (path === '/top' || path === '/top/') {
      log('→ TOP'); await doTop();
    } else if (path.includes('/prescription_registration/index')) {
      log('→ 患者検索'); await doSearch();
    } else if (path.includes('/prescription_registration/detail')) {
      log('→ 患者詳細'); await doDetail();
    } else if (path.includes('/prescription_registration/select_facility')) {
      log('→ 施設確認'); await doFacility();
    } else if (path.includes('/prescription_registration/create')) {
      log('→ 処方登録'); await doCreate();
    } else {
      log('対象外:', path);
    }
  }

  main();
})();
