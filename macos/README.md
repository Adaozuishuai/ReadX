# ReadX macOS

与 Windows 使用相同的 React 阅读器、Go API、SQLite 迁移、Electron 主进程及 Lee OCR / 翻译 / 排版流水线。macOS 独立维护运行时安装、图标、签名和打包配置。

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

`setup:runtime` 安装工程内的 Python 3.12.14、预编译 PDF 依赖和 SHA-256 校验的 Typst 0.15.1。无需单独启动翻译引擎桌面端、Rust API 或任务服务。

## 功能与架构

同步书库、PDF / EPUB 阅读、目录、选区批注、阅读位置恢复、AI 助教多会话、模型与推理强度选择、精读五重奏、图表校正、重新翻译、任务进度、译文 PDF 阅读和导出。PPT 工作区先通读全文，结合已保存的精读记录生成可编辑 16:9 演示稿；支持重点解读、对比、流程、图文证据、数据聚焦与核心观点六种版式，预览与导出共用布局，原图等比嵌入正文、宽表和长内容自动分页。中英文使用微软雅黑，数字使用 Times New Roman。页面规划使用 ReadX 内置的 `baoyu-slide-deck` skill 规划页面，并由本地 PPTX 引擎渲染；skill 经 ReadX 统一 AI 接口调用，不依赖具体模型提供商的原生 skill 支持。

以上阅读、批注、AI 助教、精读、导入与翻译功能和 Windows 版共用核心实现。Windows 功能指南中的交互与功能说明同样适用于 macOS；只有明确标注的 Windows 快捷方式、目录和系统集成例外。

PDF 导入统一运行：Go 接收文件 → Lee Python provider-case → PaddleOCR → document.v1 → 翻译 / 质检 / 修复 → RPR 排版 → 回填文库。必须配置 PaddleOCR 和可用的 AI 渠道；仅配置 OCR 不能完成全文翻译。文件、任务限制与 Windows 相同。EPUB 使用相同的安全章节导入路径。

PDF 入库时统一联网检索 OpenAlex / Crossref，再由所选 AI 助手核对并补齐缺失的期刊/会议与年份。重复导入缺少出版信息的旧论文会复用正文补齐题录。阅读器支持原 PDF 内置引用跳转、无链接方括号编号定位及返回正文；引用导出与引用关系窗口使用更大的字号并显示完整标题。

AI 渠道包括 OpenAI 兼容 API、Anthropic、Codex Desktop / CLI、Claude CLI、Kimi CLI。macOS 查找 `/Applications/Codex.app` 和 `~/Applications/Codex.app` 中的 Codex，也可用 `CBCT_CODEX_PATH` 指定。不读取登录令牌文件。

具体交互见 [Windows 功能指南](../windows/README.md)。平台安装以本文为准。

## LaTeX 写作与对话确认

顶栏「LaTeX Studio」支持新建项目、导入 Overleaf ZIP、编辑 `.tex` / `.bib` 和预览本机 TeX 编译的 PDF，需要先安装可用的 TeX 发行版。

在助手中直接发送修改要求，AI 会结合当前编辑内容和项目源码，在对应回复下显示文件修改卡片。可展开查看修改前后内容，点「确认修改」后创建快照并保存，点「取消修改」保留原文件；每张卡片修改一个文件。输入栏显示「请求批准」，聊天修改逐次确认，不需要开启自动修复写入。

LaTeX 可跟随全局模型，或在「模型设置」中指定自己的 HTTP 渠道、搜索选择模型及推理强度。目录可拖宽、诊断列表可隐藏，编译修复与源码快照默认折叠。自动修复编译错误另有「自动修复写入」开关，并会在错误未减少时回滚。项目文件和编译产物在本机；使用 AI 时，相关源码上下文会发送给所选模型服务。

![LaTeX 对话中的修改确认卡片与「请求批准」入口](../docs/images/promo/16-latex-chat-approval.png)

## 摸鱼界面

点击顶部挂件，以淡绿色漫画窗帘切换科研与摸鱼界面，采用平涂、描边褶皱、扇形帘头和少量网点；挂件可沿顶部拖动并记住位置。`Ctrl+Shift+M` 切换界面，摸鱼界面按 `Esc` 返回科研工作区。

独立书架支持本地 TXT、EPUB、图片与 CBZ。找书入口可搜索 Project Gutenberg 英文公版书并将下载内容加入书架；中文连载可导入兼容的 Legado 书源 JSON，按需获取和缓存章节。阅读数据保存在本机浏览器，在线检索和章节获取需要网络及可用书源。

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
npm run test:updates
npm run test:desktop
```

Go 测试含模拟 OCR / 模型与真实 Python / PDF 渲染集成；自动注入工程内 Python / Typst 路径。导入组件测试需要 Chrome / Edge，或设置 `CBCT_SMOKE_BROWSER`。桌面测试使用合成 PDF 和隔离书库，验证真实 Electron、preload、后端、鉴权、阅读器、位置保存、强制终止后的恢复及 Dock 重开，不调用付费模型。

这些检查不能替代真实论文与真实模型的质量验收。复杂表格、公式和多栏扫描件仍需人工对照。

## 打包

```sh
npm run build:release
npm run test:packaged
# 可选联网验证：真实更新源、并发 IPC 检查与版本号
node scripts/packaged-smoke.mjs --check-updates
```

产物位于 `release/`：当前架构的 ReadX.app、DMG 和更新用 ZIP。包内包含 Go、React、Python 及依赖、Typst、Lee 引擎、Node 渲染依赖和字体。普通用户不需要开发工具，OCR 与云端模型仍需联网。

本机未签名构建不代表通过 Gatekeeper 或公证。仓库的 `build-macos.yml` 在 macOS runner 上构建 DMG、ZIP、blockmap 和 `latest-mac.yml`，并在推送 `macos-vX.Y.Z` 标签后上传到同版本的 GitHub Release；Windows 安装包由 `vX.Y.Z` 标签对应的 Release workflow 构建。自动更新是否可用还取决于 macOS 对未签名应用的安全策略；首次启动或更新若被系统拦截，请从 Release 下载 DMG 手动安装。

### 首次启动被 macOS 拦截

先将 `ReadX.app` 拖到“应用程序”文件夹，再在“终端”中依次执行：

```sh
sudo spctl --master-disable
xattr -cr /Applications/ReadX.app
```

第一条命令会全局关闭 Gatekeeper，降低系统对所有应用的安全检查。请仅对可信来源且已确认的 ReadX 安装包执行；打开 ReadX 后，建议运行 `sudo spctl --master-enable` 恢复 Gatekeeper。输入 `sudo` 密码时，终端不会显示字符。

打包测试使用独立书库与 Electron 配置目录，不操作日常书库。CI 使用完整 ZIP 打包，拒绝缺少 `app-update.yml` 的应用目录。

本机构建不会创建线上更新。更新源缺少 macOS 更新清单时会尝试读取最新公开发布版本，并提示该平台暂不可更新；不能据此判断当前版本已是最新。更新测试还覆盖并发、重试、窗口重开、超时、安装前置条件，以及 Mac 下载完成后等待原生更新器校验的顺序。
