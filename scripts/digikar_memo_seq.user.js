// ==UserScript==
// @name         DigiKar 受付メモ 連番ツール（下から順・2x2透明UI）
// @namespace    https://digikar.jp/
// @version      1.3.0
// @description  受付一覧の受付メモに連番付与/削除（仮想スクロール対応、午前/午後、下から順、table内インライン編集対応、2x2透明UI）
// @match        https://digikar.jp/reception*
// @match        https://digikar.jp/reception/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  if (window.__DIGIKAR_MEMO_SEQ_TOOL__) return;
  window.__DIGIKAR_MEMO_SEQ_TOOL__ = true;

  const APP = {
    id: 'dk-memo-seq-panel',
    title: '受付メモ連番',
    shortLabel: '連番',
    logPrefix: '[DigiKarMemoSeq]',
    storageKey: 'dk-memo-seq-panel-state-v2',
  };

  const HEADERS = Object.freeze({
    RESERVATION: '予約',
    TIME: '時間',
    PATIENT_NO: '患者番号',
    MEMO: '受付メモ',
  });

  const RANGES = Object.freeze({
    am: { key: 'am', label: '午前', startMin: 9 * 60 + 45, endMin: 13 * 60 + 0 },
    pm: { key: 'pm', label: '午後', startMin: 14 * 60 + 15, endMin: 18 * 60 + 0 },
  });

  const CONFIG = Object.freeze({
    SCAN_SETTLE_MS: 180,
    WAIT_INTERVAL_MS: 100,
    MAX_SCAN_LOOPS: 2000,
    MAX_PROCESS_LOOPS: 6000,
    POST_CLICK_WAIT_MS: 120,
    POST_INPUT_WAIT_MS: 80,
    EDITOR_OPEN_TIMEOUT_MS: 8000,
    EDITOR_CLOSE_TIMEOUT_MS: 8000,
  });

  const SELECTORS = Object.freeze({
    TABLE: 'table',
    EDIT_BUTTON_HINTS: [
      'button.edit-icon',
      'button[class*="edit"]',
      'button[class*="pencil"]',
      'button[aria-label*="編集"]',
      'button[aria-label*="メモ"]',
      'button[aria-label*="受付"]',
      'button[title*="編集"]',
      'button[title*="メモ"]',
      'button[data-testid*="edit"]',
      'button[data-testid*="memo"]',
    ].join(','),
    OVERLAY_CANDIDATES: [
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-modal="true"]',
      '[data-state="open"]',
      '[data-radix-portal] *',
    ].join(','),
  });

  const state = {
    running: false,
    abortRequested: false,
    lastRowLabel: '',
    ui: null,
    ignorePanelClickUntil: 0,
  };

  const log = (...args) => console.log(APP.logPrefix, ...args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(getter, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const intervalMs = opts.intervalMs ?? CONFIG.WAIT_INTERVAL_MS;
    const name = opts.name ?? 'condition';
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const v = getter();
        if (v) return v;
      } catch (_) {}
      await sleep(intervalMs);
    }
    throw new Error(`${name} の待機がタイムアウトしました`);
  }

  const normalizeText = (v) => String(v ?? '').replace(/\s+/g, '');
  const visibleText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

  function stripLeadingNumberPrefix(text) {
    return String(text ?? '').replace(/^\s*\d{1,3}[ \u3000]*[.．:：\-－]?[ \u3000]+/, '');
  }

  function parseTimeFromReservationText(text) {
    const m = String(text ?? '').match(/([01]?\d|2[0-3]):([0-5]\d)/);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    return { timeMin: hh * 60 + mm, timeStr: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
  }

  const inRange = (min, range) => min >= range.startMin && min <= range.endMin;

  function isScrollableY(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const cs = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4;
  }

  function findScrollContainerForTable(table) {
    let el = table.parentElement;
    while (el && el !== document.body) {
      if (isScrollableY(el)) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  const setScrollTop = (scrollEl, v) => (scrollEl.scrollTop = Math.max(0, v));
  const isAtBottom = (scrollEl) => scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;

  function estimateRowAbsY(row, scrollEl) {
    const rr = row.getBoundingClientRect();
    if (scrollEl === document.scrollingElement || scrollEl === document.documentElement || scrollEl === document.body) {
      return (document.scrollingElement?.scrollTop || window.scrollY || 0) + rr.top;
    }
    const cr = scrollEl.getBoundingClientRect();
    return scrollEl.scrollTop + (rr.top - cr.top);
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function safeClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
  }

  function getDataRows(table) {
    const rows = [];
    for (const tbody of Array.from(table.tBodies || [])) rows.push(...Array.from(tbody.rows || []));
    return rows;
  }

  function getVisibleRowsSorted(table) {
    return getDataRows(table)
      .filter((row) => row?.cells?.length)
      .filter((row) => {
        const r = row.getBoundingClientRect();
        return r.height > 0 && r.width > 0;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function findHeaderRow(table) {
    const thead = table.tHead;
    if (!thead) return null;
    return Array.from(thead.rows || []).find((tr) => tr.cells?.length) || null;
  }

  function getColumnMapFromTable(table) {
    const headerRow = findHeaderRow(table);
    if (!headerRow) return null;

    const headers = Array.from(headerRow.cells || []);
    const normTexts = headers.map((th) => normalizeText(th.textContent));
    const findExact = (name) => normTexts.findIndex((t) => t === name);
    const findStarts = (name) => normTexts.findIndex((t) => t.startsWith(name));

    const patientNoIdx = (() => {
      const x = findExact(HEADERS.PATIENT_NO);
      return x >= 0 ? x : findStarts(HEADERS.PATIENT_NO);
    })();

    const memoIdx = (() => {
      const x = findExact(HEADERS.MEMO);
      return x >= 0 ? x : findStarts(HEADERS.MEMO);
    })();

    let reservationIdx = (() => {
      const x = findExact(HEADERS.RESERVATION);
      return x >= 0 ? x : findStarts(HEADERS.RESERVATION);
    })();
    let reservationSource = HEADERS.RESERVATION;

    if (reservationIdx < 0) {
      const fallback = findExact(HEADERS.TIME);
      if (fallback >= 0) {
        reservationIdx = fallback;
        reservationSource = HEADERS.TIME;
      }
    }

    if ([patientNoIdx, memoIdx, reservationIdx].some((i) => i < 0)) return null;
    return { reservationIdx, reservationSource, patientNoIdx, memoIdx };
  }

  function findReceptionTableContext() {
    const tables = Array.from(document.querySelectorAll(SELECTORS.TABLE));
    const candidates = [];
    for (const table of tables) {
      const rect = table.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 40) continue;
      const colMap = getColumnMapFromTable(table);
      if (!colMap) continue;
      const rowCount = getDataRows(table).length;
      if (rowCount <= 0) continue;
      candidates.push({ table, colMap, rowCount, rectTop: rect.top });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.rowCount - a.rowCount || a.rectTop - b.rectTop);
    const best = candidates[0];
    return { table: best.table, colMap: best.colMap, scrollEl: findScrollContainerForTable(best.table) };
  }

  function getTableContextOrThrow() {
    const ctx = findReceptionTableContext();
    if (!ctx) throw new Error('受付一覧テーブルを特定できません（thead見出し: 予約/患者番号/受付メモ）');
    return ctx;
  }

  function readRowSnapshot(row, ctx) {
    const { colMap } = ctx;
    const cells = row.cells;
    const reservationTd = cells[colMap.reservationIdx];
    const patientNoTd = cells[colMap.patientNoIdx];
    const memoTd = cells[colMap.memoIdx];
    if (!reservationTd || !patientNoTd || !memoTd) return null;

    const parsedTime = parseTimeFromReservationText(visibleText(reservationTd.textContent));
    if (!parsedTime) return null;

    const patientNo = visibleText(patientNoTd.textContent).replace(/\s+/g, '');
    const hasPatientNo = !!patientNo && patientNo !== '-' && patientNo !== '―';

    return {
      row,
      memoTd,
      timeMin: parsedTime.timeMin,
      timeStr: parsedTime.timeStr,
      patientNo,
      hasPatientNo,
      key: `${parsedTime.timeMin}|${patientNo}`,
    };
  }

  // 下から順（画面下→上）
  function compareForNumbering(a, b) {
    return ((b.absY || 0) - (a.absY || 0)) || ((b.displayOrder || 0) - (a.displayOrder || 0));
  }

  function buildSelections(metaMap) {
    const all = Array.from(metaMap.values());
    const eligible = all.filter((m) => m.hasPatientNo);

    const amRows = eligible.filter((m) => inRange(m.timeMin, RANGES.am)).sort(compareForNumbering);
    const pmRows = eligible.filter((m) => inRange(m.timeMin, RANGES.pm)).sort(compareForNumbering);

    const amNumberMap = new Map();
    const pmNumberMap = new Map();
    amRows.forEach((m, i) => amNumberMap.set(m.key, i + 1));

    // ❶ PMの開始番号 = AMメモに実際に振られている最大番号 + 1
    //    （臨時予約で番号なしのAM患者がいても正しく動作する）
    let amMaxNumber = 0;
    for (const m of all) {
      if (!inRange(m.timeMin, RANGES.am)) continue;
      const match = (m.memoText || '').match(/^\s*(\d{1,3})\b/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > amMaxNumber) amMaxNumber = n;
      }
    }
    // AMがまだ付番されていない場合はAM行数をフォールバック
    if (amMaxNumber === 0) amMaxNumber = amRows.length;
    pmRows.forEach((m, i) => pmNumberMap.set(m.key, amMaxNumber + i + 1));

    return {
      amRows,
      pmRows,
      counts: { all: all.length, eligible: eligible.length, am: amRows.length, pm: pmRows.length },
      numberMap: { am: amNumberMap, pm: pmNumberMap },
    };
  }

  function throwIfAborted() {
    if (!state.abortRequested) return;
    const err = new Error('ユーザー停止');
    err.__userAbort = true;
    throw err;
  }

  async function collectMetaByAutoScroll(ctx, label = 'スキャン') {
    const metaMap = new Map();
    let displayOrder = 0;

    setScrollTop(ctx.scrollEl, 0);
    await sleep(CONFIG.SCAN_SETTLE_MS * 2);

    let bottomNoNewCount = 0;
    let noMoveCount = 0;

    for (let loop = 0; loop < CONFIG.MAX_SCAN_LOOPS; loop++) {
      throwIfAborted();
      await sleep(CONFIG.SCAN_SETTLE_MS);

      const rows = getVisibleRowsSorted(ctx.table);
      const before = metaMap.size;

      for (const row of rows) {
        const snap = readRowSnapshot(row, ctx);
        if (!snap) continue;
        if (metaMap.has(snap.key)) continue;

        displayOrder += 1;
        metaMap.set(snap.key, {
          key: snap.key,
          timeMin: snap.timeMin,
          timeStr: snap.timeStr,
          patientNo: snap.patientNo,
          hasPatientNo: snap.hasPatientNo,
          displayOrder,
          absY: estimateRowAbsY(row, ctx.scrollEl),
          memoTd: snap.memoTd,
          memoText: visibleText(snap.memoTd.textContent),
        });
      }

      const foundNew = metaMap.size - before;
      setStatus(`${label}: ${metaMap.size}行`, 'info');

      const atBottom = isAtBottom(ctx.scrollEl);
      if (atBottom) {
        bottomNoNewCount = foundNew === 0 ? bottomNoNewCount + 1 : 0;
        if (bottomNoNewCount >= 2) break;
      }

      const prevTop = ctx.scrollEl.scrollTop;
      const step = Math.max(Math.floor(ctx.scrollEl.clientHeight * 0.7), 220);
      setScrollTop(ctx.scrollEl, Math.min(prevTop + step, ctx.scrollEl.scrollHeight));

      if (ctx.scrollEl.scrollTop === prevTop) {
        noMoveCount += 1;
        if (atBottom || noMoveCount >= 5) break;
      } else noMoveCount = 0;
    }

    return metaMap;
  }

  // ====== 編集（table内インライン対応） ======
  function getActiveEditor() {
    const el = document.activeElement;
    if (!el) return null;
    if (el.tagName === 'TEXTAREA') return el;
    if (el.tagName === 'INPUT') return el;
    if (el.isContentEditable) return el;
    return null;
  }

  function findEditorInMemoCell(memoTd) {
    const candidates = memoTd.querySelectorAll('textarea, input, [contenteditable="true"]');
    for (const el of Array.from(candidates)) if (isVisible(el)) return el;
    return null;
  }

  function setValueSmart(el, value) {
    if (!el) return;

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = Object.getPrototypeOf(el);
      const setter =
        Object.getOwnPropertyDescriptor(proto, 'value')?.set ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

      if (setter) setter.call(el, value);
      else el.value = value;

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function findSaveButtonForEditor(editor) {
    const labels = ['保存', '更新', 'OK', '決定', '完了', '登録'];
    const matchBtn = (root) => {
      const btns = Array.from(root.querySelectorAll('button'));
      return btns.find((b) => labels.includes(String(b.innerText || b.textContent || '').trim()));
    };

    let p = editor?.parentElement;
    for (let i = 0; i < 12 && p; i++) {
      const hit = matchBtn(p);
      if (hit) return hit;
      p = p.parentElement;
    }

    const overlays = Array.from(document.querySelectorAll(SELECTORS.OVERLAY_CANDIDATES)).filter(isVisible);
    for (const o of overlays) {
      const hit = matchBtn(o);
      if (hit) return hit;
    }
    return null;
  }

  async function waitForEditorOpened(memoTd) {
    return await waitFor(() => getActiveEditor() || findEditorInMemoCell(memoTd), {
      timeoutMs: CONFIG.EDITOR_OPEN_TIMEOUT_MS,
      name: '受付メモエディタ',
    });
  }

  async function waitForEditorClosed(prevEditor) {
    await waitFor(() => {
      const cur = getActiveEditor();
      if (!cur) return true;
      if (cur !== prevEditor) return true;
      return false;
    }, { timeoutMs: CONFIG.EDITOR_CLOSE_TIMEOUT_MS, name: 'エディタクローズ' }).catch(() => {});
  }

  function findEditButtonForMemo(memoTd) {
    memoTd.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    memoTd.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
    memoTd.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));

    const direct = memoTd.querySelector(SELECTORS.EDIT_BUTTON_HINTS);
    if (direct && isVisible(direct)) return direct;

    const row = memoTd.closest('tr');
    if (!row) return null;

    const memoRect = memoTd.getBoundingClientRect();
    const btns = Array.from(row.querySelectorAll('button')).filter(isVisible);
    const ranked = btns
      .map((b) => {
        const r = b.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const inside = cx >= memoRect.left && cx <= memoRect.right && cy >= memoRect.top && cy <= memoRect.bottom;
        const dx = Math.max(0, memoRect.left - cx, cx - memoRect.right);
        const dy = Math.max(0, memoRect.top - cy, cy - memoRect.bottom);
        const dist = Math.hypot(dx, dy);
        const hint = (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '') + (b.className || '') + (b.getAttribute('data-testid') || '');
        const ok = /メモ|受付|edit|pencil|編集/i.test(hint);
        return { b, inside, dist, ok };
      })
      .filter(x => x.ok)
      .sort((a, b) => (b.inside - a.inside) || (a.dist - b.dist));

    return ranked.length ? ranked[0].b : null;
  }

  // ctx, targetKey が渡された場合、scrollIntoView後にDOMからtdを再取得する
  async function openEditorFromMemoTd(memoTd, ctx, targetKey) {
    let td = memoTd;
    td.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    await sleep(CONFIG.POST_CLICK_WAIT_MS);

    // 仮想スクロールでDOM再描画された可能性があるため、keyで再取得
    if (ctx && targetKey) {
      const freshRows = getVisibleRowsSorted(ctx.table);
      for (const fr of freshRows) {
        const fs = readRowSnapshot(fr, ctx);
        if (fs && fs.key === targetKey) { td = fs.memoTd; break; }
      }
    }

    safeClick(td);
    await sleep(60);
    td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    await sleep(80);
    td.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    td.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));

    if (!getActiveEditor() && !findEditorInMemoCell(td)) {
      const btn = findEditButtonForMemo(td);
      if (btn) {
        safeClick(btn);
        await sleep(120);
        if (!getActiveEditor() && !findEditorInMemoCell(td)) safeClick(btn);
      }
    }

    return await waitForEditorOpened(td);
  }

  async function closeEditor(editor) {
    try {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, cancelable: true }));
    } catch (_) {}
    try { editor.blur?.(); } catch (_) {}
    try { document.body.click(); } catch (_) {}
    await waitForEditorClosed(editor);
  }

  async function editMemoForRowSnapshot(snapshot, updater, ctx) {
    const editor = await openEditorFromMemoTd(snapshot.memoTd, ctx, snapshot.key);
    const before = (editor.value ?? editor.textContent ?? '');
    const after = updater(before, snapshot);

    if (after === before) {
      await closeEditor(editor);
      return;
    }

    setValueSmart(editor, after);
    await sleep(CONFIG.POST_INPUT_WAIT_MS);

    const saveBtn = findSaveButtonForEditor(editor);
    if (saveBtn) {
      safeClick(saveBtn);
      await sleep(120);
      await closeEditor(editor);
    } else {
      try {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
      } catch (_) {}
      await closeEditor(editor);
    }
  }

  async function rescanAndProcessTargets(ctx, opts) {
    const { targetKeys, label, onRow } = opts;
    const processed = new Set();
    const total = targetKeys.size;

    setScrollTop(ctx.scrollEl, 0);
    await sleep(CONFIG.SCAN_SETTLE_MS * 2);

    let bottomNoProgressCount = 0;

    for (let loop = 0; loop < CONFIG.MAX_PROCESS_LOOPS; loop++) {
      throwIfAborted();
      await sleep(CONFIG.SCAN_SETTLE_MS);

      const rows = getVisibleRowsSorted(ctx.table);
      let progressed = false;

      for (const row of rows) {
        throwIfAborted();
        const snap = readRowSnapshot(row, ctx);
        if (!snap) continue;
        if (!targetKeys.has(snap.key)) continue;
        if (processed.has(snap.key)) continue;

        state.lastRowLabel = `${snap.timeStr} / 患者番号 ${snap.patientNo}`;
        setStatus(`${label}: ${processed.size + 1}/${total} (${state.lastRowLabel})`, 'info');

        await onRow(snap);

        processed.add(snap.key);
        progressed = true;

        if (processed.size >= total) return;
      }

      const atBottom = isAtBottom(ctx.scrollEl);
      if (!progressed) {
        if (atBottom) {
          bottomNoProgressCount += 1;
          if (bottomNoProgressCount >= 2) throw new Error(`対象行を見失いました（残り ${total - processed.size} 件）`);
        } else bottomNoProgressCount = 0;

        const prevTop = ctx.scrollEl.scrollTop;
        const step = Math.max(Math.floor(ctx.scrollEl.clientHeight * 0.7), 220);
        setScrollTop(ctx.scrollEl, Math.min(prevTop + step, ctx.scrollEl.scrollHeight));
      } else bottomNoProgressCount = 0;
    }

    throw new Error(`${label}: ループ上限に達しました`);
  }

  async function runPhase2(mode, periodKey) {
    const period = RANGES[periodKey];
    const ctx = getTableContextOrThrow();

    const metaMap = await collectMetaByAutoScroll(ctx, `${period.label}${mode === 'add' ? '付番' : '削除'} 抽出`);
    const selections = buildSelections(metaMap);

    const targetRows = periodKey === 'am' ? selections.amRows : selections.pmRows;
    const targetKeys = new Set(targetRows.map((m) => m.key));

    if (targetKeys.size === 0) {
      setStatus(`${period.label}${mode === 'add' ? '付番' : '削除'}: 対象0`, 'warn');
      return;
    }

    const numberMap = selections.numberMap[periodKey];
    const label = `${period.label}${mode === 'add' ? '付番' : '削除'}`;

    await rescanAndProcessTargets(ctx, {
      label,
      targetKeys,
      onRow: async (snap) => {
        await editMemoForRowSnapshot(snap, (before) => {
          if (mode === 'remove') return stripLeadingNumberPrefix(before);
          const n = numberMap.get(snap.key);
          if (!n) throw new Error(`番号マップ未解決: ${snap.key}`);
          const body = stripLeadingNumberPrefix(before);
          return `${n} ${body}`;
        }, ctx);
      },
    });

    setStatus(`${label}: 完了 ${targetKeys.size}件`, 'info');
  }

  // ===== UI（2x2 / 透明 / 立体枠） =====
  function setStatus(message, level = 'info') {
    if (!state.ui?.statusEl) return;
    state.ui.statusEl.textContent = message;
    state.ui.statusEl.dataset.level = level;
  }

  function updateUiBusy() {
    if (!state.ui) return;
    const btns = state.ui.panel.querySelectorAll('button[data-action]');
    btns.forEach((b) => (b.disabled = state.running));
  }

  async function runTask(taskLabel, fn) {
    if (state.running) return;
    state.running = true;
    updateUiBusy();
    setStatus(`${taskLabel}…`, 'info');

    try {
      await fn();
    } catch (err) {
      console.error(APP.logPrefix, err);
      setStatus(`エラー: ${err?.message || err}${state.lastRowLabel ? ` / ${state.lastRowLabel}` : ''}`, 'error');
    } finally {
      state.running = false;
      updateUiBusy();
    }
  }

  function loadPanelState() {
    try {
      const raw = localStorage.getItem(APP.storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function savePanelState(partial) {
    try {
      const prev = loadPanelState();
      localStorage.setItem(APP.storageKey, JSON.stringify({ ...prev, ...partial }));
    } catch (_) {}
  }

  function clampPanelToViewport(panel) {
    const r = panel.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - r.width - 8));
    const top = Math.min(Math.max(8, r.top), Math.max(8, window.innerHeight - r.height - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function setPanelMinimized(panel, closeBtn, minimized) {
    panel.classList.toggle('is-minimized', minimized);
    closeBtn.textContent = '−';
    closeBtn.title = minimized ? '開く' : '小さくする';
    closeBtn.setAttribute('aria-label', closeBtn.title);
  }

  function createPanel() {
    if (document.getElementById(APP.id)) return;

    const style = document.createElement('style');
    style.textContent = `
#${APP.id}{
  position:fixed;
  right:12px;
  bottom:12px;
  width:224px;
  padding:10px;
  background:rgba(219,233,255,.78);
  border-radius:22px;
  border:1px solid rgba(125,163,214,.78);
  box-shadow:0 14px 34px rgba(34,76,135,.22);
  backdrop-filter:blur(16px);
  z-index:2147483000;
  font-family:"Yu Gothic UI","Meiryo",sans-serif;
  color:#143d69;
  user-select:none;
  box-sizing:border-box;
}
#${APP.id}, #${APP.id} *{box-sizing:border-box}
#${APP.id}.is-minimized{
  width:68px;
  height:68px;
  padding:0;
  border-radius:999px;
  background:rgba(199,221,255,.42);
  border-color:rgba(120,162,219,.8);
  box-shadow:0 12px 28px rgba(47,93,158,.22);
  display:flex;
  align-items:center;
  justify-content:center;
}
#${APP.id}.is-minimized::before{
  content:"";
  position:absolute;
  inset:4px;
  border-radius:999px;
  border:1px solid rgba(255,255,255,.56);
  pointer-events:none;
}
#${APP.id} .dk-shell{
  display:grid;
  gap:10px;
}
#${APP.id} .dk-header{
  position:relative;
  z-index:3;
  display:flex;
  align-items:center;
  gap:8px;
  min-height:42px;
}
#${APP.id} .dk-title{
  flex:1;
  min-width:0;
  padding:8px 12px;
  border-radius:16px;
  background:rgba(255,255,255,.56);
  border:1px solid rgba(156,186,227,.58);
  font-size:13px;
  font-weight:900;
  color:#124b7d;
  letter-spacing:.04em;
}
#${APP.id} .dk-close{
  width:36px;
  height:36px;
  display:flex;
  align-items:center;
  justify-content:center;
  border-radius:14px;
  background:rgba(255,255,255,.66);
  border:1px solid rgba(142,178,222,.8);
  box-shadow:0 6px 14px rgba(45,91,153,.14);
  cursor:pointer;
  font-size:20px;
  font-weight:900;
  line-height:1;
  color:#386795;
}
#${APP.id}.is-minimized .dk-close{
  display:none;
}
#${APP.id} .dk-body{
  position:relative;
  z-index:1;
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:8px;
}
#${APP.id}.is-minimized .dk-body{
  display:none;
}
#${APP.id} .dk-btn{
  width:100%;
  min-height:46px;
  padding:0 8px;
  border:1px solid rgba(255,255,255,.72);
  border-radius:14px;
  font-size:13px;
  font-weight:900;
  color:#fff;
  cursor:pointer;
  display:flex;
  align-items:center;
  justify-content:center;
  box-shadow:0 10px 18px rgba(56,103,149,.18);
  touch-action:manipulation;
}
#${APP.id} .dk-btn:disabled{opacity:.55; cursor:not-allowed}
#${APP.id} .dk-green{background:linear-gradient(180deg, rgba(84,166,255,.96), rgba(52,130,231,.96))}
#${APP.id} .dk-red{background:linear-gradient(180deg, rgba(126,159,194,.96), rgba(92,124,166,.96))}

#${APP.id} .dk-status{
  grid-column:1 / -1;
  padding:8px 10px;
  font-size:11px;
  line-height:1.4;
  border-radius:14px;
  background:rgba(255,255,255,.56);
  border:1px solid rgba(156,186,227,.58);
  box-shadow:0 6px 14px rgba(45,91,153,.08);
  color:#143d69;
}
#${APP.id} .dk-status[data-level="error"]{
  border-color:rgba(214,69,69,.55);
  color:#b71c1c;
}
#${APP.id} .dk-status[data-level="warn"]{
  border-color:rgba(255,213,79,.7);
}
#${APP.id} .dk-bubble{
  display:none;
  width:100%;
  height:100%;
  align-items:center;
  justify-content:center;
  flex-direction:column;
  gap:2px;
  color:#124b7d;
  font-weight:900;
  letter-spacing:.06em;
}
#${APP.id} .dk-bubble-main{font-size:12px}
#${APP.id} .dk-bubble-sub{font-size:9px; opacity:.72}
#${APP.id}.is-minimized .dk-shell{display:none}
#${APP.id}.is-minimized .dk-bubble{display:flex}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = APP.id;
    const saved = loadPanelState();

    panel.innerHTML = `
<div class="dk-shell">
  <div class="dk-header">
    <div class="dk-title">${APP.title}</div>
    <button class="dk-close" type="button" data-ui="close" title="小さくする">−</button>
  </div>
  <div class="dk-body">
    <button class="dk-btn dk-green" type="button" data-action="add-am">AM付番</button>
    <button class="dk-btn dk-green" type="button" data-action="add-pm">PM付番</button>
    <button class="dk-btn dk-red" type="button" data-action="remove-am">AM番削</button>
    <button class="dk-btn dk-red" type="button" data-action="remove-pm">PM番削</button>
    <div class="dk-status" data-level="info">準備完了</div>
  </div>
</div>
<div class="dk-bubble" data-ui="bubble">
  <div class="dk-bubble-main">${APP.shortLabel}</div>
  <div class="dk-bubble-sub">SEQ</div>
</div>`;
    document.body.appendChild(panel);

    const statusEl = panel.querySelector('.dk-status');
    const closeBtn = panel.querySelector('[data-ui="close"]');
    const bubble = panel.querySelector('[data-ui="bubble"]');
    state.ui = { panel, statusEl, closeBtn, bubble };
    setPanelMinimized(panel, closeBtn, !!saved.minimized);

    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nextMinimized = !panel.classList.contains('is-minimized');
      setPanelMinimized(panel, closeBtn, nextMinimized);
      clampPanelToViewport(panel);
      savePanelState({ minimized: nextMinimized });
    });

    bubble.addEventListener('click', (e) => {
      if (!panel.classList.contains('is-minimized')) return;
      if (Date.now() < state.ignorePanelClickUntil) return;
      setPanelMinimized(panel, closeBtn, false);
      clampPanelToViewport(panel);
      savePanelState({ minimized: false });
    });

    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;

      if (a === 'add-am') runTask('AM付番', () => runPhase2('add', 'am'));
      else if (a === 'add-pm') runTask('PM付番', () => runPhase2('add', 'pm'));
      else if (a === 'remove-am') runTask('AM番削', () => runPhase2('remove', 'am'));
      else if (a === 'remove-pm') runTask('PM番削', () => runPhase2('remove', 'pm'));
    });

    // drag（パネル全体からドラッグ可能、ボタン・ステータス以外）
    let dragging = false, dx = 0, dy = 0, moved = false;
    panel.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      dragging = true;
      moved = false;
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      panel.style.left = `${r.left}px`;
      panel.style.top = `${r.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging || !document.body.contains(panel)) return;
      if (Math.abs(e.movementX) > 0 || Math.abs(e.movementY) > 0) moved = true;
      panel.style.left = `${e.clientX - dx}px`;
      panel.style.top = `${e.clientY - dy}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (!document.body.contains(panel)) return;
      clampPanelToViewport(panel);
      const r = panel.getBoundingClientRect();
      savePanelState({ left: r.left, top: r.top });
      if (moved) state.ignorePanelClickUntil = Date.now() + 250;
    });

    if (typeof saved.left === 'number' && typeof saved.top === 'number') {
      panel.style.left = `${saved.left}px`;
      panel.style.top = `${saved.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      clampPanelToViewport(panel);
    }

    updateUiBusy();
  }

  function boot() {
    createPanel();
    setStatus('準備完了', 'info');
    log('v1.3.0 loaded');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
