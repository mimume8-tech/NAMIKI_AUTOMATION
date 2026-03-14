const path = require("path");
const { spawn, spawnSync } = require("child_process");

const HELPER_PATH = path.join(__dirname, "..", "tools", "auto-confirm-cert-dialog.ps1");

/**
 * Chrome の証明書自動選択ポリシーをレジストリに設定する（同期）。
 * Chrome 起動前に呼ぶことでダイアログを抑制する。
 *
 * 注意: execSync + 文字列コマンドだと cmd.exe が JSON 内の " を食うため、
 *       spawnSync + 配列引数で reg.exe に直接渡す。
 */
function ensureCertificatePolicy({ log } = {}) {
  const policyValue = '{"pattern":"https://digikar.jp","filter":{}}';
  for (const root of ["HKLM", "HKCU"]) {
    const regPath = `${root}\\SOFTWARE\\Policies\\Google\\Chrome\\AutoSelectCertificateForUrls`;
    const result = spawnSync(
      "reg",
      ["add", regPath, "/v", "1", "/t", "REG_SZ", "/d", policyValue, "/f"],
      { stdio: "pipe", windowsHide: true }
    );
    if (result.status === 0) {
      if (typeof log === "function") {
        log(`Certificate policy set in ${root} registry.`);
      }
      return true;
    }
    // 権限不足の場合は次を試す
  }
  if (typeof log === "function") {
    log("Warning: Could not set certificate policy in registry.");
  }
  return false;
}

/**
 * PowerShell ヘルパーをバックグラウンドで常駐起動し、
 * 証明書ダイアログが表示されるたびに自動で OK を押す。
 * 返り値: 停止用の関数。
 */
function startCertificateDialogHelper({ log } = {}) {
  // まずレジストリポリシーを設定（同期）
  ensureCertificatePolicy({ log });

  // ポリシー設定後でもダイアログが出る場合に備え PowerShell ヘルパーを常駐起動
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
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );
    child.unref();

    if (typeof log === "function") {
      log("Certificate dialog helper started (persistent).");
    }

    return () => {
      try { child.kill(); } catch {}
    };
  } catch (error) {
    if (typeof log === "function") {
      log(`Certificate dialog helper failed to start: ${error.message}`);
    }
    return () => {};
  }
}

module.exports = {
  startCertificateDialogHelper,
  ensureCertificatePolicy,
};
