# DiskLens 设计文档

> 磁盘空间分析客户端（Windows / macOS / iOS / Android）
> 原型：c-relocator 项目的 Map-Reloc live map（PowerShell + SSE + Web treemap）。
> 本项目将其产品化：Rust 扫描核心 + Tauri v2 跨端壳 + 移植的 treemap 前端。

## 1. 产品定位

"看清每一寸磁盘"：以 treemap 方块视图实时呈现目录/文件的空间占用，帮助用户定位大文件、
决定迁移与清理。v0.3 起内置 **junction 方式的一键目录迁移**（评估见 §8）：软件做"安全的搬运"，
不做"删除"；无法自动迁移的场景（系统文件、被占用数据）明确指引到对应软件里修改。

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 扫描核心 | Rust（std::fs 递归，后续平台抽象层） | 性能是命根：PS 5.1 扫 C: 需 2-3 分钟，Rust 预期 <30s |
| 客户端壳 | Tauri v2 | 一套代码四端；webview 直接复用已打磨的网页 treemap 前端 |
| 前端 | 原生 HTML/CSS/JS（无框架） | 原型即此形态，交互引擎（squarify/迟滞/折叠/菜单）整体移植 |
| 数据通道 | Tauri 事件（scan-update 流） | 对齐原型的 SSE 设计：增量 flush + 版本推进 + 客户端补间动画 |

## 3. 数据流（对齐原型验证过的设计）

```
Rust DFS worker                       前端 store
  │ read_dir 逐项累计 pending            │ scan-update 事件
  │ flush: 32MB / 400项 / 250ms 触发 ──→ │ applyEvent: upsert 节点
  │ 目录完成推 done 事件                 │ dirty 标记 → rAF 渲染
  │                                     │ squarify(稳定排序+12%迟滞)
  └──────── 单次扫描即树本身 ←──────────┘ 面积折叠/形状检测/剩余条
```

- **单次扫描即树**：原型中"展开触发子树独立重扫、与根 DFS 抢 IO"的架构缺陷，
  在客户端里天然消除——扫描产出就是树，前端 store 是唯一事实源。
- **跳过 reparse point**（junction/symlink 计 0）：不成环、不重复计数。
- **deny 目录**：System Volume Information / $WinREAgent / recovery。

## 4. 前端交互（已从原型完整移植）

- squarify 布局 + **排序迟滞**（超相邻 12% 才换位）+ 0.35s CSS 补间 → 逐步长大不跳变
- **两道防细条**：面积 <180px² 折叠；布局后形状检测（最小边 <5px 或长宽比 >7）
  并入底部灰色"剩余N项（极小/未扫完）"聚合条（高度按占比 18px~40%）
- **单击展开/收起**（嵌套 treemap，兄弟保持可见）、**双击进入**、⬅返回 / Backspace / Esc
- **客户端风格右键菜单**：路径表头 + 图标项（打开/复制路径/进入/展开），mousedown 捕获关闭
- **语义色**：目录多彩、文件统一灰、聚合块深灰、counting 块流动斜纹+琥珀标签
- 多层展开标签条：深底 + 金色下划线 + 每层 12px 递进缩进

## 5. 平台矩阵与路线

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows | **M1 本机开发** | 全链路闭环；后续可选 NTFS MFT 直读加速 |
| Android | M2 | 需 Android SDK/NDK（`npm run tauri android init`）；经 SAF/MediaStore，
  实际可见范围受系统限制（MANAGE_EXTERNAL_STORAGE 政策收紧，按 SAF 设计） |
| macOS | M3 | GitHub Actions CI 构建（本地无 macOS）；目录遍历权限同 App Sandbox |
| iOS | M4 | 需 macOS + Xcode + Apple 开发者账号；系统沙盒下只能分析 Files 可见范围，
  产品形态定位为"应用沙盒 + 用户选取目录"的分析 |

移动端与桌面端的能力差异是**操作系统决定**的：桌面端全盘遍历，移动端按系统授权范围。
前端 treemap 与交互在所有端保持一致。

## 6. 里程碑

- **M1（当前）**：Windows 可用——扫描 C:\ 任意目录、treemap 全交互、事件流式渲染
- **M2**：性能（并行遍历 / 可选 MFT）、过滤规则（deny 可配置）、体积缓存（秒开）
- **M3**：Android 端（SAF 适配）
- **M4**：macOS/iOS（CI 构建 + 沙盒适配）
- **M5**：可视化增强（历史对比、清理建议联动 c-relocator）

