; Included by electron-builder; keep its install-mode/elevation/uninstall logic.
!ifndef BUILD_UNINSTALLER
!include nsDialogs.nsh
!macro customHeader
!include windows-destination.nsh
Var harborDestinationMessage

Function HarborDestinationMessage
  ${If} $harborDestinationError == "protected"
    StrCpy $harborDestinationMessage 'Program Files is not a destination for "Only for me". Click Back and choose a folder in your user profile, or choose "Anyone who uses this computer" and approve the Windows administrator prompt.'
    ${If} $LANGUAGE == 1043
      StrCpy $harborDestinationMessage 'Program Files is niet geschikt voor "Alleen voor mij installeren". Klik op Vorige en kies een map in je gebruikersprofiel, of kies installatie voor alle gebruikers en bevestig de Windows-beheerdersprompt.'
    ${EndIf}
  ${Else}
    StrCpy $harborDestinationMessage 'Harbor cannot write to the selected installation folder. Click Back and choose a writable folder. For a system folder, choose installation for all users and approve the Windows administrator prompt.'
    ${If} $LANGUAGE == 1043
      StrCpy $harborDestinationMessage 'Harbor kan niet schrijven naar de gekozen installatiemap. Klik op Vorige en kies een beschrijfbare map. Kies voor een systeemmap installatie voor alle gebruikers en bevestig de Windows-beheerdersprompt.'
    ${EndIf}
  ${EndIf}
FunctionEnd

Function HarborDestinationPage
  ; Mirror the builder's final app-subfolder normalization before checking.
  Call instFilesPre
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  Call HarborCheckDestination
  ${If} $harborDestinationError == ""
    Abort ; Skip this extra page for valid destinations.
  ${EndIf}
  Call HarborDestinationMessage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    MessageBox MB_OK|MB_ICONEXCLAMATION "$harborDestinationMessage"
    SetErrorLevel 5
    Quit
  ${EndIf}
  ${If} $LANGUAGE == 1043
    !insertmacro MUI_HEADER_TEXT "Kies een andere installatiemap" "De huidige installatie is nog niet vervangen."
  ${Else}
    !insertmacro MUI_HEADER_TEXT "Choose another installation folder" "The existing installation has not been replaced."
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 25u "$INSTDIR"
  Pop $0
  ${NSD_CreateLabel} 0 35u 100% 90u "$harborDestinationMessage"
  Pop $0
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 0
  nsDialogs::Show
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
FunctionEnd

Function HarborDestinationLeave
  ; Guard even if the disabled Next button is invoked programmatically.
  Call HarborCheckDestination
  ${If} $harborDestinationError != ""
    Abort
  ${EndIf}
FunctionEnd

!macroend

!macro customPageAfterChangeDir
  Page custom HarborDestinationPage HarborDestinationLeave
!macroend

!macro customInit
  ${If} ${Silent}
    ; A silent per-machine upgrade elevates later in the builder's section.
    ; Its elevated child repeats this check with the correct access token.
    ${If} $installMode == "CurrentUser"
    ${OrIf} ${UAC_IsAdmin}
      Call HarborCheckDestination
      ${If} $harborDestinationError != ""
        Call HarborDestinationMessage
        DetailPrint "$harborDestinationMessage"
        SetErrorLevel 5
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
!endif
