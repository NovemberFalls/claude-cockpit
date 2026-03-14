; Kill the cockpit-server sidecar process before installing
!macro NSIS_HOOK_PREINSTALL
  ; Try to kill cockpit-server.exe (the Python sidecar) if it's running
  nsExec::ExecToLog 'taskkill /f /im cockpit-server-x86_64-pc-windows-msvc.exe'
  nsExec::ExecToLog 'taskkill /f /im cockpit-server.exe'
  ; Also kill any claude-cockpit.exe that CheckIfAppIsRunning might have missed
  nsExec::ExecToLog 'taskkill /f /im claude-cockpit.exe'
  ; Give processes time to fully exit
  Sleep 1000
!macroend
