$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceDir = Split-Path -Parent $repoDir
$nodeDir = Join-Path $workspaceDir 'tools\node-v22.22.3-win-x64'
$pnpmCmd = Join-Path $env:APPDATA 'npm\pnpm.cmd'

if (-not (Test-Path $nodeDir)) {
  Write-Error "Node 22 runtime not found: $nodeDir"
  exit 1
}

if (-not (Test-Path $pnpmCmd)) {
  Write-Error "pnpm.cmd not found: $pnpmCmd"
  exit 1
}

$env:PATH = "$nodeDir;$env:PATH"
$env:NEXT_PUBLIC_GATEWAY_OPTIONAL = 'true'

Set-Location $repoDir
& $pnpmCmd dev
exit $LASTEXITCODE
