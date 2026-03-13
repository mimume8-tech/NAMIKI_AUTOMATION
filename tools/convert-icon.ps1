# PNG → ICO 変換スクリプト
# 使い方: powershell -ExecutionPolicy Bypass -File convert-icon.ps1

Add-Type -AssemblyName System.Drawing

$pngPath = Join-Path $PSScriptRoot "digikar-icon.png"
$icoPath = Join-Path $PSScriptRoot "digikar-icon.ico"

if (-not (Test-Path $pngPath)) {
    Write-Host "[エラー] $pngPath が見つかりません。" -ForegroundColor Red
    Write-Host "画像ファイルを tools\digikar-icon.png として保存してください。"
    exit 1
}

# PNGを読み込んで複数サイズのICOを作成
$png = [System.Drawing.Image]::FromFile($pngPath)

# ICOファイルをバイナリで構築（256, 48, 32, 16px の4サイズ）
$sizes = @(256, 48, 32, 16)
$images = @()

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($png, 0, 0, $size, $size)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += ,@{
        Size = $size
        Data = $ms.ToArray()
    }
    $ms.Dispose()
    $bmp.Dispose()
}

$png.Dispose()

# ICOフォーマットを手動構築
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR ヘッダー
$bw.Write([UInt16]0)         # reserved
$bw.Write([UInt16]1)         # type (1=ICO)
$bw.Write([UInt16]$images.Count)  # count

# 各エントリのオフセット計算
$headerSize = 6 + ($images.Count * 16)
$offset = $headerSize

# ICONDIRENTRY を書き出す
foreach ($img in $images) {
    $s = $img.Size
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))  # width
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))  # height
    $bw.Write([byte]0)       # color palette
    $bw.Write([byte]0)       # reserved
    $bw.Write([UInt16]1)     # color planes
    $bw.Write([UInt16]32)    # bits per pixel
    $bw.Write([UInt32]$img.Data.Length)  # size of image data
    $bw.Write([UInt32]$offset)           # offset
    $offset += $img.Data.Length
}

# 画像データを書き出す
foreach ($img in $images) {
    $bw.Write($img.Data)
}

$bw.Close()
$fs.Close()

Write-Host "[OK] ICO ファイルを作成しました: $icoPath" -ForegroundColor Green
