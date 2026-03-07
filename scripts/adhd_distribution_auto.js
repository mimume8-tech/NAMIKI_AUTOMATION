'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'adhd_distribution_auto.config.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'adhd_distribution_auto.config.example.json');
const ERROR_SHOT_PATH = path.join(__dirname, 'adhd_distribution_error.png');

const DEFAULT_CONFIG = {
  loginUrl: 'https://www.adhd-vcdcs.jp/',
  patientSearchUrl: '',
  username: '',
  password: '',
  chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  debugPort: 9333,
  profileDir: '.playwright-profile\\adhd-distribution',
  timeouts: {
    browserConnectMs: 30000,
    screenWaitMs: 180000,
    manualSearchMs: 600000,
    postClickMs: 1200,
  },
  texts: {
    medicalGate: ['\u3042\u306a\u305f\u306f\u533b\u7642\u95a2\u4fc2\u8005\u3067\u3059\u304b'],
    medicalGateYes: ['\u306f\u3044'],
    loginSubmit: ['\u30ed\u30b0\u30a4\u30f3', 'sign in', 'login'],
    patientNumber: ['\u60a3\u8005\u756a\u53f7', '\u60a3\u8005no', '\u60a3\u8005id'],
    select: ['\u9078\u629e'],
    prescriptionInput: ['\u51e6\u65b9\u5165\u529b'],
    prescriptionDate: ['\u51e6\u65b9\u65e5'],
    drugKeywords: ['\u30b3\u30f3\u30b5\u30fc\u30bf', 'concerta'],
    mgField: ['mg', '\u898f\u683c'],
    tabletField: ['\u9320\u6570', '\u6570\u91cf', '\u7528\u91cf'],
    daysField: ['\u65e5\u6570', '\u65e5\u5206', '\u6295\u4e0e\u65e5\u6570'],
  },
  selectors: {
    username: [
      'input[name="loginId"]',
      'input[name="userId"]',
      'input[name="username"]',
      'input[type="email"]',
      'input[type="text"]',
    ],
    password: [
      'input[type="password"]',
    ],
    patientNumber: [
      'input[name*="patient"]',
      'input[id*="patient"]',
      'input[placeholder*="\u60a3\u8005"]',
      'input[type="text"]',
      'input[type="number"]',
    ],
  },
};

function log(message) {
  console.log(`[adhd-rx] ${message}`);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[ \t\r\n\u3000]+/g, '')
    .toLowerCase();
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }

  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadConfig() {
  let config = deepMerge({}, DEFAULT_CONFIG);

  if (fs.existsSync(CONFIG_PATH)) {
    const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = deepMerge(config, fileConfig);
  }

  const envOverrides = {
    loginUrl: process.env.ADHD_RX_LOGIN_URL,
    patientSearchUrl: process.env.ADHD_RX_PATIENT_SEARCH_URL,
    username: process.env.ADHD_RX_USERNAME,
    password: process.env.ADHD_RX_PASSWORD,
    chromePath: process.env.ADHD_RX_CHROME_PATH,
    profileDir: process.env.ADHD_RX_PROFILE_DIR,
  };

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value) config[key] = value;
  }

  if (process.env.ADHD_RX_DEBUG_PORT) {
    const port = Number(process.env.ADHD_RX_DEBUG_PORT);
    if (Number.isFinite(port) && port > 0) {
      config.debugPort = port;
    }
  }

  if (!path.isAbsolute(config.profileDir)) {
    config.profileDir = path.join(ROOT_DIR, config.profileDir);
  }

  return config;
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function isDebugPortReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDebugPort(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isDebugPortReady(port)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

function launchChrome(config) {
  const chromePath = config.chromePath;
  if (!chromePath || !fs.existsSync(chromePath)) {
    throw new Error(`Chrome executable was not found: ${chromePath}`);
  }

  fs.mkdirSync(config.profileDir, { recursive: true });

  const entryUrl = config.loginUrl || DEFAULT_CONFIG.loginUrl;
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${config.debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--new-window',
      `--user-data-dir=${config.profileDir}`,
      entryUrl,
    ],
    {
      detached: true,
      stdio: 'ignore',
    }
  );

  child.unref();
}

