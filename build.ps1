param([string]$OutputPath = (Join-Path $PSScriptRoot 'RemoteCoding.exe'))
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler unavailable.' }
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ('remote-coding-icon-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildRoot | Out-Null
$iconBuilder = Join-Path $buildRoot 'IconBuilder.exe'
$iconPath = Join-Path $buildRoot 'RemoteCoding.ico'
try {
    & $compiler /nologo /codepage:65001 /target:exe /optimize+ /reference:System.Drawing.dll "/out:$iconBuilder" "$projectRoot\desktop\IconBuilder.cs"
    if ($LASTEXITCODE -ne 0) { throw 'Icon builder compilation failed.' }
    & $iconBuilder $iconPath
    if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
    & $compiler /nologo /codepage:65001 /target:winexe /optimize+ /platform:anycpu /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32icon:$iconPath" "/resource:$iconPath,RemoteCoding.Icon" "/out:$OutputPath" "$projectRoot\desktop\Launcher.cs"
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
} finally {
    foreach ($generated in @($iconBuilder, $iconPath)) {
        if (Test-Path -LiteralPath $generated) { Remove-Item -LiteralPath $generated -Force }
    }
    [IO.Directory]::Delete($buildRoot)
}
Write-Host "Built: $OutputPath"
