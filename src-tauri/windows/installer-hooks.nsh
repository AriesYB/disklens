; DiskLens NSIS 安装/卸载钩子（经 bundle > windows > nsis > installerHooks 接入）。
; 卸载彻底清理：应用数据目录（扫描缓存 / AI 联动令牌 / 提案记录 / 诊断日志）
; ——360 软件管家审核要求"卸载彻底、干净，不留残余"。
; 注意：卸载即清空数据不可恢复（包括诊断日志），这是有意的审核合规取舍。

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri app_data_dir = %APPDATA%\<identifier>（identifier = com.disklens.app）
  RMDir /r "$APPDATA\com.disklens.app"
!macroend