async function connectToBrowser(config) {
  const alreadyRunning = await isDebugPortReady(config.debugPort);
  if (!alreadyRunning) {
    log(`Launching Chrome on port ${config.debugPort}...`);
    launchChrome(config);
    const ready = await waitForDebugPort(config.debugPort, config.timeouts.browserConnectMs);
    if (!ready) {
      throw new Error(`Chrome did not expose CDP on port ${config.debugPort}.`);
    }
  } else {
    log(`Reusing existing Chrome on port ${config.debugPort}.`);
  }

  return chromium.connectOverCDP(`http://127.0.0.1:${config.debugPort}`);
}

async function getTargetPage(browser) {
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find(candidate => candidate.url().includes('adhd-vcdcs.jp')) || pages[0] || await context.newPage();
  await page.bringToFront();
  return page;
}

async function waitForPageQuiet(page, ms) {
  try {
    await page.waitForLoadState('networkidle', { timeout: ms });
  } catch {}
  await page.waitForTimeout(Math.min(ms, 1500));
}

async function waitForCondition(label, timeoutMs, fn) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  if (lastError) {
    throw new Error(`${label} (last error: ${lastError.message})`);
  }
  throw new Error(label);
}

async function clickControlByText(page, texts, index = 0) {
  const result = await page.evaluate(({ texts, index }) => {
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .replace(/[ \t\r\n\u3000]+/g, '')
      .toLowerCase();

    const targets = texts.map(normalize);
    const selectors = [
      'button',
      'a',
      'input[type="button"]',
      'input[type="submit"]',
      '[role="button"]',
      '[tabindex="0"]',
    ];

    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    };

    const getText = element => normalize(
      element.innerText ||
      element.textContent ||
      element.value ||
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      ''
    );

    const candidates = [];
    const seen = new Set();

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        const text = getText(element);
        if (!text) continue;
        if (!targets.some(target => text.includes(target))) continue;

        const rect = element.getBoundingClientRect();
        candidates.push({
          element,
          text,
          top: rect.top,
          left: rect.left,
        });
      }
    }

    candidates.sort((a, b) => a.top - b.top || a.left - b.left);
    const target = candidates[index];
    if (!target) {
      return null;
    }

    target.element.click();
    return {
      text: target.text,
      top: Math.round(target.top),
      left: Math.round(target.left),
    };
  }, { texts, index });

  if (!result) {
    throw new Error(`Control not found for text: ${texts.join(', ')}`);
  }

  return result;
}

async function hasControlByText(page, texts) {
  return page.evaluate(({ texts }) => {
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .replace(/[ \t\r\n\u3000]+/g, '')
      .toLowerCase();

    const targets = texts.map(normalize);
    const selectors = [
      'button',
      'a',
      'input[type="button"]',
      'input[type="submit"]',
      '[role="button"]',
      '[tabindex="0"]',
    ];

    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    };

    const getText = element => normalize(
      element.innerText ||
      element.textContent ||
      element.value ||
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      ''
    );

    return selectors.some(selector =>
      [...document.querySelectorAll(selector)].some(element => {
        if (!isVisible(element)) return false;
        const text = getText(element);
        return text && targets.some(target => text.includes(target));
      })
    );
  }, { texts });
}

async function isPatientSearchScreen(page, config) {
  return page.evaluate(({ selectors, texts }) => {
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .replace(/[ \t\r\n\u3000]+/g, '')
      .toLowerCase();

    const hints = texts.patientNumber.map(normalize);
    const bodyText = normalize(document.body.innerText || '');

    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const hasHint = hints.some(hint => bodyText.includes(hint));
    const hasField = selectors.patientNumber.some(selector =>
      [...document.querySelectorAll(selector)].some(element => isVisible(element))
    );

    return hasHint || hasField;
  }, { selectors: config.selectors, texts: config.texts });
}

async function findVisibleHandle(page, selectors) {
  for (const selector of selectors) {
    const handles = await page.$$(selector);
    for (const handle of handles) {
      const visible = await handle.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          !element.disabled
        );
      });

      if (visible) {
        return handle;
      }
    }
  }

  return null;
}

async function maybePassMedicalGate(page, config) {
  const onMedicalGate = await page.evaluate(({ medicalGate }) => {
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .replace(/[ \t\r\n\u3000]+/g, '')
      .toLowerCase();
    const bodyText = normalize(document.body.innerText || '');
    return medicalGate.map(normalize).some(target => bodyText.includes(target));
  }, { medicalGate: config.texts.medicalGate });

  if (!onMedicalGate) {
    return false;
  }

  await clickControlByText(page, config.texts.medicalGateYes, 0);
  await waitForPageQuiet(page, config.timeouts.postClickMs);
  return true;
}

