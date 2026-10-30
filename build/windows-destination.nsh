!ifndef HARBOR_WINDOWS_DESTINATION_INCLUDED
!define HARBOR_WINDOWS_DESTINATION_INCLUDED
!include LogicLib.nsh
!include FileFunc.nsh

Var harborDestinationError

!macro HarborCheckPerUserRoot ROOT
  GetFullPathName $1 "${ROOT}"
  StrLen $2 $1
  StrCpy $3 $0 $2
  ${If} $3 == $1
    StrCpy $3 $0 1 $2
    ${If} $3 == ""
    ${OrIf} $3 == "\"
      StrCpy $harborDestinationError "protected"
    ${EndIf}
  ${EndIf}
!macroend

; Check the effective destination before touching an existing installation.
; A probe tests the nearest existing directory without creating a target tree.
; This is a preflight, not a guarantee against later ACL changes or file locks.
Function HarborCheckDestination
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $harborDestinationError ""
  ClearErrors
  ; NSIS GetFullPathName also looks up the final component and can reject
  ; missing paths. Win32 normalization must allow a not-yet-created target;
  ; the ancestor walk below checks its actual filesystem accessibility.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i .r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
  ${OrIf} $0 == ""
    StrCpy $harborDestinationError "unwritable"
    Goto harbor_destination_done
  ${EndIf}
  ${If} $installMode == "CurrentUser"
    !insertmacro HarborCheckPerUserRoot "$PROGRAMFILES"
    !insertmacro HarborCheckPerUserRoot "$PROGRAMFILES32"
    !insertmacro HarborCheckPerUserRoot "$PROGRAMFILES64"
    ${If} $harborDestinationError != ""
      Goto harbor_destination_done
    ${EndIf}
  ${EndIf}

  ; Walk only upward; never create directories or alter ACLs during validation.
  harbor_destination_parent:
    IfFileExists "$0\*.*" harbor_destination_probe
    ${If} ${FileExists} "$0"
      StrCpy $harborDestinationError "unwritable"
      Goto harbor_destination_done
    ${EndIf}
    ${GetParent} "$0" $1
    ; FileFunc returns C: for the parent of C:\Harbor. Probe the drive root,
    ; not that drive's current working directory.
    StrLen $2 $1
    ${If} $2 == 2
      StrCpy $3 $1 1 1
      ${If} $3 == ":"
        StrCpy $1 "$1\"
      ${EndIf}
    ${EndIf}
    ${If} $1 == ""
    ${OrIf} $1 == $0
      StrCpy $harborDestinationError "unwritable"
      Goto harbor_destination_done
    ${EndIf}
    StrCpy $0 $1
    Goto harbor_destination_parent

  harbor_destination_probe:
    ; GetTempFileName reserves a unique empty file; delete only that file.
    ClearErrors
    GetTempFileName $1 "$0"
    ${If} ${Errors}
      StrCpy $harborDestinationError "unwritable"
    ${Else}
      Delete "$1"
      ${If} ${Errors}
        StrCpy $harborDestinationError "unwritable"
      ${EndIf}
    ${EndIf}
  harbor_destination_done:
  ClearErrors
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif
