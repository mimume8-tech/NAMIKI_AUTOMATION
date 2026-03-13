// ==UserScript==
// @name         自立仮番ボタン - デジカル公費自動登録
// @namespace    https://namiki-mental.local
// @version      3.2.0
// @description  デジカル保険画面に「自立仮番」ボタンを追加し、自立支援精神通院の仮登録を自動入力する
// @author       Namiki Mental Clinic
// @match        https://digikar.jp/*
// @match        https://*.digikar.jp/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════
  // デバッグモード（true にすると詳細ログが出る）
  // ══════════════════════════════════════════════════════════════
  const DEBUG = true;

  // ══════════════════════════════════════════════════════════════
  // 業務定数
  // ══════════════════════════════════════════════════════════════
  const TEMP_FUTANSHA = "21000000";       // 仮負担者番号
  const KOUHI_TYPE_TEXT = "精神通院";      // 公費の種類テキスト（部分一致）
  const MONTHLY_LIMIT = "20000";          // 月上限円（非生活保護）
  const RATE_PERCENT = "10";              // 1回あたり上限%（非生活保護）
  const LIFE_PROTECTION_PREFIX = "12";    // 生活保護の負担者番号先頭

  // ══════════════════════════════════════════════════════════════
  // セレクタ定数
  // 実地確認で判明した要素構造を優先し、フォールバック付き
  // ══════════════════════════════════════════════════════════════
  const SELECTORS = {
    // 公費追加「＋」ボタン — SVGパス「M13 11h9v2h-9v9h-2v-9H2v-2h9V2h2z」を持つ
    plusSvgPath: 'path[d="M13 11h9v2h-9v9h-2v-9H2v-2h9V2h2z"]',

    // 公費追加モーダル内のフォーム要素（ラベル探索をメインにするが一応セレクタも）
    futanshaInput: 'input[name="publicExpenseNumber"]',
    kouhiTypeSelect: 'select[name*="kouhi"], select[name*="publicType"], select[name*="type"]',
    jukyushaInput: 'input[name*="jukyusha"], input[name*="recipient"]',

    // カルテ更新モーダル（Phase 2 用）
    editPencilBtn: '.edit-btn, [class*="edit"], button[title*="編集"], button[aria-label*="編集"], button[title*="edit"], button[aria-label*="edit"]',
    chartUpdateEntryEditButton: '#root > div > div.css-uaysch > div.css-9vboi8 > div.css-116vn3d > div.css-16bq4yl > div.css-ztkqqy > div.css-rr4en0 > span > button',
    chartPublic1SelectExact: 'select.css-1poodrh',
    chartTempSaveButton: '#root > div > div.css-uaysch > div.css-eougxq > div.css-173zpu7 > div > span:nth-child(5) > button',
    chartListInsuranceCell: '#root > div > div > div > div > div.css-15mudl3 > table > tbody > tr:nth-child(1) > td:nth-child(7)',
    chartListInsuranceEditButton: 'button.edit-icon',
    editIconPath: 'path[d="M19.575 9.326 15.2 4.976 16.45 3.7a2.32 2.32 0 0 1 1.638-.7c.641-.017 1.22.216 1.737.7l1.05 1.025c.517.483.758 1.042.725 1.675a2.404 2.404 0 0 1-.725 1.625zm-1.425 1.45L7.4 21.526H3V17.15L13.75 6.4z"]',
    saveIconPath: 'path[d="M17 3H3v18h18V7zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3m3-10H5V5h10z"]',
    kouhi1Select: 'select[name*="kouhi1"], select[name*="public1"]',
    kouhi2Select: 'select[name*="kouhi2"], select[name*="public2"]',
  };

  // ══════════════════════════════════════════════════════════════
  // ログユーティリティ
  // ══════════════════════════════════════════════════════════════
  const P = "[JIRITSU_TMP]";
  const log   = (...a) => console.log(P, ...a);
  const debug = (...a) => { if (DEBUG) console.log(P, "[DEBUG]", ...a); };
  const warn  = (...a) => console.warn(P, ...a);
  const error = (...a) => console.error(P, ...a);

  // ══════════════════════════════════════════════════════════════
  // トースト通知
  // ══════════════════════════════════════════════════════════════
  function showToast(message, type = "info") {
    const bg = { info: "#2196F3", success: "#4CAF50", error: "#f44336", warn: "#FF9800" };
    const el = document.createElement("div");
    el.textContent = message;
    Object.assign(el.style, {
      position: "fixed", bottom: "80px", right: "20px",
      background: bg[type] || bg.info, color: "#fff",
      padding: "12px 24px", borderRadius: "8px",
      fontSize: "14px", fontWeight: "bold", zIndex: "999999",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      transition: "opacity 0.5s", opacity: "1",
      maxWidth: "400px", wordBreak: "break-word",
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 600); }, 4000);
  }

  // ══════════════════════════════════════════════════════════════
  // 非同期ユーティリティ
  // ══════════════════════════════════════════════════════════════
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitForElement(finder, timeout = 10000, interval = 300) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function check() {
        const el = finder();
        if (el) return resolve(el);
        if (Date.now() - t0 > timeout) return reject(new Error(`waitForElement timeout (${timeout}ms)`));
        setTimeout(check, interval);
      })();
    });
  }

  function waitForCondition(fn, timeout = 10000, interval = 300) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function check() {
        if (fn()) return resolve(true);
        if (Date.now() - t0 > timeout) return reject(new Error(`waitForCondition timeout (${timeout}ms)`));
        setTimeout(check, interval);
      })();
    });
  }

  // ══════════════════════════════════════════════════════════════
  // DOM探索ユーティリティ
  // ══════════════════════════════════════════════════════════════

  /** scope 内でテキストノードを含む要素を探す */
  function findTextElement(text, scope = document.body) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.trim().includes(text)) {
        return walker.currentNode.parentElement;
      }
    }
    return null;
  }

  /**
   * ラベルテキスト近傍の入力要素を探す
   * @param {string} labelText - ラベルの部分一致テキスト
   * @param {string} tag - 探すタグ (input, select, button 等)
   * @param {Element} scope - 探索範囲
   */
  function findByLabel(labelText, tag = "input", scope = document) {
    // 方法1: label[for] → 対象要素
    for (const lbl of scope.querySelectorAll("label")) {
      if (lbl.textContent.includes(labelText)) {
        const forId = lbl.getAttribute("for");
        if (forId) {
          const t = scope.querySelector(`#${CSS.escape(forId)}`);
          if (t) { debug(`findByLabel("${labelText}") → label[for]`, t); return t; }
        }
        const inner = lbl.querySelector(tag);
        if (inner) { debug(`findByLabel("${labelText}") → label内`, inner); return inner; }
      }
    }

    // 方法2: テキストノードの親→同一行→兄弟→親の兄弟
    const candidates = scope.querySelectorAll("th, td, dt, dd, span, div, p, label");
    for (const el of candidates) {
      // 直接テキストノードだけ見る（子要素のテキストは無視して誤爆防止）
      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim()).join("");
      if (!directText.includes(labelText) && el.textContent.trim() !== labelText) continue;

      // 同一行
      const row = el.closest("tr, [class*='row'], [class*='field'], [class*='Row'], [class*='Field']");
      if (row) {
        const t = row.querySelector(tag);
        if (t) { debug(`findByLabel("${labelText}") → row内`, t); return t; }
      }
      // 兄弟
      let sib = el.nextElementSibling;
      for (let i = 0; i < 5 && sib; i++, sib = sib.nextElementSibling) {
        const t = sib.matches?.(tag) ? sib : sib.querySelector(tag);
        if (t) { debug(`findByLabel("${labelText}") → 兄弟`, t); return t; }
      }
      // 親の兄弟
      const ps = el.parentElement?.nextElementSibling;
      if (ps) {
        const t = ps.matches?.(tag) ? ps : ps.querySelector(tag);
        if (t) { debug(`findByLabel("${labelText}") → 親兄弟`, t); return t; }
      }
    }

    debug(`findByLabel("${labelText}", "${tag}") → 未発見`);
    return null;
  }

  /** テキスト一致でボタンを探す */
  function findButtonByText(text, scope = document) {
    for (const btn of scope.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]')) {
      const t = btn.textContent.trim();
      if (t === text || t.includes(text)) {
        debug(`findButtonByText("${text}") →`, btn);
        return btn;
      }
    }
    debug(`findButtonByText("${text}") → 未発見`);
    return null;
  }

  /** チェックボックスをテキスト近傍で探す */
  function findCheckboxByText(text, scope = document) {
    const el = findTextElement(text, scope);
    if (!el) return null;
    // 自分自身がlabelなら中のcheckboxを探す
    let cb = el.querySelector?.('input[type="checkbox"]');
    if (cb) return cb;
    // 親要素を3段階上がって探す
    let p = el;
    for (let i = 0; i < 3; i++) {
      p = p.parentElement;
      if (!p) break;
      cb = p.querySelector('input[type="checkbox"]');
      if (cb) return cb;
    }
    // 直前の兄弟
    if (el.previousElementSibling?.matches('input[type="checkbox"]')) {
      return el.previousElementSibling;
    }
    return null;
  }

  /** ラジオボタンをテキスト近傍で探す */
  function findRadioByText(text, scope = document) {
    const el = findTextElement(text, scope);
    if (!el) return null;
    let r = el.querySelector?.('input[type="radio"]');
    if (r) return r;
    let p = el;
    for (let i = 0; i < 3; i++) {
      p = p.parentElement;
      if (!p) break;
      r = p.querySelector('input[type="radio"]');
      if (r) return r;
    }
    if (el.previousElementSibling?.matches('input[type="radio"]')) {
      return el.previousElementSibling;
    }
    return null;
  }

  /**
   * モーダルタイトルで探す
   */
  function findModalByTitle(titleText) {
    // 画面上に表示されているタイトルテキストを探し、祖先のモーダルを返す
    const titleCandidates = document.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, [class*='title'], [class*='Title'], [class*='header'], [class*='Header'], [class*='heading']"
    );
    for (const el of titleCandidates) {
      if (el.textContent.trim().includes(titleText) && el.offsetParent !== null) {
        // 親をたどってモーダルっぽい要素を探す
        let p = el.parentElement;
        for (let i = 0; i < 10; i++) {
          if (!p) break;
          const cls = p.className?.toString?.() || "";
          const style = getComputedStyle(p);
          if (
            style.position === "fixed" || style.position === "absolute" ||
            cls.match(/modal|Modal|dialog|Dialog|overlay|Overlay/) ||
            p.getAttribute("role") === "dialog"
          ) {
            debug(`findModalByTitle("${titleText}") → 発見`, p.tagName, cls.substring(0, 80));
            return p;
          }
          p = p.parentElement;
        }
        // 見つからなくてもタイトル付近を返す
        const fallback = el.closest('[class*="modal"], [class*="Modal"], [role="dialog"]') ||
                         el.parentElement?.parentElement;
        debug(`findModalByTitle("${titleText}") → fallback`, fallback?.tagName);
        return fallback;
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════
  // React SPA 対応イベント発火
  // ══════════════════════════════════════════════════════════════

  /**
   * execCommand("insertText") で入力する（React 対応の最も確実な方法）
   * ブラウザがキーボード入力と同じ InputEvent を発火するので React が受け入れる
   */
  function execInsertText(el, value) {
    if (!el) return false;
    el.focus();
    // 全選択して既存値を置き換え
    el.select?.();
    if (!el.selectionStart && !el.selectionEnd) {
      // select() が効かない場合は setSelectionRange で全選択
      try { el.setSelectionRange(0, el.value.length); } catch (e) { /* ignore */ }
    }
    // insertText で入力（React が InputEvent を正しく拾う）
    document.execCommand("insertText", false, value);
    debug(`execInsertText("${value}") → result="${el.value}"`);
    return el.value === value;
  }

  /**
   * nativeInputValueSetter + _valueTracker リセット（React 用フォールバック）
   */
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
    // React の _valueTracker をリセット
    const tracker = el._valueTracker;
    if (tracker) tracker.setValue("");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    debug(`setNativeValue("${value}") → result="${el.value}"`);
    return true;
  }

  /**
   * React fiber の onChange を直接呼び出す（React 17+ 対応の最終手段）
   * React の内部構造に直接アクセスして onChange ハンドラを実行する
   */
  function setReactFiberValue(el, value) {
    if (!el) return false;
    // React fiber key を探す
    const fiberKey = Object.keys(el).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) {
      debug("React fiber が見つかりません");
      return false;
    }

    const fiber = el[fiberKey];
    // fiber ツリーを上方に辿って onChange を持つコンポーネントを探す
    let current = fiber;
    for (let i = 0; i < 20 && current; i++) {
      const props = current.memoizedProps || current.pendingProps;
      if (props && typeof props.onChange === "function") {
        // nativeInputValueSetter で値を物理的にセット
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(el, value);
        else el.value = value;

        // React の onChange を直接呼び出す
        const syntheticEvent = {
          target: el,
          currentTarget: el,
          type: "change",
          preventDefault() {},
          stopPropagation() {},
          persist() {},
          nativeEvent: new Event("change", { bubbles: true }),
        };
        props.onChange(syntheticEvent);
        debug(`setReactFiberValue: onChange 直接呼び出し成功 → "${el.value}"`);
        return true;
      }
      current = current.return;
    }

    debug("React fiber: onChange ハンドラが見つかりません");
    return false;
  }

  /**
   * 確実に input に値をセットする（3段階）
   * 1. execCommand("insertText") — ブラウザのキーボード入力と同等
   * 2. nativeInputValueSetter + _valueTracker — 従来の React ハック
   * 3. React fiber の onChange 直接呼び出し — 最終手段
   */
  async function setInputValueRobust(el, value, label = "") {
    if (!el) return false;

    // 段階1: execCommand("insertText") — 最も確実
    el.focus();
    await sleep(50);
    execInsertText(el, value);
    await sleep(100);
    if (el.value === value) {
      log(`  ${label}: execInsertText 成功 → "${el.value}"`);
      return true;
    }

    // 段階2: nativeInputValueSetter + _valueTracker
    debug(`  ${label}: execInsertText 失敗("${el.value}") → setNativeValue へ`);
    setNativeValue(el, value);
    await sleep(100);
    if (el.value === value) {
      log(`  ${label}: setNativeValue 成功 → "${el.value}"`);
      return true;
    }

    // 段階3: React fiber の onChange 直接呼び出し
    debug(`  ${label}: setNativeValue 失敗("${el.value}") → React fiber へ`);
    el.focus();
    await sleep(50);
    const fiberOk = setReactFiberValue(el, value);
    await sleep(200);
    if (el.value === value) {
      log(`  ${label}: React fiber 成功 → "${el.value}"`);
      return true;
    }
    // fiber で onChange が呼ばれても value が反映されない場合がある（非同期レンダリング）
    // → 少し待って再確認
    if (fiberOk) {
      await sleep(500);
      if (el.value === value) {
        log(`  ${label}: React fiber 成功（遅延反映） → "${el.value}"`);
        return true;
      }
    }

    warn(`  ${label}: 全3段階で入力失敗。value="${el.value}", 期待="${value}"`);
    return false;
  }

  /** select を value で選択 */
  function setSelectValue(sel, value) {
    if (!sel) return false;
    return setNativeValue(sel, value);
  }

  /** select を option text 部分一致で選択 */
  function setSelectByText(sel, partialText) {
    if (!sel) return false;
    for (const opt of sel.options) {
      if (opt.textContent.includes(partialText)) {
        debug(`setSelectByText("${partialText}") → value="${opt.value}", text="${opt.textContent.trim()}"`);
        return setSelectValue(sel, opt.value);
      }
    }
    warn(`setSelectByText: "${partialText}" に一致する option なし`);
    return false;
  }

  /** チェックボックスを設定 */
  function setCheckbox(el, checked) {
    if (!el) return false;
    if (el.checked !== checked) {
      el.click();
      // click で変わらなかった場合の保険
      if (el.checked !== checked) {
        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
        if (s) s.call(el, checked);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    debug(`setCheckbox(${checked}) →`, el.checked);
    return true;
  }

  /** ラジオをクリック */
  function clickRadio(el) {
    if (!el) return false;
    el.click();
    el.dispatchEvent(new Event("change", { bubbles: true }));
    debug("clickRadio →", el.name, el.value);
    return true;
  }

  /** 要素クリック */
  function safeClick(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    debug("safeClick →", el.tagName, (el.textContent || "").substring(0, 30));
    return true;
  }

  // ══════════════════════════════════════════════════════════════
  // window.confirm 自動承認フック
  // チェックデジット警告「登録してよろしいですか」に対応
  // ══════════════════════════════════════════════════════════════
  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return el.offsetParent !== null && style.display !== "none" && style.visibility !== "hidden";
  }

  function queryVisible(selector, scope = document) {
    if (!selector || !scope?.querySelectorAll) return null;
    return Array.from(scope.querySelectorAll(selector)).find(isVisible) || null;
  }

  function findButtonBySvgSelector(svgSelector, scope = document) {
    if (!svgSelector || !scope?.querySelectorAll) return null;
    const path = queryVisible(svgSelector, scope);
    return path?.closest("button, a, [role='button']") || null;
  }

  function findVisibleTextElements(text, scope = document.body) {
    const hits = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim().includes(text)) continue;
      const el = node.parentElement;
      if (!isVisible(el)) continue;
      if (el.closest('[class*="modal"], [class*="Modal"], [role="dialog"]')) continue;
      hits.push(el);
    }
    return hits;
  }

  function getVisibleActionButtons(scope) {
    if (!scope) return [];
    return Array.from(scope.querySelectorAll("button, a, [role='button']")).filter(
      (btn) => isVisible(btn) && !btn.closest('[class*="modal"], [class*="Modal"], [role="dialog"]')
    );
  }

  function isLikelyEditButton(btn) {
    if (!btn) return false;

    try {
      if (btn.matches(SELECTORS.editPencilBtn)) return true;
    } catch (e) {
      debug("edit selector match failed", e);
    }

    const meta = [
      btn.getAttribute("title"),
      btn.getAttribute("aria-label"),
      btn.className?.toString?.(),
      btn.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (meta.includes("編集") || meta.includes("edit") || meta.includes("pencil")) return true;

    const svgPath = Array.from(btn.querySelectorAll("path"))
      .map((path) => path.getAttribute("d") || "")
      .join(" ");
    return svgPath.includes("17.25") && svgPath.includes("3.75");
  }

  function closeUnexpectedModalIfNeeded() {
    const anyModal = document.querySelector('[class*="modal"], [role="dialog"]');
    if (!anyModal) return false;

    const closeBtn =
      anyModal.querySelector('[aria-label="close"], [class*="close"]') ||
      findButtonByText("×", anyModal) ||
      findButtonByText("✕", anyModal) ||
      findButtonByText("閉じる", anyModal) ||
      findButtonByText("キャンセル", anyModal);

    if (!closeBtn) return false;
    safeClick(closeBtn);
    return true;
  }

  function findModalCloseButton(modal) {
    if (!modal) return null;

    const modalRect = modal.getBoundingClientRect();
    const candidates = Array.from(modal.querySelectorAll("button, a, [role='button']")).filter(isVisible);
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const btn of candidates) {
      const text = (btn.textContent || "").trim();
      const meta = [
        btn.getAttribute("title"),
        btn.getAttribute("aria-label"),
        btn.className?.toString?.(),
        text,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const rect = btn.getBoundingClientRect();
      let score = 0;

      if (meta.includes("close") || meta.includes("閉じる") || meta.includes("閉")) score += 400;
      if (text === "×" || text === "✕" || text === "x" || text === "X") score += 300;
      if (btn.querySelector("svg")) score += 20;

      score += Math.max(0, 120 - Math.abs(modalRect.right - rect.right));
      score += Math.max(0, 120 - Math.abs(modalRect.top - rect.top));
      if (rect.top <= modalRect.top + 120) score += 60;
      if (rect.right >= modalRect.right - 160) score += 60;

      if (score > bestScore) {
        bestScore = score;
        best = btn;
      }
    }

    return best;
  }

  async function closeModalByTitle(titleText, timeout = 0) {
    const modal = timeout > 0
      ? await waitForElement(() => findModalByTitle(titleText), timeout, 300).catch(() => null)
      : findModalByTitle(titleText);

    if (!modal) return false;

    const closeBtn = findModalCloseButton(modal);
    if (!closeBtn) {
      warn(`モーダル「${titleText}」の閉じるボタンが見つかりません`);
      return false;
    }

    safeClick(closeBtn);
    log(`モーダル「${titleText}」を閉じるボタンをクリック`);

    try {
      await waitForCondition(() => !findModalByTitle(titleText), 5000, 250);
      log(`モーダル「${titleText}」を閉じました ✓`);
      return true;
    } catch (e) {
      warn(`モーダル「${titleText}」が閉じません: ${e.message}`);
      return false;
    }
  }

  async function closePublicExpenseHistoryModalIfPresent() {
    const closed = await closeModalByTitle("公費更新履歴", 6000);
    if (closed) {
      await sleep(500);
      return true;
    }
    return false;
  }

  async function tryOpenChartUpdateFromButton(btn, reason) {
    if (!btn) return null;

    safeClick(btn);
    log(`${reason} をクリック`);
    await sleep(1500);

    const modal = findModalByTitle("カルテ更新");
    if (modal) {
      log(`カルテ更新モーダルが開きました（${reason}）`);
      await sleep(500);
      return modal;
    }

    if (closeUnexpectedModalIfNeeded()) {
      await sleep(500);
    }

    return null;
  }

  function findPublicExpenseRowEditButton(publicExpenseNumber = TEMP_FUTANSHA) {
    const scores = new Map();
    const hitElements = findVisibleTextElements(publicExpenseNumber);

    for (const hitEl of hitElements) {
      let container = hitEl;
      for (let depth = 0; depth < 6 && container; depth++) {
        const text = container.textContent || "";
        if (text.includes(publicExpenseNumber)) {
          const buttons = getVisibleActionButtons(container).filter((btn) => btn.querySelector("svg"));
          if (buttons.length > 0) {
            const textPenalty = Math.min(text.trim().length, 160) / 4;
            buttons.forEach((btn, index) => {
              let score = 240 - depth * 20 - textPenalty;
              if (isLikelyEditButton(btn)) score += 120;
              if (index === buttons.length - 1) score += 30;
              if (buttons.length === 2) score += 15;
              const prev = scores.get(btn) ?? Number.NEGATIVE_INFINITY;
              if (score > prev) scores.set(btn, score);
            });
          }
        }
        container = container.parentElement;
      }
    }

    const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    if (DEBUG && ranked.length > 0) {
      debug(
        "findPublicExpenseRowEditButton ranked:",
        ranked.slice(0, 5).map(([btn, score]) => ({
          score,
          html: btn.outerHTML.substring(0, 120),
        }))
      );
    }
    return ranked[0]?.[0] || null;
  }

  function findDirectChartUpdateEditButton() {
    return (
      queryVisible(SELECTORS.chartUpdateEntryEditButton) ||
      findButtonBySvgSelector(SELECTORS.editIconPath)
    );
  }

  function findTemporaryJiritsuOption(select) {
    if (!select) return null;
    for (const opt of select.options) {
      const text = opt.textContent || "";
      if (text.includes(TEMP_FUTANSHA) || text.includes(KOUHI_TYPE_TEXT)) {
        return opt;
      }
    }
    return null;
  }

  function findNumberedSelect(scope, rowNumber) {
    if (!scope) return null;

    for (const sel of scope.querySelectorAll("select")) {
      const row = sel.closest("tr, [class*='row'], [class*='Row'], [class*='field'], [class*='Field']");
      if (row) {
        const children = Array.from(row.children);
        const hasRowLabel = children.some((child) => child.textContent.trim() === rowNumber);
        if (hasRowLabel) return sel;
      }

      const prev = sel.previousElementSibling || sel.parentElement?.previousElementSibling;
      if (prev?.textContent.trim() === rowNumber) return sel;
    }

    return null;
  }

  async function clickChartTemporarySaveButton() {
    const saveBtn = await waitForElement(
      () => queryVisible(SELECTORS.chartTempSaveButton) || findButtonBySvgSelector(SELECTORS.saveIconPath),
      8000,
      300
    ).catch(() => null);

    if (!saveBtn) throw new Error("一時保存ボタンが見つかりません");

    safeClick(saveBtn);
    log("一時保存ボタンをクリック");
    await sleep(1500);
  }

  function findInsuranceCellInChartList() {
    const directCell = queryVisible(SELECTORS.chartListInsuranceCell);
    if (directCell) return directCell;

    const directEditBtn = queryVisible(SELECTORS.chartListInsuranceEditButton);
    if (directEditBtn) return directEditBtn.closest("td");

    const cells = Array.from(document.querySelectorAll("td")).filter(isVisible);
    for (const cell of cells) {
      if (!cell.querySelector(SELECTORS.chartListInsuranceEditButton)) continue;
      const text = cell.textContent.trim();
      if (text.includes("国保") || text.includes("保険")) return cell;
    }

    return null;
  }

  async function clickInsuranceCellInChartList() {
    const cell = await waitForElement(() => findInsuranceCellInChartList(), 8000, 300).catch(() => null);
    if (!cell) throw new Error("カルテ一覧の保険セルが見つかりません");

    safeClick(cell);
    log("カルテ一覧の保険セルをクリック");
    await sleep(1200);

    if (!findModalByTitle("予約編集")) {
      const editBtn = cell.querySelector(SELECTORS.chartListInsuranceEditButton);
      if (editBtn) {
        safeClick(editBtn);
        log("保険セル内の編集アイコンもクリック");
        await sleep(1200);
      }
    }
  }

  let confirmHookActive = false;
  const originalConfirm = window.confirm;

  function enableAutoConfirm() {
    confirmHookActive = true;
    window.confirm = function (msg) {
      log(`[AutoConfirm] "${msg}" → OK`);
      return true;
    };
    debug("window.confirm 自動承認 ON");
  }

  function disableAutoConfirm() {
    confirmHookActive = false;
    window.confirm = originalConfirm;
    debug("window.confirm 自動承認 OFF");
  }

  /**
   * 独自モーダル確認ダイアログの自動OK
   * 「よろしいですか」「OK」「はい」「登録」などのボタンを探してクリック
   */
  async function handleCustomConfirmDialog() {
    await sleep(500);
    // 確認系テキストを含むモーダルを探す
    const confirmTexts = ["よろしいですか", "チェックデジット"];
    for (const text of confirmTexts) {
      const el = findTextElement(text);
      if (el && el.offsetParent !== null) {
        log(`独自確認ダイアログ検出: "${text}"`);
        // OKボタンを探す
        const modal = el.closest('[class*="modal"], [class*="Modal"], [role="dialog"], [class*="overlay"]')
                     || el.parentElement?.parentElement?.parentElement;
        if (modal) {
          const okBtn =
            findButtonByText("OK", modal) ||
            findButtonByText("はい", modal) ||
            findButtonByText("登録", modal) ||
            findButtonByText("確認", modal) ||
            findButtonByText("続行", modal);
          if (okBtn) {
            safeClick(okBtn);
            log(`独自確認ダイアログ → "${okBtn.textContent.trim()}" をクリック`);
            return true;
          }
        }
      }
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════
  // 日付ユーティリティ（日本時間基準）
  // ══════════════════════════════════════════════════════════════
  function getTodayJST() {
    const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const y = jst.getUTCFullYear(), m = jst.getUTCMonth() + 1, d = jst.getUTCDate();
    return {
      year: y, month: m, day: d,
      slash: `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`,
      iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    };
  }

  function getOneYearLaterJST() {
    const today = getTodayJST();
    const d = new Date(today.year + 1, today.month - 1, today.day);
    const y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate();
    return {
      year: y, month: m, day: dd,
      slash: `${y}/${String(m).padStart(2, "0")}/${String(dd).padStart(2, "0")}`,
      iso: `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    };
  }

  /**
   * 日付入力の二段構え: 直接入力 → カレンダーUI fallback
   * @param {Element} inputEl - 日付 input 要素
   * @param {{year:number, month:number, day:number, slash:string}} dateObj - 目標日付
   * @param {string} label - ログ用ラベル（"開始日" / "終了日"）
   * @returns {Promise<boolean>} 成功したか
   */
  async function setDateField(inputEl, dateObj, label) {
    if (!inputEl) {
      warn(`  ${label}: input 要素が null`);
      return false;
    }

    // ──────────────────────────
    // 方法1: 直接テキスト入力（優先）
    // フォーマットは YYYY/MM/DD を第一候補
    // ──────────────────────────
    const slashVal = dateObj.slash;
    const isoVal = dateObj.iso;

    // まずクリアしてからフォーカス
    inputEl.focus();
    await sleep(100);

    // 既存値をクリア
    setNativeValue(inputEl, "");
    await sleep(50);

    // YYYY/MM/DD で入力
    setNativeValue(inputEl, slashVal);
    await sleep(200);

    // blur で確定
    inputEl.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(400);

    // 値が入ったか確認（和暦変換されている場合も成功とみなす）
    const afterVal = inputEl.value;
    if (afterVal && afterVal.length > 0 && afterVal !== "" && afterVal !== inputEl.placeholder) {
      // 値が入っている → 日付部分が含まれているか簡易チェック
      const yearStr = String(dateObj.year);
      const dayStr = String(dateObj.day);
      if (afterVal.includes(yearStr) || afterVal.includes("年") || afterVal.includes("/")) {
        log(`  ${label}: date-input direct success → "${afterVal}"`);
        return true;
      }
    }

    // ISO形式で再トライ
    debug(`  ${label}: YYYY/MM/DD で値が定着せず("${afterVal}")、ISO形式で再試行`);
    inputEl.focus();
    await sleep(100);
    setNativeValue(inputEl, isoVal);
    await sleep(200);
    inputEl.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(400);

    const afterVal2 = inputEl.value;
    if (afterVal2 && afterVal2.length > 0 && afterVal2 !== inputEl.placeholder) {
      log(`  ${label}: date-input direct success (ISO) → "${afterVal2}"`);
      return true;
    }

    // ──────────────────────────
    // 方法2: カレンダーUI fallback
    // input をクリック → カレンダーポップアップを操作
    // ──────────────────────────
    log(`  ${label}: 直接入力失敗 → カレンダーUI fallback 開始`);

    // input をクリックしてカレンダーを開く
    safeClick(inputEl);
    await sleep(600);

    // カレンダーポップアップを探す
    const calendarOk = await navigateCalendar(dateObj, label);
    if (calendarOk) {
      log(`  ${label}: date-input calendar fallback success`);
      return true;
    }

    // 方法3: type="date" の場合の最終手段
    if (inputEl.type === "date") {
      debug(`  ${label}: type=date の valueAsDate で再試行`);
      try {
        inputEl.valueAsDate = new Date(dateObj.year, dateObj.month - 1, dateObj.day);
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        if (inputEl.value) {
          log(`  ${label}: date-input valueAsDate success → "${inputEl.value}"`);
          return true;
        }
      } catch (e) { /* ignore */ }
    }

    warn(`  ${label}: 全方法で日付入力に失敗。手動で入力してください。`);
    return false;
  }

  /**
   * カレンダーポップアップを操作して目標日付を選択する
   * @param {{year:number, month:number, day:number}} dateObj
   * @param {string} label
   * @returns {Promise<boolean>}
   */
  async function navigateCalendar(dateObj, label) {
    // カレンダーポップアップを探す（よくあるパターン）
    const calendarSelectors = [
      '[class*="calendar"]', '[class*="Calendar"]',
      '[class*="datepicker"]', '[class*="DatePicker"]', '[class*="Datepicker"]',
      '[class*="picker"]', '[class*="Picker"]',
      '[role="grid"]', '[role="listbox"]',
      '.react-datepicker', '.react-calendar',
    ];

    let calendar = null;
    for (const sel of calendarSelectors) {
      calendar = document.querySelector(sel);
      if (calendar && calendar.offsetParent !== null) {
        debug(`  ${label}: カレンダー発見 → ${sel}`);
        break;
      }
      calendar = null;
    }

    if (!calendar) {
      debug(`  ${label}: カレンダーポップアップが見つかりません`);
      return false;
    }

    // ── 月ナビゲーション ──
    // 現在表示中の年月を取得
    const headerText = calendar.textContent;
    debug(`  ${label}: カレンダーheader="${headerText.substring(0, 50)}"`);

    // 目標の年月まで「次月」ボタンを押す（最大24回=2年分）
    for (let attempt = 0; attempt < 24; attempt++) {
      // 現在のカレンダーの年月を解読
      const calText = calendar.textContent;
      const yearMatch = calText.match(/(\d{4})/);
      const monthMatch = calText.match(/(\d{1,2})月/) || calText.match(/(\d{4})\s*[\/\-]\s*(\d{1,2})/);

      let curYear = yearMatch ? parseInt(yearMatch[1]) : null;
      let curMonth = monthMatch ? parseInt(monthMatch[1]) : null;
      // "2026/03" パターン
      if (!curMonth && monthMatch && monthMatch[2]) curMonth = parseInt(monthMatch[2]);

      if (curYear === dateObj.year && curMonth === dateObj.month) {
        debug(`  ${label}: 目標月に到達 ${curYear}/${curMonth}`);
        break;
      }

      // 前 or 次ボタンを探す
      const targetDate = new Date(dateObj.year, dateObj.month - 1);
      const currentDate = curYear && curMonth ? new Date(curYear, curMonth - 1) : null;
      const needForward = !currentDate || targetDate > currentDate;

      const navBtn = needForward
        ? (findButtonByText("›", calendar) || findButtonByText("次", calendar) ||
           findButtonByText(">", calendar) || calendar.querySelector('[class*="next"], [aria-label*="next"]'))
        : (findButtonByText("‹", calendar) || findButtonByText("前", calendar) ||
           findButtonByText("<", calendar) || calendar.querySelector('[class*="prev"], [aria-label*="prev"]'));

      if (navBtn) {
        safeClick(navBtn);
        await sleep(300);
      } else {
        debug(`  ${label}: カレンダーのナビゲーションボタンが見つかりません`);
        return false;
      }
    }

    // ── 日付を選択 ──
    await sleep(200);
    const dayStr = String(dateObj.day);
    // カレンダー内の日付セルを探す
    const dayCells = calendar.querySelectorAll(
      'td, [role="gridcell"], button, [class*="day"], [class*="Day"]'
    );
    for (const cell of dayCells) {
      const t = cell.textContent.trim();
      // 日付の完全一致（"1" が "10" "11" にマッチしないように）
      if (t === dayStr && cell.offsetParent !== null) {
        // 当月の日付か確認（disabled / 他月のクラスでないこと）
        const cls = cell.className?.toString?.() || "";
        if (cls.match(/disabled|outside|other|prev|next/i)) continue;
        safeClick(cell);
        debug(`  ${label}: カレンダーで ${dayStr} 日を選択`);
        await sleep(300);
        return true;
      }
    }

    debug(`  ${label}: カレンダー内で ${dayStr} 日が見つかりません`);
    return false;
  }

  /**
   * モーダル内の日付入力欄を収集する
   * 優先順: 「有効期間」ラベル近く → placeholder "yyyy" → 和暦表示値 → type="date"
   * @param {Element} modal
   * @returns {Element[]}
   */
  function collectDateInputs(modal) {
    const found = [];

    // 方法1: 「有効期間」ラベルの行から探す
    const yukouEl = findTextElement("有効期間", modal);
    if (yukouEl) {
      // 有効期間行 + その下のサブ行も含めて探索
      let container = yukouEl.closest("tr, [class*='row'], [class*='Row'], [class*='field'], [class*='Field']");
      if (!container) container = yukouEl.parentElement?.parentElement;
      if (container) {
        container.querySelectorAll("input").forEach((inp) => found.push(inp));
      }
      // 「開始日のみ必須」等のサブテキストがある場合、親を広げる
      if (found.length < 2) {
        const wider = container?.parentElement;
        if (wider) {
          wider.querySelectorAll("input").forEach((inp) => {
            if (!found.includes(inp)) found.push(inp);
          });
        }
      }
      debug(`  collectDateInputs 方法1(有効期間行): ${found.length} 個`);
    }

    // 方法2: placeholder / 値 / type で探す
    if (found.length < 2) {
      modal.querySelectorAll("input").forEach((inp) => {
        if (found.includes(inp)) return;
        const ph = (inp.placeholder || "").toLowerCase();
        const val = inp.value || "";
        if (
          ph.includes("yyyy") || ph.includes("年") ||
          val.includes("年") ||
          inp.type === "date"
        ) {
          found.push(inp);
        }
      });
      debug(`  collectDateInputs 方法2(placeholder/type): ${found.length} 個`);
    }

    // 方法3: 「〜」区切りの近くにある input を探す（開始日 〜 終了日 パターン）
    if (found.length < 2) {
      const tilde = findTextElement("〜", modal) || findTextElement("～", modal);
      if (tilde) {
        const parent = tilde.parentElement;
        if (parent) {
          parent.querySelectorAll("input").forEach((inp) => {
            if (!found.includes(inp)) found.push(inp);
          });
          // 前後の兄弟も探す
          const prev = parent.previousElementSibling;
          const next = parent.nextElementSibling;
          [prev, next].forEach((sib) => {
            if (!sib) return;
            sib.querySelectorAll("input").forEach((inp) => {
              if (!found.includes(inp)) found.push(inp);
            });
            // sib 自体が input の場合
            if (sib.matches?.("input") && !found.includes(sib)) found.push(sib);
          });
        }
        debug(`  collectDateInputs 方法3(〜近傍): ${found.length} 個`);
      }
    }

    // × ボタン（クリアボタン）の隣にある input も候補に
    // スクリーンショットでは日付欄の横に × がある
    if (found.length < 2) {
      const clearBtns = modal.querySelectorAll('[class*="clear"], [aria-label*="clear"], [aria-label*="クリア"]');
      for (const cb of clearBtns) {
        const sib = cb.previousElementSibling || cb.parentElement?.querySelector("input");
        if (sib?.matches?.("input") && !found.includes(sib)) found.push(sib);
      }
      debug(`  collectDateInputs 方法4(×ボタン隣): ${found.length} 個`);
    }

    return found;
  }

  // ══════════════════════════════════════════════════════════════
  // ページ判定
  // ══════════════════════════════════════════════════════════════
  function isOnTargetPage() {
    if (!location.href.includes("digikar.jp")) return false;
    // 「公費」というテキストが画面に見えるか
    return !!findTextElement("公費");
  }

  // ══════════════════════════════════════════════════════════════
  // 生活保護判定
  // ══════════════════════════════════════════════════════════════
  function detectLifeProtection() {
    // 医療保険がない人は生活保護 → 負担なし
    const noIns = !!findTextElement("有効な保険が登録されていません");
    log(`生活保護判定: 保険なし=${noIns} → ${noIns}`);
    return noIns;
  }

  // ══════════════════════════════════════════════════════════════
  // 二重登録チェック
  // ══════════════════════════════════════════════════════════════
  function hasExistingTemporaryJiritsu() {
    // 公費セクション周辺に 21000000 があるか
    const kouhiEl = findTextElement("公費");
    if (!kouhiEl) return document.body.textContent.includes(TEMP_FUTANSHA);
    let section = kouhiEl;
    for (let i = 0; i < 6; i++) {
      section = section.parentElement;
      if (!section) break;
      if (section.textContent.includes(TEMP_FUTANSHA)) {
        debug("既存仮番号を検出");
        return true;
      }
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════
  // STEP A: 公費追加モーダルを開く
  // ══════════════════════════════════════════════════════════════
  async function openPublicExpenseAddModal() {
    log("STEP A: 公費追加モーダルを開く");

    let addBtn = null;

    // === 方法1（実地確認済み）: SVGパスで＋アイコンを特定し、公費セクション近くのものを選ぶ ===
    const plusIcons = document.querySelectorAll(SELECTORS.plusSvgPath);
    debug(`＋アイコンSVG path 候補: ${plusIcons.length} 個`);

    if (plusIcons.length > 0) {
      // 「公費」テキスト要素を探す
      const kouhiEl = findTextElement("公費");
      if (kouhiEl) {
        const kouhiRect = kouhiEl.getBoundingClientRect();
        let bestDist = Infinity;

        for (const pathEl of plusIcons) {
          // path → svg → button の順に親をたどる
          const btn = pathEl.closest("button") || pathEl.closest("[role='button']") || pathEl.closest("a");
          if (!btn || btn.offsetParent === null) continue; // 非表示はスキップ
          const btnRect = btn.getBoundingClientRect();
          // 公費セクションと同じ行（Y座標が近い）のボタンを探す
          const dist = Math.abs(btnRect.top - kouhiRect.top) + Math.abs(btnRect.left - kouhiRect.left);
          debug(`＋ボタン候補: dist=${dist.toFixed(0)}, y=${btnRect.top.toFixed(0)}, kouhiY=${kouhiRect.top.toFixed(0)}`);
          if (dist < bestDist) {
            bestDist = dist;
            addBtn = btn;
          }
        }
        if (addBtn) {
          debug(`＋ボタン確定: 距離=${bestDist.toFixed(0)}`, addBtn.outerHTML.substring(0, 120));
        }
      } else {
        // 公費テキストが見つからない場合、最初のアイコンの親ボタンを使う
        const pathEl = plusIcons[0];
        addBtn = pathEl.closest("button");
      }
    }

    // === 方法2: テキスト「＋」で探す ===
    if (!addBtn) {
      warn("SVGパスでの＋ボタン探索失敗 → テキスト探索へ");
      const kouhiEl = findTextElement("公費");
      if (kouhiEl) {
        let parent = kouhiEl;
        for (let i = 0; i < 5; i++) {
          parent = parent.parentElement;
          if (!parent) break;
          for (const el of parent.querySelectorAll("button, a, [role='button']")) {
            const t = el.textContent.trim();
            if (t === "+" || t === "＋" || el.getAttribute("aria-label")?.includes("追加")) {
              addBtn = el;
              break;
            }
          }
          if (addBtn) break;
        }
      }
    }

    if (!addBtn) {
      throw new Error("公費追加の＋ボタンが見つかりません。DevToolsで SVG path d属性を確認してください。");
    }

    safeClick(addBtn);
    log("＋ボタンをクリック");

    // 公費追加モーダルが開くのを待つ
    const modal = await waitForElement(() => findModalByTitle("公費追加"), 8000);
    log("公費追加モーダルが開きました");
    await sleep(600);
    return modal;
  }

  // ══════════════════════════════════════════════════════════════
  // STEP B-F: フォーム入力
  // ══════════════════════════════════════════════════════════════
  async function fillTemporaryJiritsuForm(isLifeProtection) {
    log(`STEP B-H: フォーム入力開始 (生活保護=${isLifeProtection})`);

    const modal = findModalByTitle("公費追加");
    if (!modal) throw new Error("公費追加モーダルが見つかりません");

    // ────────────────────────────
    // B. 負担者番号に 21000000 を入力
    // ────────────────────────────
    log("  B: 負担者番号を入力");
    let futanshaInput = modal.querySelector(SELECTORS.futanshaInput);
    if (!futanshaInput) futanshaInput = findByLabel("負担者番号", "input", modal);
    if (!futanshaInput) {
      // 必須マーク付きの最初の input を試す
      const inputs = modal.querySelectorAll("input[type='text'], input:not([type])");
      if (inputs.length > 0) {
        futanshaInput = inputs[0];
        debug("負担者番号 → モーダル内最初の input で仮定:", futanshaInput);
      }
    }
    if (!futanshaInput) throw new Error("負担者番号の入力欄が見つかりません");

    // React 対応の確実な入力（execInsertText → setNativeValue の2段階）
    const futanshaOk = await setInputValueRobust(futanshaInput, TEMP_FUTANSHA, "負担者番号");
    // blur で確定させる（公費の種類の自動選択トリガー）
    futanshaInput.dispatchEvent(new Event("blur", { bubbles: true }));
    if (futanshaOk) {
      log(`  B: 負担者番号 = "${TEMP_FUTANSHA}" 入力成功`);
    } else {
      warn(`  B: 負担者番号の自動入力に失敗。手動で "${TEMP_FUTANSHA}" を入力してください。`);
      showToast(`負担者番号 ${TEMP_FUTANSHA} を手動入力してください`, "warn");
    }

    // ────────────────────────────
    // C-D. 公費の種類の自動選択を待つ
    // ────────────────────────────
    log("  C: 公費の種類の自動選択を待機...");
    await sleep(1500); // 自動選択の反映待ち

    let kouhiSelect = modal.querySelector(SELECTORS.kouhiTypeSelect);
    if (!kouhiSelect) kouhiSelect = findByLabel("公費の種類", "select", modal);

    if (kouhiSelect) {
      const selectedText = kouhiSelect.options[kouhiSelect.selectedIndex]?.textContent || "";
      if (selectedText.includes(KOUHI_TYPE_TEXT)) {
        log(`  C: 公費の種類 = "${selectedText}" ← 自動選択済み ✓`);
      } else {
        log(`  D: 公費の種類が "${selectedText}" → 手動で精神通院を選択`);
        if (!setSelectByText(kouhiSelect, KOUHI_TYPE_TEXT)) {
          warn("  D: 公費の種類の手動選択に失敗。option一覧:",
            Array.from(kouhiSelect.options).map((o) => `"${o.value}:${o.text}"`).join(", "));
        }
      }
    } else {
      warn("  C: 公費の種類 select が見つかりません（自動選択されている前提で続行）");
    }
    await sleep(300);

    // ────────────────────────────
    // E. 受給者番号は空欄、「後から確認」にチェック
    // ────────────────────────────
    log("  E: 後から確認にチェック");
    let laterCb = findCheckboxByText("後から確認", modal);
    if (!laterCb) laterCb = findByLabel("後から確認", 'input[type="checkbox"]', modal);
    if (laterCb) {
      setCheckbox(laterCb, true);
      log("  E: 後から確認 ✓");
    } else {
      warn("  E: 「後から確認」チェックボックスが見つかりません");
      // モーダル内の全チェックボックスを出力
      debug("  モーダル内 checkbox一覧:", modal.querySelectorAll('input[type="checkbox"]'));
    }
    await sleep(200);

    // ────────────────────────────
    // F. 有効期間（開始日・終了日）
    //    二段構え: 直接入力優先 → カレンダーUI fallback
    // ────────────────────────────
    log("  F: 有効期間を入力");
    const today = getTodayJST();
    const oneYearLater = getOneYearLaterJST();

    // 日付入力欄を収集する
    const dateInputs = collectDateInputs(modal);
    debug(`  日付入力欄: ${dateInputs.length} 個`);
    if (DEBUG && dateInputs.length > 0) {
      dateInputs.forEach((inp, i) => {
        debug(`    [${i}] type=${inp.type}, placeholder="${inp.placeholder}", value="${inp.value}", class="${(inp.className || "").substring(0, 60)}"`);
      });
    }

    // 開始日（最初の日付入力 — 既にデフォルトで当日が入っていることが多い）
    if (dateInputs.length >= 1) {
      const startInput = dateInputs[0];
      const startVal = startInput.value;
      // 和暦混じり（例: "2026(令和8)年3月12日"）や yyyy/mm/dd で既に入っていればスキップ
      if (startVal && (startVal.includes("年") || startVal.includes("/"))) {
        log(`  F: 開始日は既に "${startVal}" → スキップ`);
      } else {
        // 空欄なら入力
        await setDateField(startInput, today, "開始日");
      }
    } else {
      warn("  F: 開始日の入力欄が見つかりません");
    }

    // 終了日（2番目の日付入力 — 空欄・placeholder "yyyy/mm/dd"）
    if (dateInputs.length >= 2) {
      await setDateField(dateInputs[1], oneYearLater, "終了日");
    } else {
      warn("  F: 終了日の入力欄が見つかりません");
      // デバッグ: モーダル内の全 input を出力
      debug("  モーダル内の全 input:", Array.from(modal.querySelectorAll("input")).map((i) =>
        `type=${i.type}, name=${i.name}, placeholder=${i.placeholder}, value="${i.value}"`
      ));
    }
    await sleep(300);

    // ────────────────────────────
    // G/H. 患者自己負担
    // ────────────────────────────
    if (isLifeProtection) {
      // H. 生活保護 → 負担なし（初期状態が負担なしならそのまま）
      log("  H: 生活保護 → 負担なしを確認/選択");
      const noburdenRadio = findRadioByText("負担なし", modal);
      if (noburdenRadio) {
        if (!noburdenRadio.checked) {
          clickRadio(noburdenRadio);
          log("  H: 負担なしを選択");
        } else {
          log("  H: 負担なしは既に選択済み ✓");
        }
      } else {
        // ラベルをクリック
        const lbl = findTextElement("負担なし", modal);
        if (lbl) { safeClick(lbl); log("  H: 負担なしラベルをクリック"); }
        else { warn("  H: 「負担なし」ラジオが見つかりません"); }
      }
    } else {
      // G. 非生活保護 → 負担ありに切り替え
      log("  G: 非生活保護 → 負担ありに切り替え");
      const burdenRadio = findRadioByText("負担あり", modal);
      if (burdenRadio) {
        if (!burdenRadio.checked) {
          clickRadio(burdenRadio);
          log("  G: 負担ありを選択");
        } else {
          log("  G: 負担ありは既に選択済み ✓");
        }
      } else {
        // ラベルをクリック
        const lbl = findTextElement("負担あり", modal);
        if (lbl) { safeClick(lbl); log("  G: 負担ありラベルをクリック"); }
        else { warn("  G: 「負担あり」ラジオが見つかりません"); }
      }

      // 負担あり選択後、テーブルが表示/活性化されるのを待つ
      await sleep(800);

      // G-1: 1回あたり 上限 10%
      log("  G: 1回あたり 上限 10% を入力");
      const row1kai = findTextElement("1回あたり", modal);
      if (row1kai) {
        const tr = row1kai.closest("tr") || row1kai.parentElement;
        if (tr) {
          const inputs = tr.querySelectorAll("input");
          debug(`  「1回あたり」行の input: ${inputs.length} 個`, Array.from(inputs).map((i) => `type=${i.type},val=${i.value}`));
          // 最初の input が「割合 上限 [  ] %」
          if (inputs.length > 0) {
            inputs[0].focus();
            await sleep(50);
            setNativeValue(inputs[0], RATE_PERCENT);
            log(`  G: 1回あたり割合 = ${RATE_PERCENT}%`);
          } else {
            warn("  G: 「1回あたり」行に input がありません");
          }
        }
      } else {
        warn("  G: 「1回あたり」テキストが見つかりません");
      }
      await sleep(200);

      // G-2: 1月あたり 上限 20000円
      log("  G: 1月あたり 上限 20000円 を入力");
      const row1month = findTextElement("1月あたり", modal);
      if (row1month) {
        const tr = row1month.closest("tr") || row1month.parentElement;
        if (tr) {
          const inputs = tr.querySelectorAll("input");
          debug(`  「1月あたり」行の input: ${inputs.length} 個`, Array.from(inputs).map((i) => `type=${i.type},val=${i.value}`));
          // スクリーンショットから: 「1月あたり」行は 割合列が空、金額列「上限 [20000] 円」
          // 金額の上限 input を探す — 「1月あたり」行には割合 input がない可能性
          // → 最初の空の数値 input、または「上限」テキスト近くの input
          let targetInput = null;

          // 「上限」テキストの直後の input を優先
          const cells = tr.querySelectorAll("td, th");
          for (const cell of cells) {
            if (cell.textContent.includes("上限") && cell.textContent.includes("円")) {
              targetInput = cell.querySelector("input");
              if (targetInput) break;
            }
          }

          // 見つからなければ、行内の input を順番に試す
          if (!targetInput) {
            for (const inp of inputs) {
              // 割合(%)ではなく金額(円)の input を探す
              // → placeholder や周辺テキストで判定
              const parent = inp.parentElement;
              const surroundText = parent?.textContent || "";
              if (surroundText.includes("円")) {
                targetInput = inp;
                break;
              }
            }
          }

          // それでもなければ最初の input
          if (!targetInput && inputs.length > 0) {
            targetInput = inputs[0];
            debug("  1月あたり → fallback: 行内最初の input");
          }

          if (targetInput) {
            targetInput.focus();
            await sleep(50);
            setNativeValue(targetInput, MONTHLY_LIMIT);
            log(`  G: 1月あたり金額 = ${MONTHLY_LIMIT}円`);
          } else {
            warn("  G: 「1月あたり」行に入力可能な input がありません");
          }
        }
      } else {
        warn("  G: 「1月あたり」テキストが見つかりません");
      }
    }

    await sleep(300);
    log("フォーム入力完了");
  }

  // ══════════════════════════════════════════════════════════════
  // STEP I-J: 登録ボタンを押す + 確認ダイアログ処理
  // ══════════════════════════════════════════════════════════════
  async function submitPublicExpenseAdd() {
    log("STEP I: 登録ボタンを押す");

    const modal = findModalByTitle("公費追加");
    if (!modal) throw new Error("公費追加モーダルが見つかりません");

    const registerBtn = findButtonByText("登録", modal);
    if (!registerBtn) {
      // フォールバック: submit ボタン
      const sub = modal.querySelector('button[type="submit"], input[type="submit"]');
      if (!sub) throw new Error("「登録」ボタンが見つかりません");
      safeClick(sub);
    } else {
      safeClick(registerBtn);
    }
    log("登録ボタンをクリック");

    // STEP J: 確認ダイアログ対応
    // window.confirm はフックで自動承認済み
    // 独自モーダル確認ダイアログがあれば自動OK
    log("STEP J: 確認ダイアログを処理");
    await sleep(800);
    const handled = await handleCustomConfirmDialog();
    if (handled) {
      log("独自確認ダイアログを自動承認しました");
      await sleep(500);
      // 更に確認がある場合に備えてもう一度
      await handleCustomConfirmDialog();
    }

    // モーダルが閉じるのを待つ（閉じなくてもタイムアウトで続行）
    try {
      await waitForCondition(() => !findModalByTitle("公費追加"), 8000);
      log("公費追加モーダルが閉じました ✓");
    } catch (e) {
      // モーダルがまだ開いている → もう一度確認ダイアログを探す
      warn("モーダルがまだ開いています → 追加の確認ダイアログを探索");
      await handleCustomConfirmDialog();
      await sleep(1000);
      if (findModalByTitle("公費追加")) {
        warn("モーダルが閉じません。手動で確認してください。");
        showToast("登録完了を確認してください", "warn");
      }
    }

    await sleep(1000); // 一覧更新待ち
  }

  // ══════════════════════════════════════════════════════════════
  // カルテ更新（Phase 2 スタブ — 今回は最低限のみ）
  // ══════════════════════════════════════════════════════════════
  /**
   * ページ上の全SVGボタンを試行して「カルテ更新」モーダルを開く
   * 方法: 医療保険セクションや公費セクション周辺のSVGボタン（鉛筆マーク）を
   *       順番にクリックし、カルテ更新モーダルが開くものを探す
   */
  async function openChartUpdateModal() {
    await closePublicExpenseHistoryModalIfPresent();

    const directEditBtn = findDirectChartUpdateEditButton();
    const directEditModal = await tryOpenChartUpdateFromButton(directEditBtn, "direct chart edit button");
    if (directEditModal) return directEditModal;

    // Method 0: prefer the edit button on the newly added 21000000 row.
    const publicRowEditBtn = await waitForElement(
      () => findPublicExpenseRowEditButton(TEMP_FUTANSHA),
      6000,
      400
    ).catch(() => null);
    const publicRowModal = await tryOpenChartUpdateFromButton(
      publicRowEditBtn,
      `public expense row ${TEMP_FUTANSHA} edit button`
    );
    if (publicRowModal) return publicRowModal;
    log("STEP: カルテ更新モーダルを開く（Phase 2）");

    // === 方法1: 「編集」テキストを含むクリック可能な要素を探す ===
    // button だけでなく a, span, div 等も対象
    log("方法1: 「編集」要素を探索");
    const editEl = findTextElement("編集");
    if (editEl && editEl.offsetParent !== null) {
      // モーダル内でなければクリック
      if (!editEl.closest('[class*="modal"], [class*="Modal"], [role="dialog"]')) {
        const clickTarget = editEl.closest("button, a, [role='button']") || editEl;
        safeClick(clickTarget);
        log("「編集」要素をクリック:", clickTarget.tagName);
        await sleep(1500);
        const modal = findModalByTitle("カルテ更新");
        if (modal) {
          log("カルテ更新モーダルが開きました（編集ボタン経由）");
          await sleep(500);
          return modal;
        }
        debug("「編集」クリックでカルテ更新が開かなかった");
      }
    }

    // === 方法2: 医療保険セクションの鉛筆マーク ===
    // 「医療保険」テキスト近くのSVGボタンを探す
    log("方法2: 医療保険セクションの鉛筆マークを探索");
    const insuranceEl = findTextElement("医療保険");
    if (insuranceEl) {
      let section = insuranceEl;
      for (let i = 0; i < 6; i++) {
        section = section.parentElement;
        if (!section) break;
        // SVGボタンを収集
        const svgBtns = Array.from(
          section.querySelectorAll("button, a, [role='button']")
        ).filter((b) => b.querySelector("svg") && b.offsetParent !== null);

        if (svgBtns.length > 0) {
          debug(`医療保険セクション内のSVGボタン: ${svgBtns.length} 個`);
          // 最後のSVGボタン（鉛筆マーク）からクリック
          for (let j = svgBtns.length - 1; j >= 0; j--) {
            safeClick(svgBtns[j]);
            log(`医療保険セクションのSVGボタン[${j}]をクリック`);
            await sleep(1500);
            const modal = findModalByTitle("カルテ更新");
            if (modal) {
              log("カルテ更新モーダルが開きました（医療保険鉛筆経由）");
              await sleep(500);
              return modal;
            }
            // 別のモーダルが開いた場合は閉じる
            const anyModal = document.querySelector('[class*="modal"], [role="dialog"]');
            if (anyModal) {
              const closeBtn = anyModal.querySelector('[aria-label="close"], [class*="close"]')
                || findButtonByText("×", anyModal) || findButtonByText("✕", anyModal);
              if (closeBtn) { safeClick(closeBtn); await sleep(500); }
            }
          }
          break; // セクション見つかったので終了
        }
      }
    }

    // === 方法3: 公費行の鉛筆マーク（21000000行） ===
    log("方法3: 公費行(21000000)の鉛筆マークを探索");
    const futanshaEl = findTextElement(TEMP_FUTANSHA);
    if (futanshaEl) {
      let container = futanshaEl;
      for (let i = 0; i < 5; i++) {
        container = container.parentElement;
        if (!container) break;
        const svgBtns = Array.from(
          container.querySelectorAll("button, a, [role='button']")
        ).filter((b) => b.querySelector("svg") && b.offsetParent !== null);
        if (svgBtns.length > 0) {
          for (let j = svgBtns.length - 1; j >= 0; j--) {
            safeClick(svgBtns[j]);
            log(`公費行のSVGボタン[${j}]をクリック`);
            await sleep(1500);
            const modal = findModalByTitle("カルテ更新");
            if (modal) {
              log("カルテ更新モーダルが開きました（公費鉛筆経由）");
              await sleep(500);
              return modal;
            }
            // 別のモーダルが開いた場合は閉じる
            const anyModal = document.querySelector('[class*="modal"], [role="dialog"]');
            if (anyModal) {
              const closeBtn = anyModal.querySelector('[aria-label="close"], [class*="close"]')
                || findButtonByText("×", anyModal) || findButtonByText("✕", anyModal);
              if (closeBtn) { safeClick(closeBtn); await sleep(500); }
            }
          }
          break;
        }
      }
    }

    // === 方法4: ページ上の全SVGボタンを総当たり ===
    log("方法4: 全ページのSVGボタンを総当たり");
    const allBtns = document.querySelectorAll("button, a, [role='button']");
    for (const btn of allBtns) {
      if (!btn.querySelector("svg") || btn.offsetParent === null) continue;
      // モーダル内のボタンはスキップ
      if (btn.closest('[class*="modal"], [role="dialog"]')) continue;
      safeClick(btn);
      debug(`総当たり: SVGボタンをクリック (${btn.outerHTML.substring(0, 80)})`);
      await sleep(1200);
      const modal = findModalByTitle("カルテ更新");
      if (modal) {
        log("カルテ更新モーダルが開きました（総当たり）");
        await sleep(500);
        return modal;
      }
      // 別のモーダルが開いた場合は閉じる
      const anyModal = document.querySelector('[class*="modal"], [role="dialog"]');
      if (anyModal) {
        const closeBtn = anyModal.querySelector('[aria-label="close"], [class*="close"]')
          || findButtonByText("×", anyModal) || findButtonByText("✕", anyModal);
        if (closeBtn) { safeClick(closeBtn); await sleep(500); }
      }
    }

    throw new Error("カルテ更新モーダルの開き方が見つかりません。手動で鉛筆マークをクリックしてください。");
  }

  async function selectJiritsuToPublic1() {
    log("STEP: 公費1に自立仮番をセット");
    const modal = findModalByTitle("カルテ更新");
    if (!modal) throw new Error("カルテ更新モーダルが見つかりません");

    const selects = modal.querySelectorAll("select");
    debug(`カルテ更新モーダル内の select: ${selects.length} 個`);
    if (DEBUG) {
      Array.from(selects).forEach((sel, i) => {
        const txt = sel.options[sel.selectedIndex]?.textContent?.substring(0, 60) || "";
        debug(`  select[${i}]: selected="${txt}", options=${sel.options.length}`);
      });
    }

    // 公費1の select を見つけて 21000000 のオプションを選択する
    // 画面構造: ラベル "1" → select（公費1）、ラベル "2" → select（公費2）、...
    const directKouhi1 = (
      queryVisible(SELECTORS.chartPublic1SelectExact, modal) ||
      Array.from(modal.querySelectorAll(SELECTORS.kouhi1Select)).find((sel) => findTemporaryJiritsuOption(sel))
    );
    if (directKouhi1) {
      const targetOpt = findTemporaryJiritsuOption(directKouhi1);
      if (targetOpt) {
        if (directKouhi1.value !== targetOpt.value) {
          setSelectValue(directKouhi1, targetOpt.value);
          log(`公費1(selector) → "${targetOpt.textContent.trim().substring(0, 50)}" を選択`);
        } else {
          log(`公費1(selector): 既に "${targetOpt.textContent.trim().substring(0, 50)}" が選択済み ✓`);
        }
        await sleep(300);
        return;
      }
    }

    const row1Select = findNumberedSelect(modal, "1");
    if (row1Select) {
      const targetOpt = findTemporaryJiritsuOption(row1Select);
      if (targetOpt) {
        if (row1Select.value !== targetOpt.value) {
          setSelectValue(row1Select, targetOpt.value);
          log(`公費1(row1) → "${targetOpt.textContent.trim().substring(0, 50)}" を選択`);
        } else {
          log(`公費1(row1): 既に "${targetOpt.textContent.trim().substring(0, 50)}" が選択済み ✓`);
        }
        await sleep(300);
        return;
      }
    }

    let kouhi1 = null;

    for (const sel of selects) {
      // この select に 21000000/精神通院 を含む option があるか
      let targetOpt = null;
      for (const opt of sel.options) {
        if (opt.textContent.includes(TEMP_FUTANSHA) || opt.textContent.includes("精神通院")) {
          targetOpt = opt;
          break;
        }
      }
      if (!targetOpt) continue;

      // このselectが公費1行にあるか確認
      // 方法A: 近傍に "1" テキストがある
      const parent = sel.parentElement;
      const grandParent = parent?.parentElement;
      const nearText = (parent?.textContent || "") + (grandParent?.textContent || "");

      // 行内の先頭テキスト要素を確認
      const siblings = grandParent?.children || parent?.children || [];
      let isRow1 = false;
      for (const sib of siblings) {
        const t = sib.textContent.trim();
        if (t === "1") { isRow1 = true; break; }
      }

      // 方法B: selectの直前にある要素のテキストが "1"
      const prevSib = sel.previousElementSibling || parent?.previousElementSibling;
      if (prevSib && prevSib.textContent.trim() === "1") isRow1 = true;

      // 方法C: ラベル "1" が近傍にある（findByLabel的な探索）
      if (!isRow1) {
        const row = sel.closest("tr, [class*='row'], [class*='Row']");
        if (row) {
          const firstCell = row.querySelector("td, th, span, div");
          if (firstCell && firstCell.textContent.trim() === "1") isRow1 = true;
        }
      }

      if (isRow1 || !kouhi1) {
        // 既に選択されているか確認
        if (sel.value === targetOpt.value) {
          log(`公費1: 既に "${targetOpt.textContent.trim().substring(0, 50)}" が選択済み ✓`);
          kouhi1 = sel;
          break;
        }
        // 選択する
        setSelectValue(sel, targetOpt.value);
        log(`公費1 → "${targetOpt.textContent.trim().substring(0, 50)}" を選択`);
        kouhi1 = sel;
        if (isRow1) break; // 確実に row1 なら終了
      }
    }

    if (!kouhi1) {
      // フォールバック: 全 select を順番に試す
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (opt.textContent.includes(TEMP_FUTANSHA) || opt.textContent.includes("精神通院")) {
            setSelectValue(sel, opt.value);
            log(`公費1(fallback) → "${opt.textContent.trim().substring(0, 50)}" を選択`);
            kouhi1 = sel;
            break;
          }
        }
        if (kouhi1) break;
      }
    }

    if (!kouhi1) {
      warn("公費1の設定に失敗。手動で設定してください。");
      showToast("公費1を手動で選択してください", "warn");
    }
    await sleep(300);
  }

  async function selectLifeProtectionToPublic2IfNeeded(isLifeProtection) {
    if (!isLifeProtection) { log("公費2は変更なし（非生活保護）"); return; }

    log("STEP: 公費2に生活保護公費をセット");
    const modal = findModalByTitle("カルテ更新");
    if (!modal) return;

    const selects = modal.querySelectorAll("select");

    // 公費2 の select を探す（ラベル "2" の行）
    for (const sel of selects) {
      // 生活保護の option があるか
      let targetOpt = null;
      for (const opt of sel.options) {
        if (/\b12\d{6}\b/.test(opt.textContent) || opt.textContent.includes("生活保護")) {
          targetOpt = opt;
          break;
        }
      }
      if (!targetOpt) continue;

      // "2" ラベルの行か確認
      const row = sel.closest("tr, [class*='row'], [class*='Row']");
      const firstCell = row?.querySelector("td, th, span, div");
      const prevSib = sel.previousElementSibling || sel.parentElement?.previousElementSibling;
      if (
        (firstCell && firstCell.textContent.trim() === "2") ||
        (prevSib && prevSib.textContent.trim() === "2")
      ) {
        setSelectValue(sel, targetOpt.value);
        log(`公費2 → "${targetOpt.textContent.trim().substring(0, 50)}" を選択`);
        return;
      }
    }
    warn("公費2の設定に失敗。手動で設定してください。");
  }

  async function submitChartUpdate() {
    log("STEP: カルテ更新を確定");
    const modal = findModalByTitle("カルテ更新");
    if (!modal) throw new Error("カルテ更新モーダルが見つかりません");
    const btn = findButtonByText("更新", modal);
    if (!btn) throw new Error("「更新」ボタンが見つかりません");
    safeClick(btn);
    log("更新ボタンをクリック");

    // 確認ダイアログがあれば処理
    await sleep(800);
    await handleCustomConfirmDialog();

    try {
      await waitForCondition(() => !findModalByTitle("カルテ更新"), 8000);
      log("カルテ更新完了 ✓");
    } catch (e) {
      // もう一度確認ダイアログを処理
      await handleCustomConfirmDialog();
      await sleep(1000);
      if (findModalByTitle("カルテ更新")) {
        warn("カルテ更新モーダルが閉じません。手動で確認してください。");
        showToast("カルテ更新を確認してください", "warn");
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // メインフロー
  // ══════════════════════════════════════════════════════════════
  async function main() {
    log("========== 自立仮番登録 開始 ==========");
    let step = "";

    // window.confirm 自動承認を有効化
    enableAutoConfirm();

    try {
      // 二重登録チェック
      step = "二重登録チェック";
      if (hasExistingTemporaryJiritsu()) {
        const proceed = originalConfirm(
          `[自立仮番] 仮番号 ${TEMP_FUTANSHA} は既に登録されています。\n再度登録しますか？`
        );
        if (!proceed) {
          log("ユーザーがキャンセル");
          showToast("登録をキャンセルしました", "warn");
          return;
        }
      }

      // 生活保護判定
      step = "生活保護判定";
      const isLifeProtection = detectLifeProtection();
      showToast(
        isLifeProtection
          ? "生活保護として処理します（負担なし）"
          : "通常患者として処理します（負担あり 10%/月上限20000円）",
        "info"
      );

      // Phase 1: 公費追加
      step = "公費追加モーダルを開く";
      await openPublicExpenseAddModal();

      step = "フォーム入力";
      await fillTemporaryJiritsuForm(isLifeProtection);

      step = "公費追加の登録";
      await submitPublicExpenseAdd();

      step = "公費更新履歴を閉じる";
      await closePublicExpenseHistoryModalIfPresent();

      log("===== Phase 1（公費追加）完了 =====");
      showToast("公費追加が完了しました！", "success");

      // Phase 1 完了後、ページ更新を待つ（DOM再描画 + 公費一覧反映）
      log("Phase 2 準備: ページ更新を待機...");
      await sleep(3000);

      // Phase 2: カルテ更新（失敗しても Phase 1 は有効）
      try {
        step = "カルテ更新モーダルを開く";
        log("===== Phase 2（カルテ更新）開始 =====");
        await openChartUpdateModal();

        step = "公費1に自立仮番をセット";
        await selectJiritsuToPublic1();

        step = "公費2の処理";
        await selectLifeProtectionToPublic2IfNeeded(isLifeProtection);

        step = "カルテ更新の確定";
        await submitChartUpdate();

        step = "カルテを一時保存";
        await clickChartTemporarySaveButton();

        step = "カルテ一覧の保険セルを開く";
        await clickInsuranceCellInChartList();

        log("===== Phase 2（カルテ更新）完了 =====");
        showToast("保険セルを開くところまで完了しました！", "success");
      } catch (err2) {
        warn(`Phase 2 エラー [${step}]: ${err2.message}`);
        showToast(`公費追加は完了。カルテ更新は手動で行ってください: ${err2.message}`, "warn");
      }

      log("========== 自立仮番登録 全完了 ==========");
    } catch (err) {
      error(`ステップ「${step}」でエラー:`, err.message, err);
      showToast(`エラー [${step}]: ${err.message}`, "error");
    } finally {
      disableAutoConfirm();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ボタン挿入（公費セクション横のインラインボタンのみ）
  // ══════════════════════════════════════════════════════════════
  const BTN_ID = "jiritsu-tmp-btn";

  /**
   * 公費セクションヘッダー（「公費 ☑現在有効 ＋」の行）を特定する
   * 「有効な公費が…」等の別テキストにマッチしないよう、
   * 「現在有効」が近傍にある「公費」要素だけを返す
   */
  function findKouhiSectionHeader() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const txt = walker.currentNode.textContent.trim();
      if (!txt.includes("公費")) continue;
      // 「有効な公費が登録されていません」等の長文はスキップ
      if (txt.length > 10) continue;
      const el = walker.currentNode.parentElement;
      if (!el) continue;
      // モーダル内はスキップ
      if (el.closest('[class*="modal"], [class*="Modal"], [role="dialog"], [class*="overlay"], [class*="Overlay"]')) continue;
      // 親を3段階上がって「現在有効」があるか確認
      let p = el;
      for (let i = 0; i < 4; i++) {
        if (!p) break;
        if (p.textContent.includes("現在有効")) {
          debug("findKouhiSectionHeader: 発見", el.textContent.substring(0, 30));
          return el;
        }
        p = p.parentElement;
      }
    }
    return null;
  }

  function ensureButton() {
    if (document.getElementById(BTN_ID)) return;
    if (!isOnTargetPage()) return;

    const kouhiEl = findKouhiSectionHeader();
    if (!kouhiEl) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.textContent = "自立仮番";
    Object.assign(btn.style, {
      marginLeft: "8px", padding: "2px 10px", fontSize: "12px",
      fontWeight: "bold", color: "#fff", background: "#1976D2",
      border: "none", borderRadius: "6px", cursor: "pointer",
      verticalAlign: "middle",
    });
    btn.onclick = () => {
      if (btn.disabled) return;
      setButtonBusy(true);
      main().finally(() => setButtonBusy(false));
    };
    kouhiEl.parentElement?.appendChild(btn);
    log("「自立仮番」ボタンを追加（公費セクション横）");
  }

  function setButtonBusy(busy) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? "処理中..." : "自立仮番";
    btn.style.opacity = busy ? "0.6" : "1";
  }

  // ══════════════════════════════════════════════════════════════
  // SPA対応: MutationObserver + 定期監視
  // ══════════════════════════════════════════════════════════════
  function startObserver() {
    setInterval(ensureButton, 5000);
    new MutationObserver(() => {
      if (!document.getElementById(BTN_ID)) ensureButton();
    }).observe(document.body, { childList: true, subtree: true });
    debug("監視開始");
  }

  // ══════════════════════════════════════════════════════════════
  // 初期化
  // ══════════════════════════════════════════════════════════════
  function init() {
    log("v3.2.0 初期化");
    log(`設定: 仮番号=${TEMP_FUTANSHA}, 月上限=${MONTHLY_LIMIT}円, 割合=${RATE_PERCENT}%`);
    setTimeout(() => { ensureButton(); startObserver(); }, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
