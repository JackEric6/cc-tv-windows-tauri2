!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 +2
  CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\cc-tv-windows-icon-1.0.26.ico" 0

  IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 +2
  CreateShortCut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\cc-tv-windows-icon-1.0.26.ico" 0
!macroend
