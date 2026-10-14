param(
  [string]$DshHome,
  [string]$Profile = 'bkms-workbench',
  [int]$Port = 9186,
  [switch]$Build,
  [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $pluginRoot '../../..'))
$coreRoot = Join-Path $workspaceRoot 'sources/deepseek-harness'
$emailRoot = Join-Path $workspaceRoot 'sources/plugins/dsh-email'
$cli = Join-Path $coreRoot 'apps/cli/lib/bin.js'
if (-not $DshHome) { $DshHome = Join-Path $workspaceRoot 'runtime/dev/bkms-workbench/dsh-home' }
$DshHome = [IO.Path]::GetFullPath($DshHome)
if ($Profile -notmatch '^[a-zA-Z0-9_-]+$' -or $Profile -in @('web','desktop','headless','sdk','sdk-minimal','acp')) { throw 'Use an independent custom Profile name.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be 1024..65535.' }
if (-not (Test-Path -LiteralPath $cli)) { throw 'Build the mapped DSH core first: apps/cli/lib/bin.js is missing.' }
if ($Build -or -not (Test-Path (Join-Path $pluginRoot 'lib/client.js'))) {
  Push-Location $emailRoot
  try { & pnpm run build; if ($LASTEXITCODE) { throw 'Email build failed.' } } finally { Pop-Location }
  Push-Location $pluginRoot
  try { & pnpm run build; if ($LASTEXITCODE) { throw 'Workbench build failed.' } } finally { Pop-Location }
}
$env:DSH_HOME = $DshHome
$manifest = Join-Path $DshHome "profiles/$Profile/package.json"
if (-not (Test-Path -LiteralPath $manifest)) {
  & node $cli --profile $Profile --from-default-profile web --help
  if ($LASTEXITCODE) { throw 'Profile initialization failed.' }
}
& node $cli plugin --profile $Profile add $emailRoot $pluginRoot
if ($LASTEXITCODE) { throw 'Local plugin installation failed.' }
Write-Host "Workbench prepared. DSH_HOME=$DshHome; Profile=$Profile" -ForegroundColor Cyan
if (-not $PrepareOnly) { & node $cli --profile $Profile --port $Port; exit $LASTEXITCODE }
