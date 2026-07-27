; 区域身份参数化:本文件不再硬编码 Cindy 字面量,
; 一律走 electron-builder 在 common.nsh 里注入的宏——
;   ${APP_EXECUTABLE_FILENAME} = <productName>.exe(CindyMeka*.exe)
;   ${PRODUCT_FILENAME}        = productName(CindyMeka*)
;   ${SHORTCUT_NAME}           = forge.config nsis.shortcutName(与 exe 基名同源)
; Cindy Meka 的 cn/global/dev 文件名按区域派生，安装器只处理本区域身份。
!macro customInit
  ; Check if the app is already running
  check_running:
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
        "${PRODUCT_FILENAME} 正在运行，请先关闭后再继续安装。$\n$\n点击「确定」将在关闭后继续。" \
        IDOK kill_app
      Abort
      kill_app:
        nsProcess::_KillProcess "${APP_EXECUTABLE_FILENAME}"
        Sleep 1000
        Goto check_running
    ${EndIf}

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

!macro customInstall
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

!macro customUnInstall
  ; 卸载时清理本产品自己的快捷方式(不碰并存的老 XDMaker / 另一区域安装)
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}\${SHORTCUT_NAME}.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"
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
