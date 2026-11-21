# Builds a Tizen app, signs it with the active certificate profile, installs
# it on the TV and launches it.
#
#   tizen\scripts\deploy.ps1 [-App app] [-Tv 10.0.0.125] [-Debug]
#
# -App app   the real app (tizen\app): bundled by its build.mjs first
# -App poc   the AVPlay proof-of-concept (tizen\poc)
# -Debug     launches with the web inspector on; prints its port
#
# Expects the Tizen SDK next to the repo (..\sdk\tizen) and a Samsung
# certificate profile made in its Certificate Manager (see tizen\README.md).
param(
  [string]$App = 'app',
  [string]$Tv = '10.0.0.125',
  [string]$Profile = 'FireIO',
  [switch]$Debug
)
$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$sdk = Resolve-Path (Join-Path $repo '..\sdk\tizen')
$tizen = Join-Path $sdk 'tools\ide\bin\tizen.bat'
$sdb = Join-Path $sdk 'tools\sdb.exe'
$source = Join-Path $repo "tizen\$App"
$device = "${Tv}:26101"

if (Test-Path (Join-Path $source 'build.mjs')) {
  Push-Location $source
  try {
    if (-not (Test-Path 'node_modules')) { npm install --no-audit --no-fund | Out-Null }
    node build.mjs
    if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  } finally { Pop-Location }
  $appDir = Join-Path $source 'build'
} else {
  # The proof-of-concept reads the addon list from a generated local file.
  node (Join-Path $repo 'tizen\scripts\make-local-config.mjs') $App
  $appDir = $source
}

[xml]$config = Get-Content (Join-Path $appDir 'config.xml')
$appId = $config.widget.application.id
$pkgId = $config.widget.application.package

Get-ChildItem $appDir -Filter *.wgt | Remove-Item
& $tizen package -t wgt -s $Profile -- $appDir | Out-Null
# The TV's installer fails on a package file name containing spaces.
$wgt = Get-ChildItem $appDir -Filter *.wgt | Select-Object -First 1
if (-not $wgt) { throw 'packaging failed' }
$target = Join-Path $appDir "$pkgId.wgt"
if ($wgt.FullName -ne $target) { Move-Item -Force $wgt.FullName $target }

& $sdb connect $device | Out-Null
& $sdb -s $device push $target "/home/owner/share/tmp/sdk_tools/tmp/$pkgId.wgt" | Out-Null
& $sdb -s $device shell 0 vd_appinstall $pkgId "/home/owner/share/tmp/sdk_tools/tmp/$pkgId.wgt" |
  Select-String 'install (completed|failed)'

& $sdb -s $device shell 0 was_kill $pkgId | Out-Null
if ($Debug) {
  # Prints the inspector port; forward it with `sdb forward tcp:<port> tcp:<port>`.
  & $sdb -s $device shell 0 debug $appId
} else {
  & $tizen run -p $appId -s $device | Select-String 'launched'
}
