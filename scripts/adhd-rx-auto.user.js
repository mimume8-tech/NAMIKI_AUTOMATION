// ==UserScript==
// @name         ADHD適正流通 処方登録 半自動化
// @namespace    https://adhd-vcdcs.jp/
// @version      1.0.0
// @description  Login→TOP→患者検索→患者詳細→施設確認→処方登録を半自動化
// @match        https://www.adhd-vcdcs.jp/*
// @match        https://adhd-vcdcs.jp/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // 多重起動防止
  if (window.__ADHD_RX_AUTO__) return;
  window.__ADHD_RX_AUTO__ = true;

  const LOG_PREFIX = '[ADHD-RX]';
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── ステータスUI ──────────────────────────────
  function createStatusBadge() {
    const el = document.createElement('div');
    el.id = 'adhd-rx-auto-status';
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '12px',
      right: '12px',
      padding: '8px 14px',
      background: 'rgba(25,118,210,0.92)',
      color: '#fff',
      fontSize: '13px',
      fontWeight: 'bold',
      borderRadius: '8px',
      zIndex: '2147483000',
      fontFamily: '"Yu Gothic UI","Meiryo",sans-serif',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      transition: 'opacity 0.3s',
      maxWidth: '400px',
    });
    document.body.appendChild(el);
    return el;
  }

  let statusEl = null;
  function setStatus(msg, color) {
    if (!statusEl) statusEl = createStatusBadge();
    statusEl.textContent = msg;
    if (color) statusEl.style.background = color;
    log(msg);
  }

  function fadeStatus() {
    if (statusEl) {
      setTimeout(() => { statusEl.style.opacity = '0.4'; }, 3000);
    }
  }

  // ── ユーティリティ ─────────────────────────────
  function waitForElement(selector, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`waitForElement timeout: ${selector}`));
      }, timeoutMs);
    });
  }

  function clickButton(btn) {
    if (!btn) return false;
    btn.scrollIntoView({ block: 'center', behavior: 'auto' });
    btn.click();
    return true;
  }

  function getTodayStr() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd}`;
  }

  function setInputValue(input, value) {
    const proto = input.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ── 前回処方データの保存/取得 ──────────────────
  const STORAGE_KEY = 'adhd_rx_prev_prescription';

  function savePrevPrescription(data) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function loadPrevPrescription() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // ── ページ判定 ─────────────────────────────────
  const path = location.pathname;
  const url = location.href;

  const isLoginPage = path.includes('/login');
  const isTopPage = path === '/top' || path === '/top/';
  const isPatientSearchPage = path.includes('/prescription_registration/index');
  const isPatientDetailPage = path.includes('/prescription_registration/detail');
  const isSelectFacilityPage = path.includes('/prescription_registration/select_facility');
  const isCreatePage = path.includes('/prescription_registration/create');

  // ── ログイン認証情報 ────────────────────────────
  const LOGIN_ID = 'adhd491995';
  const LOGIN_PW = 'Ykimura1183';

  // ── フィールドに値を直接セットする ─────────────
  function forceSetField(field, value) {
    field.focus();
    field.value = '';
    // ネイティブsetterで確実にセット
    const proto = HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(field, value);
    } else {
      field.value = value;
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ══════════════════════════════════════════════
  // 1. ログインページ → ID/PW入力 → Loginクリック
  // ══════════════════════════════════════════════
  async function handleLoginPage() {
    setStatus('ログイン中...', 'rgba(25,118,210,0.92)');
    await sleep(1000);

    const form = document.querySelector('form');
    if (!form) {
      setStatus('フォームが見つかりません', 'rgba(211,47,47,0.92)');
      return;
    }

    const idField = form.querySelector('input[type="text"]');
    const pwField = form.querySelector('input[type="password"]');

    if (!idField || !pwField) {
      setStatus('ID/PWフィールドが見つかりません', 'rgba(211,47,47,0.92)');
      return;
    }

    // スクリプトから直接値をセット（オートフィルに頼らない）
    forceSetField(idField, LOGIN_ID);
    await sleep(200);
    forceSetField(pwField, LOGIN_PW);
    await sleep(200);

    log(`ID: "${idField.value}", PW: ${'*'.repeat(pwField.value.length)}`);

    const loginBtn = form.querySelector(
      'button[formaction*="login/login"], ' +
      'button.btn-adhd[type="submit"]'
    );

    if (!loginBtn) {
      setStatus('Loginボタンが見つかりません', 'rgba(211,47,47,0.92)');
      return;
    }

    // requestSubmitでsubmitイベントハンドラも発火させる
    if (typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit(loginBtn);
      } catch {
        loginBtn.click();
      }
    } else {
      loginBtn.click();
    }
    setStatus('ログイン送信完了', 'rgba(46,125,50,0.92)');
  }

  // ══════════════════════════════════════════════
  // 2. TOPページ → 処方登録ボタンをクリック
  // ══════════════════════════════════════════════
  async function handleTopPage() {
    setStatus('TOP画面 → 処方登録へ移動中...', 'rgba(25,118,210,0.92)');
    await sleep(800);

    // 処方登録ボタンを探す
    const btn = document.querySelector(
      'button[formaction*="prescription_registration/index"]'
    );

    if (btn) {
      clickButton(btn);
      setStatus('処方登録クリック完了', 'rgba(46,125,50,0.92)');
    } else {
      // ボタンがformの中にある場合、formをsubmitする
      const allButtons = document.querySelectorAll('button');
      for (const b of allButtons) {
        if (b.textContent.trim().includes('処方登録')) {
          clickButton(b);
          setStatus('処方登録クリック完了', 'rgba(46,125,50,0.92)');
          return;
        }
      }
      setStatus('処方登録ボタンが見つかりません', 'rgba(211,47,47,0.92)');
    }
  }

  // ══════════════════════════════════════════════
  // 3. 患者検索ページ → 選択ボタンが出たら自動クリック
  // ══════════════════════════════════════════════
  async function handlePatientSearchPage() {
    setStatus('患者検索画面: 患者IDを入力し検索してください', 'rgba(255,152,0,0.92)');

    // 選択ボタンが出現するのを監視
    const observer = new MutationObserver(async () => {
      const selectBtn = document.querySelector(
        '#searchTable > tbody > tr > td:nth-child(1) > button'
      );

      if (selectBtn) {
        observer.disconnect();
        await sleep(500);
        setStatus('患者を自動選択中...', 'rgba(25,118,210,0.92)');
        clickButton(selectBtn);
        setStatus('選択クリック完了', 'rgba(46,125,50,0.92)');
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // 既に選択ボタンがあるか確認
    await sleep(500);
    const existingBtn = document.querySelector(
      '#searchTable > tbody > tr > td:nth-child(1) > button'
    );
    if (existingBtn) {
      observer.disconnect();
      setStatus('患者を自動選択中...', 'rgba(25,118,210,0.92)');
      clickButton(existingBtn);
      setStatus('選択クリック完了', 'rgba(46,125,50,0.92)');
    }
  }

  // ══════════════════════════════════════════════
  // 4. 患者詳細ページ → 前回処方を抽出 → 処方入力クリック
  // ══════════════════════════════════════════════
  async function handlePatientDetailPage() {
    setStatus('患者詳細画面 → 前回処方を取得中...', 'rgba(25,118,210,0.92)');
    await sleep(800);

    // 前回処方情報を抽出（ページ内テキストから）
    extractAndSavePreviousPrescription();

    // 処方入力ボタンをクリック
    const btn = document.querySelector(
      'button[formaction*="prescription_registration/select_facility"]'
    );

    if (btn) {
      await sleep(300);
      clickButton(btn);
      setStatus('処方入力クリック完了', 'rgba(46,125,50,0.92)');
    } else {
      // fallback
      const allButtons = document.querySelectorAll('button.btn-adhd');
      for (const b of allButtons) {
        if (b.textContent.includes('処方入力')) {
          clickButton(b);
          setStatus('処方入力クリック完了', 'rgba(46,125,50,0.92)');
          return;
        }
      }
      setStatus('処方入力ボタンが見つかりません', 'rgba(211,47,47,0.92)');
    }
  }

  function extractAndSavePreviousPrescription() {
    // ページ内のテキストからコンサータの前回処方を探す
    const bodyText = document.body.innerText || '';
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

    let prevData = null;

    // 処方履歴テーブルがあれば解析
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const text = row.textContent || '';
        if (/コンサータ|concerta/i.test(text)) {
          // mgパターンを抽出: "72mg(18mg×1錠・27mg×2錠)" のような形式
          const mgMatch = text.match(/(\d+mg\([^)]+\))/);
          // 日分を抽出
          const daysMatch = text.match(/(\d+)\s*日分/);

          if (mgMatch || daysMatch) {
            prevData = {
              mgPattern: mgMatch ? mgMatch[1] : null,
              days: daysMatch ? daysMatch[1] : null,
              rawText: text.trim(),
            };
            log('前回処方を検出:', prevData);
          }
        }
      }
    }

    // テーブル以外のテキストからも探す
    if (!prevData) {
      for (const line of lines) {
        if (/コンサータ|concerta/i.test(line)) {
          const mgMatch = line.match(/(\d+mg\([^)]+\))/);
          const daysMatch = line.match(/(\d+)\s*日分/);
          const simpleMgMatch = line.match(/(\d+)\s*mg/i);

          if (mgMatch || daysMatch || simpleMgMatch) {
            prevData = {
              mgPattern: mgMatch ? mgMatch[1] : null,
              days: daysMatch ? daysMatch[1] : null,
              simpleMg: simpleMgMatch ? simpleMgMatch[1] : null,
              rawText: line,
            };
            log('前回処方を検出(テキスト):', prevData);
          }
        }
      }
    }

    if (prevData) {
      savePrevPrescription(prevData);
      log('前回処方データを保存:', prevData);
    } else {
      log('前回処方データが見つかりませんでした');
    }
  }

  // ══════════════════════════════════════════════
  // 5. 施設確認ページ → 選択ボタンをクリック
  // ══════════════════════════════════════════════
  async function handleSelectFacilityPage() {
    setStatus('施設確認画面 → 自動選択中...', 'rgba(25,118,210,0.92)');
    await sleep(800);

    const btn = document.querySelector(
      'button[formaction*="prescription_registration/create"][name="action"][value="create"]'
    );

    if (btn) {
      clickButton(btn);
      setStatus('施設選択クリック完了', 'rgba(46,125,50,0.92)');
    } else {
      // fallback
      const allButtons = document.querySelectorAll('button.btn-adhd');
      for (const b of allButtons) {
        if (b.textContent.includes('選択') && !b.textContent.includes('戻る')) {
          clickButton(b);
          setStatus('施設選択クリック完了', 'rgba(46,125,50,0.92)');
          return;
        }
      }
      setStatus('選択ボタンが見つかりません', 'rgba(211,47,47,0.92)');
    }
  }

  // ══════════════════════════════════════════════
  // 6. 処方登録(create)ページ → 処方日＋前回処方を入力
  // ══════════════════════════════════════════════
  async function handleCreatePage() {
    setStatus('処方登録画面 → 自動入力中...', 'rgba(25,118,210,0.92)');
    await sleep(1000);

    // (A) 処方日に当日日付を入力
    fillPrescriptionDate();

    // (B) 前回処方データを取得して日分を入力
    await sleep(500);
    fillPreviousPrescription();

    setStatus('自動入力完了！内容を確認して確認ボタンを押してください', 'rgba(46,125,50,0.92)');
    fadeStatus();
  }

  function fillPrescriptionDate() {
    const today = getTodayStr();

    // 処方日の入力フィールドを探す
    // date型のinputを優先
    const dateInputs = document.querySelectorAll('input[type="date"], input[type="text"]');

    for (const input of dateInputs) {
      // 周辺テキストに「処方日」があるか確認
      const parent = input.closest('tr, div, td, th, label');
      const contextText = parent ? (parent.textContent || '') : '';

      if (/処方日/.test(contextText)) {
        if (input.type === 'date') {
          // date型の場合 yyyy-mm-dd 形式
          const d = new Date();
          const dateVal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          setInputValue(input, dateVal);
        } else {
          setInputValue(input, today);
        }
        log('処方日を設定:', today);
        return true;
      }
    }

    // フォールバック: name属性等で探す
    const fallback = document.querySelector(
      'input[name*="date"], input[name*="prescri"], input[name*="shohou"]'
    );
    if (fallback) {
      setInputValue(fallback, today);
      log('処方日を設定(fallback):', today);
      return true;
    }

    log('処方日フィールドが見つかりません');
    return false;
  }

  function fillPreviousPrescription() {
    const prev = loadPrevPrescription();

    if (!prev) {
      log('前回処方データがありません。手動で入力してください。');
      setStatus('前回処方データなし: 手動で日分を入力してください', 'rgba(255,152,0,0.92)');
      return;
    }

    log('前回処方データ:', prev);

    // mgPatternから対応する行を見つけて日分を入力
    // ページ内のテーブル行をスキャンして、一致するmgパターンの日分フィールドに入力
    const allRows = document.querySelectorAll('tr, div.form-row, div.row');

    for (const row of allRows) {
      const rowText = row.textContent || '';

      // コンサータの行でmgパターンが一致するか
      let matched = false;

      if (prev.mgPattern && rowText.includes(prev.mgPattern)) {
        matched = true;
      } else if (prev.simpleMg) {
        // "72mg" のようなシンプルなmg値で始まるパターンにマッチ
        const re = new RegExp(prev.simpleMg + 'mg');
        if (re.test(rowText)) {
          matched = true;
        }
      }

      if (matched && prev.days) {
        // この行内のinputフィールド（日分）に値を入力
        const inputs = row.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
        for (const input of inputs) {
          // 周辺に「日分」があるか確認
          const nearText = (input.parentElement?.textContent || '') +
                          (input.nextSibling?.textContent || '') +
                          (input.nextElementSibling?.textContent || '');

          if (/日分/.test(nearText) || inputs.length === 1) {
            setInputValue(input, prev.days);
            log(`日分を入力: ${prev.days} (${prev.mgPattern || prev.simpleMg + 'mg'})`);
            return;
          }
        }
      }
    }

    // マッチしなかった場合: 全ての「日分」入力フィールドを列挙して候補表示
    log('前回処方のmgパターンに一致する行が見つかりませんでした');
    setStatus(`前回処方: ${prev.rawText || '不明'} → 手動で日分を入力してください`, 'rgba(255,152,0,0.92)');
  }

  // ══════════════════════════════════════════════
  // メインルーター
  // ══════════════════════════════════════════════
  async function main() {
    log(`ページ検出: ${path}`);

    if (isLoginPage) {
      await handleLoginPage();
    } else if (isTopPage) {
      await handleTopPage();
    } else if (isPatientSearchPage) {
      await handlePatientSearchPage();
    } else if (isPatientDetailPage) {
      await handlePatientDetailPage();
    } else if (isSelectFacilityPage) {
      await handleSelectFacilityPage();
    } else if (isCreatePage) {
      await handleCreatePage();
    } else {
      log('対象外のページです:', path);
    }
  }

  // 起動
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
