// ==UserScript==
// @name         DigiKar 公費正式化 OCR
// @namespace    https://digikar.jp/
// @version      0.1.0
// @description  カルテ画面から最新の受給者証画像をOCRし、カルテ更新と予約編集の公費を同じ内容で反映する dryRun 初版
// @author       Codex
// @match        https://digikar.jp/*
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    dryRun: true,
    debug: true,
    buttonText: "公費正式化",
    ocrLang: "jpn",
    timeoutMs: 30000,
  };

  const APP = {
    logPrefix: "[DK_KOUHI_FORMALIZER]",
    buttonId: "dk-kouhi-formalize-btn",
    pendingKey: "dk_kouhi_formalize_pending_v1",
    version: "0.1.0",
  };

  const OCR_PATHS = {
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5",
    langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn@1.0.0/4.0.0_best_int",
  };

  const BENEFIT_CODES = ["21", "81", "82", "83", "84"];
  const OTHER_PUBLIC_CODES = ["81", "82", "83", "84"];
  const FILE_ROW_PRIORITY_KEYWORDS = [
    "自立支援医療受給者証",
    "重度心身障害者医療費受給者証",
    "受給者証",
    "精神通院",
    "公費",
  ];
  const RECEPTION_HEADERS = {
    patientNo: "患者番号",
    patientName: "患者氏名",
    insurance: "保険",
  };

  if (window.__DK_KOUHI_FORMALIZER__) return;
  window.__DK_KOUHI_FORMALIZER__ = true;

  let ensureButtonTimer = 0;
  let observerStarted = false;
  let lastLocationHref = location.href;
  let ocrWorkerPromise = null;
  let flowRunning = false;
  let resumeRunning = false;
  let pendingContextForNavigation = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function logStep(step, message, payload) {
    const stamp = new Date().toISOString();
    if (typeof payload === "undefined") {
      console.log(APP.logPrefix, `[${stamp}]`, `[${step}]`, message);
      return;
    }
    console.log(APP.logPrefix, `[${stamp}]`, `[${step}]`, message, payload);
  }

  function debugLog(step, message, payload) {
    if (!CONFIG.debug) return;
    logStep(step, message, payload);
  }

  function fail(message, details) {
    const error = new Error(message);
    error.__dkAlreadyAlerted = true;
    console.error(APP.logPrefix, "[STOP]", message, details || "");
    alert(`${CONFIG.buttonText}: ${message}`);
    throw error;
  }

  async function waitFor(getter, options = {}) {
    const {
      timeoutMs = CONFIG.timeoutMs,
      intervalMs = 80,
      name = "condition",
      root = document.body,
      observeAttributes = false,
    } = options;

    return new Promise((resolve, reject) => {
      const started = Date.now();
      let settled = false;

      const cleanup = () => {
        settled = true;
        clearInterval(poller);
        clearTimeout(timer);
        try {
          observer.disconnect();
        } catch (_) {
          // ignore
        }
      };

      const check = () => {
        if (settled) return;
        try {
          const value = getter();
          if (value) {
            cleanup();
            resolve(value);
          }
        } catch (_) {
          // ignore getter errors while waiting
        }
      };

      const observer = new MutationObserver(check);
      if (root) {
        observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: observeAttributes,
        });
      }

      const poller = setInterval(check, intervalMs);
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`waitFor timeout: ${name} (${Date.now() - started}ms)`));
      }, timeoutMs);

      check();
    });
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  function safeClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    } catch (_) {
      // ignore
    }
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    if (typeof el.click === "function") el.click();
    return true;
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    const proto = el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    const tracker = el._valueTracker;
    if (tracker) tracker.setValue("");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function setSelectValue(select, value) {
    return setNativeValue(select, value);
  }

  function flatText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function compactText(value) {
    return normalizeOcrText(value).replace(/\s+/g, "");
  }

  function normalizeOcrText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/\r/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[，]/g, ",")
      .replace(/[／]/g, "/")
      .replace(/[：]/g, ":")
      .replace(/[―ーｰ‐‑‒–—]/g, "-")
      .replace(/[¥￥]/g, "円")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeNumericSnippet(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/[OoＯ○〇]/g, "0")
      .replace(/[Ilｌｉ|｜]/g, "1")
      .replace(/[Ssｓ]/g, "5")
      .replace(/[Zzｚ]/g, "2")
      .replace(/[B８]/g, "8")
      .replace(/[Gg９]/g, "9")
      .replace(/[^\d]/g, "");
  }

  function isoToDisplay(iso) {
    if (!iso) return "";
    const [year, month, day] = iso.split("-").map(Number);
    if (!year || !month || !day) return iso;
    return `${year}/${month}/${day}`;
  }

  function parseEraYear(rawYear) {
    if (!rawYear) return null;
    if (rawYear === "元") return 2019;
    const year = Number(rawYear);
    if (!Number.isFinite(year)) return null;
    return 2018 + year;
  }

  function buildIsoDate(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function extractAllDates(text) {
    const normalized = normalizeOcrText(text);
    const out = [];
    const seen = new Set();

    const pushDate = (iso, raw, index) => {
      if (!iso || seen.has(`${iso}@${index}`)) return;
      seen.add(`${iso}@${index}`);
      out.push({ iso, raw: flatText(raw), index });
    };

    let match;
    const reiwaRegex = /令和\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g;
    while ((match = reiwaRegex.exec(normalized))) {
      const iso = buildIsoDate(parseEraYear(match[1]), match[2], match[3]);
      pushDate(iso, match[0], match.index);
    }

    const shortReiwaRegex = /\bR\s*(\d{1,2})\s*[./-]?\s*(\d{1,2})\s*[./-]?\s*(\d{1,2})\b/gi;
    while ((match = shortReiwaRegex.exec(normalized))) {
      const iso = buildIsoDate(parseEraYear(match[1]), match[2], match[3]);
      pushDate(iso, match[0], match.index);
    }

    const westernRegex = /\b(20\d{2})\s*[./-年]\s*(\d{1,2})\s*[./-月]\s*(\d{1,2})\s*日?\b/g;
    while ((match = westernRegex.exec(normalized))) {
      const iso = buildIsoDate(match[1], match[2], match[3]);
      pushDate(iso, match[0], match.index);
    }

    out.sort((a, b) => a.index - b.index);
    return out;
  }

  function extractDateRange(text) {
    const normalized = normalizeOcrText(text);
    const rangeRegexes = [
      /(令和\s*(?:元|\d{1,2})\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?)[^\n]{0,30}?(?:から|より|~|〜|-)[^\n]{0,10}?(令和\s*(?:元|\d{1,2})\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?)/,
      /\b(20\d{2}\s*[./-年]\s*\d{1,2}\s*[./-月]\s*\d{1,2}\s*日?)[^\n]{0,30}?(?:から|より|~|〜|-)[^\n]{0,10}?(20\d{2}\s*[./-年]\s*\d{1,2}\s*[./-月]\s*\d{1,2}\s*日?)/,
    ];

    for (const regex of rangeRegexes) {
      const match = normalized.match(regex);
      if (!match) continue;
      const first = extractAllDates(match[1])[0];
      const second = extractAllDates(match[2])[0];
      if (first && second) {
        return {
          startDate: first.iso,
          endDate: second.iso,
          source: flatText(match[0]),
          candidates: [first, second],
        };
      }
    }

    const dates = extractAllDates(normalized);
    if (dates.length >= 2) {
      return {
        startDate: dates[0].iso,
        endDate: dates[1].iso,
        source: "date-sequence",
        candidates: dates,
      };
    }

    return {
      startDate: dates[0]?.iso || null,
      endDate: dates[1]?.iso || null,
      source: "partial-date-sequence",
      candidates: dates,
    };
  }

  function dateRangeScore(left, right) {
    if (!left || !right || !left.startDate || !right.startDate) return 0;
    if (left.startDate === right.startDate && left.endDate === right.endDate) return 40;
    if (left.startDate === right.startDate || (left.endDate && right.endDate && left.endDate === right.endDate)) return 30;
    if (left.startDate.slice(0, 4) === right.startDate.slice(0, 4)) return 10;
    return 0;
  }

  function collectLabeledNumberCandidates(text, regexes, validator) {
    const normalized = normalizeOcrText(text);
    const candidates = [];

    for (const { regex, score, label } of regexes) {
      let match;
      while ((match = regex.exec(normalized))) {
        const value = normalizeNumericSnippet(match[1] || match[2] || "");
        if (!validator(value)) continue;
        candidates.push({
          value,
          score,
          label,
          index: match.index,
          raw: flatText(match[0]),
        });
      }
    }

    return candidates;
  }

  function choosePrimaryCandidate(candidates) {
    const deduped = new Map();

    for (const item of candidates) {
      const existing = deduped.get(item.value);
      if (!existing || item.score > existing.score || (item.score === existing.score && item.index < existing.index)) {
        deduped.set(item.value, item);
      }
    }

    const ranked = Array.from(deduped.values()).sort((a, b) => b.score - a.score || a.index - b.index);
    if (!ranked.length) {
      return { value: null, ranked, ambiguous: false };
    }
    if (ranked[1] && ranked[0].score === ranked[1].score && ranked[0].value !== ranked[1].value) {
      return { value: null, ranked, ambiguous: true };
    }
    return { value: ranked[0].value, ranked, ambiguous: false };
  }

  function extractLimitAmount(text) {
    const normalized = normalizeOcrText(text).replace(/,/g, "");
    if (/(自己負担上限額|上限額|月額)[^\n]{0,20}(負担なし|0円)/.test(normalized)) {
      return { amount: 0, source: "負担なし", candidates: [{ amount: 0, score: 800, raw: "負担なし" }] };
    }

    const candidates = [];
    const regexes = [
      { regex: /(?:自己負担上限額|上限額|月額)\D{0,12}([0-9OoＯ○〇Ilｌｉ|, ]{1,8})\s*円?/g, score: 700 },
      { regex: /([0-9OoＯ○〇Ilｌｉ|, ]{1,8})\s*円\s*(?:\/|毎)?\s*月/g, score: 500 },
    ];

    for (const { regex, score } of regexes) {
      let match;
      while ((match = regex.exec(normalized))) {
        const amount = Number(normalizeNumericSnippet(match[1]));
        if (!Number.isFinite(amount) || amount < 0 || amount > 999999) continue;
        candidates.push({
          amount,
          score,
          raw: flatText(match[0]),
          index: match.index,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    return {
      amount: candidates[0]?.amount ?? null,
      source: candidates[0]?.raw ?? null,
      candidates,
    };
  }

  function extractName(text) {
    const normalized = normalizeOcrText(text);
    const regexes = [
      /(?:受給者氏名|氏名|名前)\s*[:：]?\s*([一-龥々ぁ-んァ-ヶー ]{2,20})/,
      /(?:氏\s*名)\s*([一-龥々ぁ-んァ-ヶー ]{2,20})/,
    ];
    for (const regex of regexes) {
      const match = normalized.match(regex);
      if (match) return flatText(match[1]);
    }
    return null;
  }

  function parseOcrText(text) {
    const normalizedText = normalizeOcrText(text);

    const burdenerCandidates = collectLabeledNumberCandidates(
      normalizedText,
      [
        {
          regex: /(?:公費)?負担者(?:番号|番?号)?\D{0,12}([0-9OoＯ○〇Ilｌｉ| \-]{8,18})/g,
          score: 900,
          label: "負担者ラベル",
        },
        {
          regex: /(?:公費)?番号\D{0,12}([0-9OoＯ○〇Ilｌｉ| \-]{8,18})/g,
          score: 350,
          label: "番号ラベル",
        },
      ],
      (value) => value.length === 8 && BENEFIT_CODES.includes(value.slice(0, 2))
    );

    const fallbackBurdeners = Array.from(normalizedText.matchAll(/(^|[^\d])([0-9OoＯ○〇Ilｌｉ| \-]{8,18})(?!\d)/g))
      .map((match) => ({
        value: normalizeNumericSnippet(match[2]),
        score: 250,
        label: "8桁フォールバック",
        index: match.index,
        raw: flatText(match[0]),
      }))
      .filter((item) => item.value.length === 8 && BENEFIT_CODES.includes(item.value.slice(0, 2)));

    const primaryBurdener = choosePrimaryCandidate([...burdenerCandidates, ...fallbackBurdeners]);

    const recipientCandidates = collectLabeledNumberCandidates(
      normalizedText,
      [
        {
          regex: /(?:受給者(?:番号|証番号)?|受給番号)\D{0,12}([0-9OoＯ○〇Ilｌｉ| \-]{5,14})/g,
          score: 900,
          label: "受給者ラベル",
        },
        {
          regex: /(?:受給者証)\D{0,10}([0-9OoＯ○〇Ilｌｉ| \-]{5,14})/g,
          score: 400,
          label: "受給者証ラベル",
        },
      ],
      (value) => value.length >= 5 && value.length <= 10
    ).filter((item) => item.value !== primaryBurdener.value);

    const fallbackRecipients = Array.from(normalizedText.matchAll(/(^|[^\d])([0-9OoＯ○〇Ilｌｉ| \-]{5,12})(?!\d)/g))
      .map((match) => ({
        value: normalizeNumericSnippet(match[2]),
        score: 120,
        label: "受給者フォールバック",
        index: match.index,
        raw: flatText(match[0]),
      }))
      .filter((item) => item.value.length >= 5 && item.value.length <= 10 && item.value !== primaryBurdener.value);

    const primaryRecipient = choosePrimaryCandidate([...recipientCandidates, ...fallbackRecipients]);
    const dateRange = extractDateRange(normalizedText);
    const limit = extractLimitAmount(normalizedText);
    const name = extractName(normalizedText);

    const parsed = {
      rawText: text,
      normalizedText,
      burdenerCandidates: primaryBurdener.ranked,
      recipientCandidates: primaryRecipient.ranked,
      burdenerNumber: primaryBurdener.value,
      recipientNumber: primaryRecipient.value,
      burdenerAmbiguous: primaryBurdener.ambiguous,
      recipientAmbiguous: primaryRecipient.ambiguous,
      benefitCode: primaryBurdener.value ? primaryBurdener.value.slice(0, 2) : null,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      dateCandidates: dateRange.candidates,
      limitAmount: limit.amount,
      limitCandidates: limit.candidates,
      patientNameRef: name,
    };

    logStep("parseOcrText", "OCR生テキスト", text);
    console.table(parsed.burdenerCandidates.map((item) => ({
      type: "負担者番号候補",
      value: item.value,
      score: item.score,
      label: item.label,
      raw: item.raw,
    })));
    console.table(parsed.recipientCandidates.map((item) => ({
      type: "受給者番号候補",
      value: item.value,
      score: item.score,
      label: item.label,
      raw: item.raw,
    })));
    console.table((parsed.dateCandidates || []).map((item) => ({
      type: "日付候補",
      iso: item.iso,
      raw: item.raw,
      index: item.index,
    })));
    console.table((parsed.limitCandidates || []).map((item) => ({
      type: "上限額候補",
      amount: item.amount,
      score: item.score,
      raw: item.raw,
    })));

    logStep("parseOcrText", "抽出した番号 / 期限 / 上限額", {
      burdenerNumber: parsed.burdenerNumber,
      recipientNumber: parsed.recipientNumber,
      benefitCode: parsed.benefitCode,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      limitAmount: parsed.limitAmount,
      patientNameRef: parsed.patientNameRef,
    });

    return parsed;
  }

  function classifyBenefits(parsed) {
    if (!parsed.burdenerNumber) fail("OCRで負担者番号が取れませんでした");
    if (!parsed.recipientNumber) fail("OCRで受給者番号が取れませんでした");
    if (parsed.burdenerAmbiguous) fail("OCRの負担者番号候補が複数で一意に決まりません");
    if (parsed.recipientAmbiguous) fail("OCRの受給者番号候補が複数で一意に決まりません");
    if (!BENEFIT_CODES.includes(parsed.benefitCode)) {
      fail(`公費コードが対象外です: ${parsed.benefitCode || "不明"}`);
    }

    const classification = {
      primary: {
        burdenerNumber: parsed.burdenerNumber,
        recipientNumber: parsed.recipientNumber,
        benefitCode: parsed.benefitCode,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        limitAmount: parsed.limitAmount,
        patientNameRef: parsed.patientNameRef,
      },
      requiresCompanion21: parsed.benefitCode === "84",
      dryRun: CONFIG.dryRun,
    };

    logStep("classifyBenefits", "公費分類結果", classification);
    return classification;
  }

  function extractCurrentPatientChartNumber() {
    const labelCandidates = Array.from(document.querySelectorAll("th, td, dt, dd, div, span, p")).filter(
      (el) => isVisible(el) && /患者番号/.test(flatText(el.textContent))
    );

    for (const label of labelCandidates) {
      const row = label.closest("tr, dl, [class*='row'], [class*='field'], [class*='Field']");
      if (row) {
        const text = normalizeOcrText(row.textContent);
        const match = text.match(/患者番号\D{0,8}(\d{1,8})/);
        if (match) return match[1];
      }
      const siblingText = flatText(label.parentElement?.textContent || "");
      const siblingMatch = siblingText.match(/患者番号\D{0,8}(\d{1,8})/);
      if (siblingMatch) return siblingMatch[1];
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const numbers = [];
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      const el = walker.currentNode.parentElement;
      if (!el || !isVisible(el)) continue;
      if (el.closest('[role="dialog"], [class*="modal"], [class*="Modal"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top > 180) continue;
      if (/^\d{1,8}$/.test(text)) numbers.push({ value: text, top: rect.top, left: rect.left });
    }
    numbers.sort((a, b) => a.top - b.top || a.left - b.left);
    return numbers[0]?.value || null;
  }

  function extractCurrentPatientName() {
    const labelCandidates = Array.from(document.querySelectorAll("th, td, dt, dd, div, span, p")).filter(
      (el) => isVisible(el) && /(患者氏名|氏名)/.test(flatText(el.textContent))
    );

    for (const label of labelCandidates) {
      const row = label.closest("tr, dl, [class*='row'], [class*='field'], [class*='Field']");
      if (row) {
        const text = normalizeOcrText(row.textContent);
        const match = text.match(/(?:患者氏名|氏名)\D{0,6}([一-龥々ぁ-んァ-ヶー ]{2,20})/);
        if (match) return flatText(match[1]);
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const names = [];
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      const el = walker.currentNode.parentElement;
      if (!el || !isVisible(el)) continue;
      if (el.closest('[role="dialog"], [class*="modal"], [class*="Modal"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top > 180) continue;
      if (!/^[一-龥々ぁ-んァ-ヶー ]{2,12}$/.test(text)) continue;
      names.push({ value: flatText(text), top: rect.top, left: rect.left });
    }
    names.sort((a, b) => a.top - b.top || a.left - b.left);
    return names[0]?.value || null;
  }

  function parseCurrentKarteContext() {
    const match = location.pathname.match(/^\/karte\/patients\/(\d+)\/(\d{8})$/);
    if (!match) fail("カルテ画面のURL形式を解釈できません");

    const patientId = match[1];
    const visitDate = match[2];
    const patientNo = extractCurrentPatientChartNumber();
    const patientName = extractCurrentPatientName();

    if (!patientNo) fail("患者番号を取得できませんでした");

    const ctx = { patientId, visitDate, patientNo, patientName };
    logStep("context", "対象患者の patientId / patientNo / patientName / visitDate", ctx);
    return ctx;
  }

  function findButtonByText(texts, scope = document) {
    const list = Array.isArray(texts) ? texts : [texts];
    const buttons = Array.from(scope.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
    for (const button of buttons) {
      if (!isVisible(button)) continue;
      const text = flatText(button.textContent || button.value || "");
      if (list.some((needle) => text === needle || text.includes(needle))) return button;
    }
    return null;
  }

  function findTextElement(texts, scope = document.body) {
    const list = Array.isArray(texts) ? texts : [texts];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = flatText(node.textContent);
      if (!value) continue;
      const el = node.parentElement;
      if (!el || !isVisible(el)) continue;
      if (list.some((needle) => value.includes(needle))) return el;
    }
    return null;
  }

  function findModalByTitle(title) {
    const titleNodes = Array.from(
      document.querySelectorAll("h1, h2, h3, h4, h5, h6, [class*='title'], [class*='Title'], [class*='header'], [class*='Header']")
    );
    for (const node of titleNodes) {
      if (!isVisible(node)) continue;
      const text = flatText(node.textContent);
      if (!text.includes(title)) continue;
      const modal = node.closest('[role="dialog"], [class*="modal"], [class*="Modal"]');
      if (modal) return modal;
      let parent = node.parentElement;
      for (let depth = 0; depth < 8 && parent; depth += 1) {
        const style = getComputedStyle(parent);
        const cls = String(parent.className || "");
        if (
          parent.getAttribute("role") === "dialog" ||
          /modal|Modal|dialog|Dialog/.test(cls) ||
          style.position === "fixed"
        ) {
          return parent;
        }
        parent = parent.parentElement;
      }
    }
    return null;
  }

  function isLikelyEditButton(button) {
    if (!button) return false;
    const meta = [
      button.getAttribute("title"),
      button.getAttribute("aria-label"),
      button.className?.toString?.(),
      button.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/編集|edit|pencil/.test(meta)) return true;
    const svgPath = Array.from(button.querySelectorAll("path"))
      .map((path) => path.getAttribute("d") || "")
      .join(" ");
    return svgPath.includes("17.25") || svgPath.includes("19.575 9.326") || svgPath.includes("13.75 6.4");
  }

  async function ensureFileTabOpen() {
    logStep("ensureFileTabOpen", "ファイルタブを開きます");

    const alreadyOpen = Array.from(document.querySelectorAll("img, a"))
      .some((node) => {
        const value = node.getAttribute("src") || node.getAttribute("href") || "";
        return /attachments/.test(value);
      });
    if (alreadyOpen) {
      debugLog("ensureFileTabOpen", "すでに添付画像系DOMが見えています");
      return true;
    }

    const fileTab = findButtonByText(["ファイル"]);
    if (!fileTab) fail("ファイルタブが見つかりません");
    safeClick(fileTab);

    await waitFor(
      () =>
        Array.from(document.querySelectorAll("img, a")).find((node) => {
          const value = node.getAttribute("src") || node.getAttribute("href") || "";
          return /attachments|public_api\/patients/.test(value);
        }) || findTextElement(["添付", "ファイル", "受給者証"]),
      { timeoutMs: CONFIG.timeoutMs, name: "ファイルタブ内容" }
    );

    return true;
  }

  function findMeaningfulAttachmentContainer(node) {
    let current = node;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      if (!(current instanceof Element)) {
        current = current.parentElement;
        continue;
      }
      const text = flatText(current.textContent);
      if (text.length >= 4 && text.length <= 600) return current;
      current = current.parentElement;
    }
    return null;
  }

  function scoreAttachmentRow(row) {
    const text = flatText(row.textContent);
    const normalized = normalizeOcrText(text);
    const rect = row.getBoundingClientRect();
    let score = 0;

    if (row.querySelector('a[href*="/attachments/"], a[href*="/public_api/patients/"], img[src*="/attachments/"], img[src*="/public_api/patients/"]')) score += 220;
    if (row.querySelector("img")) score += 60;
    if (/受給者証|精神通院|公費/.test(normalized)) score += 300;
    for (const keyword of FILE_ROW_PRIORITY_KEYWORDS) {
      if (normalized.includes(keyword)) score += 200;
    }
    score += Math.max(0, 300 - rect.top);

    return {
      row,
      score,
      top: rect.top,
      text,
    };
  }

  function getTopAttachmentRow() {
    const urlNodes = Array.from(
      document.querySelectorAll(
        '[href*="/attachments/"], [href*="/public_api/patients/"], [src*="/attachments/"], [src*="/public_api/patients/"]'
      )
    ).filter((node) => isVisible(node));

    const rows = new Map();
    for (const node of urlNodes) {
      const row =
        node.closest("tr, li, [role='row'], [class*='row'], [class*='item'], [class*='Row'], [class*='Item']") ||
        findMeaningfulAttachmentContainer(node);
      if (row && isVisible(row)) rows.set(row, row);
    }

    if (!rows.size) {
      const keywordRows = Array.from(document.querySelectorAll("tr, li, div"))
        .filter((el) => isVisible(el))
        .filter((el) => /受給者証|精神通院|公費|添付/.test(flatText(el.textContent)))
        .slice(0, 50);
      for (const row of keywordRows) rows.set(row, row);
    }

    const ranked = Array.from(rows.values()).map(scoreAttachmentRow).sort((a, b) => b.score - a.score || a.top - b.top);
    console.table(
      ranked.slice(0, 10).map((item, index) => ({
        rank: index + 1,
        score: item.score,
        top: Math.round(item.top),
        text: item.text.slice(0, 120),
      }))
    );

    const picked = ranked[0]?.row || null;
    if (!picked) fail("添付ファイル行が見つかりません");
    logStep("getTopAttachmentRow", "対象ファイル行のテキスト", flatText(picked.textContent));
    return picked;
  }

  async function extractAttachmentImageUrl(row) {
    const urlCandidates = [];
    const collectUrl = (value, source) => {
      if (!value) return;
      try {
        const absolute = new URL(value, location.origin).href;
        if (!/^https:\/\/digikar\.jp\//.test(absolute)) return;
        if (!/attachments|public_api\/patients/.test(absolute)) return;
        urlCandidates.push({ url: absolute, source });
      } catch (_) {
        // ignore malformed URLs
      }
    };

    row.querySelectorAll("[href], [src], [data-src], [data-url]").forEach((node) => {
      collectUrl(node.getAttribute("href"), "href");
      collectUrl(node.getAttribute("src"), "src");
      collectUrl(node.getAttribute("data-src"), "data-src");
      collectUrl(node.getAttribute("data-url"), "data-url");
    });

    if (!urlCandidates.length) {
      // TODO: 実環境で一覧行クリックで右ペインに原寸画像が出る場合はここを増やしやすいです。
      safeClick(row);
      await sleep(250);
      document.querySelectorAll('img[src], a[href]').forEach((node) => {
        collectUrl(node.getAttribute("src"), "fallback-src");
        collectUrl(node.getAttribute("href"), "fallback-href");
      });
    }

    const ranked = urlCandidates
      .map((item) => ({
        ...item,
        score: (item.url.includes("/file") ? 500 : 0) + (/\.(png|jpe?g)(\?|$)/i.test(item.url) ? 100 : 0),
      }))
      .sort((a, b) => b.score - a.score);

    const picked = ranked[0]?.url || null;
    if (!picked) fail("添付画像URLを取得できませんでした");

    logStep("extractAttachmentImageUrl", "取得した画像URL", picked);
    console.table(ranked.map((item) => ({ source: item.source, score: item.score, url: item.url })));
    return picked;
  }

  async function fetchImageBlob(url) {
    logStep("fetchImageBlob", "画像を fetch します", url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) fail(`画像 fetch に失敗しました (${response.status})`, url);
      const blob = await response.blob();
      logStep("fetchImageBlob", "画像 blob を取得", { type: blob.type, size: blob.size });
      return blob;
    } catch (error) {
      fail(`画像 fetch に失敗しました: ${error.message}`, { url });
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadImageFromBlob(blob) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("画像読み込みに失敗しました"));
        image.src = objectUrl;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }

  function computePercentileThreshold(grayValues) {
    const values = Array.from(grayValues).sort((a, b) => a - b);
    const low = values[Math.floor(values.length * 0.05)] ?? 0;
    const high = values[Math.floor(values.length * 0.95)] ?? 255;
    return { low, high: Math.max(low + 1, high) };
  }

  function computeOtsuThreshold(grayValues) {
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < grayValues.length; i += 1) histogram[grayValues[i]] += 1;
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

    let sumB = 0;
    let weightB = 0;
    let varianceMax = 0;
    let threshold = 128;
    const total = grayValues.length;

    for (let i = 0; i < 256; i += 1) {
      weightB += histogram[i];
      if (!weightB) continue;
      const weightF = total - weightB;
      if (!weightF) break;
      sumB += i * histogram[i];
      const meanB = sumB / weightB;
      const meanF = (sum - sumB) / weightF;
      const variance = weightB * weightF * (meanB - meanF) ** 2;
      if (variance > varianceMax) {
        varianceMax = variance;
        threshold = i;
      }
    }

    return threshold;
  }

  async function preprocessImage(blob) {
    const image = await loadImageFromBlob(blob);
    const longest = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height);
    const scale = longest < 1200 ? 2.5 : longest < 1800 ? 2.0 : 1.5;
    const width = Math.min(3200, Math.max(1200, Math.round((image.naturalWidth || image.width) * scale)));
    const height = Math.round(width * ((image.naturalHeight || image.height) / (image.naturalWidth || image.width)));

    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    sourceCtx.drawImage(image, 0, 0, width, height);

    const sourceData = sourceCtx.getImageData(0, 0, width, height);
    const grayValues = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < sourceData.data.length; i += 4, p += 1) {
      const r = sourceData.data[i];
      const g = sourceData.data[i + 1];
      const b = sourceData.data[i + 2];
      grayValues[p] = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
    }

    const { low, high } = computePercentileThreshold(grayValues);
    const contrastGray = new Uint8ClampedArray(grayValues.length);
    for (let i = 0; i < grayValues.length; i += 1) {
      const stretched = ((grayValues[i] - low) * 255) / (high - low);
      contrastGray[i] = Math.max(0, Math.min(255, Math.round(stretched)));
    }

    const grayCanvas = document.createElement("canvas");
    grayCanvas.width = width;
    grayCanvas.height = height;
    const grayCtx = grayCanvas.getContext("2d", { willReadFrequently: true });
    const grayImageData = grayCtx.createImageData(width, height);
    for (let i = 0, p = 0; i < grayImageData.data.length; i += 4, p += 1) {
      const value = contrastGray[p];
      grayImageData.data[i] = value;
      grayImageData.data[i + 1] = value;
      grayImageData.data[i + 2] = value;
      grayImageData.data[i + 3] = 255;
    }
    grayCtx.putImageData(grayImageData, 0, 0);

    const threshold = computeOtsuThreshold(contrastGray);
    const binaryCanvas = document.createElement("canvas");
    binaryCanvas.width = width;
    binaryCanvas.height = height;
    const binaryCtx = binaryCanvas.getContext("2d", { willReadFrequently: true });
    const binaryImageData = binaryCtx.createImageData(width, height);
    for (let i = 0, p = 0; i < binaryImageData.data.length; i += 4, p += 1) {
      const value = contrastGray[p] >= threshold ? 255 : 0;
      binaryImageData.data[i] = value;
      binaryImageData.data[i + 1] = value;
      binaryImageData.data[i + 2] = value;
      binaryImageData.data[i + 3] = 255;
    }
    binaryCtx.putImageData(binaryImageData, 0, 0);

    logStep("preprocessImage", "OCR前処理結果", {
      originalWidth: image.naturalWidth || image.width,
      originalHeight: image.naturalHeight || image.height,
      width,
      height,
      scale,
      contrastLow: low,
      contrastHigh: high,
      threshold,
    });

    return {
      sourceCanvas,
      grayCanvas,
      binaryCanvas,
      width,
      height,
      scale,
      threshold,
    };
  }

  async function getOcrWorker() {
    if (ocrWorkerPromise) return ocrWorkerPromise;

    ocrWorkerPromise = (async () => {
      if (!window.Tesseract?.createWorker) {
        fail("Tesseract.js が読み込まれていません");
      }

      logStep("runOcr", "Tesseract worker を初期化します", OCR_PATHS);
      const worker = await window.Tesseract.createWorker(CONFIG.ocrLang, 1, {
        workerPath: OCR_PATHS.workerPath,
        corePath: OCR_PATHS.corePath,
        langPath: OCR_PATHS.langPath,
        logger: (message) => {
          if (CONFIG.debug) console.log(APP.logPrefix, "[OCR]", message);
        },
        errorHandler: (error) => console.error(APP.logPrefix, "[OCR worker error]", error),
      });
      return worker;
    })();

    return ocrWorkerPromise;
  }

  async function runOcr(imageSource) {
    const worker = await getOcrWorker();
    const passes = [
      {
        name: "binary-sparse",
        image: imageSource.binaryCanvas,
        params: {
          tessedit_pageseg_mode: window.Tesseract.PSM.SPARSE_TEXT,
          preserve_interword_spaces: "1",
          user_defined_dpi: "300",
        },
      },
      {
        name: "gray-auto",
        image: imageSource.grayCanvas,
        params: {
          tessedit_pageseg_mode: window.Tesseract.PSM.AUTO,
          preserve_interword_spaces: "1",
          user_defined_dpi: "300",
        },
      },
    ];

    const results = [];
    for (const pass of passes) {
      logStep("runOcr", `OCR pass 開始: ${pass.name}`);
      await worker.setParameters(pass.params);
      const { data } = await worker.recognize(pass.image);
      const text = String(data?.text || "");
      results.push({
        pass: pass.name,
        confidence: data?.confidence ?? null,
        text,
      });
      logStep("runOcr", `OCR pass 完了: ${pass.name}`, {
        confidence: data?.confidence ?? null,
        textLength: text.length,
      });
    }

    const mergedText = results
      .map((item) => `[PASS:${item.pass} CONF:${item.confidence ?? "?"}]\n${item.text}`)
      .join("\n\n");

    return {
      rawText: mergedText,
      passes: results,
    };
  }

  async function openKarteUpdateModal() {
    const existing = findModalByTitle("カルテ更新");
    if (existing) return existing;

    logStep("openKarteUpdateModal", "カルテ更新モーダルを開きます");

    const candidates = [];
    const pushCandidate = (button, score, label) => {
      if (!button || !isVisible(button)) return;
      if (button.closest('[role="dialog"], [class*="modal"], [class*="Modal"]')) return;
      candidates.push({ button, score, label });
    };

    // TODO: 実環境で「保険等」周りのDOMが違う場合は、この近傍探索を足すと調整しやすいです。
    for (const anchorText of ["保険等", "医療保険", "公費"]) {
      const anchor = findTextElement([anchorText]);
      if (!anchor) continue;
      let container = anchor;
      for (let depth = 0; depth < 5 && container; depth += 1) {
        Array.from(container.querySelectorAll("button, a, [role='button']")).forEach((button, index) => {
          if (isLikelyEditButton(button)) pushCandidate(button, 900 - depth * 60 - index * 5, `${anchorText}近傍`);
        });
        container = container.parentElement;
      }
    }

    Array.from(document.querySelectorAll("button, a, [role='button']")).forEach((button, index) => {
      if (isLikelyEditButton(button)) pushCandidate(button, 300 - index, "全体フォールバック");
    });

    candidates.sort((a, b) => b.score - a.score);
    console.table(candidates.slice(0, 20).map((item, index) => ({
      rank: index + 1,
      score: item.score,
      label: item.label,
      text: flatText(item.button.textContent).slice(0, 40),
      title: item.button.getAttribute("title") || item.button.getAttribute("aria-label") || "",
    })));

    for (const candidate of candidates) {
      safeClick(candidate.button);
      try {
        const modal = await waitFor(() => findModalByTitle("カルテ更新"), {
          timeoutMs: 2500,
          name: "カルテ更新モーダル",
        });
        logStep("openKarteUpdateModal", `カルテ更新モーダルを開きました: ${candidate.label}`);
        return modal;
      } catch (_) {
        // ignore and try next candidate
      }
    }

    fail("カルテ更新モーダルを開けませんでした");
  }

  function parseBenefitOptionMeta(option) {
    const text = flatText(option.textContent || "");
    const normalized = normalizeOcrText(text);
    const burdenerMatch = normalized.match(/\b(21|81|82|83|84)\d{6}\b/);
    const burdenerNumber = burdenerMatch ? burdenerMatch[0] : null;
    const recipientCandidates = Array.from(normalized.matchAll(/\b\d{5,10}\b/g))
      .map((match) => match[0])
      .filter((value) => value !== burdenerNumber);
    const dateRange = extractDateRange(normalized);
    const limit = extractLimitAmount(normalized);
    const isNone = normalized.includes("公費なし");
    const benefitCode = burdenerNumber ? burdenerNumber.slice(0, 2) : (normalized.match(/\((21|81|82|83|84)\)/)?.[1] || null);

    return {
      text,
      normalizedText: normalized,
      burdenerNumber,
      recipientNumber: recipientCandidates[0] || null,
      benefitCode,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      limitAmount: limit.amount,
      isNone,
      selected: !!option.selected,
    };
  }

  function getModalBenefitSelects(modal) {
    const visibleSelects = Array.from(modal.querySelectorAll("select")).filter(isVisible);
    const publicSelects = visibleSelects.filter((select) =>
      Array.from(select.options).some((option) => {
        const text = normalizeOcrText(option.textContent);
        return text.includes("公費なし") || BENEFIT_CODES.some((code) => text.includes(`(${code})`) || text.includes(`${code}`));
      })
    );

    const uniqueRows = Array.from(new Set(publicSelects.map((select) => select.closest("tr, [class*='row'], [class*='Row'], [class*='field'], [class*='Field']") || select)));
    const sortedSelects = uniqueRows
      .map((row) => {
        const select = row.matches?.("select") ? row : row.querySelector("select");
        return select;
      })
      .filter(Boolean)
      .filter((select) => publicSelects.includes(select))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    return {
      1: sortedSelects[0] || null,
      2: sortedSelects[1] || null,
      3: sortedSelects[2] || null,
    };
  }

  function buildUniqueOptionPool(selectMap) {
    const pool = new Map();
    for (const [slot, select] of Object.entries(selectMap)) {
      if (!select) continue;
      Array.from(select.options).forEach((option) => {
        const meta = parseBenefitOptionMeta(option);
        const key = meta.isNone
          ? "NONE"
          : [meta.burdenerNumber, meta.recipientNumber, meta.normalizedText].filter(Boolean).join("|");
        if (!pool.has(key)) {
          pool.set(key, {
            key,
            meta,
            slots: new Set([slot]),
            selectedCount: option.selected ? 1 : 0,
          });
        } else {
          const existing = pool.get(key);
          existing.slots.add(slot);
          if (option.selected) existing.selectedCount += 1;
        }
      });
    }

    return Array.from(pool.values()).map((item) => ({
      ...item,
      slots: Array.from(item.slots).sort(),
    }));
  }

  function scoreOptionForPrimary(meta, primary) {
    if (meta.isNone) return { score: -1, reasons: ["公費なし"], exactBurdener: false };

    let score = 0;
    const reasons = [];
    const rangeScore = dateRangeScore(
      { startDate: meta.startDate, endDate: meta.endDate },
      { startDate: primary.startDate, endDate: primary.endDate }
    );

    if (meta.burdenerNumber && meta.burdenerNumber === primary.burdenerNumber) {
      score += 500;
      reasons.push("負担者番号一致");
    }
    if (meta.recipientNumber && primary.recipientNumber && meta.recipientNumber === primary.recipientNumber) {
      score += 250;
      reasons.push("受給者番号一致");
    }
    if (meta.benefitCode && meta.benefitCode === primary.benefitCode) {
      score += 120;
      reasons.push("公費コード一致");
    }
    if (
      Number.isFinite(meta.limitAmount) &&
      Number.isFinite(primary.limitAmount) &&
      meta.limitAmount === primary.limitAmount
    ) {
      score += 60;
      reasons.push("上限額一致");
    }
    score += rangeScore;
    if (rangeScore) reasons.push("有効期間一致補助");
    if (meta.selected) {
      score += 10;
      reasons.push("現在選択中");
    }

    return {
      score,
      reasons,
      exactBurdener: meta.burdenerNumber === primary.burdenerNumber,
    };
  }

  function scoreMirrorOption(meta, target) {
    if (target.isNone) return { score: meta.isNone ? 1000 : -1, reasons: meta.isNone ? ["公費なし"] : ["非公費なし"] };
    if (meta.isNone) return { score: -1, reasons: ["公費なし"] };

    let score = 0;
    const reasons = [];
    const rangeScore = dateRangeScore(
      { startDate: meta.startDate, endDate: meta.endDate },
      { startDate: target.startDate, endDate: target.endDate }
    );

    if (meta.normalizedText === target.normalizedText) {
      score += 250;
      reasons.push("表示テキスト一致");
    }
    if (meta.burdenerNumber && meta.burdenerNumber === target.burdenerNumber) {
      score += 500;
      reasons.push("負担者番号一致");
    }
    if (meta.recipientNumber && target.recipientNumber && meta.recipientNumber === target.recipientNumber) {
      score += 250;
      reasons.push("受給者番号一致");
    }
    if (meta.benefitCode && meta.benefitCode === target.benefitCode) {
      score += 120;
      reasons.push("公費コード一致");
    }
    if (
      Number.isFinite(meta.limitAmount) &&
      Number.isFinite(target.limitAmount) &&
      meta.limitAmount === target.limitAmount
    ) {
      score += 60;
      reasons.push("上限額一致");
    }
    score += rangeScore;
    if (rangeScore) reasons.push("有効期間一致補助");

    return { score, reasons };
  }

  function pickUniqueBestCandidate(scoredCandidates, label, minimumScore) {
    const ranked = scoredCandidates
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || Number(b.meta.selected) - Number(a.meta.selected));

    if (!ranked.length) fail(`${label} の候補が見つかりません`);
    if (ranked[0].score < minimumScore) {
      fail(`${label} の最高得点が低すぎます`, ranked.slice(0, 5));
    }
    if (ranked[1] && ranked[1].score === ranked[0].score && ranked[1].meta.normalizedText !== ranked[0].meta.normalizedText) {
      fail(`${label} の最高得点候補が同点で一意に決まりません`, ranked.slice(0, 5));
    }
    return ranked[0];
  }

  function chooseCompanion21(pool, currentSelections) {
    const current21 = currentSelections.find((item) => item && item.benefitCode === "21" && !item.isNone);
    if (current21) return current21;

    const candidates = pool
      .map((item) => item.meta)
      .filter((meta) => meta.benefitCode === "21" && !meta.isNone);

    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    fail("21公費候補が複数あり一意に決まりません", candidates);
  }

  function buildResolvedTarget(meta) {
    return {
      isNone: !!meta.isNone,
      text: meta.text,
      normalizedText: meta.normalizedText,
      burdenerNumber: meta.burdenerNumber,
      recipientNumber: meta.recipientNumber,
      benefitCode: meta.benefitCode,
      startDate: meta.startDate,
      endDate: meta.endDate,
      limitAmount: meta.limitAmount,
    };
  }

  function getCurrentSelectionMetas(selectMap) {
    return [1, 2, 3].map((slot) => {
      const select = selectMap[slot];
      if (!select) return null;
      const option = select.options[select.selectedIndex];
      return option ? parseBenefitOptionMeta(option) : null;
    });
  }

  function scoreMirrorCandidates(select, target) {
    return Array.from(select.options).map((option) => {
      const meta = parseBenefitOptionMeta(option);
      const result = scoreMirrorOption(meta, target);
      return {
        option,
        meta,
        score: result.score,
        reasons: result.reasons.join(", "),
      };
    });
  }

  function findMatchingOptionInSelect(select, target, options = {}) {
    const { quiet = false } = options;
    const scored = scoreMirrorCandidates(select, target);
    const minimumScore = target.isNone ? 900 : 620;
    const ranked = scored
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || Number(b.meta.selected) - Number(a.meta.selected));

    if (!quiet) {
      console.table(
        scored.map((item) => ({
          text: item.meta.text.slice(0, 100),
          burdener: item.meta.burdenerNumber,
          recipient: item.meta.recipientNumber,
          code: item.meta.benefitCode,
          score: item.score,
          reasons: item.reasons,
        }))
      );
    }

    if (!ranked.length) return null;
    if (ranked[0].score < minimumScore) return null;
    if (ranked[1] && ranked[1].score === ranked[0].score && ranked[1].meta.normalizedText !== ranked[0].meta.normalizedText) {
      return null;
    }
    return ranked[0].option;
  }

  async function applySlotTargetsToModal(modal, slotTargets, modeLabel) {
    for (const slot of [1, 2, 3]) {
      const selectMap = getModalBenefitSelects(modal);
      const select = selectMap[slot];
      if (!select) fail(`${modeLabel}: 公費${slot} の select が見つかりません`);

      const target = slotTargets[slot];
      const option = await waitFor(() => findMatchingOptionInSelect(select, target, { quiet: true }), {
        timeoutMs: 2500,
        name: `${modeLabel} 公費${slot} 候補`,
        root: modal,
        observeAttributes: true,
      }).catch(() => null);

      if (!option) {
        console.table(
          scoreMirrorCandidates(select, target).map((item) => ({
            text: item.meta.text.slice(0, 100),
            burdener: item.meta.burdenerNumber,
            recipient: item.meta.recipientNumber,
            code: item.meta.benefitCode,
            score: item.score,
            reasons: item.reasons,
          }))
        );
        fail(`${modeLabel}: 公費${slot} の候補が一意に見つかりません`, target);
      }

      if (select.value !== option.value) {
        setSelectValue(select, option.value);
        logStep(modeLabel, `公費${slot} を選択`, {
          value: option.value,
          text: flatText(option.textContent),
        });
      } else {
        logStep(modeLabel, `公費${slot} はすでに選択済み`, flatText(option.textContent));
      }

      await sleep(150);
    }
  }

  async function applyKarteBenefits(selection) {
    const modal = findModalByTitle("カルテ更新");
    if (!modal) fail("カルテ更新モーダルが見つかりません");

    const selectMap = getModalBenefitSelects(modal);
    if (!selectMap[1] || !selectMap[2] || !selectMap[3]) {
      fail("カルテ更新モーダル内の公費selectが見つかりません");
    }

    const pool = buildUniqueOptionPool(selectMap);
    const currentSelections = getCurrentSelectionMetas(selectMap);

    const candidateRows = pool.map((item) => {
      const score = scoreOptionForPrimary(item.meta, selection.primary);
      return {
        ...item,
        score: score.score,
        reasons: score.reasons,
        exactBurdener: score.exactBurdener,
      };
    });

    console.table(
      candidateRows.map((item) => ({
        text: item.meta.text.slice(0, 120),
        burdener: item.meta.burdenerNumber,
        recipient: item.meta.recipientNumber,
        code: item.meta.benefitCode,
        limitAmount: item.meta.limitAmount,
        startDate: item.meta.startDate,
        endDate: item.meta.endDate,
        slots: item.slots.join(","),
        selectedCount: item.selectedCount,
        score: item.score,
        reasons: item.reasons.join(", "),
      }))
    );
    logStep("applyKarteBenefits", "カルテ側候補一覧", candidateRows);

    const primaryMatch = pickUniqueBestCandidate(candidateRows, "カルテ側 primary 公費候補", 620);
    if (!primaryMatch.exactBurdener) {
      fail("カルテ側の primary 候補で負担者番号一致が取れていません", primaryMatch);
    }

    let slot1 = null;
    let slot2 = null;

    if (primaryMatch.meta.benefitCode === "21") {
      slot1 = primaryMatch.meta;
      slot2 = currentSelections.find((item) => item && OTHER_PUBLIC_CODES.includes(item.benefitCode) && !item.isNone) || null;
    } else if (primaryMatch.meta.benefitCode === "84") {
      const companion21 = chooseCompanion21(pool, currentSelections);
      if (!companion21) fail("84単独のため停止します。21公費が必要です");
      slot1 = companion21;
      slot2 = primaryMatch.meta;
    } else {
      const companion21 = chooseCompanion21(pool, currentSelections);
      if (companion21) {
        slot1 = companion21;
        slot2 = primaryMatch.meta;
      } else {
        slot1 = primaryMatch.meta;
        slot2 = null;
      }
    }

    if (slot1?.benefitCode === "84" && !slot2) {
      fail("84単独のため停止します。21公費が必要です");
    }

    const noneMeta = { isNone: true, text: "公費なし", normalizedText: "公費なし" };
    const slotTargets = {
      1: buildResolvedTarget(slot1 || noneMeta),
      2: buildResolvedTarget(slot2 || noneMeta),
      3: buildResolvedTarget(noneMeta),
    };

    console.table(
      Object.entries(slotTargets).map(([slot, target]) => ({
        slot: `公費${slot}`,
        burdener: target.burdenerNumber || "",
        recipient: target.recipientNumber || "",
        code: target.benefitCode || "",
        limitAmount: target.limitAmount ?? "",
        startDate: target.startDate ? isoToDisplay(target.startDate) : "",
        endDate: target.endDate ? isoToDisplay(target.endDate) : "",
        text: (target.text || "").slice(0, 120),
      }))
    );

    await applySlotTargetsToModal(modal, slotTargets, "applyKarteBenefits");

    const resolvedSelection = {
      primary: selection.primary,
      slotTargets,
      dryRun: CONFIG.dryRun,
      source: "karte",
    };

    logStep("applyKarteBenefits", "dryRunか本更新か", { dryRun: CONFIG.dryRun });

    if (CONFIG.dryRun) {
      console.table(
        Object.entries(slotTargets).map(([slot, target]) => ({
          slot: `公費${slot}`,
          action: "NO_UPDATE",
          text: target.text,
        }))
      );
      logStep("applyKarteBenefits", "dryRun=true のためカルテ更新ボタンは押しません");
      return resolvedSelection;
    }

    const updateButton = findButtonByText(["更新"], modal);
    if (!updateButton) fail("カルテ更新モーダルの更新ボタンが見つかりません");
    safeClick(updateButton);
    await waitFor(() => !findModalByTitle("カルテ更新"), {
      timeoutMs: 5000,
      name: "カルテ更新モーダル close",
    }).catch(() => fail("カルテ更新後にモーダルが閉じませんでした"));

    logStep("applyKarteBenefits", "カルテ側の更新が完了しました");
    return resolvedSelection;
  }

  function formatVisitDatePath(visitDate) {
    if (/^\d{8}$/.test(visitDate)) return visitDate;
    fail(`visitDate が 8 桁ではありません: ${visitDate}`);
  }

  function writePendingState(payload) {
    sessionStorage.setItem(APP.pendingKey, JSON.stringify(payload));
  }

  function readPendingState() {
    const raw = sessionStorage.getItem(APP.pendingKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      sessionStorage.removeItem(APP.pendingKey);
      return null;
    }
  }

  function clearPendingState() {
    sessionStorage.removeItem(APP.pendingKey);
  }

  async function gotoReceptionPage(visitDate) {
    const datePath = formatVisitDatePath(visitDate);
    const targetUrl = `${location.origin}/reception/${datePath}`;
    if (!pendingContextForNavigation) fail("受付一覧遷移用の pending context がありません");

    writePendingState({
      ...pendingContextForNavigation,
      createdAt: Date.now(),
      targetUrl,
    });

    logStep("gotoReceptionPage", "受付一覧へ移動します", {
      visitDate: datePath,
      targetUrl,
    });

    if (location.href === targetUrl) {
      await maybeResumePendingFlow();
      return;
    }

    window.location.href = targetUrl;
  }

  function findHeaderRow(table) {
    const thead = table.tHead;
    if (!thead) return null;
    return Array.from(thead.rows || []).find((row) => row.cells?.length) || null;
  }

  function getReceptionColumnMap(table) {
    const headerRow = findHeaderRow(table);
    if (!headerRow) return null;
    const headers = Array.from(headerRow.cells || []).map((cell) => compactText(cell.textContent));
    const findHeaderIndex = (label) => {
      const exact = headers.findIndex((text) => text === compactText(label));
      return exact >= 0 ? exact : headers.findIndex((text) => text.startsWith(compactText(label)));
    };

    const noIdx = findHeaderIndex(RECEPTION_HEADERS.patientNo);
    const nameIdx = findHeaderIndex(RECEPTION_HEADERS.patientName);
    const insuranceIdx = findHeaderIndex(RECEPTION_HEADERS.insurance);
    if ([noIdx, insuranceIdx].some((index) => index < 0)) return null;

    return { noIdx, nameIdx, insuranceIdx };
  }

  function getReceptionTableContext() {
    const candidates = Array.from(document.querySelectorAll("table")).map((table) => {
      if (!isVisible(table)) return null;
      const rect = table.getBoundingClientRect();
      if (rect.width < 400 || rect.height < 80) return null;
      const cols = getReceptionColumnMap(table);
      if (!cols) return null;
      const rows = Array.from(table.tBodies || []).flatMap((tbody) => Array.from(tbody.rows || []));
      if (!rows.length) return null;
      return { table, cols, rowCount: rows.length, top: rect.top };
    }).filter(Boolean);

    candidates.sort((a, b) => b.rowCount - a.rowCount || a.top - b.top);
    const picked = candidates[0] || null;
    if (picked) picked.table.__dkInsuranceIdx = String(picked.cols.insuranceIdx);
    return picked;
  }

  function isScrollableY(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const style = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4;
  }

  function findScrollContainer(table) {
    let current = table.parentElement;
    while (current && current !== document.body) {
      if (isScrollableY(current)) return current;
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function getVisibleTableRows(table) {
    return Array.from(table.tBodies || [])
      .flatMap((tbody) => Array.from(tbody.rows || []))
      .filter((row) => row.cells?.length)
      .filter((row) => isVisible(row))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function readReceptionRowSnapshot(row, ctx) {
    const noCell = row.cells[ctx.cols.noIdx];
    const nameCell = ctx.cols.nameIdx >= 0 ? row.cells[ctx.cols.nameIdx] : null;
    const insuranceCell = row.cells[ctx.cols.insuranceIdx];
    if (!noCell || !insuranceCell) return null;

    const patientNo = flatText(noCell.textContent).replace(/\s+/g, "");
    const patientName = flatText(nameCell?.textContent || "");
    if (!patientNo) return null;

    return {
      key: `${patientNo}|${patientName}`,
      patientNo,
      patientName,
      rowText: flatText(row.textContent),
    };
  }

  async function collectReceptionSnapshots(ctx) {
    const scrollEl = findScrollContainer(ctx.table);
    const snapshots = new Map();
    scrollEl.scrollTop = 0;
    await sleep(200);

    let stableCount = 0;
    for (let loop = 0; loop < 100; loop += 1) {
      const beforeSize = snapshots.size;

      for (const row of getVisibleTableRows(ctx.table)) {
        const snap = readReceptionRowSnapshot(row, ctx);
        if (!snap) continue;
        snapshots.set(snap.key, snap);
      }

      if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 5) {
        stableCount = snapshots.size === beforeSize ? stableCount + 1 : 0;
        if (stableCount >= 2) break;
      }

      const next = Math.min(scrollEl.scrollTop + Math.max(240, Math.floor(scrollEl.clientHeight * 0.7)), scrollEl.scrollHeight);
      if (next === scrollEl.scrollTop) break;
      scrollEl.scrollTop = next;
      await sleep(160);
    }

    console.table(
      Array.from(snapshots.values()).map((item) => ({
        patientNo: item.patientNo,
        patientName: item.patientName,
        rowText: item.rowText.slice(0, 100),
      }))
    );

    return { snapshots };
  }

  async function locateReceptionRowElement(ctx, targetKey) {
    const scrollEl = findScrollContainer(ctx.table);
    scrollEl.scrollTop = 0;
    await sleep(200);

    for (let loop = 0; loop < 120; loop += 1) {
      for (const row of getVisibleTableRows(ctx.table)) {
        const snap = readReceptionRowSnapshot(row, ctx);
        if (snap?.key === targetKey) return row;
      }
      const next = Math.min(scrollEl.scrollTop + Math.max(240, Math.floor(scrollEl.clientHeight * 0.7)), scrollEl.scrollHeight);
      if (next === scrollEl.scrollTop) break;
      scrollEl.scrollTop = next;
      await sleep(160);
    }
    return null;
  }

  async function findReceptionPatientRow(ctx) {
    logStep("findReceptionPatientRow", "受付一覧から対象患者行を探します", {
      patientNo: ctx.patientNo,
      patientName: ctx.patientName,
    });

    const { snapshots } = await collectReceptionSnapshots(ctx);
    const exactNo = Array.from(snapshots.values()).filter((item) => item.patientNo === ctx.patientNo);
    let matched = exactNo;

    if (matched.length > 1 && ctx.patientName) {
      matched = matched.filter((item) => item.patientName === ctx.patientName || item.patientName.includes(ctx.patientName) || ctx.patientName.includes(item.patientName));
    }

    if (matched.length !== 1) {
      fail("受付一覧で患者行が一意に見つかりません", matched);
    }

    const row = await locateReceptionRowElement(ctx, matched[0].key);
    if (!row) fail("受付一覧で対象患者行の実DOMを再取得できませんでした", matched[0]);
    logStep("findReceptionPatientRow", "受付一覧の患者行を特定しました", matched[0]);
    return row;
  }

  function findEditButtonNearCell(cell) {
    const direct = Array.from(cell.querySelectorAll("button, a, [role='button']")).find((button) => isVisible(button) && isLikelyEditButton(button));
    if (direct) return direct;
    const row = cell.closest("tr");
    if (!row) return null;
    return Array.from(row.querySelectorAll("button, a, [role='button']")).find((button) => isVisible(button) && isLikelyEditButton(button));
  }

  async function openReceptionEditModal(row) {
    const insuranceIdx = Number(row.closest("table").__dkInsuranceIdx);
    const insuranceCell = row.cells[insuranceIdx];
    if (!insuranceCell) fail("受付一覧の保険セルが見つかりません");

    logStep("openReceptionEditModal", "予約編集モーダルを開きます");

    const editButton = findEditButtonNearCell(insuranceCell);
    const clickTargets = [editButton, insuranceCell].filter(Boolean);

    for (const target of clickTargets) {
      safeClick(target);
      try {
        const modal = await waitFor(() => findModalByTitle("予約編集"), {
          timeoutMs: 2500,
          name: "予約編集モーダル",
        });
        logStep("openReceptionEditModal", "予約編集モーダルを開きました");
        return modal;
      } catch (_) {
        // try next target
      }
    }

    fail("予約編集モーダルを開けませんでした");
  }

  async function applyReceptionBenefits(ctx, selection) {
    const modal = findModalByTitle("予約編集");
    if (!modal) fail("予約編集モーダルが見つかりません");

    const selectMap = getModalBenefitSelects(modal);
    if (!selectMap[1] || !selectMap[2] || !selectMap[3]) {
      fail("予約編集モーダル内の公費selectが見つかりません");
    }

    const optionPool = buildUniqueOptionPool(selectMap);
    logStep("applyReceptionBenefits", "予約側候補一覧", optionPool);
    console.table(
      optionPool.map((item) => ({
        text: item.meta.text.slice(0, 120),
        burdener: item.meta.burdenerNumber,
        recipient: item.meta.recipientNumber,
        code: item.meta.benefitCode,
        slots: item.slots.join(","),
        selectedCount: item.selectedCount,
      }))
    );

    await applySlotTargetsToModal(modal, selection.slotTargets, "applyReceptionBenefits");
    logStep("applyReceptionBenefits", "dryRunか本更新か", { dryRun: CONFIG.dryRun });

    if (CONFIG.dryRun) {
      console.table(
        Object.entries(selection.slotTargets).map(([slot, target]) => ({
          slot: `公費${slot}`,
          action: "NO_UPDATE",
          text: target.text,
        }))
      );
      logStep("applyReceptionBenefits", "dryRun=true のため予約編集の更新ボタンは押しません");
      return true;
    }

    const updateButton = findButtonByText(["更新"], modal);
    if (!updateButton) fail("予約編集モーダルの更新ボタンが見つかりません");
    safeClick(updateButton);
    await waitFor(() => !findModalByTitle("予約編集"), {
      timeoutMs: 5000,
      name: "予約編集モーダル close",
    }).catch(() => fail("予約編集後にモーダルが閉じませんでした"));

    logStep("applyReceptionBenefits", "予約側の更新が完了しました");
    return true;
  }

  function setButtonBusy(busy) {
    const button = document.getElementById(APP.buttonId);
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? `${CONFIG.buttonText} 実行中...` : CONFIG.buttonText;
    button.style.opacity = busy ? "0.65" : "1";
    button.style.cursor = busy ? "wait" : "pointer";
  }

  function isKartePage() {
    return /^\/karte\/patients\/\d+\/\d{8}$/.test(location.pathname);
  }

  function isReceptionPage() {
    return /^\/reception\/\d{8}$/.test(location.pathname);
  }

  function addActionButton() {
    if (!isKartePage()) return;
    if (document.getElementById(APP.buttonId)) return;

    const button = document.createElement("button");
    button.id = APP.buttonId;
    button.textContent = CONFIG.buttonText;
    Object.assign(button.style, {
      position: "fixed",
      right: "18px",
      bottom: "18px",
      zIndex: "999999",
      padding: "12px 16px",
      borderRadius: "10px",
      border: "none",
      background: "#0f766e",
      color: "#fff",
      fontSize: "14px",
      fontWeight: "700",
      boxShadow: "0 8px 20px rgba(0,0,0,0.25)",
      cursor: "pointer",
    });

    button.addEventListener("click", async () => {
      if (flowRunning) return;
      flowRunning = true;
      setButtonBusy(true);
      try {
        await runKarteFlow();
      } catch (error) {
        if (!error?.__dkAlreadyAlerted) {
          console.error(APP.logPrefix, error);
          alert(`${CONFIG.buttonText}: ${error.message}`);
        }
      } finally {
        flowRunning = false;
        setButtonBusy(false);
      }
    });

    document.body.appendChild(button);
    logStep("addActionButton", "固定ボタンを追加しました");
  }

  async function runKarteFlow() {
    const ctx = parseCurrentKarteContext();
    logStep("runKarteFlow", "dryRunか本更新か", { dryRun: CONFIG.dryRun });

    await ensureFileTabOpen();
    const row = getTopAttachmentRow();
    const imageUrl = await extractAttachmentImageUrl(row);
    const blob = await fetchImageBlob(imageUrl);
    const preprocessed = await preprocessImage(blob);
    const ocr = await runOcr(preprocessed);
    logStep("runKarteFlow", "OCR生テキスト", ocr.rawText);
    const parsed = parseOcrText(ocr.rawText);
    const classified = classifyBenefits(parsed);
    await openKarteUpdateModal();
    const resolvedSelection = await applyKarteBenefits(classified);

    pendingContextForNavigation = {
      type: "reception-apply",
      patientId: ctx.patientId,
      patientNo: ctx.patientNo,
      patientName: ctx.patientName,
      visitDate: ctx.visitDate,
      imageUrl,
      ocr: {
        burdenerNumber: parsed.burdenerNumber,
        recipientNumber: parsed.recipientNumber,
        benefitCode: parsed.benefitCode,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        limitAmount: parsed.limitAmount,
        patientNameRef: parsed.patientNameRef,
      },
      selection: resolvedSelection,
      dryRun: CONFIG.dryRun,
    };

    await gotoReceptionPage(ctx.visitDate);
  }

  async function maybeResumePendingFlow() {
    if (!isReceptionPage()) return false;
    if (resumeRunning) return false;

    const pending = readPendingState();
    if (!pending) return false;
    if (Date.now() - (pending.createdAt || 0) > 30 * 60 * 1000) {
      clearPendingState();
      return false;
    }

    resumeRunning = true;
    try {
      logStep("resume", "受付側処理を再開します", pending);
      const ctx = await waitFor(() => {
        const tableCtx = getReceptionTableContext();
        if (!tableCtx) return null;
        return {
          ...tableCtx,
          patientNo: pending.patientNo,
          patientName: pending.patientName,
        };
      }, {
        timeoutMs: CONFIG.timeoutMs,
        name: "受付一覧テーブル",
      });

      const row = await findReceptionPatientRow(ctx);
      await openReceptionEditModal(row);
      await applyReceptionBenefits(ctx, pending.selection);
      clearPendingState();
      logStep("resume", "成功", {
        patientNo: pending.patientNo,
        patientName: pending.patientName,
        dryRun: pending.dryRun,
      });
      return true;
    } catch (error) {
      clearPendingState();
      if (error?.__dkAlreadyAlerted) throw error;
      console.error(APP.logPrefix, "[resume error]", error);
      alert(`${CONFIG.buttonText}: ${error.message}`);
      throw error;
    } finally {
      resumeRunning = false;
    }
  }

  function scheduleEnsureButton(delay = 100) {
    if (ensureButtonTimer) return;
    ensureButtonTimer = window.setTimeout(() => {
      ensureButtonTimer = 0;
      addActionButton();
      maybeResumePendingFlow().catch((error) => {
        if (!error?.__dkAlreadyAlerted) console.error(APP.logPrefix, error);
      });
    }, delay);
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;

    window.setInterval(() => {
      const urlChanged = location.href !== lastLocationHref;
      if (urlChanged) {
        lastLocationHref = location.href;
        scheduleEnsureButton(0);
      } else if ((isKartePage() && !document.getElementById(APP.buttonId)) || (isReceptionPage() && readPendingState())) {
        scheduleEnsureButton(80);
      }
    }, 1000);

    new MutationObserver(() => {
      scheduleEnsureButton(80);
    }).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function init() {
    logStep("init", `version=${APP.version}`);
    logStep("init", "dryRunか本更新か", { dryRun: CONFIG.dryRun });
    scheduleEnsureButton(300);
    startObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
