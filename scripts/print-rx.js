/**
 * print-rx.js  ── 常駐型・会計モーダル自動処理
 *
 * Chrome (--remote-debugging-port=9222) に接続し、
 * digikar.jp の会計モーダルが開くのを監視。
 * 検知したら チェック → 保存 → PDF印刷 を自動実行。
 *
 * 起動: node scripts/print-rx.js
 * 停止: Ctrl+C
 */

const { chromium } = require("playwright");
const pdfParse = require("pdf-parse");
const { PDFDocument } = require("pdf-lib");

// ── 設定 ─────────────────────────────────────────
const CDP_URL = "http://127.0.0.1:9222";
const POLL_INTERVAL_MS = 2_000; // モーダル監視間隔
const CDP_RETRY_INTERVAL_MS = 10_000; // Chrome 未起動時のリトライ間隔
const PDF_TAB_TIMEOUT_MS = 15_000;
// ─────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toLocaleTimeString("ja-JP");
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════
// メインループ（常駐）
// ══════════════════════════════════════════════════

async function mainLoop() {
  log("print-rx 常駐開始");

  while (true) {
    // ── Chrome 接続を試みる ──
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch {
      log("Chrome 待機中...(CDP未検出)");
      await sleep(CDP_RETRY_INTERVAL_MS);
      continue;
    }

    log("Chrome 接続OK");

    try {
      await watchLoop(browser);
    } catch (err) {
      log(`接続切断: ${err.message}`);
    }

    // 切断されたら再接続を試みる
    try { browser.close(); } catch {}
    log("再接続を試みます...");
    await sleep(CDP_RETRY_INTERVAL_MS);
  }
}

// ══════════════════════════════════════════════════
// モーダル監視ループ
// ══════════════════════════════════════════════════

