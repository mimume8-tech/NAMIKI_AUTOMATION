param(
  [int]$PollIntervalMs = 500
)

# ── 常駐型: Chrome の証明書選択ダイアログを自動で OK する ──
# print-rx.js のバックグラウンドプロセスとして動作し、
# ダイアログが表示されるたびに自動クリックする。

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  public const uint BM_CLICK = 0x00F5;
  public const uint WM_CLOSE = 0x0010;

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

  public static string GetClass(IntPtr hWnd) {
    var sb = new StringBuilder(256);
    GetClassName(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public static List<IntPtr> GetChildWindows(IntPtr hWndParent) {
    var children = new List<IntPtr>();
    EnumChildWindows(hWndParent, (hWnd, lParam) => {
      children.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return children;
  }
}
"@

# 証明書の選択
$japaneseTitle = [string]::Concat(
  [char]0x8A3C,
  [char]0x660E,
  [char]0x66F8,
  [char]0x306E,
  [char]0x9078,
  [char]0x629E
)

# OK ボタンのテキスト
$okText = "OK"

$titlePatterns = @(
  $japaneseTitle,
  'Certificate Selection',
  'Select a Certificate'
)

$shell = New-Object -ComObject WScript.Shell

while ($true) {
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
      # 方法1: 子ウィンドウから OK ボタンを探して BM_CLICK
      $clicked = $false
      foreach ($child in [NativeWindows]::GetChildWindows($hWnd)) {
        $childText = [NativeWindows]::GetTitle($child)
        $childClass = [NativeWindows]::GetClass($child)
        if ($childText -eq $okText -or $childText -eq "&OK") {
          [NativeWindows]::SendMessage($child, [NativeWindows]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
          $clicked = $true
          break
        }
      }

      # 方法2: フォアグラウンドにして Enter キー送信
      if (-not $clicked) {
        [NativeWindows]::SetForegroundWindow($hWnd) | Out-Null
        Start-Sleep -Milliseconds 200
        $shell.SendKeys("{ENTER}")
      }

      # ダイアログが閉じるのを待ってから再監視
      Start-Sleep -Milliseconds 1000
    }
  }

  Start-Sleep -Milliseconds ([Math]::Max($PollIntervalMs, 100))
}
