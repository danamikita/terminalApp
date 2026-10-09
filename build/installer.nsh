!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AddToFoldersApp"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\AddToFoldersApp"
!macroend
