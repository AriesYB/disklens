# DiskLens 盘析

> 看清每一寸磁盘 —— 一个开源的磁盘空间分析器：实时 treemap 方块视图 + 排序列表 + 大文件榜。

![platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android%20%7C%20iOS-blue)
![rust](https://img.shields.io/badge/built%20with-Rust%20%2B%20Tauri%202-dea584)
![license](https://img.shields.io/badge/license-MIT-green)

**DiskLens** 用一张实时生长的 treemap 把目录占用画出来：谁在吃你的硬盘，一眼可见。
扫描引擎是 Rust 单次 DFS，扫描过程中方块**渐进生长**、越扫越深，不用等扫完才能看。

<p align="center">
  <img src="docs/screenshot-treemap.png" width="88%" alt="DiskLens treemap 方块视图" />
</p>

## ✨ 特性

- **实时流式渲染** —— Rust 扫描边扫边推（32MB / 400 项 / 250ms 增量 flush），前端补间动画，扫描未结束即可下钻浏览
- **三种视图，各司其职**
  - 🔲 **方块视图**：squarify treemap，面积即体积，单击展开对比、双击进入、右键更多操作
  - 📋 **列表视图**：名称 / 大小表头点击排序，占比条实时反映父目录构成
  - 🏆 **大文件榜**：全盘 ≥1MB 大文件 Top 榜，扫描中实时上榜，一键在资源管理器中定位
- **📦 一键迁移（junction 方式）** —— 右键任意目录迁移到其他盘：预检（空间/占用/系统目录）→
  复制 → 校验 → 切换，原位置创建目录联接，程序无感；同卷秒迁，跨卷断点续传，任何失败源目录原样保留。
  不能自动迁移的（虚拟内存、Docker、WSL、被占用文件等）直接告诉你要去哪个软件里改
- **交互细节打磨**
  - 排序迟滞：方块平滑生长，大小超越相邻 12% 才换位，不跳变
  - 两道防细条：极小项自动折叠为"剩余 N 项"聚合条，杜绝不可读的细条
  - 面包屑导航 + Backspace/Esc 快捷返回 + 右键菜单（打开 / 复制路径 / 进入 / 展开）
  - junction/symlink 计 0：不成环、不重复计数；系统目录（System Volume Information 等）自动跳过

<table>
  <tr>
    <td><img src="docs/screenshot-list.png" alt="列表视图" /></td>
    <td><img src="docs/screenshot-files.png" alt="大文件榜" /></td>
  </tr>
</table>

## 🚀 快速开始

### 下载 exe（Windows）

从 [Releases](https://github.com/AriesYB/disklens/releases) 下载：

- `DiskLens_x.y.z_x64-setup.exe` —— 安装版
- `disklens.exe` —— 免安装单文件版，直接双击运行

> 无需安装任何运行库：Windows 10/11 自带 WebView2，DiskLens 直接可用。

### 从源码运行

```bash
# 前置：Rust (rustup) + Node.js
npm install
npm run tauri dev    # Windows 桌面客户端，真实扫描
npm run dev          # 浏览器模式：合成数据演示，无需 Rust 工具链，UI 迭代用
```

浏览器模式打开 [http://127.0.0.1:5180](http://127.0.0.1:5180) 即自动播放一轮模拟扫描，可体验全部三种视图。

## 📦 打包 exe

```bash
npm run build        # = tauri build
```

产物：

- 免安装单文件：`src-tauri/target/release/disklens.exe`
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/*.exe`

## 🧪 测试

```bash
npm test             # Rust 单元测试（deny 目录匹配、事件序列化等）
cargo check          # 后端类型检查
```

前端交互可在浏览器模式下人工验证：视图切换、表头排序、双击进入、右键菜单、Backspace 返回。

## 🏗️ 架构

```
Rust DFS worker                        前端 store（唯一事实源）
  │ read_dir 递归，跳过 reparse point     │ scan-update 事件 → upsert 节点
  │ flush: 32MB / 400项 / 250ms ────────→ │ dirty → 渲染泵 → 按视图绘制
  │ 目录完成推 done                       │   ├ treemap: squarify + 迟滞 + 折叠
  └──────── 单次扫描即树本身 ──────────────┘   ├ list: 排序 + 占比条
                                           └ files: 全局大文件索引
```

- **一次扫描即整棵树**：不存在"展开触发重扫、与根 DFS 抢 IO"的问题，前端 store 即真相
- **前端零框架**：原生 HTML/CSS/JS，无构建步骤；Tauri 只做壳和事件通道
- 技术细节与平台路线见 [DESIGN.md](DESIGN.md)

## 🗺️ 路线图

| 平台 | 状态 |
|---|---|
| Windows | ✅ 可用（v0.3：三视图 + junction 迁移） |
| Android | M2（SAF 适配，受系统授权范围限制） |
| macOS / Linux | M3（CI 构建） |
| iOS | M4（沙盒内"选取目录分析"形态） |

计划中：并行遍历 / NTFS MFT 直读加速、体积缓存秒开、历史对比。

## License

[MIT](LICENSE)
