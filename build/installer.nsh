; Included in the NSIS installer (electron-builder.yml, nsis.include).

; Electron refuses to start from a folder whose permissions have an entry for an AppContainer package but none for
; ALL APPLICATION PACKAGES (S-1-15-2-1): Windows would deny its sandboxed processes access. Give it read access to the
; install folder, inherited by what it holds, on every install and update (electron-updater runs this installer too).
; Hive checks again at start (src/main/installDir.ts), for a folder changed after installing.
!macro customInstall
  nsExec::Exec '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX)'
  Pop $0
!macroend
