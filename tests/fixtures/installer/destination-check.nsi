Unicode true
!include LogicLib.nsh
Var installMode
!include windows-destination.nsh
Name "Harbor destination checks"
OutFile "${OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
Var report

!macro CheckDestination MODE DEST EXPECTED LABEL
  StrCpy $installMode "${MODE}"
  StrCpy $INSTDIR "${DEST}"
  Call HarborCheckDestination
  ${If} $harborDestinationError != "${EXPECTED}"
    FileWrite $report 'FAIL ${LABEL}: expected [${EXPECTED}], actual [$harborDestinationError], destination [$INSTDIR]$\r$\n'
    FileClose $report
    SetErrorLevel 1
    Quit
  ${EndIf}
  FileWrite $report 'PASS ${LABEL}$\r$\n'
!macroend

Section
  FileOpen $report "$EXEDIR\results.txt" w
  !insertmacro CheckDestination "CurrentUser" "$PROGRAMFILES\Harbor" "protected" "per-user Program Files"
  !insertmacro CheckDestination "CurrentUser" "$PROGRAMFILES32\Harbor" "protected" "per-user Program Files 32"
  !insertmacro CheckDestination "CurrentUser" "$PROGRAMFILES64\Harbor" "protected" "per-user Program Files 64"
  !insertmacro CheckDestination "CurrentUser" "$PROGRAMFILES64" "protected" "protected root itself"
  !insertmacro CheckDestination "CurrentUser" "$PROGRAMFILES64\Other\..\Harbor" "protected" "normalized protected path"
  !insertmacro CheckDestination "CurrentUser" "$EXEDIR\writable" "" "existing writable custom directory"
  !insertmacro CheckDestination "CurrentUser" "$EXEDIR\writable\new\Harbor" "" "new writable custom directory"
  !insertmacro CheckDestination "all" "$EXEDIR\writable" "" "all-users writable directory"
  !insertmacro CheckDestination "CurrentUser" "$EXEDIR\occupied\Harbor" "unwritable" "file in target path"
  !insertmacro CheckDestination "CurrentUser" "$EXEDIR\denied\Harbor" "unwritable" "NTFS write denial"
  FileClose $report
  SetErrorLevel 0
SectionEnd
