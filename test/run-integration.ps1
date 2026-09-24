# Runs test/integration in a separate, throw-away VS Code instance (own profile and
# extensions folder, fixture Claude config). Your normal VS Code setup is not touched.
param(
  [string]$WorkDir = (Join-Path $env:TEMP ("ccg-itest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))),
  [string]$Code = (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
  # Optional: a Claude Code .vsix to install into the test profile (tests opening sessions for real).
  [string]$ClaudeVsix = '',
  [int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
$ext = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force $WorkDir | Out-Null
$userData = Join-Path $WorkDir 'user-data'
$extensions = Join-Path $WorkDir 'extensions'

if ($ClaudeVsix) {
  $vsix = Join-Path $WorkDir 'claude-code.vsix'
  Copy-Item $ClaudeVsix $vsix
  $cli = Get-ChildItem (Split-Path -Parent $Code) -Directory | ForEach-Object { Join-Path $_.FullName 'resources\app\out\cli.js' } | Where-Object { Test-Path $_ } | Select-Object -First 1
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $Code $cli --user-data-dir $userData --extensions-dir $extensions --install-extension $vsix | Out-String | Write-Output
  Remove-Item Env:ELECTRON_RUN_AS_NODE
}

$env:ELECTRON_RUN_AS_NODE = '1'
$setup = & $Code (Join-Path $PSScriptRoot 'integration\setup.js') $WorkDir | Out-String
Remove-Item Env:ELECTRON_RUN_AS_NODE
$paths = $setup | ConvertFrom-Json

$results = Join-Path $WorkDir 'results.json'
$env:CLAUDE_CONFIG_DIR = $paths.config
$env:CCG_RESULTS = $results
$arguments = @(
  "--extensionDevelopmentPath=`"$ext`"",
  "--extensionTestsPath=`"$(Join-Path $PSScriptRoot 'integration')`"",
  "--user-data-dir=`"$userData`"",
  "--extensions-dir=`"$extensions`"",
  '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window',
  "`"$($paths.workspace)`""
)
$process = Start-Process -FilePath $Code -ArgumentList $arguments -PassThru
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
  Stop-Process -Id $process.Id -Force
  throw "VS Code did not finish within $TimeoutSeconds s"
}
Remove-Item Env:CLAUDE_CONFIG_DIR, Env:CCG_RESULTS

if (-not (Test-Path $results)) { throw "No results were written (exit code $($process.ExitCode))" }
$steps = Get-Content $results -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($s in $steps) {
  if ($s.ok) { Write-Output ("PASS  {0}  ({1} ms)" -f $s.name, $s.ms) }
  else { Write-Output ("FAIL  {0}`n{1}" -f $s.name, $s.error) }
}
$failed = @($steps | Where-Object { -not $_.ok }).Count
Write-Output ("{0} passed, {1} failed (VS Code exit code {2})" -f (@($steps).Count - $failed), $failed, $process.ExitCode)
if ($failed) { exit 1 }
