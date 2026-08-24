$ErrorActionPreference = "Continue"
cmd /c "taskkill /F /IM java.exe" | Out-Null
Start-Sleep 3
# single clean instance, detached properly via WMI so it survives this shell
$wd = Join-Path $PSScriptRoot ""
$jar = Join-Path $wd "target\debug-client-1.0.0.jar"
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "java -jar `"$jar`""
  CurrentDirectory = $wd
} | Out-Null
$deadline = (Get-Date).AddSeconds(45)
do {
  Start-Sleep 3
  try { $r = Invoke-RestMethod 'http://127.0.0.1:8083/api/debug/ping' -TimeoutSec 2 } catch { $r = $null }
} until (($r -and $r.ok) -or ((Get-Date) -gt $deadline))
if ($r -and $r.ok) { Write-Host "CLIENT UP" } else { Write-Host "CLIENT DOWN"; exit 1 }
