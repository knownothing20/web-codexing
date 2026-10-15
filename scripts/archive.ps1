param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $Destination) { throw 'Archive already exists. Choose a fresh release name.' }
[System.IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination)