async function maybeLogin(page, config) {
  const passwordHandle = await findVisibleHandle(page, config.selectors.password);
  if (!passwordHandle) {
    return false;
  }

  if (!config.username || !config.password) {
    log(`Login fields detected but credentials are blank. Fill ${CONFIG_PATH} or ADHD_RX_USERNAME / ADHD_RX_PASSWORD.`);
    return false;
  }

  const usernameHandle = await findVisibleHandle(page, config.selectors.username);
  if (!usernameHandle) {
    throw new Error('Username field was not found.');
  }

  await usernameHandle.fill('');
  await usernameHandle.type(config.username, { delay: 30 });
  await passwordHandle.fill('');
  await passwordHandle.type(config.password, { delay: 30 });

  try {
    await clickControlByText(page, config.texts.loginSubmit, 0);
  } catch {
    await passwordHandle.press('Enter');
  }

  await waitForPageQuiet(page, config.timeouts.postClickMs);
  return true;
}

async function ensurePatientSearchScreen(page, config) {
  if (!page.url() || page.url() === 'about:blank') {
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
    await waitForPageQuiet(page, config.timeouts.postClickMs);
  }

  if (!page.url().startsWith('http')) {
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
    await waitForPageQuiet(page, config.timeouts.postClickMs);
  }

  if (!page.url().includes('adhd-vcdcs.jp')) {
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
    await waitForPageQuiet(page, config.timeouts.postClickMs);
  }

  await maybePassMedicalGate(page, config);
  await maybeLogin(page, config);

  if (config.patientSearchUrl) {
    await page.goto(config.patientSearchUrl, { waitUntil: 'domcontentloaded' });
    await waitForPageQuiet(page, config.timeouts.postClickMs);
  }

  const ready = await waitForCondition(
    'patient number screen was not detected',
    config.timeouts.screenWaitMs,
    async () => {
      await maybePassMedicalGate(page, config);
      const searchReady = await isPatientSearchScreen(page, config);
      return searchReady ? true : false;
    }
  );

  if (!ready) {
    throw new Error('Patient number screen was not reached.');
  }
}

async function waitForManualSearch(page, config) {
  log('Patient number screen detected.');
  log('Type the patient number manually in Chrome and press the search button. Automation resumes when a visible "Select" button appears.');

  await waitForCondition(
    'search result "Select" button did not appear',
    config.timeouts.manualSearchMs,
    async () => {
      const found = await hasControlByText(page, config.texts.select);
      return found ? true : false;
    }
  );
}

async function setPrescriptionDate(page, config) {
  const today = new Date();
  const yyyy = String(today.getFullYear());
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');

  const result = await page.evaluate(({ hints, slash, hyphen, compact }) => {
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .replace(/[ \t\r\n\u3000]+/g, '')
      .toLowerCase();

    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        !element.disabled
      );
    };

    const collectContextText = element => {
      const parts = [];
      const id = element.getAttribute('id');
      if (id) {
        for (const label of document.querySelectorAll(`label[for="${CSS.escape(id)}"]`)) {
          parts.push(label.textContent || '');
        }
      }

      let current = element.closest('label') || element.parentElement;
      let depth = 0;
      while (current && depth < 4) {
        parts.push(current.textContent || '');
        current = current.parentElement;
        depth += 1;
      }

      parts.push(element.getAttribute('placeholder') || '');
      parts.push(element.getAttribute('aria-label') || '');
      parts.push(element.getAttribute('name') || '');
      parts.push(element.getAttribute('id') || '');

      return normalize(parts.join(' '));
    };

    const setValue = (element, value) => {
      const prototype = element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('blur', { bubbles: true }));
    };

    const targets = hints.map(normalize);
    const candidates = [];

    for (const element of document.querySelectorAll('input, textarea')) {
      if (!isVisible(element)) continue;
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(type)) continue;

      const contextText = collectContextText(element);
      let score = 0;
      for (const target of targets) {
        if (contextText.includes(target)) score += 60;
      }
      if (type === 'date') score += 20;
      if (/^\d{4}[\/-]\d{2}[\/-]\d{2}$/.test(element.value || '')) score += 10;

      if (score > 0) {
        candidates.push({ element, score, type, contextText });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const target = candidates[0];
    if (!target) {
      return { ok: false, reason: 'No matching date field was found.' };
    }

    const placeholder = normalize(target.element.getAttribute('placeholder') || '');
    const currentValue = normalize(target.element.value || '');
    let value = slash;

    if (target.type === 'date') {
      value = hyphen;
    } else if (placeholder.includes('yyyymmdd') || currentValue.length === 8) {
      value = compact;
    } else if (placeholder.includes('yyyy-mm') || currentValue.includes('-')) {
      value = hyphen;
    }

    setValue(target.element, value);
    return {
      ok: true,
      value,
      contextText: target.contextText,
    };
  }, {
    hints: config.texts.prescriptionDate,
    slash: `${yyyy}/${mm}/${dd}`,
    hyphen: `${yyyy}-${mm}-${dd}`,
    compact: `${yyyy}${mm}${dd}`,
  });

  if (!result.ok) {
    throw new Error(result.reason);
  }

  return result;
}

