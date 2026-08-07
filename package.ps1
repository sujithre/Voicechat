<#
.SYNOPSIS
    Builds app.zip for deployment to Azure App Service and verifies its contents.

.DESCRIPTION
    Compress-Archive on Windows PowerShell 5.1 writes ZIP entry names with
    backslashes, which the ZIP spec forbids. Linux App Service cannot interpret
    'public\app.js' as a directory, so the whole public/ folder is dropped and the
    deployment fails with a 400 after an otherwise clean build. This script writes
    the entries explicitly with '/' separators instead.

.EXAMPLE
    ./package.ps1
    az webapp deploy -g <rg> -n <app> --src-path app.zip --type zip
#>
[CmdletBinding()]
param(
    # Output path for the deployment package.
    [string] $Destination = "$PSScriptRoot\app.zip"
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = $PSScriptRoot
$items = @('package.json', 'package-lock.json', 'server.js', 'README.md') +
         (Get-ChildItem (Join-Path $root 'public') -Recurse -File |
            ForEach-Object { $_.FullName.Substring($root.Length + 1) })

foreach ($item in $items) {
    if (-not (Test-Path (Join-Path $root $item))) { throw "Missing file: $item" }
}

Remove-Item $Destination -Force -ErrorAction SilentlyContinue

$zip = [IO.Compression.ZipFile]::Open($Destination, 'Create')
try {
    foreach ($item in $items) {
        $entry = $item -replace '\\', '/'
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, (Join-Path $root $item), $entry) | Out-Null
    }
} finally {
    $zip.Dispose()
}

$reader = [IO.Compression.ZipFile]::OpenRead($Destination)
try {
    $entries = $reader.Entries | ForEach-Object { $_.FullName }
} finally {
    $reader.Dispose()
}

$bad = $entries | Where-Object { $_ -like '*\*' }
if ($bad) {
    throw "ZIP contains backslash separators, App Service will reject it: $($bad -join ', ')"
}

Write-Host "Created $Destination" -ForegroundColor Green
Write-Host "$($entries.Count) entries:"
$entries | ForEach-Object { Write-Host "  $_" }
