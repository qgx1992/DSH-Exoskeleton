# 把真实打赏图转换为 resources/tip.png（处理 EXIF 方向、统一为 PNG）
# 用法：pwsh scripts/set-tip-image.ps1 -Source "C:\path\to\tip.jpg"
param(
    [Parameter(Mandatory = $true)][string]$Source
)
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\resources\tip.png'

$img = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
try {
    # EXIF 方向（0x0112）：手机照片常带旋转标记，浏览器不会自动纠正
    $orient = 1
    foreach ($prop in $img.PropertyItems) {
        if ($prop.Id -eq 0x0112 -and $prop.Value.Length -ge 1) { $orient = $prop.Value[0] }
    }
    switch ($orient) {
        2 { $img.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipX) }
        3 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
        4 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipX) }
        5 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipX) }
        6 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
        7 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipX) }
        8 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
    }
    $img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ("written: {0}  ({1}x{2})" -f $out, $img.Width, $img.Height)
}
finally {
    $img.Dispose()
}
