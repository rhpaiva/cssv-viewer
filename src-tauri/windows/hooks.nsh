; The NSIS installer's hooks (bundle.windows.nsis.installerHooks).
;
; Tauri associates .cssv files with the class named after the file
; association ("CSSV table" in tauri.conf.json) and gives it the program's
; icon. Once that is done, the class gets the icon of .cssv files instead,
; which tauri.windows.conf.json installs next to the program, and Explorer
; hears of it. Uninstalling deletes the class, and the icon with the resources.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\CSSV table\DefaultIcon" "" "$INSTDIR\cssv-file.ico"
  !insertmacro UPDATEFILEASSOC
!macroend