## 7. 开发

```
npm install
npm run tauri dev      # Windows 桌面（Rust 真实扫描）
npm run dev            # 浏览器模式（合成数据，无需 Rust，UI 迭代用）
cargo check            # 后端类型检查（在 src-tauri/ 下）
```

浏览器模式与 Tauri 模式共享同一套事件协议（`scan-update` / `scan-finished` / `migrate-update`），
前端通过 `window.__TAURI__` 自动探测运行环境。

### Windows 工具链说明（windows-gnu 目标）

`stable-x86_64-pc-windows-gnu` 目标需要完整 GNU binutils（as/dlltool/windres），
且 dlltool/as 必须**支持 x86_64**（老版 32 位 MinGW 不行，报 "no compiled in support for x86_64"）。
推荐二选一：

1. **MSVC 目标**（推荐）：`rustup default stable-x86_64-pc-windows-msvc` + VS BuildTools（含 Windows SDK）
2. **GNU 目标**：确保 PATH 中有 64 位 binutils（如 [w64devkit](https://github.com/skeeto/w64devkit)）

桌面端构建 `crate-type` 只保留 `["rlib"]`：cdylib 会让 GNU ld 因导出符号过多而失败
（"export ordinal too large"）；做 Android/iOS 时再加回 staticlib/cdylib（MSVC 无此限制）。

## 8. 迁移功能评估（v0.3，junction 方式）

### 8.1 原理

把 `C:\大目录` 的内容搬到 `E:\大目录`，然后在原位置创建 **NTFS junction**（目录联接）指向新位置。
junction 对应用完全透明——程序仍按旧路径读写，数据实际落在新盘。**免管理员权限**。

已实证验证（本机 C:→E: 跨卷实测）：

| 验证项 | 结论 |
|---|---|
| 跨卷 junction（C: → E:） | ✅ mklink /J 成功，无需管理员 |
| 读写透明 | ✅ 旧路径读写、子目录（含空格名）全部正常 |
| 删除 junction | ✅ `rmdir` 只删链接，目标数据完好 |
| 被占用文件 | ✅ 删除报错、源保持原样；锁释放后即可继续 → 三阶段事务可行 |

### 8.2 能一键迁移的（软件自动完成）

- 普通用户目录 / 数据目录 / 构建缓存（node_modules、.cargo、target 等）——junction 对程序透明
- **同卷迁移走快速路径**：rename 瞬时完成 + 建链接，无数据搬移
- 跨卷走**三阶段事务**：`copy`（断点续传：同名同大小跳过）→ `verify`（对账：文件数与字节数）
  → `switch`（删源内容 → 建链接）。任何一步失败/被停止，源目录保持原样，数据永远在两侧之一，
  重试自动续传。

### 8.3 不能一键迁移的（对话框给出「去软件里改」指引）

| 场景 | 原因 | 用户操作 |
|---|---|---|
| pagefile/swapfile.sys | 系统虚拟内存 | 系统属性 → 高级 → 性能设置 → 虚拟内存 |
| hiberfil.sys | 休眠文件 | `powercfg /h /size 50` 或关闭休眠 |
| Docker 数据盘（ext4.vhdx） | 程序写死路径 | Docker Desktop → Settings → Resources |
| WSL 发行版 | 注册表+vhdx 绑定 | `wsl --export / --import` |
| WindowsApps | TrustedInstaller ACL | 设置 → 应用 → 移动 |
| OneDrive / Steam 库 | 程序有自管理迁移 | 各自软件内"更改位置/移动" |
| 文件被占用 | 句柄未释放 | 关闭程序后重试；写死的去软件里改 |

### 8.4 硬性拦截（预检 blockers）

盘根 / `C:\Windows` / deny 目录 / 源已是链接 / 源内嵌套链接 / 目标在源内 / 目标已存在 /
目标空间不足 / 非本地盘符路径。`Program Files`、`ProgramData` 给出警告不拦截（junction 对
程序透明，但自更新类软件可能异常）。

### 8.5 已知限制

- 迁移期间修改目录内容会被 verify 阶段拦下（数据无损，重试即可）
- 不复制 NTFS ACL（复制的是数据+属性+时间戳；目标继承目标卷默认 ACL）
- 目标卷为 FAT32 时有单文件 4GB 上限（给出警告）
- 超长路径（>260 字符）为已知限制
