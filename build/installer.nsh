!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AddToFolderminalApp"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\AddToFolderminalApp"
!macroend
