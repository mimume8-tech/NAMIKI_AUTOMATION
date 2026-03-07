param(
    [string]$ContactName,
    [string]$OutputDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class NativeMethods {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@

function New-UiString {
    param([int[]]$CodePoints)
    return (-join ($CodePoints | ForEach-Object { [char]$_ }))
}

$script:MessageLabel = New-UiString @(0x30E1, 0x30C3, 0x30BB, 0x30FC, 0x30B8)

if (-not $PSBoundParameters.ContainsKey("ContactName")) {
    $ContactName = New-UiString @(0x3086, 0x3044, 0x3053, 0x20, 0x3068, 0x3070, 0x308A)
}

if (-not $PSBoundParameters.ContainsKey("OutputDir")) {
    $rootDir = Split-Path -Parent $PSScriptRoot
    $baseDir = Join-Path $rootDir "exports"
    $leaf = "imazing_chat_yuiko_tobari_{0}" -f (Get-Date -Format "yyyyMMdd_HHmmss")
    $OutputDir = Join-Path $baseDir $leaf
}

$assetsDir = Join-Path $OutputDir "assets"
$jsonPath = Join-Path $OutputDir "chat.json"
$htmlPath = Join-Path $OutputDir "chat.html"
$pdfPath = Join-Path $OutputDir "chat.pdf"

function Write-Step {
    param([string]$Message)
    Write-Host "[iMazing] $Message"
}

function Get-RootElement {
    return [System.Windows.Automation.AutomationElement]::RootElement
}

function Get-ImazingWindow {
    $root = Get-RootElement
    $children = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )

    for ($i = 0; $i -lt $children.Count; $i++) {
        $candidate = $children.Item($i)
        if ($candidate.Current.Name -eq "iMazing" -and $candidate.Current.ClassName -eq "Window") {
            return $candidate
        }
    }

    throw "Main iMazing window was not found."
}

function Focus-Window {
    param([System.Windows.Automation.AutomationElement]$Window)

    $handle = [IntPtr]$Window.Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
        [NativeMethods]::ShowWindowAsync($handle, 9) | Out-Null
        [NativeMethods]::SetForegroundWindow($handle) | Out-Null
        Start-Sleep -Milliseconds 400
    }
}

function Find-FirstDescendant {
    param(
        [System.Windows.Automation.AutomationElement]$Parent,
        [string]$Name = $null,
        [System.Windows.Automation.ControlType]$ControlType = $null,
        [string]$AutomationId = $null,
        [string]$ClassName = $null
    )

    $all = $Parent.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )

    for ($i = 0; $i -lt $all.Count; $i++) {
        $element = $all.Item($i)

        if (-not [string]::IsNullOrEmpty($Name) -and $element.Current.Name -ne $Name) {
            continue
        }

        if (-not [string]::IsNullOrEmpty($AutomationId) -and $element.Current.AutomationId -ne $AutomationId) {
            continue
        }

        if (-not [string]::IsNullOrEmpty($ClassName) -and $element.Current.ClassName -ne $ClassName) {
            continue
        }

        if ($null -ne $ControlType -and $element.Current.ControlType -ne $ControlType) {
            continue
        }

        return $element
    }

    return $null
}

function Wait-FirstDescendant {
    param(
        [System.Windows.Automation.AutomationElement]$Parent,
        [string]$Name = $null,
        [System.Windows.Automation.ControlType]$ControlType = $null,
        [string]$AutomationId = $null,
        [string]$ClassName = $null,
        [int]$TimeoutMs = 15000
    )

    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $found = Find-FirstDescendant -Parent $Parent -Name $Name -ControlType $ControlType -AutomationId $AutomationId -ClassName $ClassName
        if ($null -ne $found) {
            return $found
        }

        Start-Sleep -Milliseconds 250
    }

    throw "Required element was not found."
}

function Select-Element {
    param([System.Windows.Automation.AutomationElement]$Element)

    $scrollItem = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollItem)) {
        $scrollItem.ScrollIntoView()
        Start-Sleep -Milliseconds 250
    }

    $selectionItem = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionItem)) {
        $selectionItem.Select()
        return
    }

    throw "SelectionItemPattern was not available."
}

