// ==UserScript==
// @name         DigiKar 患者メモ→受付メモ 自動転記
// @namespace    https://digikar.jp/
// @version      1.1.0
// @description  受付一覧を開いた直後に、患者メモを受付メモへ自動転記し、差分があれば既存の受付メモも上書きします。左下のガラス調パネルはドラッグ移動できます。
// @match        https://digikar.jp/reception*
// @match        https://digikar.jp/reception/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  if (window.__DIGIKAR_PATIENT_TO_RECEPTION_AUTO__) return;
  window.__DIGIKAR_PATIENT_TO_RECEPTION_AUTO__ = true;

  const APP = { id: 'dk-patient-to-reception-auto', key: 'dk-patient-to-reception-auto-v2', log: '[DKPatientToReception]' };
  const HEADERS = { reservation: '予約', time: '時間', no: '患者番号', name: '患者氏名', patientMemo: '患者メモ', receptionMemo: '受付メモ' };
  const CFG = {
    scanSettleMs: 180, waitMs: 100, maxScanLoops: 2000, maxProcessLoops: 6000,
    openTimeoutMs: 8000, closeTimeoutMs: 8000, tableTimeoutMs: 30000,
    routeWatchMs: 700, autoDelayMs: 1000, edge: 8, left: 12, bottom: 12,
  };
  const SEL = {
    tables: 'table',
    editBtns: [
      'button.edit-icon', 'button[class*="edit"]', 'button[class*="pencil"]',
      'button[aria-label*="編集"]', 'button[aria-label*="メモ"]',
      'button[title*="編集"]', 'button[title*="メモ"]',
      'button[data-testid*="edit"]', 'button[data-testid*="memo"]',
    ].join(','),
    overlays: ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[data-state="open"]', '[data-radix-portal] *'].join(','),
  };
  const state = { running: false, autoEnabled: true, ui: null, lastSeenRoute: '', lastDoneRoute: '', lastRow: '', autoTimer: 0, routeTimer: 0, resizeBound: false };

  const log = (...a) => console.log(APP.log, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const normalize = (v) => String(v ?? '').replace(/\s+/g, '');
  const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const memo = (v) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const blank = (v) => text(v).length === 0;

  function loadState() { try { return JSON.parse(localStorage.getItem(APP.key) || '{}'); } catch { return {}; } }
  function saveState(partial) { try { localStorage.setItem(APP.key, JSON.stringify({ ...loadState(), ...partial })); } catch {} }
  async function waitFor(getter, { timeoutMs = 5000, intervalMs = CFG.waitMs, name = 'condition' } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { const v = getter(); if (v) return v; } catch {}
      await sleep(intervalMs);
    }
    throw new Error(`${name} が見つかりません`);
  }
  function visible(el) { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function click(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch {}
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
  }
  function scrollableY(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const cs = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4;
  }
  function tableScrollEl(table) {
    let el = table.parentElement;
    while (el && el !== document.body) { if (scrollableY(el)) return el; el = el.parentElement; }
    return document.scrollingElement || document.documentElement;
  }
  function rows(table) {
    const out = [];
    for (const tbody of Array.from(table.tBodies || [])) out.push(...Array.from(tbody.rows || []));
    return out;
  }
  function visibleRows(table) {
    return rows(table)
      .filter((row) => row?.cells?.length)
      .filter((row) => { const r = row.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }
  function headerRow(table) { const thead = table.tHead; return thead ? Array.from(thead.rows || []).find((tr) => tr.cells?.length) || null : null; }
  function columnMap(table) {
    const row = headerRow(table); if (!row) return null;
    const headers = Array.from(row.cells || []).map((th) => normalize(th.textContent));
    const hit = (label) => { const exact = headers.findIndex((t) => t === label); return exact >= 0 ? exact : headers.findIndex((t) => t.startsWith(label)); };
    const reservationIdx = (() => { const r = hit(HEADERS.reservation); return r >= 0 ? r : hit(HEADERS.time); })();
    const noIdx = hit(HEADERS.no), nameIdx = hit(HEADERS.name), patientMemoIdx = hit(HEADERS.patientMemo), receptionMemoIdx = hit(HEADERS.receptionMemo);
    if ([reservationIdx, noIdx, patientMemoIdx, receptionMemoIdx].some((i) => i < 0)) return null;
    return { reservationIdx, noIdx, nameIdx, patientMemoIdx, receptionMemoIdx };
  }
  function findCtx() {
    const candidates = [];
    for (const table of Array.from(document.querySelectorAll(SEL.tables))) {
      const rect = table.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 40) continue;
      const cols = columnMap(table); if (!cols) continue;
      const count = rows(table).length; if (!count) continue;
      candidates.push({ table, cols, count, top: rect.top });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.count - a.count || a.top - b.top);
    return { table: candidates[0].table, cols: candidates[0].cols, scrollEl: tableScrollEl(candidates[0].table) };
  }
  function ctxOrThrow() { const ctx = findCtx(); if (!ctx) throw new Error('受付一覧テーブルを特定できません'); return ctx; }
  function readRow(row, ctx) {
    const cells = row.cells, cols = ctx.cols;
    const reservationTd = cells[cols.reservationIdx], noTd = cells[cols.noIdx], nameTd = cols.nameIdx >= 0 ? cells[cols.nameIdx] : null;
    const patientMemoTd = cells[cols.patientMemoIdx], receptionMemoTd = cells[cols.receptionMemoIdx];
    if (!reservationTd || !noTd || !patientMemoTd || !receptionMemoTd) return null;
    const reservation = text(reservationTd.textContent);
    const patientNo = text(noTd.textContent).replace(/\s+/g, '');
    const patientName = text(nameTd?.textContent) || text(row.querySelector('a')?.textContent) || text(row.textContent).slice(0, 30);
    if (!patientNo || patientNo === '-') return null;
    return {
      row, reservation, patientNo, patientName, patientMemoTd, receptionMemoTd,
      patientMemo: memo(patientMemoTd.textContent), receptionMemo: memo(receptionMemoTd.textContent),
      key: `${reservation}|${patientNo}|${patientName}`,
    };
  }
  const setScrollTop = (el, v) => { el.scrollTop = Math.max(0, v); };
  const atBottom = (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 4;

  async function scanAll(ctx, label) {
    const map = new Map();
    setScrollTop(ctx.scrollEl, 0);
    await sleep(CFG.scanSettleMs * 2);
    let bottomNoNew = 0, noMove = 0;
    for (let loop = 0; loop < CFG.maxScanLoops; loop += 1) {
      await sleep(CFG.scanSettleMs);
      const before = map.size;
      for (const row of visibleRows(ctx.table)) {
        const snap = readRow(row, ctx);
        if (!snap) continue;
        map.set(snap.key, snap);
      }
      const foundNew = map.size - before;
      setStatus(`${label}: ${map.size}件走査`, 'info');
      const bottom = atBottom(ctx.scrollEl);
      if (bottom) { bottomNoNew = foundNew === 0 ? bottomNoNew + 1 : 0; if (bottomNoNew >= 2) break; }
      const prevTop = ctx.scrollEl.scrollTop;
      const step = Math.max(Math.floor(ctx.scrollEl.clientHeight * 0.7), 220);
      setScrollTop(ctx.scrollEl, Math.min(prevTop + step, ctx.scrollEl.scrollHeight));
      if (ctx.scrollEl.scrollTop === prevTop) { noMove += 1; if (bottom || noMove >= 5) break; } else noMove = 0;
    }
    return map;
  }

  function buildSelections(map) {
    const all = Array.from(map.values());
    const withPatientMemo = all.filter((r) => !blank(r.patientMemo));
    const sameMemo = withPatientMemo.filter((r) => normalize(r.patientMemo) === normalize(r.receptionMemo));
    const blankTargets = withPatientMemo.filter((r) => blank(r.receptionMemo));
    const overwriteTargets = withPatientMemo.filter((r) => !blank(r.receptionMemo) && normalize(r.patientMemo) !== normalize(r.receptionMemo));
    const targets = withPatientMemo.filter((r) => normalize(r.patientMemo) !== normalize(r.receptionMemo));
    return { all, withPatientMemo, sameMemo, blankTargets, overwriteTargets, targets };
  }

  function activeEditor() {
    const el = document.activeElement;
    if (!el) return null;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) return el;
    return null;
  }
  function editorInCell(cell) { return Array.from(cell.querySelectorAll('textarea,input,[contenteditable="true"]')).find(visible) || null; }
  function setValue(el, value) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  function saveBtn(editor) {
    const labels = ['保存', '更新', 'OK', '確定', '登録', '適用'];
    const match = (root) => Array.from(root.querySelectorAll('button')).find((btn) => labels.includes(String(btn.innerText || btn.textContent || '').trim()));
    let p = editor?.parentElement;
    for (let i = 0; i < 12 && p; i += 1) { const hit = match(p); if (hit) return hit; p = p.parentElement; }
    for (const overlay of Array.from(document.querySelectorAll(SEL.overlays)).filter(visible)) { const hit = match(overlay); if (hit) return hit; }
    return null;
  }
  async function waitEditorOpen(cell) { return waitFor(() => activeEditor() || editorInCell(cell), { timeoutMs: CFG.openTimeoutMs, name: '受付メモエディタ' }); }
  async function waitEditorClose(prev) {
    await waitFor(() => { const cur = activeEditor(); return !cur || cur !== prev; }, { timeoutMs: CFG.closeTimeoutMs, name: '受付メモエディタ終了' }).catch(() => {});
  }
  function findEditBtn(cell) {
    cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    cell.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
    cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
    const direct = cell.querySelector(SEL.editBtns); if (direct && visible(direct)) return direct;
    const row = cell.closest('tr'); if (!row) return null;
    const rect = cell.getBoundingClientRect();
    return Array.from(row.querySelectorAll('button')).filter(visible)
      .map((btn) => {
        const r = btn.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const inside = cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
        const dx = Math.max(0, rect.left - cx, cx - rect.right), dy = Math.max(0, rect.top - cy, cy - rect.bottom);
        const hint = (btn.getAttribute('aria-label') || '') + (btn.getAttribute('title') || '') + (btn.className || '') + (btn.getAttribute('data-testid') || '');
        return { btn, inside, dist: Math.hypot(dx, dy), ok: /メモ|編集|edit|pencil/i.test(hint) };
      })
      .filter((x) => x.ok).sort((a, b) => (b.inside - a.inside) || (a.dist - b.dist))[0]?.btn || null;
  }
  async function openEditor(cell, ctx, key) {
    let currentCell = cell;
    currentCell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    await sleep(120);
    if (ctx && key) {
      for (const row of visibleRows(ctx.table)) {
        const snap = readRow(row, ctx);
        if (snap && snap.key === key) { currentCell = snap.receptionMemoTd; break; }
      }
    }
    click(currentCell);
    await sleep(60);
    currentCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    await sleep(80);
    currentCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    currentCell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
    if (!activeEditor() && !editorInCell(currentCell)) {
      const btn = findEditBtn(currentCell);
      if (btn) { click(btn); await sleep(120); if (!activeEditor() && !editorInCell(currentCell)) click(btn); }
    }
    return waitEditorOpen(currentCell);
  }
  async function closeEditor(editor) {
    try {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, cancelable: true }));
    } catch {}
    try { editor.blur?.(); } catch {}
    try { document.body.click(); } catch {}
    await waitEditorClose(editor);
  }
  async function editReceptionMemo(snap, desired, ctx) {
    const editor = await openEditor(snap.receptionMemoTd, ctx, snap.key);
    const before = memo(editor.value ?? editor.textContent ?? ''), after = memo(desired);
    if (before === after) { await closeEditor(editor); return false; }
    setValue(editor, after);
    await sleep(CFG.postInputWaitMs || 80);
    const btn = saveBtn(editor);
    if (btn) { click(btn); await sleep(120); }
    else {
      try {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
      } catch {}
    }
    await closeEditor(editor);
    return true;
  }

  async function processTargets(ctx, targetMap) {
    const processed = new Set();
    let updatedCount = 0, bottomNoProgress = 0;
    setScrollTop(ctx.scrollEl, 0);
    await sleep(CFG.scanSettleMs * 2);
    for (let loop = 0; loop < CFG.maxProcessLoops; loop += 1) {
      await sleep(CFG.scanSettleMs);
      const list = visibleRows(ctx.table);
      let progressed = false;
      for (const row of list) {
        const snap = readRow(row, ctx);
        if (!snap || !targetMap.has(snap.key) || processed.has(snap.key)) continue;
        const target = targetMap.get(snap.key);
        if (!target || blank(target.patientMemo)) { processed.add(snap.key); continue; }
        state.lastRow = `${snap.reservation} / ${snap.patientNo} ${snap.patientName}`.trim();
        setStatus(`転記 ${processed.size + 1}/${targetMap.size}: ${state.lastRow}`, 'info');
        if (await editReceptionMemo(snap, target.patientMemo, ctx)) updatedCount += 1;
        processed.add(snap.key);
        progressed = true;
        if (processed.size >= targetMap.size) return { updatedCount, processedCount: processed.size };
      }
      const bottom = atBottom(ctx.scrollEl);
      if (!progressed) {
        if (bottom) { bottomNoProgress += 1; if (bottomNoProgress >= 2) throw new Error(`転記対象の一部を見失いました（残り ${targetMap.size - processed.size} 件）`); }
        else bottomNoProgress = 0;
        const prevTop = ctx.scrollEl.scrollTop;
        const step = Math.max(Math.floor(ctx.scrollEl.clientHeight * 0.7), 220);
        setScrollTop(ctx.scrollEl, Math.min(prevTop + step, ctx.scrollEl.scrollHeight));
      } else bottomNoProgress = 0;
    }
    throw new Error('転記処理が上限ループに達しました');
  }

  function routeKey() {
    const match = location.pathname.match(/^\/reception(?:\/(\d{8}))?/);
    return match ? `/reception/${match[1] || 'today'}` : `${location.pathname}${location.search}`;
  }
  async function syncCurrentRoute(key) {
    await waitFor(() => findCtx(), { timeoutMs: CFG.tableTimeoutMs, name: '受付一覧テーブル' });
    const ctx = ctxOrThrow();
    const selections = buildSelections(await scanAll(ctx, '一覧走査'));
    const targetMap = new Map(selections.targets.map((item) => [item.key, item]));
    if (!targetMap.size) {
      state.lastDoneRoute = key;
      return { level: 'info', message: `全件同期済み / 同一内容 ${selections.sameMemo.length}件` };
    }
    const result = await processTargets(ctx, targetMap);
    state.lastDoneRoute = key;
    return { level: 'success', message: `転記完了 ${result.updatedCount}件 / 上書き ${selections.overwriteTargets.length}件 / 新規 ${selections.blankTargets.length}件` };
  }

  function setStatus(message, level = 'info') {
    if (!state.ui?.status) return;
    state.ui.status.textContent = message;
    state.ui.status.dataset.level = level;
  }
  function updateUiBusy() {
    if (!state.ui) return;
    state.ui.run.disabled = state.running;
    state.ui.toggle.disabled = state.running;
    state.ui.run.textContent = state.running ? '転記中...' : '今すぐ転記';
    state.ui.toggle.textContent = state.autoEnabled ? 'AUTO ON' : 'AUTO OFF';
    state.ui.toggle.dataset.enabled = state.autoEnabled ? 'true' : 'false';
  }
  async function runTask(label, fn) {
    if (state.running) return;
    state.running = true;
    updateUiBusy();
    setStatus(`${label}を開始`, 'info');
    try {
      const result = await fn();
      if (result?.message) setStatus(result.message, result.level || 'info');
    } catch (error) {
      console.error(APP.log, error);
      setStatus(`エラー: ${error?.message || error}${state.lastRow ? ` / ${state.lastRow}` : ''}`, 'error');
    } finally {
      state.running = false;
      updateUiBusy();
    }
  }
  function clearAutoTimer() { if (!state.autoTimer) return; clearTimeout(state.autoTimer); state.autoTimer = 0; }
  function scheduleAutoRun(reason) {
    if (!state.autoEnabled || state.running) return;
    const key = routeKey();
    if (state.lastDoneRoute === key) return;
    clearAutoTimer();
    state.autoTimer = window.setTimeout(() => {
      state.autoTimer = 0;
      if (!state.autoEnabled || state.running) return;
      runTask('患者メモ→受付メモ 自動転記', () => syncCurrentRoute(key));
    }, CFG.autoDelayMs);
    log(`auto scheduled: ${reason} / ${key}`);
  }

  function clampPanel(panel) {
    const r = panel.getBoundingClientRect();
    const left = Math.min(Math.max(CFG.edge, r.left), Math.max(CFG.edge, window.innerWidth - r.width - CFG.edge));
    const top = Math.min(Math.max(CFG.edge, r.top), Math.max(CFG.edge, window.innerHeight - r.height - CFG.edge));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }
  function persistPanel(panel) {
    const r = panel.getBoundingClientRect();
    saveState({ panelLeft: Math.round(r.left), panelTop: Math.round(r.top) });
  }
  function restorePanel(panel) {
    const saved = loadState();
    if (typeof saved.panelLeft === 'number' && typeof saved.panelTop === 'number') {
      panel.style.left = `${saved.panelLeft}px`;
      panel.style.top = `${saved.panelTop}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      clampPanel(panel);
      return;
    }
    panel.style.left = `${CFG.left}px`;
    panel.style.bottom = `${CFG.bottom}px`;
    panel.style.right = 'auto';
    panel.style.top = 'auto';
  }
  function enableDrag(panel, handle) {
    let dragging = false, dx = 0, dy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      dragging = true; dx = e.clientX - r.left; dy = e.clientY - r.top;
      panel.style.left = `${r.left}px`; panel.style.top = `${r.top}px`; panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.dataset.dragging = 'true'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging || !document.body.contains(panel)) return;
      panel.style.left = `${e.clientX - dx}px`;
      panel.style.top = `${e.clientY - dy}px`;
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; panel.dataset.dragging = 'false';
      if (!document.body.contains(panel)) return;
      clampPanel(panel); persistPanel(panel);
    });
  }
  function bindResizeClamp(panel) {
    if (state.resizeBound) return;
    state.resizeBound = true;
    window.addEventListener('resize', () => {
      if (!document.body.contains(panel)) return;
      if (panel.style.top && panel.style.top !== 'auto') { clampPanel(panel); persistPanel(panel); }
    });
  }

  function createPanel() {
    if (document.getElementById(APP.id)) return;
    const style = document.createElement('style');
    style.textContent = `
#${APP.id}{position:fixed;left:${CFG.left}px;bottom:${CFG.bottom}px;width:196px;padding:10px;border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.05));border:1px solid rgba(255,255,255,.34);box-shadow:0 18px 40px rgba(4,24,16,.18),inset 0 1px 0 rgba(255,255,255,.28);backdrop-filter:blur(16px) saturate(145%);-webkit-backdrop-filter:blur(16px) saturate(145%);z-index:2147483000;font-family:"Yu Gothic UI","Meiryo",sans-serif;overflow:hidden}
#${APP.id}::before{content:"";position:absolute;inset:1px;border-radius:16px;border:1px solid rgba(16,82,50,.18);pointer-events:none}
#${APP.id}[data-dragging="true"]{box-shadow:0 22px 44px rgba(4,24,16,.24),inset 0 1px 0 rgba(255,255,255,.28)}
#${APP.id} .dk-head{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px;padding:4px 2px 2px;cursor:grab;user-select:none}
#${APP.id}[data-dragging="true"] .dk-head{cursor:grabbing}
#${APP.id} .dk-title-wrap{display:flex;flex-direction:column;gap:2px}
#${APP.id} .dk-title{margin:0;font-size:11px;font-weight:800;letter-spacing:.08em;color:#effaf2;text-shadow:0 1px 10px rgba(0,0,0,.12)}
#${APP.id} .dk-sub{font-size:10px;color:rgba(239,250,242,.72)}
#${APP.id} .dk-grip{display:grid;grid-template-columns:repeat(2,4px);gap:4px;padding:4px}
#${APP.id} .dk-grip span{width:4px;height:4px;border-radius:50%;background:rgba(239,250,242,.62);box-shadow:0 0 8px rgba(239,250,242,.18)}
#${APP.id} .dk-body{position:relative;z-index:1}
#${APP.id} .dk-btn{width:100%;height:38px;margin:0 0 8px;border:1px solid rgba(255,255,255,.26);border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;background:rgba(255,255,255,.08);color:#f7fff9;box-shadow:inset 0 1px 0 rgba(255,255,255,.16);backdrop-filter:blur(10px)}
#${APP.id} .dk-btn:disabled{opacity:.6;cursor:not-allowed}
#${APP.id} .dk-btn-auto[data-enabled="true"]{background:rgba(29,143,81,.24);border-color:rgba(102,255,176,.38);box-shadow:0 0 18px rgba(29,143,81,.18),inset 0 1px 0 rgba(255,255,255,.18)}
#${APP.id} .dk-btn-auto[data-enabled="false"]{background:rgba(107,114,128,.2);border-color:rgba(203,213,225,.26)}
#${APP.id} .dk-btn-run{background:rgba(255,255,255,.06)}
#${APP.id} .dk-status{padding:8px 9px;border-radius:12px;font-size:11px;line-height:1.45;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.18);color:#f7fff9;white-space:pre-wrap;word-break:break-word}
#${APP.id} .dk-status[data-level="success"]{color:#c9ffd8}
#${APP.id} .dk-status[data-level="warn"]{color:#ffe1a8}
#${APP.id} .dk-status[data-level="error"]{color:#ffd0cf}
`;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = APP.id;
    panel.innerHTML = `
<div class="dk-head" data-ui="drag">
  <div class="dk-title-wrap">
    <div class="dk-title">患者メモ → 受付メモ</div>
    <div class="dk-sub">drag to move</div>
  </div>
  <div class="dk-grip" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
</div>
<div class="dk-body">
  <button type="button" class="dk-btn dk-btn-auto" data-ui="toggle"></button>
  <button type="button" class="dk-btn dk-btn-run" data-ui="run">今すぐ転記</button>
  <div class="dk-status" data-ui="status">待機中</div>
</div>`;
    document.body.appendChild(panel);

    const drag = panel.querySelector('[data-ui="drag"]');
    const toggle = panel.querySelector('[data-ui="toggle"]');
    const run = panel.querySelector('[data-ui="run"]');
    const status = panel.querySelector('[data-ui="status"]');

    toggle.addEventListener('click', () => {
      state.autoEnabled = !state.autoEnabled;
      saveState({ autoEnabled: state.autoEnabled });
      if (!state.autoEnabled) { clearAutoTimer(); setStatus('AUTO OFF', 'warn'); }
      else { state.lastDoneRoute = ''; setStatus('AUTO ON', 'success'); scheduleAutoRun('toggle-on'); }
      updateUiBusy();
    });
    run.addEventListener('click', () => {
      state.lastDoneRoute = '';
      runTask('患者メモ→受付メモ 手動転記', () => syncCurrentRoute(routeKey()));
    });

    restorePanel(panel);
    enableDrag(panel, drag);
    bindResizeClamp(panel);
    state.ui = { panel, drag, toggle, run, status };
    updateUiBusy();
  }

  function watchRoute() {
    state.lastSeenRoute = routeKey();
    state.routeTimer = window.setInterval(() => {
      const current = routeKey();
      if (current === state.lastSeenRoute) return;
      state.lastSeenRoute = current;
      state.lastDoneRoute = '';
      setStatus(`日付変更を検知: ${current}`, 'info');
      scheduleAutoRun('route-change');
    }, CFG.routeWatchMs);
  }

  function boot() {
    const saved = loadState();
    state.autoEnabled = saved.autoEnabled !== false;
    createPanel();
    setStatus(state.autoEnabled ? 'AUTO ON / ページ待機中' : 'AUTO OFF', state.autoEnabled ? 'success' : 'warn');
    updateUiBusy();
    watchRoute();
    if (state.autoEnabled) scheduleAutoRun('initial-load');
    log('loaded');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
