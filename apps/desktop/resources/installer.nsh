; 区域身份参数化:本文件不再硬编码 Cindy 字面量,
; 一律走 electron-builder 在 common.nsh 里注入的宏——
;   ${APP_EXECUTABLE_FILENAME} = <productName>.exe(CindyMeka*.exe)
;   ${PRODUCT_FILENAME}        = productName(CindyMeka*)
;   ${SHORTCUT_NAME}           = forge.config nsis.shortcutName(与 exe 基名同源)
; Cindy Meka 正式版 cn/global 文件名同值（CindyMeka），dev 独立（CindyMekaDev）；
; 安装器只处理本区域身份，dev 安装器绝不误伤同机并存的正式安装。注册表键名
; Windows 大小写不敏感，同名不同大小写视为同一个键，行为零变化。
; 同级 include 必须走 ${__FILEDIR__}:NSIS 解析相对 !include 只看 makensis 的
; 工作目录、!addincludedir 列表和 NSISDIR\Include,不看「包含它的文件所在目录」;
; 而生产打包时 app-builder-lib 只把 buildResourcesDir 加进 !addincludedir
; (NsisTarget.js addIncludeDir(packager.info.buildResourcesDir)),本仓没有
; apps/desktop/build,于是裸文件名在生产会 could not find——0.0.22 的
; Windows 发布就是这样挂在第 9 行的。加目录前缀会重新依赖调用方,别退回裸名。
!include "${__FILEDIR__}\winget-shortcuts.nsh"
!include "${__FILEDIR__}\installer-directory.nsh"

!ifndef BUILD_UNINSTALLER
!macro customInit
  !insertmacro cindyDirectoryInit
!macroend

; Run only after the directory preflight, immediately before replacing the app.
; The upstream install section skips this hook in elevated inner instances;
; cindyDirectoryBeforeInstall invokes it for those instances instead.
!macro customCheckAppRunning
  ; Check if the app is already running
  check_running:
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
        "${PRODUCT_FILENAME} 正在运行，请先关闭后再继续安装。$\n$\n点击「确定」将在关闭后继续。" \
        /SD IDCANCEL IDOK kill_app
      SetErrorLevel 1602
      Quit
      kill_app:
        nsProcess::_KillProcess "${APP_EXECUTABLE_FILENAME}"
        Sleep 1000
        Goto check_running
    ${EndIf}

  ${If} ${isUpdated}
    ; winget passes --updated. Preserve existing links across old uninstallers,
    ; which deleted them even when electron-builder passed --keep-shortcuts.
    !insertmacro cindyBackupUpgradeShortcuts
  ${Else}
  ; 删旧快捷方式：老 .lnk 里 IconLocation 仍指向上一版 exe 的资源索引，
  ; 新版 .ico 内多尺寸顺序/数量变化后那个索引会落到另一张图。
  ; 让 NSIS 在后续步骤中重建 .lnk，新的 IconLocation 自然指向当前 exe 的索引 0。
  ; ⚠️ 只清理本产品(本区域身份)自己的快捷方式——同机可能并存老 XDMaker 安装
  ; 或另一区域的 Cindy 安装,它们的 .lnk 指向别的 exe,不属于本安装器,绝不能删。
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}\${SHORTCUT_NAME}.lnk"

  ; 同步清掉 PinnedTaskbar 里的副本（任务栏固定项也会缓存图标）
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"
  ${EndIf}

  ; Cindy Meka 首装接管旧 XDMaker Meka 快捷方式。仅 cn 身份清理旧名，
  ; 避免 global/dev 跨区域误删。
  StrCmp "${PRODUCT_FILENAME}" "CindyMeka" 0 meka_legacy_shortcuts_done_init
  Delete "$DESKTOP\xdmaker-meka.lnk"
  Delete "$SMPROGRAMS\xdmaker-meka.lnk"
  Delete "$SMPROGRAMS\xdmaker-meka\xdmaker-meka.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\xdmaker-meka.lnk"
  Delete "$DESKTOP\XDMaker Meka.lnk"
  Delete "$SMPROGRAMS\XDMaker Meka.lnk"
  Delete "$SMPROGRAMS\XDMaker Meka\XDMaker Meka.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\XDMaker Meka.lnk"
  meka_legacy_shortcuts_done_init:
!macroend
!endif

