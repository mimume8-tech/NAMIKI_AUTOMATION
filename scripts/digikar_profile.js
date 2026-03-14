const fs = require("fs");
const path = require("path");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEFAULT_CHROME_USER_DATA = "C:\\Users\\ykimu\\AppData\\Local\\Google\\Chrome\\User Data";
const DEFAULT_CHROME_PROFILE_DIRECTORY = "Default";
const DIGIKAR_USER_DATA = "C:\\ChromeDebugProfile";
const DIGIKAR_PROFILE_DIRECTORY = "Default";

const ROOT_SYNC_FILES = ["Local State", "Last Version", "Last Browser"];
const PROFILE_SYNC_FILES = [
  "Bookmarks",
  "Bookmarks.bak",
  "Preferences",
  "Secure Preferences",
  "Login Data",
  "Login Data-journal",
  "Login Data For Account",
  "Login Data For Account-journal",
  "Web Data",
  "Web Data-journal",
  "Account Web Data",
  "Account Web Data-journal",
  "Affiliation Database",
  "Affiliation Database-journal",
  "Extension Cookies",
  "Extension Cookies-journal",
  "Favicons",
  "Favicons-journal",
  "History",
  "History-journal",
  "PreferredApps",
  "Shortcuts",
  "Shortcuts-journal",
  "Top Sites",
  "Top Sites-journal",
  "trusted_vault.pb",
  "Google Profile Picture.png",
  "Google Profile.ico",
];
const PROFILE_SYNC_DIRS = [
  "Accounts",
  "Extension Rules",
  "Extension Scripts",
  "Extension State",
  "Extensions",
  "Local Extension Settings",
  "Local Storage",
  "IndexedDB",
  "Managed Extension Settings",
  "Network",
  "Service Worker",
  "Session Storage",
  "Sessions",
  "Storage",
  "Sync App Settings",
  "Sync Data",
  "Sync Extension Settings",
  "Web Applications",
  "WebStorage",
];

function prepareDigikarProfile({ log } = {}) {
  const logger = typeof log === "function" ? log : null;

  fs.mkdirSync(DIGIKAR_USER_DATA, { recursive: true });
  fs.mkdirSync(getDigikarProfilePath(), { recursive: true });

  syncRootFiles(logger);
  syncProfileFiles(logger);
  ensureBookmarkBarVisible();
}

function getDefaultProfilePath() {
  return path.join(DEFAULT_CHROME_USER_DATA, DEFAULT_CHROME_PROFILE_DIRECTORY);
}

function getDigikarProfilePath() {
  return path.join(DIGIKAR_USER_DATA, DIGIKAR_PROFILE_DIRECTORY);
}

function syncRootFiles(log) {
  for (const fileName of ROOT_SYNC_FILES) {
    const sourcePath = path.join(DEFAULT_CHROME_USER_DATA, fileName);
    const targetPath = path.join(DIGIKAR_USER_DATA, fileName);
    copyPath(sourcePath, targetPath, { log, verbose: fileName === "Local State" });
  }
}

function syncProfileFiles(log) {
  const sourceProfile = getDefaultProfilePath();
  const targetProfile = getDigikarProfilePath();

  for (const fileName of PROFILE_SYNC_FILES) {
    const sourcePath = path.join(sourceProfile, fileName);
    const targetPath = path.join(targetProfile, fileName);
    copyPath(sourcePath, targetPath, {
      log,
      verbose: ["Bookmarks", "Bookmarks.bak", "Preferences"].includes(fileName),
    });
  }

  for (const dirName of PROFILE_SYNC_DIRS) {
    const sourcePath = path.join(sourceProfile, dirName);
    const targetPath = path.join(targetProfile, dirName);
    copyPath(sourcePath, targetPath, { log, verbose: dirName === "Extensions" });
  }
}

function copyPath(sourcePath, targetPath, { log, verbose = false } = {}) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  try {
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }

    if (verbose && log) {
      log(`synced ${path.basename(sourcePath)}`);
    }
  } catch (error) {
    if (verbose && log) {
      log(`sync failed: ${path.basename(sourcePath)} (${error.message})`);
    }
  }
}

function ensureBookmarkBarVisible() {
  const targetProfile = getDigikarProfilePath();
  const prefsPath = path.join(targetProfile, "Preferences");
  const defaultPrefsPath = path.join(getDefaultProfilePath(), "Preferences");

  const basePrefs = readJsonFile(prefsPath) || readJsonFile(defaultPrefsPath) || {};
  basePrefs.bookmark_bar = {
    ...(basePrefs.bookmark_bar || {}),
    show_on_all_tabs: true,
  };
  basePrefs.account_values = {
    ...(basePrefs.account_values || {}),
    bookmark_bar: {
      ...((basePrefs.account_values || {}).bookmark_bar || {}),
      show_on_all_tabs: true,
    },
  };

  writeJsonFile(prefsPath, basePrefs);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

module.exports = {
  CHROME_PATH,
  DIGIKAR_PROFILE_DIRECTORY,
  DIGIKAR_USER_DATA,
  prepareDigikarProfile,
};
