// Update desktop shortcut: rename to DigiKar下書き保存 and set custom icon
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const desktop = path.join(os.homedir(), 'Desktop');
const oldLnk = path.join(desktop, 'DigiKar.lnk');
const newLnk = path.join(desktop, 'DigiKar下書き保存.lnk');
const icoPath = 'C:\\NAMIKI_AUTOMATION\\scripts\\DigiKar下書き保存.ico';
const batPath = 'C:\\NAMIKI_AUTOMATION\\デジカル自動処理.bat';
const workDir = 'C:\\NAMIKI_AUTOMATION';

// Remove old shortcut if exists
if (fs.existsSync(oldLnk)) {
  fs.unlinkSync(oldLnk);
  console.log('Removed old shortcut:', oldLnk);
}
// Remove new name if exists
if (fs.existsSync(newLnk)) {
  fs.unlinkSync(newLnk);
  console.log('Removed existing shortcut:', newLnk);
}

// Create PowerShell script with UTF-16LE encoding
const ps1Content = `$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("${newLnk.replace(/\\/g, '\\\\')}")
$sc.TargetPath = "${batPath.replace(/\\/g, '\\\\')}"
$sc.WorkingDirectory = "${workDir.replace(/\\/g, '\\\\')}"
$sc.IconLocation = "${icoPath.replace(/\\/g, '\\\\')},0"
$sc.Description = "DigiKar カルテ下書き一括保存"
$sc.Save()
Write-Output "Shortcut created"
`;

const ps1Path = path.join(__dirname, '_tmp_shortcut.ps1');
// Write as UTF-16LE with BOM for PowerShell
const bom = Buffer.from([0xFF, 0xFE]);
const content = Buffer.from(ps1Content, 'utf16le');
fs.writeFileSync(ps1Path, Buffer.concat([bom, content]));

try {
  const result = execSync(`powershell -ExecutionPolicy Bypass -File "${ps1Path}"`, { encoding: 'utf8' });
  console.log(result.trim());

  if (fs.existsSync(newLnk)) {
    console.log('OK: DigiKar下書き保存.lnk created on desktop');
  } else {
    console.log('ERROR: Shortcut file not found after creation');
  }
} catch (e) {
  console.error('PowerShell error:', e.message);
} finally {
  fs.unlinkSync(ps1Path);
}