!macro customInstall
  ${If} ${isUpdated}
    !insertmacro cindyRestoreUpgradeShortcuts
  ${EndIf}
  ; 注册文件夹右键菜单 "通过 <区域名> 打开" (与 main/folderContextMenu.ts 写的是同一组键)。
  ; 双重保险:installer 写一次让首装即可用, app 启动时的 registerFolderContextMenu()
  ; 也会校验+修复, 覆盖 "升级后路径漂移" / "组策略清掉注册表" 等场景。
  ;
  ; 用 HKCU 不用 HKLM:不需要管理员权限, 多用户机器上每个用户启动 app 时自注册。
  ; %V 在 Directory\shell / Directory\Background\shell 两种上下文里都解析为
  ; "用户右键所在的目录" 路径, argv 直传不做 URL 编解码 (deep link 走 cindy-meka:// 另一套)。
  ; 键名用 ${PRODUCT_FILENAME}(区域身份):cn 'CindyMeka',global
  ; 'CindyMekaGlobal',dev 'CindyMekaDev'——双装时菜单项并存互不覆盖,
  ; 也与老 XDMaker 安装的 xdt-maker 键并存。
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCT_FILENAME}" "" "通过 ${PRODUCT_FILENAME} 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCT_FILENAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCT_FILENAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-folder "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_FILENAME}" "" "通过 ${PRODUCT_FILENAME} 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_FILENAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_FILENAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-folder "%V"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\${PRODUCT_FILENAME}" "" "通过 ${PRODUCT_FILENAME} 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\${PRODUCT_FILENAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\${PRODUCT_FILENAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-share-file "%1"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\${PRODUCT_FILENAME}" "" "通过 ${PRODUCT_FILENAME} 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\${PRODUCT_FILENAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\${PRODUCT_FILENAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-share-file "%1"'

  ; 广播 SHCNE_ASSOCCHANGED 让 Explorer 失效图标缓存，新图标无需注销/重启就能生效
  ; 0x08000000 = SHCNE_ASSOCCHANGED, 0 = SHCNF_IDLIST
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

; Electron registers the per-user login item under the executable basename.
; Upgrades invoke the old uninstaller too: preserve both registration and the
; user's StartupApproved state. Only remove entries owned by this install path.
!macro cindyRemoveLoginItemOnUninstall
  ${IfNot} ${isUpdated}
    Push $R0
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_FILENAME}"
    ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    ${OrIf} $R0 == '$INSTDIR\${APP_EXECUTABLE_FILENAME}'
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_FILENAME}"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCT_FILENAME}"
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend

!macro customUnInstall
  !insertmacro cindyRemoveLoginItemOnUninstall
  ; Only --keep-shortcuts opts out: manual reinstall still uses its old cleanup
  ; path, although electron-builder also passes --updated to that uninstaller.
  ${IfNot} ${isKeepShortcuts}
  ; 卸载时清理本产品自己的快捷方式(不碰并存的老 XDMaker / 另一区域安装)
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}\${SHORTCUT_NAME}.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"
  ${EndIf}
  ; 清理右键菜单注册表项 (子键 \command 必须先删 / 用 DeleteRegKey 整树删)。
  ; 老版本 (未引入此功能) 这两条键不存在, DeleteRegKey 静默 no-op 不抛错。
  DeleteRegKey HKCU "Software\Classes\Directory\shell\${PRODUCT_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\${PRODUCT_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\${PRODUCT_FILENAME}"

  ; 只在卸载 cn/Cindy Meka 身份时清理自己的 ProgID；若旧 XDMaker Meka
  ; 仍安装则恢复其 handler，不把另一个应用留下的可用关联一并删除。
  StrCmp "${PRODUCT_FILENAME}" "CindyMeka" 0 meka_file_assoc_done
  ReadRegStr $R0 HKCU "Software\Classes\.cindy" ""
  ${If} $R0 == "CindyMeka.CindyGhost"
    ReadRegStr $R1 HKCU "Software\Classes\XDMakerMeka.CindyGhost\shell\open\command" ""
    ${If} $R1 != ""
      WriteRegStr HKCU "Software\Classes\.cindy" "" "XDMakerMeka.CindyGhost"
    ${Else}
      DeleteRegValue HKCU "Software\Classes\.cindy" ""
    ${EndIf}
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.cindy\OpenWithProgIds" "CindyMeka.CindyGhost"
  DeleteRegKey /ifempty HKCU "Software\Classes\.cindy\OpenWithProgIds"
  DeleteRegKey HKCU "Software\Classes\CindyMeka.CindyGhost"
  meka_file_assoc_done:
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

; Runs before removing files, including the old-version uninstall during upgrade.
; Never leave a SYSTEM service referring to a removed or partially updated image.
!macro customUnInit
  IfFileExists "$INSTDIR\resources\tools\remote-desktop\cindy-windows-desktop-host.exe" 0 cindy_remote_service_done
  nsExec::ExecToStack '"$INSTDIR\resources\tools\remote-desktop\cindy-windows-desktop-host.exe" --uninstall'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    ; Per-user uninstallers may lack service permissions. Keep the direct path
    ; first so missing services (including ordinary per-user installs) need no UAC.
    nsExec::ExecToStack '"$INSTDIR\resources\tools\remote-desktop\cindy-windows-desktop-host.exe" --elevate-uninstall'
    Pop $R0
    Pop $R1
  ${EndIf}
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Could not stop the Cindy remote desktop service. Run the uninstaller as administrator and try again."
    Abort
  ${EndIf}
  cindy_remote_service_done:
!macroend
