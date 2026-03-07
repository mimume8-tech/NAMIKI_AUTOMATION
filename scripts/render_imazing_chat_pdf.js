const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function detectChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function buildHtml(payload, outputDir) {
  const entries = payload.messages.map((message, index) => {
    const who = message.sender === "sent" ? "自分" : message.sender === "received" ? "相手" : "System";
    const timestamp = escapeHtml(message.timestamp || "");
    const roleClass = message.sender === "sent" ? "sent" : message.sender === "received" ? "received" : "system";

    let body = "";
    if (message.kind === "image") {
      if (message.image) {
        const absoluteImagePath = path.resolve(outputDir, message.image);
        const src = pathToFileURL(absoluteImagePath).href;
        body = `<img class="image" src="${src}" alt="image message ${index + 1}">`;
      } else {
        body = `<div class="missing">[image]</div>`;
      }
    } else {
      const text = escapeHtml(message.text || "").replaceAll(/\r?\n/g, "<br>");
      body = `<div class="text">${text}</div>`;
    }

    return `
      <article class="entry ${roleClass}">
        <div class="meta">
          <span class="who">${escapeHtml(who)}</span>
          <span class="time">${timestamp}</span>
        </div>
        <div class="bubble">${body}</div>
      </article>
    `;
  });

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(payload.contact)} chat export</title>
  <style>
    :root {
      --bg: #f3efe4;
      --paper: #fffdf8;
      --ink: #222;
      --muted: #6a6257;
      --sent: #d7ecff;
      --received: #fff1dd;
      --border: #d7cfbf;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Yu Gothic UI", "Meiryo", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #fff6d8 0, transparent 30%),
        linear-gradient(180deg, #efe7d6 0%, #f8f4eb 100%);
    }
    main {
      width: 100%;
      max-width: 920px;
      margin: 0 auto;
      padding: 28px 24px 40px;
    }
    header {
      background: rgba(255, 253, 248, 0.92);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 20px 22px;
      margin-bottom: 18px;
      box-shadow: 0 10px 24px rgba(77, 57, 27, 0.08);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.2;
    }
    .summary {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .timeline {
      display: grid;
      gap: 12px;
    }
    .entry {
      display: grid;
      gap: 6px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: rgba(255, 253, 248, 0.85);
      box-shadow: 0 8px 18px rgba(77, 57, 27, 0.06);
    }
    .entry.sent {
      background: linear-gradient(180deg, rgba(215, 236, 255, 0.95), rgba(241, 248, 255, 0.92));
    }
    .entry.received {
      background: linear-gradient(180deg, rgba(255, 241, 221, 0.96), rgba(255, 251, 244, 0.92));
    }
    .entry.system {
      background: rgba(244, 240, 230, 0.9);
    }
    .meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .who {
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .bubble {
      font-size: 14px;
      line-height: 1.7;
      word-break: break-word;
    }
    .image {
      display: block;
      width: auto;
      max-width: 100%;
      max-height: 360px;
      border-radius: 14px;
      border: 1px solid rgba(0, 0, 0, 0.08);
    }
    .missing {
      color: var(--muted);
      font-style: italic;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(payload.contact)}</h1>
      <div class="summary">
        <div>Messages: ${escapeHtml(payload.messageCount)}</div>
        <div>Generated: ${escapeHtml(payload.generatedAt)}</div>
      </div>
    </header>
    <section class="timeline">
      ${entries.join("\n")}
    </section>
  </main>
</body>
</html>`;
}

async function main() {
  const [jsonPath, htmlPath, pdfPath] = process.argv.slice(2);
  if (!jsonPath || !htmlPath || !pdfPath) {
    throw new Error("Usage: node render_imazing_chat_pdf.js <json> <html> <pdf>");
  }

  const absoluteJsonPath = path.resolve(jsonPath);
  const absoluteHtmlPath = path.resolve(htmlPath);
  const absolutePdfPath = path.resolve(pdfPath);
  const outputDir = path.dirname(absoluteJsonPath);
  const rawJson = fs.readFileSync(absoluteJsonPath, "utf8").replace(/^\uFEFF/, "");
  const payload = JSON.parse(rawJson);
  const html = buildHtml(payload, outputDir);
  fs.writeFileSync(absoluteHtmlPath, html, "utf8");

  const executablePath = detectChrome();
  const launchOptions = { headless: true };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(absoluteHtmlPath).href, { waitUntil: "load" });
    await page.waitForTimeout(400);
    await page.pdf({
      path: absolutePdfPath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "12mm",
        right: "10mm",
        bottom: "12mm",
        left: "10mm",
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
