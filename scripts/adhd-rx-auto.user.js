// ==UserScript==
// @name         ADHD適正流通 処方登録 半自動化
// @namespace    https://adhd-vcdcs.jp/
// @version      5.5.0
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
    if (input.tagName === 'SELECT') {
      // selectの場合はoptionを探して設定
      const opt = [...input.options].find(o => o.value === String(value) || o.textContent.trim() === String(value));
      if (opt) {
        input.value = opt.value;
      } else {
        input.value = value;
      }
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function submitClick(btn) {
    if (!btn) return;
    btn.scrollIntoView({ block: 'center' });
    log(`submitClick: tag=${btn.tagName} type=${btn.type} formaction=${btn.getAttribute('formaction')}`);

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
    catch(e) { return null; }
  }

  // ── 処方履歴モーダルを開いてスクレイプ ──────────────
  async function scrapeModalPrescriptions() {
    // 処方履歴ボタンを探す
    let historyBtn = document.querySelector('button[data-target="#prescriptionModal"]')
      || document.querySelector('#content > main button.btn-adhd');
    if (!historyBtn) {
      for (const el of document.querySelectorAll('button')) {
        if (el.textContent.includes('処方履歴')) { historyBtn = el; break; }
      }
    }
    if (!historyBtn) {
      log('処方履歴ボタンが見つかりません');
      return [];
    }

    log('処方履歴ボタン発見:', historyBtn.outerHTML.slice(0, 200));
    historyBtn.click();

    // モーダルが表示されるまでポーリング（最大5秒）
    let modal = null;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      modal = document.querySelector('#prescriptionModal');
      if (modal && modal.classList.contains('show')) {
        log('モーダル表示確認');
        break;
      }
      if (modal && getComputedStyle(modal).display !== 'none') {
        log('モーダル表示確認（display）');
        break;
      }
    }

    await sleep(500); // テーブルデータ読み込み待ち

    const allPrescriptions = [];
    const modalEl = document.querySelector('#prescriptionModal') || document;
    const tables = modalEl.querySelectorAll('table');
    log(`モーダル内テーブル数: ${tables.length}`);

    let currentDrug = null;
    for (const tbl of tables) {
      const prev = tbl.previousElementSibling;
      if (prev) {
        const pt = prev.textContent || '';
        if (/コンサータ/i.test(pt)) currentDrug = 'コンサータ';
        else if (/ビバンセ/i.test(pt)) currentDrug = 'ビバンセ';
      }

      for (const row of tbl.querySelectorAll('tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) continue;

        const cellTexts = [...cells].map(c => c.textContent.trim());
        log('モーダル行:', cellTexts.join(' | '));

        let days = null;
        for (const ct of cellTexts) {
          const m = ct.match(/^(\d+)\s*日分$/);
          if (m) { days = m[1]; break; }
        }
        if (!days) continue;

        let doseMg = '';
        for (const ct of cellTexts) {
          if (/^\d+mg$/.test(ct)) { doseMg = ct; break; }
        }

        let capsuleDetail = '';
        for (const ct of cellTexts) {
          if (/\d+mg[×x]\d+/i.test(ct)) { capsuleDetail = ct; break; }
        }

        const mgDetail = (doseMg && capsuleDetail) ? `${doseMg}(${capsuleDetail})` : null;

        allPrescriptions.push({
          drug: currentDrug,
          mgDetail: mgDetail,
          doseMg: doseMg,
          capsuleDetail: capsuleDetail,
          simpleMg: doseMg ? doseMg.replace('mg', '') : null,
          days: days,
        });

        log(`処方取得: drug=${currentDrug} mgDetail=${mgDetail} days=${days}`);
      }
    }

    log(`モーダルから処方履歴 ${allPrescriptions.length}件取得`);

    // モーダルを閉じる
    const closeBtn = modalEl.querySelector('.close, button.close, [data-dismiss="modal"]');
    if (closeBtn) {
      closeBtn.click();
      log('モーダル閉じ（closeボタン）');
    } else {
      try { $('#prescriptionModal').modal('hide'); log('モーダル閉じ（jQuery）'); }
      catch(e) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        log('モーダル閉じ（ESC）');
      }
    }
    await sleep(300);

    return allPrescriptions;
  }

  const path = location.pathname;
  log('path:', path);

  // ══════════════════════════════════════════════
  // 1. ログイン（v4.1と同一）
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
  // 2. TOPページ → 処方登録（v4.1と同一）
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
  // 3. 患者検索 → 自動選択（v4.1 + MutationObserver追加）
  // ══════════════════════════════════════════════
  function getVisibleBtns() {
    let allBtns = [...document.querySelectorAll('#searchTable > tbody > tr > td:nth-child(1) > button')];
    if (!allBtns.length) allBtns = [...document.querySelectorAll('button[name="patId"]')];
    if (!allBtns.length) allBtns = [...document.querySelectorAll('button[formaction*="detail"]')];

    return allBtns.filter(b => {
      const tr = b.closest('tr');
      if (tr && tr.style.display === 'none') return false;
      if (tr && getComputedStyle(tr).display === 'none') return false;
      if (b.offsetParent === null) return false;
      return true;
    });
  }

  async function doSearch() {
    show('選択ボタンを待機中...', BLUE);

    let btns = [];
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      btns = getVisibleBtns();
      if (btns.length > 0) {
        log(`ポーリング${i+1}回目: 可視${btns.length}個発見`);
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
      show(`${btns.length}件: 検索して1件に絞ると自動選択します`, ORANGE);

      // 検索後にDOMが変化して1件になったら自動選択
      const observer = new MutationObserver(() => {
        const current = getVisibleBtns();
        if (current.length === 1) {
          observer.disconnect();
          show('患者を自動選択中...', BLUE);
          setTimeout(() => {
            submitClick(current[0]);
            show('選択完了', GREEN);
          }, 300);
        } else if (current.length > 0 && current.length !== btns.length) {
          show(`${current.length}件: 検索して1件に絞ると自動選択します`, ORANGE);
        }
      });

      const table = document.querySelector('#searchTable') || document.querySelector('table');
      if (table) {
        observer.observe(table, { childList: true, subtree: true, attributes: true });
        setTimeout(() => observer.disconnect(), 120000);
      }
      fade();
    } else {
      show('患者IDを入力して検索してください', ORANGE); fade();
    }
  }

  // ══════════════════════════════════════════════
  // 4. 患者詳細 → 処方履歴モーダルをスクレイプ → 処方入力
  // ══════════════════════════════════════════════
  async function doDetail() {
    show('患者詳細 → 処方履歴を取得中...', BLUE);
    await sleep(800);

    const allPrescriptions = await scrapeModalPrescriptions();

    if (allPrescriptions.length > 0) {
      savePrev(allPrescriptions);
      log('処方履歴を保存:', allPrescriptions);
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
  // 5. 施設確認 → 選択（v4.1と同一）
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
  //    ★ 改善: 前回処方のmgDetailに一致する行のみに入力
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
    let prevList = loadPrev();
    log('前回処方データ(sessionStorage):', prevList);

    // sessionStorageにデータがなければ、このページで直接モーダルを開いてスクレイプ
    if (!prevList || !Array.isArray(prevList) || prevList.length === 0) {
      log('sessionStorageにデータなし → このページで処方履歴モーダルを直接スクレイプ');
      show('処方履歴を取得中...', BLUE);
      const scraped = await scrapeModalPrescriptions();
      if (scraped.length > 0) {
        prevList = scraped;
        savePrev(scraped);
        log('直接スクレイプ成功:', scraped);
      }
    }

    if (!prevList || !Array.isArray(prevList) || prevList.length === 0) {
      show(dateSet ? '処方日設定済。処方履歴が見つかりません' : '処方履歴が見つかりません', RED);
      fade();
      return;
    }

    // ページ内の日分入力行を収集
    // 戦略: 「日分」テキストの直前にあるinput/selectを全て探す
    const rowEntries = [];
    const seenInputs = new Set();

    // 方法1: input/selectの直後テキストが「日分」のものを探す（レイアウト非依存）
    for (const inp of document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), select')) {
      if (inp.type === 'hidden' || inp.type === 'date') continue;
      const after = (inp.nextSibling?.textContent || '') + (inp.nextElementSibling?.textContent || '');
      if (!/日分/.test(after)) continue;
      if (seenInputs.has(inp)) continue;
      seenInputs.add(inp);

      // このinputの属する行（tr, div, liなど最も近い行コンテナ）のテキストを取得
      const container = inp.closest('tr') || inp.closest('li') || inp.closest('div.row') || inp.parentElement?.parentElement;
      const rowText = container ? container.textContent.replace(/\s+/g, '') : '';
      rowEntries.push({ rowText, dayInput: inp });
      log(`日分入力発見(方法1): "${rowText.slice(0, 80)}"`);
    }

    // 方法2: tr内での検索（フォールバック）
    if (rowEntries.length === 0) {
      for (const row of document.querySelectorAll('tr')) {
        const rowText = row.textContent || '';
        if (!/日分/.test(rowText)) continue;

        const rowInputs = row.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), select');
        let dayInput = null;

        for (const inp of rowInputs) {
          if (inp.type === 'hidden' || inp.type === 'date') continue;
          if (seenInputs.has(inp)) continue;
          const after = (inp.nextSibling?.textContent || '') + (inp.nextElementSibling?.textContent || '');
          if (/日分/.test(after)) { dayInput = inp; break; }
        }
        if (!dayInput) {
          for (const td of row.querySelectorAll('td, th')) {
            if (!/日分/.test(td.textContent)) continue;
            const inp = td.querySelector('input[type="text"], input[type="number"], input:not([type]), select');
            if (inp && !seenInputs.has(inp)) { dayInput = inp; break; }
          }
        }
        if (!dayInput) {
          for (const inp of rowInputs) {
            if (seenInputs.has(inp)) continue;
            if (inp.value && (inp.value.includes('/') || inp.value.includes('-'))) continue;
            if (inp.type === 'date') continue;
            dayInput = inp;
            break;
          }
        }

        if (dayInput) {
          seenInputs.add(dayInput);
          rowEntries.push({ rowText: rowText.replace(/\s+/g, ''), dayInput });
          log(`日分入力発見(方法2): "${rowText.replace(/\s+/g, '').slice(0, 80)}"`);
        }
      }
    }

    log(`日分入力行: ${rowEntries.length}件`);

    // 正規化: スペース除去、×統一、「錠」「カプセル」を除去、中黒統一
    function norm(s) {
      if (!s) return '';
      return s.replace(/\s+/g, '')
        .replace(/[×Xx✕✖╳]/g, '×')
        .replace(/[・\u00B7\uFF65\u2022\u2027\u30FB]/g, '・')
        .replace(/錠/g, '').replace(/カプセル/g, '');
    }

    // 前回処方とマッチする行のみに日分を入力
    let filledCount = 0;
    for (const prev of prevList) {
      if (!prev.days) continue;

      // マッチ用のキーを作成
      // モーダルから取得: doseMg="63mg", capsuleDetail="27mg×1・36mg×1"
      // → 正規化して "63mg(27mg×1・36mg×1)" にして比較
      const prevMgNorm = norm(prev.mgDetail);
      const rawMgMatch = prev.raw ? prev.raw.match(/(\d+mg\([^)]+\))/) : null;
      const rawNorm = rawMgMatch ? norm(rawMgMatch[1]) : '';

      log(`前回処方マッチング: mgDetail="${prev.mgDetail}" norm="${prevMgNorm}" days=${prev.days}`);

      for (const entry of rowEntries) {
        const rowNorm = norm(entry.rowText);

        let matched = false;

        // mgDetail一致（「錠」除去して比較）
        // 前回: "63mg(27mg×1・36mg×1)" vs 行: "63mg(27mg×1錠・36mg×1錠)" → 正規化後一致
        if (prevMgNorm && rowNorm.includes(prevMgNorm)) matched = true;
        if (!matched && rawNorm && rowNorm.includes(rawNorm)) matched = true;

        // capsuleDetailでの部分マッチ（doseMg + capsuleDetail）
        if (!matched && prev.capsuleDetail && prev.doseMg) {
          const capNorm = norm(prev.capsuleDetail);
          const doseNorm = norm(prev.doseMg);
          if (rowNorm.includes(doseNorm) && rowNorm.includes(capNorm)) matched = true;
        }

        if (matched) {
          setVal(entry.dayInput, prev.days);
          log(`マッチ成功: "${prev.mgDetail || prev.doseMg}" → ${prev.days}日分`);
          filledCount++;
          break;
        }
      }
    }

    if (filledCount > 0) {
      show(`処方日+日分(${filledCount}件)を自動入力しました`, GREEN);
    } else {
      const hint = prevList.map(p => `${p.mgDetail || p.doseMg || (p.simpleMg + 'mg') || '?'} ${p.days}日分`).join(', ');
      show(`前回: ${hint} — 該当行に手動入力してください`, ORANGE);
      log('マッチ行なし。前回処方:', prevList);
      rowEntries.forEach((e, i) => log(`  行[${i}]: ${e.rowText.slice(0, 120)}`));
    }
    fade();
  }

  // ══════════════════════════════════════════════
  // 7. 確認画面 → 登録ボタン自動クリック
  // ══════════════════════════════════════════════
  async function doConfirm() {
    show('確認画面 → 登録ボタンを自動クリック中...', BLUE);
    await sleep(800);

    const registerBtn =
      document.querySelector('button[formaction*="prescription_registration/complete"][value="create"]') ||
      document.querySelector('button[formaction*="/complete"][value="create"]');

    if (registerBtn) {
      submitClick(registerBtn);
      show('登録完了', GREEN);
    } else {
      show('登録ボタンが見つかりません', RED);
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
    } else if (path.includes('/prescription_registration/confirm')) {
      log('→ 確認画面'); await doConfirm();
    } else {
      log('対象外:', path);
    }
  }

  main();
})();
