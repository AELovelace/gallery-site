param(
    [string]$BindAddress = '10.1.1.23',
    [int]$Port = 8787,
    [string]$PublicOrigin = 'https://lidoll.dev',
    [string]$DataDirectory = ''
)

$ErrorActionPreference = 'Stop'
$galleryProjectRoot = Split-Path -Parent $PSScriptRoot # Resolves the project without depending on the caller's working directory.
if (-not $DataDirectory) { $DataDirectory = Join-Path $galleryProjectRoot 'gallery-data' }
$env:HOST = $BindAddress # Binds the service to the gallery box's LAN interface for the nginx proxy.
$env:PORT = [string]$Port
$env:GALLERY_ORIGIN = $PublicOrigin # Controls origin checks and HTTPS-only authentication cookies.
$env:GALLERY_DATA_DIR = [System.IO.Path]::GetFullPath($DataDirectory)
$env:GALLERY_MAX_UPLOAD_MB = '250'
if (-not (Test-Path -LiteralPath (Join-Path $env:GALLERY_DATA_DIR 'admin.json'))) {
    & node (Join-Path $galleryProjectRoot 'server/gallery/setup.mjs') # Prompts locally for the owner account before starting a new installation.
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& node (Join-Path $galleryProjectRoot 'server/gallery/server.mjs') # Runs in the foreground so a service wrapper can supervise the same entry point.
exit $LASTEXITCODE
