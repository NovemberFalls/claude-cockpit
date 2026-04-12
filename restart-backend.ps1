# Restart the Claude Cockpit backend
$port = 8420
$procId = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($procId) {
    Stop-Process -Id $procId -Force
    Write-Host "Killed PID $procId on port $port"
    Start-Sleep -Milliseconds 500
} else {
    Write-Host "No process on port $port"
}
Set-Location "$PSScriptRoot\web"
Start-Process -FilePath "python" -ArgumentList "server.py" -NoNewWindow
Write-Host "Backend started"
