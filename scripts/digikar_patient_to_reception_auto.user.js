// ==UserScript==
// @name         DigiKar 患者メモ→受付メモ 手動転記
// @namespace    https://digikar.jp/
// @version      2.0.0
// @description  START を押した時だけ、未転記の受付メモへ患者メモを転記します。番号カードは保持し、左下パネルは折りたたみ・ドラッグ移動できます。
// @match        https://digikar.jp/reception*
// @match        https://digikar.jp/reception/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  if (window.__DIGIKAR_PATIENT_TO_RECEPTION_MANUAL__) return;
  window.__DIGIKAR_PATIENT_TO_RECEPTION_MANUAL__ = true;

  const APP = { id: 'dk-patient-to-reception-manual', key: 'dk-patient-to-reception-manual-v1', log: '[DKPatientToReceptionManual]' };
  const HEADERS = { reservation: '予約', time: '時間', no: '患者番号', name: '患者氏名', patientMemo: '患者メモ', receptionMemo: '受付メモ' };
  const CFG = {
    waitMs: 100, scanSettleMs: 180, postInputMs: 80, postClickMs: 120,
    openTimeoutMs: 8000, closeTimeoutMs: 8000, tableTimeoutMs: 30000,
    maxScanLoops: 2000, maxFindLoops: 3000, edgePx: 8, leftPx: 12, bottomPx: 12,
  };
  const SEL = {
    table: 'table',
    editButtons: [
      'button.edit-icon', 'button[class*="edit"]', 'button[class*="pencil"]',
      'button[aria-label*="編集"]', 'button[aria-label*="メモ"]',
      'button[title*="編集"]', 'button[title*="メモ"]',
      'button[data-testid*="edit"]', 'button[data-testid*="memo"]',
    ].join(','),
    overlays: ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[data-state="open"]', '[data-radix-portal] *'].join(','),
  };

  const state = {
    running: false,
    stopRequested: false,
    resizeBound: false,
    lastRowLabel: '',
    ui: null,
  };

  const log = (...args) => console.log(APP.log, ...args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => String(value ?? '').replace(/\s+/g, '');
  const flatText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const memoText = (value) =>
    String(value ?? '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  const isBlank = (value) => flatText(value).length === 0;

  function loadState() {
    try { return JSON.parse(localStorage.getItem(APP.key) || '{}'); } catch { return {}; }
  }

  function saveState(partial) {
    try { localStorage.setItem(APP.key, JSON.stringify({ ...loadState(), ...partial })); } catch {}
  }

  async function waitFor(getter, { timeoutMs = 5000, intervalMs = CFG.waitMs, name = 'condition' } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const value = getter();
        if (value) return value;
      } catch {}
      await sleep(intervalMs);
    }
    throw new Error(`${name} が見つかりません`);
  }

  function throwIfStopped() {
    if (!state.stopRequested) return;
    const error = new Error('ユーザー停止');
    error.__userStop = true;
    throw error;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function safeClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch {}
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
  }

  function isScrollableY(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const cs = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4;
  }

  function findScrollContainer(table) {
    let el = table.parentElement;
    while (el && el !== document.body) {
      if (isScrollableY(el)) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function getDataRows(table) {
    const out = [];
    for (const tbody of Array.from(table.tBodies || [])) out.push(...Array.from(tbody.rows || []));
    return out;
  }

  function getVisibleRows(table) {
    return getDataRows(table)
      .filter((row) => row?.cells?.length)
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function findHeaderRow(table) {
    const thead = table.tHead;
    if (!thead) return null;
    return Array.from(thead.rows || []).find((tr) => tr.cells?.length) || null;
  }

  function getColumnMap(table) {
    const headerRow = findHeaderRow(table);
    if (!headerRow) return null;
    const headers = Array.from(headerRow.cells || []).map((cell) => normalize(cell.textContent));
    const hit = (label) => {
      const exact = headers.findIndex((text) => text === label);
      return exact >= 0 ? exact : headers.findIndex((text) => text.startsWith(label));
    };
    const reservationIdx = (() => { const idx = hit(HEADERS.reservation); return idx >= 0 ? idx : hit(HEADERS.time); })();
    const noIdx = hit(HEADERS.no);
    const nameIdx = hit(HEADERS.name);
    const patientMemoIdx = hit(HEADERS.patientMemo);
    const receptionMemoIdx = hit(HEADERS.receptionMemo);
    if ([reservationIdx, noIdx, patientMemoIdx, receptionMemoIdx].some((idx) => idx < 0)) return null;
    return { reservationIdx, noIdx, nameIdx, patientMemoIdx, receptionMemoIdx };
  }

  function findTableContext() {
    const candidates = [];
    for (const table of Array.from(document.querySelectorAll(SEL.table))) {
      const rect = table.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 40) continue;
      const cols = getColumnMap(table);
      if (!cols) continue;
      const rowCount = getDataRows(table).length;
      if (!rowCount) continue;
      candidates.push({ table, cols, rowCount, top: rect.top });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.rowCount - a.rowCount || a.top - b.top);
    const best = candidates[0];
    return { table: best.table, cols: best.cols, scrollEl: findScrollContainer(best.table) };
  }

  function getTableContextOrThrow() {
    const ctx = findTableContext();
    if (!ctx) throw new Error('受付一覧テーブルを特定できません');
    return ctx;
  }

  function parseTimeMin(raw) {
    const m = String(raw ?? '').match(/([01]?\d|2[0-3]):([0-5]\d)/);
    if (!m) return Number.POSITIVE_INFINITY;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function splitNumberCard(receiptMemo) {
    const raw = memoText(receiptMemo);
    const match = raw.match(/^(\s*\d{1,3}(?:(?=[\s\u3000.\-:：、]|$)[\s\u3000.\-:：、]*))(.*)$/s);
    if (!match) return { hasCard: false, prefix: '', body: raw };
    return { hasCard: true, prefix: match[1], body: match[2].trim() };
  }

  function containsPatientMemo(receiptMemo, patientMemo) {
    const body = splitNumberCard(receiptMemo).body;
    if (isBlank(body) || isBlank(patientMemo)) return false;
    return normalize(body).includes(normalize(patientMemo));
  }

  function isTransferPending(receiptMemo, patientMemo) {
    return !containsPatientMemo(receiptMemo, patientMemo);
  }

  function mergeBody(existingBody, patientMemo) {
    if (isBlank(existingBody)) return patientMemo;
    if (normalize(existingBody).includes(normalize(patientMemo))) return existingBody;
    return `${patientMemo}\n${existingBody}`;
  }

  function buildDesiredReceipt(currentReceiptMemo, patientMemo) {
    const parts = splitNumberCard(currentReceiptMemo);
    if (!parts.hasCard) return mergeBody(parts.body, patientMemo);
    const joiner = /[\s\u3000.\-:：、]$/.test(parts.prefix) ? '' : ' ';
    return `${parts.prefix}${joiner}${mergeBody(parts.body, patientMemo)}`;
  }

  function readRowSnapshot(row, ctx, displayOrder = 0) {
    const cells = row.cells;
    const reservationTd = cells[ctx.cols.reservationIdx];
    const noTd = cells[ctx.cols.noIdx];
    const nameTd = ctx.cols.nameIdx >= 0 ? cells[ctx.cols.nameIdx] : null;
    const patientMemoTd = cells[ctx.cols.patientMemoIdx];
    const receptionMemoTd = cells[ctx.cols.receptionMemoIdx];
    if (!reservationTd || !noTd || !patientMemoTd || !receptionMemoTd) return null;

    const reservation = flatText(reservationTd.textContent);
    const patientNo = flatText(noTd.textContent).replace(/\s+/g, '');
    const patientName =
      flatText(nameTd?.textContent) ||
      flatText(row.querySelector('a')?.textContent) ||
      flatText(row.textContent).slice(0, 30);
    if (!patientNo || patientNo === '-') return null;

    return {
      key: `${reservation}|${patientNo}|${patientName}`,
      reservation,
      patientNo,
      patientName,
      patientMemo: memoText(patientMemoTd.textContent),
      receptionMemo: memoText(receptionMemoTd.textContent),
      patientMemoTd,
      receptionMemoTd,
      timeMin: parseTimeMin(reservation),
      displayOrder,
    };
  }

  function setScrollTop(scrollEl, value) {
    scrollEl.scrollTop = Math.max(0, value);
  }

  function isAtBottom(scrollEl) {
    return scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;
  }

  async function scanAllRows(ctx) {
    const map = new Map();
    let displayOrder = 0;
    setScrollTop(ctx.scrollEl, 0);
    await sleep(CFG.scanSettleMs * 2);

    let bottomNoNew = 0;
    let noMove = 0;

    for (let loop = 0; loop < CFG.maxScanLoops; loop += 1) {
      throwIfStopped();
      await sleep(CFG.scanSettleMs);

      const beforeSize = map.size;
      for (const row of getVisibleRows(ctx.table)) {
        const snap = readRowSnapshot(row, ctx, displayOrder + 1);
        if (!snap) continue;
        displayOrder += 1;
        const prev = map.get(snap.key);
        map.set(snap.key, prev ? { ...snap, displayOrder: prev.displayOrder } : snap);
      }

      setStatus(`一覧走査: ${map.size}件`, 'info');
      const foundNew = map.size - beforeSize;
      const bottom = isAtBottom(ctx.scrollEl);
      if (bottom) {
        bottomNoNew = foundNew === 0 ? bottomNoNew + 1 : 0;
        if (bottomNoNew >= 2) break;
      }

      const prevTop = ctx.scrollEl.scrollTop;
      const step = Math.max(Math.floor(ctx.scrollEl.clientHeight * 0.7), 220);
      setScrollTop(ctx.scrollEl, Math.min(prevTop + step, ctx.scrollEl.scrollHeight));

      if (ctx.scrollEl.scrollTop === prevTop) {
        noMove += 1;
        if (bottom || noMove >= 5) break;
      } else {
        noMove = 0;
      }
    }

    return map;
  }

  function buildSelections(metaMap) {
    const withPatientMemo = Array.from(metaMap.values()).filter((item) => !isBlank(item.patientMemo));
    const targets = withPatientMemo
      .filter((item) => isTransferPending(item.receptionMemo, item.patientMemo))
      .sort((a, b) => a.timeMin - b.timeMin || a.displayOrder - b.displayOrder);
    const sameOrDone = withPatientMemo.length - targets.length;
    return { withPatientMemo, targets, sameOrDone };
  }

  function getActiveEditor() {
    const el = document.activeElement;
    if (!el) return null;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) return el;
    return null;
  }

  function findEditorInCell(cell) {
    return Array.from(cell.querySelectorAll('textarea, input, [contenteditable="true"]')).find(isVisible) || null;
  }

  function setEditorValue(editor, value) {
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      const proto = Object.getPrototypeOf(editor);
      const setter =
        Object.getOwnPropertyDescriptor(proto, 'value')?.set ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(editor, value);
      else editor.value = value;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    editor.textContent = value;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function findSaveButton(editor) {
    const labels = ['保存', '更新', 'OK', '確定', '登録', '適用'];
    const findInRoot = (root) => Array.from(root.querySelectorAll('button')).find((btn) => labels.includes(String(btn.innerText || btn.textContent || '').trim()));
    let parent = editor?.parentElement;
    for (let i = 0; i < 12 && parent; i += 1) {
      const hit = findInRoot(parent);
      if (hit) return hit;
      parent = parent.parentElement;
    }
    for (const overlay of Array.from(document.querySelectorAll(SEL.overlays)).filter(isVisible)) {
      const hit = findInRoot(overlay);
      if (hit) return hit;
    }
    return null;
  }

  async function waitEditorOpen(cell) {
    return waitFor(() => getActiveEditor() || findEditorInCell(cell), { timeoutMs: CFG.openTimeoutMs, name: '受付メモエディタ' });
  }

  async function waitEditorClose(prevEditor) {
    await waitFor(() => {
      const current = getActiveEditor();
      return !current || current !== prevEditor;
    }, { timeoutMs: CFG.closeTimeoutMs, name: '受付メモエディタ終了' }).catch(() => {});
  }

  function findEditButton(cell) {
    cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    cell.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
    cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
    const direct = cell.querySelector(SEL.editButtons);
    if (direct && isVisible(direct)) return direct;

    const row = cell.closest('tr');
    if (!row) return null;
    const cellRect = cell.getBoundingClientRect();

    return Array.from(row.querySelectorAll('button')).filter(isVisible)
      .map((btn) => {
        const rect = btn.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const inside = cx >= cellRect.left && cx <= cellRect.right && cy >= cellRect.top && cy <= cellRect.bottom;
        const dx = Math.max(0, cellRect.left - cx, cx - cellRect.right);
        const dy = Math.max(0, cellRect.top - cy, cy - cellRect.bottom);
        const hint = (btn.getAttribute('aria-label') || '') + (btn.getAttribute('title') || '') + (btn.className || '') + (btn.getAttribute('data-testid') || '');
        return { btn, inside, dist: Math.hypot(dx, dy), ok: /メモ|編集|edit|pencil/i.test(hint) };
      })
      .filter((item) => item.ok)
      .sort((a, b) => (b.inside - a.inside) || (a.dist - b.dist))[0]?.btn || null;
  }

  async function openEditorFromCell(cell, ctx, targetKey) {
    let currentCell = cell;
    currentCell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    await sleep(CFG.postClickMs);

    for (const row of getVisibleRows(ctx.table)) {
      const snap = readRowSnapshot(row, ctx);
      if (snap && snap.key === targetKey) {
        currentCell = snap.receptionMemoTd;
        break;
      }
    }

    safeClick(currentCell);
    await sleep(60);
    currentCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    await sleep(80);
    currentCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    currentCell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));

    if (!getActiveEditor() && !findEditorInCell(currentCell)) {
      const editButton = findEditButton(currentCell);
      if (editButton) {
        safeClick(editButton);
        await sleep(120);
        if (!getActiveEditor() && !findEditorInCell(currentCell)) safeClick(editButton);
      }
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

  async function editRow(ctx, snap, patientMemo) {
    if (!isTransferPending(snap.receptionMemo, patientMemo)) return { skipped: true, reason: 'same' };
    const desired = buildDesiredReceipt(snap.receptionMemo, patientMemo);
    if (memoText(desired) === memoText(snap.receptionMemo)) return { skipped: true, reason: 'same' };

    const editor = await openEditorFromCell(snap.receptionMemoTd, ctx, snap.key);
    const before = memoText(editor.value ?? editor.textContent ?? '');
    if (!isTransferPending(before, patientMemo)) {
      await closeEditor(editor);
      return { skipped: true, reason: 'same' };
    }

    const finalText = buildDesiredReceipt(before, patientMemo);
    setEditorValue(editor, finalText);
    await sleep(CFG.postInputMs);

    const saveButton = findSaveButton(editor);
    if (saveButton) {
      safeClick(saveButton);
      await sleep(120);
    } else {
      try {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
      } catch {}
    }

    await closeEditor(editor);
    return { skipped: false };
  }

  async function findAndProcessTarget(ctx, target) {
    setScrollTop(ctx.scrollEl, 0);
    await sleep(CFG.scanSettleMs * 2);

    let bottomNoHit = 0;
    for (let loop = 0; loop < CFG.maxFindLoops; loop += 1) {
      throwIfStopped();
      await sleep(CFG.scanSettleMs);

      for (const row of getVisibleRows(ctx.table)) {
        const snap = readRowSnapshot(row, ctx);
        if (!snap || snap.key !== target.key) continue;
        return editRow(ctx, snap, target.patientMemo);
      }

      const bottom = isAtBottom(ctx.scrollEl);
      if (bottom) {
        bottomNoHit += 1;
        if (bottomNoHit >= 2) throw new Error(`対象行が見つかりません: ${target.patientNo}`);
      } else {
        bottomNoHit = 0;
      }

      const prevTop = ctx.scrollEl.scrollTop;
      const step = Math.max(Math.floor(ctx.scrollEl.clientHeight * 0.7), 220);
      setScrollTop(ctx.scrollEl, Math.min(prevTop + step, ctx.scrollEl.scrollHeight));
      if (ctx.scrollEl.scrollTop === prevTop && bottom) break;
    }

    throw new Error(`対象行が見つかりません: ${target.patientNo}`);
  }

  async function runTransfer() {
    await waitFor(() => findTableContext(), { timeoutMs: CFG.tableTimeoutMs, name: '受付一覧テーブル' });
    const ctx = getTableContextOrThrow();
    const selections = buildSelections(await scanAllRows(ctx));

    if (!selections.targets.length) {
      return { level: 'info', message: `未転記なし / 対象患者メモ ${selections.withPatientMemo.length}件` };
    }

    let updated = 0;
    let skippedFilled = 0;
    state.stopRequested = false;

    for (let i = 0; i < selections.targets.length; i += 1) {
      throwIfStopped();
      const target = selections.targets[i];
      state.lastRowLabel = `${target.reservation} / ${target.patientNo} ${target.patientName}`.trim();
      setStatus(`START ${i + 1}/${selections.targets.length}: ${state.lastRowLabel}`, 'info');
      const result = await findAndProcessTarget(ctx, target);
      if (result.skipped) skippedFilled += 1;
      else updated += 1;
    }

    return {
      level: 'success',
      message: `完了 ${updated}件 / 未転記対象 ${selections.targets.length}件 / スキップ ${skippedFilled}件`,
    };
  }

  function setStatus(message, level = 'info') {
    if (!state.ui?.status) return;
    state.ui.status.textContent = message;
    state.ui.status.dataset.level = level;
  }

  function updateUi() {
    if (!state.ui) return;
    state.ui.start.disabled = state.running;
    state.ui.stop.disabled = !state.running;
    state.ui.collapse.textContent = state.ui.panel.dataset.collapsed === 'true' ? '▸' : '▾';
  }

  async function startTransfer() {
    if (state.running) return;
    state.running = true;
    state.stopRequested = false;
    updateUi();
    setStatus('START 準備中', 'info');

    try {
      const result = await runTransfer();
      if (result?.message) setStatus(result.message, result.level || 'info');
    } catch (error) {
      if (error?.__userStop) setStatus('STOP しました', 'warn');
      else {
        console.error(APP.log, error);
        setStatus(`エラー: ${error?.message || error}${state.lastRowLabel ? ` / ${state.lastRowLabel}` : ''}`, 'error');
      }
    } finally {
      state.running = false;
      state.stopRequested = false;
      updateUi();
    }
  }

  function stopTransfer() {
    state.stopRequested = true;
    setStatus(state.running ? 'STOP 指示を受け付けました' : '停止中', 'warn');
  }

  function clampPanel(panel) {
    const rect = panel.getBoundingClientRect();
    const left = Math.min(Math.max(CFG.edgePx, rect.left), Math.max(CFG.edgePx, window.innerWidth - rect.width - CFG.edgePx));
    const top = Math.min(Math.max(CFG.edgePx, rect.top), Math.max(CFG.edgePx, window.innerHeight - rect.height - CFG.edgePx));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function persistPanel(panel) {
    const rect = panel.getBoundingClientRect();
    saveState({ panelLeft: Math.round(rect.left), panelTop: Math.round(rect.top), collapsed: panel.dataset.collapsed === 'true' });
  }

  function restorePanel(panel) {
    const saved = loadState();
    panel.dataset.collapsed = saved.collapsed ? 'true' : 'false';
    if (typeof saved.panelLeft === 'number' && typeof saved.panelTop === 'number') {
      panel.style.left = `${saved.panelLeft}px`;
      panel.style.top = `${saved.panelTop}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      clampPanel(panel);
      return;
    }
    panel.style.left = `${CFG.leftPx}px`;
    panel.style.bottom = `${CFG.bottomPx}px`;
    panel.style.right = 'auto';
    panel.style.top = 'auto';
  }

  function enableDrag(panel, handle) {
    let dragging = false;
    let dx = 0;
    let dy = 0;

    handle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      dx = event.clientX - rect.left;
      dy = event.clientY - rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.dataset.dragging = 'true';
      event.preventDefault();
    });

    document.addEventListener('mousemove', (event) => {
      if (!dragging || !document.body.contains(panel)) return;
      panel.style.left = `${event.clientX - dx}px`;
      panel.style.top = `${event.clientY - dy}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      panel.dataset.dragging = 'false';
      if (!document.body.contains(panel)) return;
      clampPanel(panel);
      persistPanel(panel);
    });
  }

  function bindResize(panel) {
    if (state.resizeBound) return;
    state.resizeBound = true;
    window.addEventListener('resize', () => {
      if (!document.body.contains(panel)) return;
      if (panel.style.top && panel.style.top !== 'auto') {
        clampPanel(panel);
        persistPanel(panel);
      }
    });
  }

  function toggleCollapse() {
    const panel = state.ui?.panel;
    if (!panel) return;
    panel.dataset.collapsed = panel.dataset.collapsed === 'true' ? 'false' : 'true';
    persistPanel(panel);
    updateUi();
  }

  function createPanel() {
    if (document.getElementById(APP.id)) return;

    const style = document.createElement('style');
    style.textContent = `
#${APP.id}{
  position:fixed;
  left:${CFG.leftPx}px;
  bottom:${CFG.bottomPx}px;
  width:206px;
  padding:8px;
  border-radius:16px;
  background:transparent;
  border:1px solid rgba(255,255,255,.76);
  box-shadow:0 10px 24px rgba(0,0,0,.18);
  z-index:2147483000;
  font-family:"Yu Gothic UI","Meiryo",sans-serif;
}
#${APP.id}::before{
  content:"";
  position:absolute;
  inset:2px;
  border-radius:12px;
  border:1px solid rgba(255,255,255,.34);
  pointer-events:none;
}
#${APP.id}[data-dragging="true"]{
  box-shadow:0 14px 28px rgba(0,0,0,.24);
}
#${APP.id} .dk-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
  margin:0 0 10px;
  cursor:grab;
  user-select:none;
}
#${APP.id}[data-dragging="true"] .dk-head{cursor:grabbing}
#${APP.id} .dk-flow{
  display:flex;
  align-items:center;
  gap:6px;
  min-height:28px;
  padding:4px 8px;
  border-radius:10px;
  border:1px solid rgba(15,23,42,.12);
  background:rgba(255,255,255,.82);
  box-shadow:0 4px 10px rgba(0,0,0,.08);
}
#${APP.id} .dk-word{
  font-size:13px;
  font-weight:900;
  letter-spacing:.02em;
  text-shadow:none;
}
#${APP.id} .dk-word-patient{
  color:#0f8a5b;
}
#${APP.id} .dk-arrow{
  color:#475569;
  font-size:16px;
  font-weight:900;
  text-shadow:none;
}
#${APP.id} .dk-word-reception{
  color:#2563eb;
}
#${APP.id} .dk-tools{
  display:flex;
  align-items:center;
  gap:6px;
}
#${APP.id} .dk-mini{
  width:28px;
  height:28px;
  border-radius:10px;
  border:1px solid rgba(15,23,42,.12);
  background:rgba(255,255,255,.88);
  color:#334155;
  font-size:16px;
  font-weight:900;
  text-shadow:none;
  box-shadow:0 4px 10px rgba(0,0,0,.08);
  cursor:pointer;
}
#${APP.id} .dk-body{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:8px;
}
#${APP.id}[data-collapsed="true"] .dk-body{display:none}
#${APP.id} .dk-btn{
  min-height:42px;
  border-radius:12px;
  border:2px solid rgba(255,255,255,.72);
  font-size:14px;
  font-weight:900;
  color:#fff;
  cursor:pointer;
  text-shadow:0 1px 6px rgba(0,0,0,.35);
}
#${APP.id} .dk-btn:disabled{opacity:.45;cursor:not-allowed}
#${APP.id} .dk-start{
  background:linear-gradient(180deg, rgba(42,215,124,.96), rgba(19,170,94,.96));
  border-color:rgba(219,255,232,.95);
  box-shadow:0 10px 22px rgba(19,170,94,.34), inset 0 1px 0 rgba(255,255,255,.34);
}
#${APP.id} .dk-stop{
  background:linear-gradient(180deg, rgba(255,96,96,.97), rgba(222,44,44,.97));
  border-color:rgba(255,230,230,.95);
  box-shadow:0 10px 22px rgba(222,44,44,.36), inset 0 1px 0 rgba(255,255,255,.28);
}
#${APP.id} .dk-status{
  grid-column:1 / -1;
  min-height:44px;
  padding:8px 10px;
  border-radius:12px;
  border:1px solid rgba(15,23,42,.12);
  background:rgba(255,255,255,.82);
  color:#111827;
  font-size:11px;
  line-height:1.45;
  text-shadow:none;
  white-space:pre-wrap;
  word-break:break-word;
  box-shadow:0 4px 10px rgba(0,0,0,.08);
}
#${APP.id} .dk-status[data-level="success"]{color:#0f8a5b}
#${APP.id} .dk-status[data-level="warn"]{color:#9a6700}
#${APP.id} .dk-status[data-level="error"]{color:#b42318}
`;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = APP.id;
    panel.innerHTML = `
<div class="dk-head" data-ui="drag">
  <div class="dk-flow">
    <span class="dk-word dk-word-patient">患者メモ</span>
    <span class="dk-arrow">→</span>
    <span class="dk-word dk-word-reception">受付メモ</span>
  </div>
  <div class="dk-tools">
    <button type="button" class="dk-mini" data-ui="collapse" title="折りたたみ"></button>
  </div>
</div>
<div class="dk-body">
  <button type="button" class="dk-btn dk-start" data-ui="start">START</button>
  <button type="button" class="dk-btn dk-stop" data-ui="stop">STOP</button>
  <div class="dk-status" data-ui="status">待機中</div>
</div>`;
    document.body.appendChild(panel);

    const drag = panel.querySelector('[data-ui="drag"]');
    const collapse = panel.querySelector('[data-ui="collapse"]');
    const start = panel.querySelector('[data-ui="start"]');
    const stop = panel.querySelector('[data-ui="stop"]');
    const status = panel.querySelector('[data-ui="status"]');

    collapse.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleCollapse();
    });
    start.addEventListener('click', () => { startTransfer(); });
    stop.addEventListener('click', () => { stopTransfer(); });

    restorePanel(panel);
    enableDrag(panel, drag);
    bindResize(panel);

    state.ui = { panel, collapse, start, stop, status };
    updateUi();
  }

  function boot() {
    createPanel();
    setStatus('START 待機中', 'info');
    updateUi();
    log('loaded');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
