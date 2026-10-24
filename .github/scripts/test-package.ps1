# Checks a packaged Windows build using only what's inside it.
#   ./.github/scripts/test-package.ps1 "path/to/Chess Review"
param([Parameter(Mandatory)] [string] $Root)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path

foreach ($p in 'Chess Review.exe', 'runtime/node.exe', 'server.js', 'node_modules/chess.js', 'node_modules/chessground',
               'public/index.html', 'public/sounds/wood-1.ogg', 'data/a.tsv', 'LICENSE', 'THIRD_PARTY_NOTICES.md') {
  if (-not (Test-Path (Join-Path $Root $p))) { throw "Package is missing $p" }
}
$sf = Get-ChildItem (Join-Path $Root 'engine') -Recurse -Filter 'stockfish*.exe' | Select-Object -First 1
if (-not $sf) { throw 'Package is missing Stockfish' }
"Contents OK (Stockfish: $($sf.Name), $([math]::Round($sf.Length / 1MB)) MB)"

Push-Location $Root
try {
  $node = Join-Path $Root 'runtime/node.exe'
  "Bundled Node.js: $(& $node --version)"

  & $node scripts/smoke-test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Smoke test failed' }

  $env:CHESS_REVIEW_NO_UPDATE_CHECK = '1'
  $env:PORT = '3123'
  $server = Start-Process $node -ArgumentList 'server.js' -PassThru -NoNewWindow
  $status = $null
  for ($i = 0; $i -lt 60 -and -not $status; $i++) {
    Start-Sleep -Seconds 1
    try { $status = Invoke-RestMethod 'http://localhost:3123/api/status' -TimeoutSec 3 } catch {}
  }
  if (-not $status -or $status.app -ne 'chess-review' -or -not $status.engine.ok) { throw 'Server did not start' }
  "Server OK: v$($status.version), $($status.engine.name)"
  $page = Invoke-WebRequest 'http://localhost:3123/' -UseBasicParsing
  if ($page.Content -notmatch '<title>Chess Review</title>') { throw 'UI was not served' }
  'UI OK'
  Stop-Process -Id $server.Id -Force
} finally {
  Pop-Location
}
