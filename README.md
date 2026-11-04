# DiskLens 盘析

磁盘空间分析客户端（Windows / macOS / iOS / Android）——treemap 方块视图实时呈现目录占用。

以 c-relocator 的 live map（PowerShell + SSE + Web treemap）为原型产品化：
**Rust 扫描核心 + Tauri v2 四端壳 + 原生 JS treemap 前端**。

![platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20iOS%20%7C%20Android-blue)

## 快速开始

```bash
npm install
npm run tauri dev    # Windows 桌面客户端（真实扫描）
npm run dev          # 浏览器模式（合成数据，无需 Rust 工具链）
```

## 特性

- 实时流式渲染：扫描过程中方块渐进生长（增量 flush 32MB/400项/250ms）
- SpaceSniffer 式交互：单击展开对比、双击进入、右键菜单（打开/复制路径/进入/展开）
- 防细条布局：极小项与极端长宽比块自动折叠为剩余聚合条
- 语义配色：目录多彩 / 文件灰 / 扫描中流动斜纹
- 排序迟滞：方块平滑生长，越界 12% 才换位

## 平台

| 平台 | 状态 |
|---|---|
| Windows | ✅ M1 开发中（本机） |
| Android | M2（需 Android SDK） |
| macOS | M3（CI 构建） |
| iOS | M4（需 macOS + Apple 开发者账号） |

详见 [DESIGN.md](DESIGN.md)。

## License

MIT
