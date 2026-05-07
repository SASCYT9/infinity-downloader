# Local-network setup helper. Run once from the repo root:
#   powershell -ExecutionPolicy Bypass -File .\setup-local.ps1
#
# What it does:
#   1. Detects your Wi-Fi LAN IP
#   2. Writes .env.local + .env (for docker compose) with that IP
#   3. Starts Cobalt in Docker on :9000
#   4. Starts Next.js bound to 0.0.0.0:3000 so phones on the same Wi-Fi can reach it
#
# Stop with Ctrl+C. To stop Cobalt later: `docker compose down`.

$ErrorActionPreference = "Stop"

Write-Host "[1/4] Detecting LAN IP..." -ForegroundColor Cyan
$wifi = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -ne "127.0.0.1" } |
    Select-Object -First 1

if (-not $wifi) {
    # Fall back to any non-loopback IPv4 with a default gateway
    $wifi = Get-NetIPConfiguration |
        Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq "Up" } |
        Select-Object -First 1 -ExpandProperty IPv4Address
}

if (-not $wifi) {
    Write-Host "  Could not detect Wi-Fi IP. Check 'ipconfig' and edit .env.local manually." -ForegroundColor Red
    exit 1
}

$lanIp = $wifi.IPAddress
Write-Host "  Found: $lanIp" -ForegroundColor Green

Write-Host "[2/4] Writing .env.local and .env..." -ForegroundColor Cyan
$envLocal = @"
LAN_IP=$lanIp
COBALT_INSTANCE_URL=http://localhost:9000
COBALT_API_URL=http://${lanIp}:9000/
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_USE_LOCAL_ENGINE=false
"@
$envLocal | Set-Content -Path ".env.local" -Encoding utf8

# docker compose reads .env from the same directory
"COBALT_API_URL=http://${lanIp}:9000/" | Set-Content -Path ".env" -Encoding utf8

Write-Host "[3/4] Starting Cobalt in Docker..." -ForegroundColor Cyan
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Docker compose failed. Is Docker Desktop running?" -ForegroundColor Red
    exit 1
}

# Probe Cobalt readiness
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:9000/" -Method GET -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
if ($ready) {
    Write-Host "  Cobalt up at http://localhost:9000" -ForegroundColor Green
} else {
    Write-Host "  Cobalt not responding yet. Continuing anyway." -ForegroundColor Yellow
}

Write-Host "[4/4] Starting Next.js on http://${lanIp}:3000" -ForegroundColor Cyan
Write-Host "  From your phone (same Wi-Fi): http://${lanIp}:3000" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop. Cobalt keeps running — stop it with: docker compose down" -ForegroundColor Yellow
Write-Host ""

# Bind dev server to 0.0.0.0 so other devices on the LAN can connect
$env:HOSTNAME = "0.0.0.0"
npx next dev --hostname 0.0.0.0 --port 3000
