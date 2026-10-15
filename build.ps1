param([string]$OutputPath = (Join-Path $PSScriptRoot 'RemoteCoding.exe'))
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler unavailable.' }
& $compiler /nologo /codepage:65001 /target:winexe /optimize+ /platform:anycpu /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$OutputPath" "$projectRoot\desktop\Launcher.cs"
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "Built: $OutputPath"
