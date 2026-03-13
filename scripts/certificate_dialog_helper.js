const path = require("path");
const { spawn } = require("child_process");

const HELPER_PATH = path.join(__dirname, "..", "tools", "auto-confirm-cert-dialog.ps1");

function startCertificateDialogHelper({ timeoutSeconds = 45, log } = {}) {
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
};