async function extractPreviousConcerta(page, config) {
  const data = await page.evaluate(({ drugKeywords }) => {
    const normalizeLine = value => String(value || '')
      .normalize('NFKC')
      .replace(/[ \t\r\n\u3000]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const keywords = drugKeywords.map(keyword => keyword.normalize('NFKC').toLowerCase());
    const lines = String(document.body.innerText || '')
      .split('\n')
      .map(line => normalizeLine(line))
      .filter(Boolean);

    const snippets = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const normalizedLine = line.toLowerCase();
      if (!keywords.some(keyword => normalizedLine.includes(keyword))) {
        continue;
      }

      const joined = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join(' ');
      snippets.push(joined);
    }

    const parseNumber = (pattern, text) => {
      const match = text.match(pattern);
      return match ? match[1] : '';
    };

    const candidates = snippets.map(snippet => {
      const mg = parseNumber(/(\d+(?:\.\d+)?)\s*mg/i, snippet);
      const days = parseNumber(/(\d+)\s*(?:\u65e5\u5206|\u65e5\u6570|\u65e5)/, snippet);

      let tablets = '';
      const tabletPatterns = [
        /(\d+(?:\.\d+)?)\s*\u9320/,
        /\u6570\u91cf\s*[:\uff1a]?\s*(\d+(?:\.\d+)?)/,
        /\u7528\u91cf\s*[:\uff1a]?\s*(\d+(?:\.\d+)?)/,
      ];

      for (const pattern of tabletPatterns) {
        tablets = parseNumber(pattern, snippet);
        if (tablets) break;
      }

      const score = Number(Boolean(mg)) + Number(Boolean(tablets)) + Number(Boolean(days));
      return { snippet, mg, tablets, days, score };
    }).sort((a, b) => b.score - a.score);

    return candidates[0] || null;
  }, { drugKeywords: config.texts.drugKeywords });

  if (!data || !data.score) {
    throw new Error('Previous Concerta details were not found on the page.');
  }

  if (!data.mg || !data.tablets || !data.days) {
    throw new Error(`Previous Concerta details were incomplete: ${JSON.stringify(data)}`);
  }

  return data;
}