function Get-MessageGrid {
    param([System.Windows.Automation.AutomationElement]$MainWindow)

    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        try {
            $currentMainWindow = Get-ImazingWindow
        }
        catch {
            $currentMainWindow = $MainWindow
        }

        try {
            $all = $currentMainWindow.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
        }
        catch {
            Start-Sleep -Milliseconds 250
            continue
        }

        $best = $null
        $bestWidth = -1.0

        for ($i = 0; $i -lt $all.Count; $i++) {
            $element = $all.Item($i)
            if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::DataGrid) {
                continue
            }

            $width = $element.Current.BoundingRectangle.Width
            if ($width -gt $bestWidth) {
                $best = $element
                $bestWidth = $width
            }
        }

        if ($null -ne $best) {
            return $best
        }

        Start-Sleep -Milliseconds 250
    }

    throw "Message grid was not found."
}

function Get-ScrollPatternOrThrow {
    param([System.Windows.Automation.AutomationElement]$Element)

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern)) {
        return $pattern
    }

    throw "ScrollPattern was not available."
}

function Get-VisibleDataItems {
    param([System.Windows.Automation.AutomationElement]$Grid)

    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::DataItem
    )

    $items = $Grid.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    $result = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $items.Count; $i++) {
        [void]$result.Add($items.Item($i))
    }
    return $result
}

function Get-MessageItemInfo {
    param([System.Windows.Automation.AutomationElement]$Item)

    $descendants = $Item.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )

    $classes = New-Object System.Collections.Generic.HashSet[string]
    $helpText = $null
    $hasImageControl = $false

    for ($i = 0; $i -lt $descendants.Count; $i++) {
        $child = $descendants.Item($i)
        if (-not [string]::IsNullOrEmpty($child.Current.ClassName)) {
            [void]$classes.Add($child.Current.ClassName)
        }

        if (-not $helpText -and -not [string]::IsNullOrEmpty($child.Current.HelpText)) {
            $helpText = $child.Current.HelpText
        }

        if ($child.Current.ControlType -eq [System.Windows.Automation.ControlType]::Image) {
            $hasImageControl = $true
        }
    }

    $kind = "other"
    if ($classes.Contains("MessagesTextMessageContentViewController")) {
        $kind = "text"
    }
    elseif ($classes.Contains("MessagesImageContentViewController") -or $hasImageControl) {
        $kind = "image"
    }
    elseif ($classes.Contains("MessagesDateHeaderContentViewController") -or $classes.Contains("MessagesNotificationMessageViewController")) {
        $kind = "header"
    }

    $sender = "system"
    if ($classes.Contains("MessagesSentMessageViewController")) {
        $sender = "sent"
    }
    elseif ($classes.Contains("MessagesReceivedMessageViewController")) {
        $sender = "received"
    }

    $text = ($Item.Current.Name -replace "`r", "" -replace "`n", [Environment]::NewLine).Trim()
    if ($kind -eq "text" -and $text.StartsWith($script:MessageLabel + $script:MessageLabel)) {
        $text = $text.Substring($script:MessageLabel.Length)
    }

    return [pscustomobject]@{
        kind = $kind
        sender = $sender
        text = $text
        helpText = $helpText
    }
}

