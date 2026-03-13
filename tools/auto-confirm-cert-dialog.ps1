param(
  [int]$TimeoutSeconds = 45,
  [int]$PollIntervalMs = 300
)

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
}
"@

function Get-VisibleWindowTitles {
  $titles = New-Object System.Collections.Generic.List[string]
  $callback = [NativeWindows+EnumWindowsProc]{
    param($hWnd, $lParam)

    if (-not [NativeWindows]::IsWindowVisible($hWnd)) {
      return $true
    }

    $builder = New-Object System.Text.StringBuilder 512
    [void][NativeWindows]::GetWindowText($hWnd, $builder, $builder.Capacity)
    $title = $builder.ToString().Trim()

    if ($title) {
      $titles.Add($title)
    }

    return $true
  }

  [void][NativeWindows]::EnumWindows($callback, [IntPtr]::Zero)
  return $titles
}

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
  $matchedTitle = $null

  foreach ($title in Get-VisibleWindowTitles) {
    if ($titlePatterns | Where-Object { $title -like "*$_*" }) {
      $matchedTitle = $title
      break
    }
  }

  if ($matchedTitle) {
    if ($shell.AppActivate($matchedTitle)) {
      Start-Sleep -Milliseconds 200
      $shell.SendKeys("~")
      Start-Sleep -Milliseconds 500
      $shell.SendKeys("~")
      break
    }
  }

  Start-Sleep -Milliseconds ([Math]::Max($PollIntervalMs, 100))
}
