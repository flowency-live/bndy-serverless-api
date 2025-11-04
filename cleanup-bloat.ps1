# Cleanup Lambda Directory Bloat
# Created: 2025-11-04
# IMPORTANT: Run download-all-baselines.ps1 FIRST!

$ErrorActionPreference = "Stop"

Write-Host "=== Lambda Directory Cleanup ===" -ForegroundColor Cyan
Write-Host ""

# Safety check
if (-not (Test-Path "_production_baselines\BASELINE_INFO.md")) {
    Write-Host "ERROR: Production baselines not found!" -ForegroundColor Red
    Write-Host "Run download-all-baselines.ps1 first to create safety backup" -ForegroundColor Yellow
    exit 1
}

Write-Host "✓ Production baselines verified" -ForegroundColor Green
Write-Host ""

# Count before cleanup
$zipCount = (Get-ChildItem -Path . -Filter "*.zip" -File | Measure-Object).Count
$backupDirs = @(
    "auth-lambda-backup-*",
    "auth-lambda-backups",
    "auth-lambda-deployed",
    "auth-lambda-deployed-temp",
    "invites-lambda-current-check",
    "invites-lambda-deployed"
)

Write-Host "Found $zipCount zip files in root" -ForegroundColor Gray
Write-Host ""

# Archive migration scripts
Write-Host "[1/4] Archiving migration scripts..." -NoNewline
$archiveDir = "scripts\archive"
if (-not (Test-Path $archiveDir)) {
    New-Item -ItemType Directory -Path $archiveDir | Out-Null
}

$migrationScripts = @(
    "migrate-songs-complete.js",
    "check-firestore-song.js",
    "list-firestore-collections.js",
    "migration-log.txt"
)

foreach ($script in $migrationScripts) {
    if (Test-Path $script) {
        Move-Item -Path $script -Destination $archiveDir -Force
    }
}
Write-Host " DONE" -ForegroundColor Green

# Delete zip files (keep only _production_baselines/)
Write-Host "[2/4] Deleting zip files..." -NoNewline
$deleted = 0
Get-ChildItem -Path . -Filter "*.zip" -File | ForEach-Object {
    Remove-Item $_.FullName -Force
    $deleted++
}
$msg = " DONE ($deleted)"
Write-Host $msg -ForegroundColor Green

# Delete backup directories
Write-Host "[3/4] Deleting backup directories..." -NoNewline
$dirDeleted = 0
foreach ($pattern in $backupDirs) {
    Get-ChildItem -Path . -Directory -Filter $pattern | ForEach-Object {
        Remove-Item $_.FullName -Recurse -Force
        $dirDeleted++
    }
}
$msg = " DONE ($dirDeleted)"
Write-Host $msg -ForegroundColor Green

# Clean up root-level test files
Write-Host "[4/4] Cleaning test files..." -NoNewline
$testFiles = @("test.json", "lambda-test.json", "songs-list.json")
$testDeleted = 0
foreach ($file in $testFiles) {
    if (Test-Path $file) {
        Remove-Item $file -Force
        $testDeleted++
    }
}
$msg = " DONE ($testDeleted)"
Write-Host $msg -ForegroundColor Green

Write-Host ""
Write-Host "=== Cleanup Complete ===" -ForegroundColor Cyan
Write-Host "Deleted:" -ForegroundColor Gray
Write-Host "  - $deleted zip files" -ForegroundColor Gray
Write-Host "  - $dirDeleted backup directories" -ForegroundColor Gray
Write-Host "  - $testDeleted test files" -ForegroundColor Gray
Write-Host "Archived:" -ForegroundColor Gray
Write-Host "  - $($migrationScripts.Length) migration scripts → scripts\archive\" -ForegroundColor Gray
Write-Host ""

# Verify essential directories still exist
Write-Host "Verifying Lambda directories..." -ForegroundColor Yellow
$lambdaDirs = @(
    "auth-lambda",
    "artist-songs-lambda",
    "artists-lambda",
    "events-lambda",
    "invites-lambda",
    "issues-lambda",
    "memberships-lambda",
    "setlists-lambda",
    "songs-lambda",
    "uploads-lambda",
    "users-lambda",
    "venues-lambda",
    "events-agent-lambda",
    "spotify-lambda"
)

$allGood = $true
foreach ($dir in $lambdaDirs) {
    if (Test-Path $dir) {
        $handlerExists = (Test-Path "$dir\handler.js") -or (Test-Path "$dir\index.js")
        if ($handlerExists) {
            Write-Host "  ✓ $dir" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ $dir (no handler found)" -ForegroundColor Yellow
            $allGood = $false
        }
    } else {
        Write-Host "  ✗ $dir (missing)" -ForegroundColor Red
        $allGood = $false
    }
}

Write-Host ""
if ($allGood) {
    Write-Host "All Lambda directories verified ✓" -ForegroundColor Green
} else {
    Write-Host "Some Lambda directories need attention" -ForegroundColor Yellow
    Write-Host "You can restore from baselines if needed:" -ForegroundColor Gray
    Write-Host "  Expand-Archive -Path _production_baselines\[lambda]-BASELINE.zip -DestinationPath [lambda]\ -Force" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Review directory structure" -ForegroundColor Gray
Write-Host "2. Update .gitignore" -ForegroundColor Gray
Write-Host "3. Commit clean state to git" -ForegroundColor Gray
Write-Host "4. Update team documentation" -ForegroundColor Gray
