# 生成 resources/tip.png 打赏图占位（收款码样式占位卡片）
# 用法：pwsh scripts/gen-tip-placeholder.ps1
# 真实打赏图就绪后，直接用图片覆盖 resources/tip.png 即可（无需改代码）。
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\resources\tip.png'
$W = 480
$H = 480

function New-RoundedRectPath([System.Drawing.Rectangle]$rect, [int]$radius) {
    $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $r = [math]::Min($radius, [math]::Min($rect.Width, $rect.Height) / 2)
    $d = $r * 2
    $p.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $p.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $p.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $p.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

$bmp = [System.Drawing.Bitmap]::new($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::FromArgb(255, 21, 27, 38))   # canvas 底色

$gold = [System.Drawing.Color]::FromArgb(255, 212, 178, 95)   # accent 金
$gray = [System.Drawing.Color]::FromArgb(255, 145, 156, 175)
$faint = [System.Drawing.Color]::FromArgb(255, 92, 102, 122)
$darkCell = [System.Drawing.Color]::FromArgb(255, 27, 34, 48)
$light = [System.Drawing.Color]::FromArgb(255, 244, 241, 232)

# 圆角边框卡片
$cardRect = [System.Drawing.Rectangle]::new(26, 26, $W - 52, $H - 52)
$cardPath = New-RoundedRectPath $cardRect 24
$pen = [System.Drawing.Pen]::new($gold, 2.5)
$g.DrawPath($pen, $cardPath)
$cardPath.Dispose(); $pen.Dispose()

# 顶部小字
$sfCenter = [System.Drawing.StringFormat]::new()
$sfCenter.Alignment = [System.Drawing.StringAlignment]::Center
$sfCenter.LineAlignment = [System.Drawing.StringAlignment]::Center
$fontTop = [System.Drawing.Font]::new('Segoe UI', 16, [System.Drawing.FontStyle]::Regular)
$g.DrawString('DSH-Exoskeleton', $fontTop, ([System.Drawing.Brushes]::Gray), (New-Object System.Drawing.RectangleF(0, 40, $W, 34)), $sfCenter)
$fontTop.Dispose()

# 仿收款码：浅底圆角方块 + 暗色模块 + 三个定位角
$codeRect = [System.Drawing.Rectangle]::new(140, 92, 200, 200)
$codePath = New-RoundedRectPath $codeRect 12
$g.FillPath([System.Drawing.Brushes]::White, $codePath)
$g.FillPath([System.Drawing.SolidBrush]::new($light), $codePath)
$codePath.Dispose()

$n = 21
$cell = [math]::Floor(200 / $n)
$seed = 42
function Next-Byte {
    $script:seed = ($script:seed * 1103515245 + 12345) % 2147483648
    return [int]($script:seed / 2147483648 * 256)
}
for ($y = 0; $y -lt $n; $y++) {
    for ($x = 0; $x -lt $n; $x++) {
        $inFinder = ($x -lt 7 -and $y -lt 7) -or ($x -ge $n - 7 -and $y -lt 7) -or ($x -lt 7 -and $y -ge $n - 7)
        if ($inFinder) { continue }
        if ((Next-Byte) -lt 96) {
            $g.FillRectangle([System.Drawing.SolidBrush]::new($darkCell), $codeRect.X + $x * $cell, $codeRect.Y + $y * $cell, $cell, $cell)
        }
    }
}
# 三个定位角（外框 + 白环 + 内芯）
$fxA = $codeRect.X
$fxB = $codeRect.Right - 7 * $cell
$fyA = $codeRect.Y
$fyB = $codeRect.Bottom - 7 * $cell
foreach ($fx in @($fxA, $fxB)) {
    foreach ($fy in @($fyA, $fyB)) {
        $g.FillRectangle([System.Drawing.SolidBrush]::new($darkCell), $fx, $fy, 7 * $cell, 7 * $cell)
        $g.FillRectangle([System.Drawing.Brushes]::White, $fx + $cell, $fy + $cell, 5 * $cell, 5 * $cell)
        $g.FillRectangle([System.Drawing.SolidBrush]::new($darkCell), $fx + 2 * $cell, $fy + 2 * $cell, 3 * $cell, 3 * $cell)
    }
}

# 中部标题
$fontMain = [System.Drawing.Font]::new('Microsoft YaHei UI', 30, [System.Drawing.FontStyle]::Bold)
$g.DrawString('打赏码 · 待替换', $fontMain, ([System.Drawing.SolidBrush]::new($gold)), (New-Object System.Drawing.RectangleF(0, 306, $W, 52)), $sfCenter)
$fontMain.Dispose()

# 底部说明
$fontSub = [System.Drawing.Font]::new('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Regular)
$g.DrawString('将图片保存为 resources/tip.png 后重新构建即可', $fontSub, ([System.Drawing.SolidBrush]::new($gray)), (New-Object System.Drawing.RectangleF(0, 366, $W, 36)), $sfCenter)
$fontSub.Dispose()
$fontSub2 = [System.Drawing.Font]::new('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Regular)
$g.DrawString('扫码支持 · 感谢你的每一份心意', $fontSub2, ([System.Drawing.SolidBrush]::new($faint)), (New-Object System.Drawing.RectangleF(0, 408, $W, 30)), $sfCenter)
$fontSub2.Dispose()

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "written: $out"
