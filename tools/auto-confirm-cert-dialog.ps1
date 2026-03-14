param(
  [int]$TimeoutSeconds = 45,
  [int]$PollIntervalMs = 300
)

# ── 方法1: レジストリポリシーで証明書自動選択を設定 ──
# AutoSelectCertificateForUrls は Chrome のポリシーであり、
# コマンドラインフラグではないためレジストリで設定する必要がある
$policyPath = "HKLM:\SOFTWARE\Policies\Google\Chrome\AutoSelectCertificateForUrls"
$policyValue = '{"pattern":"https://digikar.jp","filter":{}}'

try {
  if (-not (Test-Path $policyPath)) {
    New-Item -Path $policyPath -Force | Out-Null
  }
  Set-ItemProperty -Path $policyPath -Name "1" -Value $policyValue -Type String -Force
  # 成功した場合は終了（次回Chrome起動時からダイアログが出なくなる）
  exit 0
} catch {
  # HKLM に書けない場合は HKCU を試す
}

$policyPathCU = "HKCU:\SOFTWARE\Policies\Google\Chrome\AutoSelectCertificateForUrls"
try {
  if (-not (Test-Path $policyPathCU)) {
    New-Item -Path $policyPathCU -Force | Out-Null
  }
  Set-ItemProperty -Path $policyPathCU -Name "1" -Value $policyValue -Type String -Force
  exit 0
} catch {
  # レジストリ設定に失敗した場合はウィンドウ操作にフォールバック
}

# ── 方法2: フォールバック — ウィンドウ検索 + SendKeys ──
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

  public static List<IntPtr> GetVisibleWindows() {
    var windows = new List<IntPtr>();
    EnumWindows((hWnd, lParam) => {
      if (IsWindowVisible(hWnd)) {
        windows.Add(hWnd);
      }
      return true;
    }, IntPtr.Zero);
    return windows;
  }

  public static string GetTitle(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString().Trim();
  }
}
"@

$japaneseTitle = [string]::Concat(
  [char]0x8A3C,
  [char]0x660E,
  [char]0x66F8,
  [char]0x306E,
  [char]0x9078,
  [char]0x629E
)

$titlePatterns = @(
  $japaneseTitle,
  'Certificate Selection',
  'Select a Certificate'
)

$shell = New-Object -ComObject WScript.Shell
$deadline = (Get-Date).AddSeconds([Math]::Max($TimeoutSeconds, 1))

while ((Get-Date) -lt $deadline) {
  foreach ($hWnd in [NativeWindows]::GetVisibleWindows()) {
    $title = [NativeWindows]::GetTitle($hWnd)
    if (-not $title) { continue }

    $matched = $false
    foreach ($pattern in $titlePatterns) {
      if ($title -like "*$pattern*") {
        $matched = $true
        break
      }
    }

    if ($matched) {
      [NativeWindows]::SetForegroundWindow($hWnd) | Out-Null
      Start-Sleep -Milliseconds 300
      $shell.SendKeys("{ENTER}")
      Start-Sleep -Milliseconds 500
      $shell.SendKeys("{ENTER}")
      exit 0
    }
  }

  Start-Sleep -Milliseconds ([Math]::Max($PollIntervalMs, 100))
}
