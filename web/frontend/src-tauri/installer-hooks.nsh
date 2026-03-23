; Kill the cockpit-server sidecar and Tauri app before installing.
; Must be aggressive: Windows holds exe file locks until process fully exits.
!macro NSIS_HOOK_PREINSTALL
  ; First pass: kill by image name (covers both sidecar and Tauri app)
  nsExec::ExecToLog 'cmd /c taskkill /f /im cockpit-server-x86_64-pc-windows-msvc.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /im cockpit-server.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /im claude-cockpit.exe 2>nul'
  Sleep 500

  ; Second pass: kill anything listening on port 8420 (the sidecar's API port)
  nsExec::ExecToLog 'cmd /c for /f "tokens=5" %a in ('"'"'netstat -ano ^| findstr :8420 ^| findstr LISTENING'"'"') do taskkill /f /pid %a 2>nul'
  Sleep 500

  ; Third pass: one more taskkill in case something respawned
  nsExec::ExecToLog 'cmd /c taskkill /f /im cockpit-server-x86_64-pc-windows-msvc.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /im claude-cockpit.exe 2>nul'

  ; Wait for file handles to be fully released
  Sleep 2000
!macroend
