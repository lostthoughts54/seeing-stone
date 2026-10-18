; Default to a per-user installation so updates need no elevation helper.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Written only by a completed per-user NSIS installation. An explicit
; /allusers installation remains manually upgradable, without a broken updater.
!macro customInstall
  FileOpen $0 "$INSTDIR\resources\seeing-stone-install-type" w
  ${If} $installMode == "CurrentUser"
    FileWrite $0 "nsis"
  ${Else}
    FileWrite $0 "nsis-machine"
  ${EndIf}
  FileClose $0
!macroend
