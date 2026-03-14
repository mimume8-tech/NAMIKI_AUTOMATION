const path = require("path");
const { spawn, execSync } = require("child_process");

const HELPER_PATH = path.join(__dirname, "..", "tools", "auto-confirm-cert-dialog.ps1");

/**
 * Chrome の証明書自動選択ポリシーをレジストリに設定する（同期）。
 * Chrome 起動前に呼ぶことでダイアログを抑制する。
 */
function ensureCertificatePolicy({ log } = {}) {
  const policyValue = '{"pattern":"https://digikar.jp","filter":{}}';
  // HKLM → HKCU の順に試す
  for (const root of ["HKLM", "HKCU"]) {
    const regPath = `${root}\\SOFTWARE\\Policies\\Google\\Chrome\\AutoSelectCertificateForUrls`;
    try {
      execSync(
        `reg add "${regPath}" /v 1 /t REG_SZ /d "${policyValue}" /f`,
        { stdio: "pipe", windowsHide: true }
      );
      if (typeof log === "function") {
        log(`Certificate policy set in ${root} registry.`);
      }
      return true;
    } catch {
      // 権限不足の場合は次を試す
    }
  }
  if (typeof log === "function") {
    log("Warning: Could not set certificate policy in registry.");
  }
  return false;
}

/**
 * PowerShell ヘルパーを起動して証明書ダイアログを監視する（フォールバック用）。
 */
function startCertificateDialogHelper({ timeoutSeconds = 45, log } = {}) {
  // まずレジストリポリシーを設定（同期）
  const policySet = ensureCertificatePolicy({ log });

  // ポリシー設定成功でも初回起動時はダイアログが出る可能性があるため
  // PowerShell ヘルパーも起動しておく
  try {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        HELPER_PATH,
        "-TimeoutSeconds",
        String(timeoutSeconds),
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );
    child.unref();

    if (typeof log === "function") {
      log("Certificate dialog helper started.");
    }
  } catch (error) {
    if (typeof log === "function") {
      log(`Certificate dialog helper failed to start: ${error.message}`);
    }
  }
}

module.exports = {
  startCertificateDialogHelper,
  ensureCertificatePolicy,
};