async function fillFieldByHints(page, hints, rawValue) {
  const result = await page.evaluate(({ hints, rawValue }) => {
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .replace(/[ \t\r\n\u3000]+/g, '')
      .toLowerCase();

    const value = String(rawValue);
    const valueNormalized = normalize(value);

    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        !element.disabled
      );
    };

    const collectContextText = element => {
      const parts = [];
      const id = element.getAttribute('id');
      if (id) {
        for (const label of document.querySelectorAll(`label[for="${CSS.escape(id)}"]`)) {
          parts.push(label.textContent || '');
        }
      }

      let current = element.closest('label') || element.parentElement;
      let depth = 0;
      while (current && depth < 4) {
        parts.push(current.textContent || '');
        current = current.parentElement;
        depth += 1;
      }

      parts.push(element.getAttribute('placeholder') || '');
      parts.push(element.getAttribute('aria-label') || '');
      parts.push(element.getAttribute('name') || '');
      parts.push(element.getAttribute('id') || '');
      return normalize(parts.join(' '));
    };

    const targets = hints.map(normalize);
    const candidates = [];

    for (const element of document.querySelectorAll('input, select, textarea')) {
      if (!isVisible(element)) continue;

      const tagName = element.tagName.toLowerCase();
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (tagName === 'input' && ['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(type)) continue;

      const contextText = collectContextText(element);
      let score = 0;
      for (const target of targets) {
        if (contextText.includes(target)) score += 60;
      }

      if (!score) continue;
      if (tagName === 'select') score += 15;
      if (!normalize(element.value || '')) score += 10;

      candidates.push({ element, score, tagName, contextText });
    }

    candidates.sort((a, b) => b.score - a.score);
    const target = candidates[0];
    if (!target) {
      return { ok: false, reason: `No field matched hints: ${hints.join(', ')}` };
    }

    if (target.tagName === 'select') {
      const options = [...target.element.options].map(option => ({
        value: option.value,
        text: normalize(option.textContent || ''),
      }));

      let option = options.find(item =>
        item.text.includes(valueNormalized) ||
        normalize(item.value) === valueNormalized
      );

      if (!option && /mg$/.test(valueNormalized)) {
        const numericValue = valueNormalized.replace(/mg$/, '');
        option = options.find(item => item.text.includes(numericValue));
      }

      if (!option) {
        return {
          ok: false,
          reason: `No matching option for value "${value}".`,
          contextText: target.contextText,
        };
      }

      target.element.value = option.value;
      target.element.dispatchEvent(new Event('input', { bubbles: true }));
      target.element.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        method: 'select',
        value,
        contextText: target.contextText,
      };
    }

    const prototype = target.tagName === 'textarea'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(target.element, value);
    } else {
      target.element.value = value;
    }

    target.element.dispatchEvent(new Event('input', { bubbles: true }));
    target.element.dispatchEvent(new Event('change', { bubbles: true }));
    target.element.dispatchEvent(new Event('blur', { bubbles: true }));

    return {
      ok: true,
      method: 'input',
      value,
      contextText: target.contextText,
    };
  }, { hints, rawValue });

  if (!result.ok) {
    throw new Error(result.reason);
  }

  return result;
}

async function run() {
  const config = loadConfig();

  if (!fs.existsSync(CONFIG_PATH)) {
    log(`Config file not found. Using defaults and environment variables. Copy ${EXAMPLE_CONFIG_PATH} to ${CONFIG_PATH} if you want fixed credentials/selectors.`);
  }

  let browser;
  let page;

  try {
    browser = await connectToBrowser(config);
    page = await getTargetPage(browser);

    await ensurePatientSearchScreen(page, config);
    await waitForManualSearch(page, config);

    const firstSelect = await clickControlByText(page, config.texts.select, 0);
    log(`Clicked first select button at (${firstSelect.left}, ${firstSelect.top}).`);
    await waitForPageQuiet(page, config.timeouts.postClickMs);

    const prescriptionInput = await clickControlByText(page, config.texts.prescriptionInput, 0);
    log(`Clicked prescription input button at (${prescriptionInput.left}, ${prescriptionInput.top}).`);
    await waitForPageQuiet(page, config.timeouts.postClickMs);

    const secondSelect = await clickControlByText(page, config.texts.select, 0);
    log(`Clicked second select button at (${secondSelect.left}, ${secondSelect.top}).`);
    await waitForPageQuiet(page, config.timeouts.postClickMs);

    const dateResult = await setPrescriptionDate(page, config);
    log(`Prescription date set to ${dateResult.value}.`);
    await waitForPageQuiet(page, config.timeouts.postClickMs);

    const previousConcerta = await extractPreviousConcerta(page, config);
    const mgValue = /mg$/i.test(previousConcerta.mg) ? previousConcerta.mg : `${previousConcerta.mg}mg`;

    await fillFieldByHints(page, config.texts.mgField, mgValue);
    log(`Filled mg field with ${mgValue}.`);

    await fillFieldByHints(page, config.texts.tabletField, previousConcerta.tablets);
    log(`Filled tablet field with ${previousConcerta.tablets}.`);

    await fillFieldByHints(page, config.texts.daysField, previousConcerta.days);
    log(`Filled days field with ${previousConcerta.days}.`);

    log(`Done. Browser stays open for manual continuation.`);
  } catch (error) {
    if (page) {
      try {
        await page.screenshot({ path: ERROR_SHOT_PATH, fullPage: true });
        log(`Saved debug screenshot to ${ERROR_SHOT_PATH}.`);
      } catch {}
    }

    console.error(`[adhd-rx] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

run();