function Save-ImageCapture {
    param(
        [System.Windows.Automation.AutomationElement]$Item,
        [System.Windows.Automation.AutomationElement]$Grid,
        [string]$AssetPath
    )

    $gridRect = $Grid.Current.BoundingRectangle
    $images = $Item.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Image
        ))
    )

    $target = $null
    for ($i = 0; $i -lt $images.Count; $i++) {
        $candidate = $images.Item($i)
        $rect = $candidate.Current.BoundingRectangle
        if ($rect.Width -gt 80 -and $rect.Height -gt 80) {
            $target = $candidate
            break
        }
    }

    if ($null -eq $target) {
        return $null
    }

    $rect = $target.Current.BoundingRectangle
    if (
        $rect.Left -lt $gridRect.Left + 2 -or
        $rect.Top -lt $gridRect.Top + 2 -or
        ($rect.Left + $rect.Width) -gt ($gridRect.Left + $gridRect.Width) - 2 -or
        ($rect.Top + $rect.Height) -gt ($gridRect.Top + $gridRect.Height) - 2
    ) {
        return $null
    }

    $width = [Math]::Max(1, [int][Math]::Round($rect.Width))
    $height = [Math]::Max(1, [int][Math]::Round($rect.Height))
    $left = [int][Math]::Round($rect.Left)
    $top = [int][Math]::Round($rect.Top)

    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

    try {
        $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
        $bitmap.Save($AssetPath, [System.Drawing.Imaging.ImageFormat]::Png)
        return $AssetPath
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Get-RelativePath {
    param(
        [string]$BasePath,
        [string]$TargetPath
    )

    $baseFullPath = [System.IO.Path]::GetFullPath($BasePath).TrimEnd("\")
    $targetFullPath = [System.IO.Path]::GetFullPath($TargetPath)
    $baseUri = New-Object System.Uri(($baseFullPath + "\"))
    $targetUri = New-Object System.Uri($targetFullPath)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString().Replace("/", "\"))
}

function Build-ImageAssetKey {
    param(
        [string]$Timestamp,
        [string]$Sender,
        [string]$Text
    )

    return "{0}|{1}|{2}" -f $Timestamp, $Sender, $Text
}

function Get-SnapshotAppendStart {
    param(
        [System.Collections.ArrayList]$Sequence,
        [System.Collections.ArrayList]$Snapshot
    )

    if ($Sequence.Count -eq 0) {
        return 0
    }

    $bestOffset = -1
    $bestLength = 0

    for ($offset = 0; $offset -lt $Snapshot.Count; $offset++) {
        $maxLength = [Math]::Min($Sequence.Count, $Snapshot.Count - $offset)
        for ($length = $maxLength; $length -gt $bestLength; $length--) {
            $matches = $true
            for ($i = 0; $i -lt $length; $i++) {
                $left = $Sequence[$Sequence.Count - $length + $i].token
                $right = $Snapshot[$offset + $i].token
                if ($left -ne $right) {
                    $matches = $false
                    break
                }
            }

            if ($matches) {
                $bestOffset = $offset
                $bestLength = $length
                break
            }
        }
    }

    if ($bestLength -gt 0) {
        return $bestOffset + $bestLength
    }

    return 0
}

New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null

Write-Step "Finding iMazing window"
$mainWindow = Get-ImazingWindow
Focus-Window -Window $mainWindow
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Start-Sleep -Milliseconds 250

Write-Step "Selecting chat"
$chatItem = Wait-FirstDescendant -Parent $mainWindow -Name $ContactName -ControlType ([System.Windows.Automation.ControlType]::DataItem)
Select-Element -Element $chatItem
Start-Sleep -Milliseconds 700

Write-Step "Preparing message view"
$messageGrid = Get-MessageGrid -MainWindow $mainWindow
$scrollPattern = Get-ScrollPatternOrThrow -Element $messageGrid
$scrollPattern.SetScrollPercent(-1, 0)
Start-Sleep -Milliseconds 800

$sequence = New-Object System.Collections.ArrayList
$imageAssets = @{}
$imageCounter = 0

Write-Step "Extracting messages"
for ($percent = 0.0; $percent -le 100.0001; $percent += 0.5) {
    $targetPercent = [Math]::Min(100.0, [Math]::Round($percent, 2))

    $messageGrid = Get-MessageGrid -MainWindow $mainWindow
    $scrollPattern = Get-ScrollPatternOrThrow -Element $messageGrid
    $scrollPattern.SetScrollPercent(-1, $targetPercent)
    Start-Sleep -Milliseconds 120

    $messageGrid = Get-MessageGrid -MainWindow $mainWindow
    $items = Get-VisibleDataItems -Grid $messageGrid
    $snapshot = New-Object System.Collections.ArrayList
    $pendingMeta = $null

    foreach ($item in $items) {
        $info = Get-MessageItemInfo -Item $item

        if ($info.kind -eq "header") {
            if (-not [string]::IsNullOrWhiteSpace($info.helpText)) {
                $pendingMeta = $info.helpText
                [void]$snapshot.Add([pscustomobject]@{
                    token = "HEADER|" + $info.helpText
                    timestamp = $info.helpText
                    sender = "system"
                    kind = "header"
                    text = $info.helpText
                })
            }
            continue
        }

        if ($info.kind -eq "other") {
            continue
        }

        $text = $info.text
        if ([string]::IsNullOrWhiteSpace($text)) {
            $text = "DDNA.MessagesMessage"
        }

        if ($info.kind -eq "image" -and -not [string]::IsNullOrWhiteSpace($pendingMeta)) {
            $imageKey = Build-ImageAssetKey -Timestamp $pendingMeta -Sender $info.sender -Text $text
            if (-not $imageAssets.ContainsKey($imageKey)) {
                $imageCounter += 1
                $imagePath = Join-Path $assetsDir ("image_{0:D3}.png" -f $imageCounter)
                $saved = Save-ImageCapture -Item $item -Grid $messageGrid -AssetPath $imagePath
                if ($saved) {
                    $imageAssets[$imageKey] = Get-RelativePath -BasePath $OutputDir -TargetPath $saved
                }
            }
        }

        $entry = [pscustomobject]@{
            token = "{0}|{1}|{2}" -f $info.kind.ToUpperInvariant(), $info.sender, $text
            timestamp = $pendingMeta
            sender = $info.sender
            kind = $info.kind
            text = $text
        }

        [void]$snapshot.Add($entry)
        $pendingMeta = $null
    }

    if ($snapshot.Count -eq 0) {
        continue
    }

    $appendStart = Get-SnapshotAppendStart -Sequence $sequence -Snapshot $snapshot
    for ($i = $appendStart; $i -lt $snapshot.Count; $i++) {
        [void]$sequence.Add($snapshot[$i])
    }
}

$records = New-Object System.Collections.ArrayList
$pendingTimestamp = $null

foreach ($entry in $sequence) {
    if ($entry.kind -eq "header") {
        $pendingTimestamp = $entry.timestamp
        continue
    }

    if ($entry.kind -eq "other") {
        continue
    }

    $recordText = $entry.text
    if ($entry.kind -eq "image" -and $recordText -eq "DDNA.MessagesMessage") {
        $recordText = "[image]"
    }

    $record = [pscustomobject]@{
        timestamp = $pendingTimestamp
        sender = $entry.sender
        kind = $entry.kind
        text = $recordText
        image = $null
    }

    if ($entry.kind -eq "image" -and -not [string]::IsNullOrWhiteSpace($pendingTimestamp)) {
        $imageKey = Build-ImageAssetKey -Timestamp $pendingTimestamp -Sender $entry.sender -Text $entry.text
        if ($imageAssets.ContainsKey($imageKey)) {
            $record.image = $imageAssets[$imageKey]
        }
    }

    [void]$records.Add($record)
    $pendingTimestamp = $null
}

$exportPayload = [pscustomobject]@{
    contact = $ContactName
    generatedAt = (Get-Date).ToString("s")
    messageCount = $records.Count
    messages = $records
}

$exportPayload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

Write-Step "Rendering HTML and PDF"
& node (Join-Path $PSScriptRoot "render_imazing_chat_pdf.js") $jsonPath $htmlPath $pdfPath
if ($LASTEXITCODE -ne 0) {
    throw "PDF rendering failed."
}

if (-not (Test-Path -LiteralPath $pdfPath)) {
    throw "PDF file was not created."
}

$pdfItem = Get-Item -LiteralPath $pdfPath
if ($pdfItem.Length -le 0) {
    throw "PDF file was empty."
}

Write-Step ("Export complete: {0} messages" -f $records.Count)
Write-Output $pdfPath
