# ReadX macOS

与 Windows 使用相同的 React 阅读器、Go API、SQLite 迁移、Electron 主进程及 RetainPDF OCR / 翻译 / 排版流水线。macOS 独立维护运行时安装、图标、签名和打包配置。

## 开发与启动

需要 Node.js 22.8+、Go 1.27+、uv。Apple Silicon 和 Intel 分别在对应架构的 Mac 上构建。

```sh
cd macos
npm ci
npm run setup:runtime
npm run check:runtime
npm start
```

也可双击 `启动 ReadX.command`。`npm start` 检查源码指纹后构建并启动；`npm run dev` 启动 Go、Vite 和 Electron 开发环境。设置 `CBCT_V2_GO` 可指定 Go，`READX_UV` 可指定 uv。

`setup:runtime` 安装工程内的 Python 3.12.14、预编译 PDF 依赖和 SHA-256 校验的 Typst 0.15.1。不启动 RetainPDF 桌面端、Rust API 或独立任务服务。

## 功能与架构

同步书库、PDF / EPUB 阅读、目录、选区批注、阅读位置恢复、AI 助教多会话、模型与推理强度选择、精读五重奏、图表校正、重新翻译、任务进度、译文 PDF 阅读和导出。PPT 工作区先通读全文，结合已保存的精读记录生成可编辑 16:9 演示稿；支持重点解读、对比、流程、图文证据、数据聚焦与核心观点六种版式，预览与导出共用布局，原图等比嵌入正文、宽表和长内容自动分页。中英文使用微软雅黑，数字使用 Times New Roman。页面规划使用 ReadX 内置的 `baoyu-slide-deck` skill 规划页面，并由本地 PPTX 引擎渲染；skill 经 ReadX 统一 AI 接口调用，不依赖具体模型提供商的原生 skill 支持。

以上阅读、批注、AI 助教、精读、导入与翻译功能和 Windows 版共用核心实现。Windows 功能指南中的交互与功能说明同样适用于 macOS；只有明确标注的 Windows 快捷方式、目录和系统集成例外。

PDF 导入统一运行：Go 接收文件 → RetainPDF Python provider-case → PaddleOCR → document.v1 → 翻译 / 质检 / 修复 → RPR 排版 → 回填文库。必须配置 PaddleOCR 和可用的 AI 渠道；仅配置 OCR 不能完成全文翻译。文件、任务限制与 Windows 相同。EPUB 使用相同的安全章节导入路径。

AI 渠道包括 OpenAI 兼容 API、Anthropic、Codex Desktop / CLI、Claude CLI、Kimi CLI。macOS 查找 `/Applications/Codex.app` 和 `~/Applications/Codex.app` 中的 Codex，也可用 `CBCT_CODEX_PATH` 指定。不读取登录令牌文件。

具体交互见 [Windows 功能指南](../windows/README.md)。平台安装以本文为准。

## 数据与故障恢复

开发桌面版和打包版默认共用 `~/Library/Application Support/ReadX/`：

- `library/`：文献和译文 PDF。
- `app/data/v2/reader.db`：SQLite。
- `app/config.json`：AI / OCR 配置，令牌不回传前端。
- `app/logs/desktop.log`：异常退出与重启记录。

`CBCT_DATA_ROOT` 可指定其他数据根。服务仅绑定回环地址并校验 Bearer Token。正常退出先标记停机，再关闭后端；意外退出一分钟内最多重启三次，沿用原端口和 Token。中断的请求可能失败，需要用户重试，不会自动重放模型或导入请求。

## 保持双端一致

核心实现以 `windows/` 为编辑入口，macOS 对应源码由同步脚本生成。新功能或修复应先合入 Windows 对应源码，再运行同步脚本更新 macOS；不要只修改 macOS 的受管源码。macOS 独有的启动器、运行时安装、图标、签名和打包配置仍在 `macos/` 单独维护。

```sh
# 在仓库根目录
node scripts/sync-platforms.mjs
node scripts/sync-platforms.mjs --check
```

同步范围包含 server、web、shared、desktop/src、第三方源码、字体和渲染资源及公共构建 / 测试脚本。两端独立安装依赖和生成构建产物。完整边界见 [架构说明](../docs/architecture.md)。

## 验证

```sh
npm test
npm run build
npm run check:runtime
npm run test:import
npm run test:desktop
```

Go 测试含模拟 OCR / 模型与真实 Python / PDF 渲染集成；自动注入工程内 Python / Typst 路径。导入组件测试需要 Chrome / Edge，或设置 `CBCT_SMOKE_BROWSER`。桌面测试使用合成 PDF 和隔离书库，验证真实 Electron、preload、后端、鉴权、阅读器、位置保存、强制终止后的恢复及 Dock 重开，不调用付费模型。

这些检查不能替代真实论文与真实模型的质量验收。复杂表格、公式和多栏扫描件仍需人工对照。

## 打包

```sh
npm run build:release
npm run test:packaged
```

产物位于 `release/`：当前架构的 ReadX.app、DMG 和更新用 ZIP。包内包含 Go、React、Python 及依赖、Typst、RetainPDF、Node 渲染依赖和字体。普通用户不需要开发工具，OCR 与云端模型仍需联网。

本机未签名构建不代表通过 Gatekeeper 或公证。仓库的 `build-macos.yml` 在 macOS runner 上构建 DMG、ZIP、blockmap 和 `latest-mac.yml`，并在推送 `macos-vX.Y.Z` 标签后上传到同版本的 GitHub Release；Windows 安装包由 `vX.Y.Z` 标签对应的 Release workflow 构建。自动更新是否可用还取决于 macOS 对未签名应用的安全策略；首次启动或更新若被系统拦截，请从 Release 下载 DMG 手动安装。
