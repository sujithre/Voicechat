$port = if ($env:PORT) { [int]$env:PORT } else { 3001 }
$processIds = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

if (-not $processIds) {
    Write-Host "No server is listening on port $port."
    exit 0
}

$stoppedProcessIds = @()
$failedProcessIds = @()

foreach ($processId in $processIds) {
    try {
        Stop-Process -Id $processId -Force -ErrorAction Stop
        $stoppedProcessIds += $processId
    }
    catch {
        $failedProcessIds += $processId
        Write-Error "Could not stop PID $processId on port $port. Run this command from an elevated terminal, or stop the terminal that started the server. $($_.Exception.Message)"
    }
}

if ($stoppedProcessIds) {
    Write-Host "Stopped process(es) listening on port ${port}: $($stoppedProcessIds -join ', ')"
}

if ($failedProcessIds) {
    exit 1
}