async function watchLoop(browser) {
  const context = browser.contexts()[0];
  if (!context) throw new Error("コンテキストなし");

  log("会計モーダルを監視中... (￥ボタンを押してください)");

  while (true) {
    // digikar.jp のページを探す
    const pages = context.pages();
    const kartePage = pages.find((p) => p.url().includes("digikar.jp"));

    if (!kartePage) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // 会計モーダルが開いているかチェック
    const modalOpen = await kartePage
      .evaluate(() => {
        // モーダル内に「デジスマ払い」or「現金等払い」のラジオがあるか
        for (const label of document.querySelectorAll("label")) {
          const text = label.textContent.trim();
          if (text.includes("デジスマ") || text.includes("現金等払い")) {
            return true;
          }
        }
        return false;
      })
      .catch(() => false);

    if (modalOpen) {
      log("会計モーダルを検知！処理開始...");
      try {
        await processModal(context, kartePage);
        log("処理完了。次のモーダルを待機中...");
      } catch (err) {
        log(`処理エラー: ${err.message}`);
      }
      // 処理後は少し長めに待つ（二重実行防止）
      await sleep(5_000);
    } else {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

// ══════════════════════════════════════════════════
// モーダル処理（1回分）
// ══════════════════════════════════════════════════

async function processModal(context, kartePage) {
  // 1. 支払い方法を自動判定
  const isCash = await detectPaymentMethod(kartePage);
  log(isCash ? "-> 現金等払い（全ページ印刷）" : "-> デジスマ払い（処方箋のみ印刷）");

  // 2. チェックボックスを設定
  log("チェックボックスを設定中...");
  await checkPrintOptions(kartePage);

  // 3. 保存ボタン → 新しいタブを待ち受け
  log("保存ボタンをクリック...");
  const [pdfPage] = await Promise.all([
    context.waitForEvent("page", { timeout: PDF_TAB_TIMEOUT_MS }),
    clickSaveButton(kartePage),
  ]);

  // 4. PDF タブの読み込みを待つ
  log("PDF タブを待機中...");
  await pdfPage.waitForLoadState("load");
  await sleep(2000);
  const pdfUrl = pdfPage.url();
  log(`PDF URL: ${pdfUrl}`);

  if (isCash) {
    // ── 現金: 全ページ印刷 ──
    log("全ページを印刷します...");
    await pdfPage.evaluate(() => window.print());
    log("印刷ダイアログを表示しました。");
  } else {
    // ── デジスマ: 処方箋ページのみ印刷 ──
    await printRxPagesOnly(context, pdfPage, pdfUrl);
  }
}

// ── 支払い方法の自動判定 ─────────────────────────

async function detectPaymentMethod(page) {
  return await page.evaluate(() => {
    for (const label of document.querySelectorAll("label")) {
      const text = label.textContent.trim();
      const radio =
        label.querySelector('input[type="radio"]') ||
        document.getElementById(label.getAttribute("for"));
      if (!radio) continue;
      if (text.includes("デジスマ") && radio.checked) return false;
      if (text.includes("現金") && radio.checked) return true;
    }
    for (const radio of document.querySelectorAll('input[type="radio"]')) {
      if (!radio.checked) continue;
      const parent = radio.closest("label, div, span");
      if (parent) {
        if (parent.textContent.includes("デジスマ")) return false;
        if (parent.textContent.includes("現金")) return true;
      }
    }
    return true; // 判定不能 → 現金扱い（安全側）
  });
}

// ── チェックボックス操作 ─────────────────────────

async function checkPrintOptions(page) {
  const labels = ["領収書", "診療明細書", "院外処方箋"];

  for (const label of labels) {
    const result = await page.evaluate((labelText) => {
      for (const lbl of document.querySelectorAll("label")) {
        if (!lbl.textContent.trim().includes(labelText)) continue;
        const cb =
          lbl.querySelector('input[type="checkbox"]') ||
          document.getElementById(lbl.getAttribute("for"));
        if (cb && !cb.checked) { cb.click(); return "checked"; }
        if (cb && cb.checked) return "already";
      }
      for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
        const parent = cb.closest("div, label, span");
        if (parent && parent.textContent.includes(labelText)) {
          if (!cb.checked) { cb.click(); return "checked"; }
          return "already";
        }
      }
      return "not_found";
    }, label);

    const status =
      result === "checked" ? "ON" : result === "already" ? "済" : "?";
    log(`  ${label}: ${status}`);
  }
}

// ── 保存ボタン ──────────────────────────────────

async function clickSaveButton(page) {
  await page.evaluate(() => {
    for (const btn of document.querySelectorAll("button")) {
      const text = btn.textContent.trim();
      if (text === "保存" || (text.includes("会計") && text.includes("保存"))) {
        btn.click();
        return;
      }
    }
    throw new Error("保存ボタンが見つかりません");
  });
}

// ── デジスマ: 処方箋ページのみ印刷 ──────────────

async function printRxPagesOnly(context, pdfPage, pdfUrl) {
  log("PDF をダウンロード・解析中...");
  const pdfBuffer = await downloadPdf(pdfPage, pdfUrl);
  const pageTexts = await extractPageTexts(pdfBuffer);
  log(`全 ${pageTexts.length} ページ`);

  const rxPages = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const text = pageTexts[i];
    if (text.includes("処方箋料")) {
      log(`  ページ ${i + 1}: 除外（処方箋料を含む）`);
      continue;
    }
    if (/処\s*方\s*箋/.test(text)) {
      log(`  ページ ${i + 1}: 処方箋ページ`);
      rxPages.push(i + 1);
    } else {
      log(`  ページ ${i + 1}: スキップ`);
    }
  }

  if (rxPages.length === 0) {
    log("処方箋ページが見つかりません。全ページで印刷します。");
    await pdfPage.evaluate(() => window.print());
    return;
  }

  log(`印刷対象: ページ ${rxPages.join(", ")}`);

  // pdf-lib で処方箋ページだけの PDF を作成
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const newDoc = await PDFDocument.create();
  const copiedPages = await newDoc.copyPages(
    srcDoc,
    rxPages.map((p) => p - 1)
  );
  for (const p of copiedPages) {
    newDoc.addPage(p);
  }
  const newPdfBytes = await newDoc.save();

  // base64 データURL で新しいタブに表示
  log("処方箋ページのみの PDF を新しいタブで開きます...");
  const base64 = Buffer.from(newPdfBytes).toString("base64");
  const newTab = await context.newPage();
  await newTab.goto(`data:application/pdf;base64,${base64}`, {
    waitUntil: "load",
  });
  await sleep(2000);

  log("印刷ダイアログを表示...");
  await newTab.evaluate(() => window.print());
  log("印刷ダイアログを表示しました。");
}

// ── ヘルパー ─────────────────────────────────────

async function downloadPdf(page, url) {
  const response = await page.context().request.get(url);
  return Buffer.from(await response.body());
}

async function extractPageTexts(buffer) {
  const pageTexts = [];
  let currentPage = 0;

  await pdfParse(buffer, {
    pagerender: function (pageData) {
      return pageData.getTextContent().then((textContent) => {
        const text = textContent.items.map((item) => item.str).join(" ");
        pageTexts[currentPage] = text;
        currentPage++;
        return text;
      });
    },
  });

  return pageTexts;
}

// ── 起動 ─────────────────────────────────────────

mainLoop().catch((err) => {
  console.error("致命的エラー:", err.message);
  process.exit(1);
});
