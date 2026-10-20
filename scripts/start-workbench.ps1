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
$cli = Join-Path $coreRoot 'apps/cli/lib/bin.js'
if (-not $DshHome) { $DshHome = Join-Path $workspaceRoot 'runtime/dev/bkms-workbench/dsh-home' }
$DshHome = [IO.Path]::GetFullPath($DshHome)
if ($Profile -notmatch '^[a-zA-Z0-9_-]+$' -or $Profile -in @('web','desktop','headless','sdk','sdk-minimal','acp')) { throw 'Use an independent custom Profile name.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be 1024..65535.' }
if (-not (Test-Path -LiteralPath $cli)) { throw 'Build the mapped DSH core first: apps/cli/lib/bin.js is missing.' }
# Mail (IMAP/SMTP, drafts) is built into the workbench; the separate dsh-email plugin is no longer installed.
# The built-in mail module adds dependencies (imapflow, nodemailer, ...); install them when missing.
$needsInstall = -not (Test-Path (Join-Path $pluginRoot 'node_modules/imapflow'))
if ($Build -or $needsInstall -or -not (Test-Path (Join-Path $pluginRoot 'lib/mail/service.js'))) {
  Push-Location $pluginRoot
  try { if ($needsInstall) { & pnpm install --frozen-lockfile; if ($LASTEXITCODE) { throw 'Dependency installation failed.' } }; & pnpm run build; if ($LASTEXITCODE) { throw 'Workbench build failed.' } } finally { Pop-Location }
}
$env:DSH_HOME = $DshHome
$manifest = Join-Path $DshHome "profiles/$Profile/package.json"
if (-not (Test-Path -LiteralPath $manifest)) {
  & node $cli --profile $Profile --from-default-profile web --help
  if ($LASTEXITCODE) { throw 'Profile initialization failed.' }
}
& node $cli plugin --profile $Profile add $pluginRoot
if ($LASTEXITCODE) { throw 'Local plugin installation failed.' }
Write-Host "Workbench prepared. DSH_HOME=$DshHome; Profile=$Profile" -ForegroundColor Cyan
if (-not $PrepareOnly) { & node $cli --profile $Profile --port $Port; exit $LASTEXITCODE }
