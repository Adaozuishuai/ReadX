# macOS 完整性检查（2026-10-26）

结论：核心源码、开发运行资源及主要功能链路基本齐全；**仍有未修复的 P1/P2 数据与取消操作缺陷，未达到完整验收通过**。发布准备阶段已修复测试门禁问题，v1.0.2 ARM64 安装包构建与打包 smoke 通过。

## 检查基线与范围

- 初始完整性检查基线：`a4940a6`，`feat: add academic workbench and Zotero batch imports`；发布准备时快进同步到 `0f7c8f5`（Windows v1.0.2 release commit）。
- 实测环境：Apple Silicon macOS，Node.js 23.11.0，Go 1.27.2，Electron 44.2.0，Typst 0.15.1，已安装 MacTeX。
- 检查对象是当前工作区，**包含先前尚未提交的更新器、Codex 探测、Finder 环境及签名配置修复**；结果不能直接套用到干净的远端 HEAD。
- 首次检查补齐了本地 npm 依赖；之后将 macOS 包版本升至 1.0.2、修复测试桩和平台图标断言，生成 ARM64 DMG/ZIP。未改动业务实现，未覆盖已安装应用或真实书库。
- 测试使用隔离书库、临时项目及合成 PDF；没有调用付费模型，没有读取真实 Zotero 文献库。

## 已执行的检查

| 项目 | 结果 | 实际覆盖 |
| --- | --- | --- |
| 跨平台源码同步 | 通过 | `node scripts/sync-platforms.mjs --check`：3234 个受管核心文件一致；这不代表两个平台的实际运行效果相同 |
| 差异格式 | 通过 | `git diff --check` |
| 依赖安装 | 已补齐 | 初查缺少新增的 `opentype.js@1.3.4`；`npm ci --no-audit --no-fund` 后依赖检查通过，未修改清单和锁文件 |
| 运行资源 | 通过 | Python 的 PIL / fitz / pikepdf / requests / urllib3、retainpdf 入口、Typst、Node 排版依赖与字体 |
| 普通源码构建 | 通过 | shared、web、desktop 类型检查及编译、Vite 生产构建、原生 Go 后端；存在体积提示，无构建错误 |
| Go 测试 | 通过 | 20 个有测试的包；securefile 包无测试。包含本机 TeX 工具链相关测试 |
| shared 测试 | 58 / 58 通过 | 包括本次拉取新增的 2048 测试 |
| LaTeX 前端状态测试 | 15 / 15 通过 | 发布准备中为新工作台和计时挂件补齐测试 mock |
| 书源前端测试 | 9 / 9 通过 | 独立执行，避免被默认测试前序失败遮蔽 |
| 更新器与图标单元测试 | 40 / 40 通过 | 检查、下载、安装交接、异常状态及 macOS ICNS / PNG 打包资源；不等于线上安装验收 |
| 新学术工作台测试 | 13 / 13 通过 | 独立执行 `node --test scripts/research-workbench.test.cjs` |
| 更新界面 Chromium 测试 | 10 / 10 通过 | 模拟更新桥接及网络状态；在构建完成后独立执行 |
| 导入界面 Chromium 测试 | 6 / 6 通过 | 真实组件交互，解析及网络输入为模拟数据 |
| 原生 Electron 桌面 | 通过 | 真实 main / preload、认证、SQLite 导入、PDF 阅读、阅读位置、后端崩溃恢复、Dock 重开和正常退出 |
| rtex 实时预览后端 | 通过 | 官方 rtex 0.0.5 ARM64 二进制、MacTeX LuaLaTeX，使用 Electron as Node：初次布局成功，编辑后收到真实 ParagraphUpdate |
| Zotero 本地接口 | 通过（模拟服务） | 隔离的本地 HTTP API：集合、条目、PDF 附件；含中文及空格的 file:// 附件路径，校验下载字节一致 |
| 桌面图标测试 | 2 / 2 通过 | 加入 macOS ICNS 头、资源长度及 PNG 包含检查 |
| 定向缺陷复现 | **3 项均复现** | 取消 AI 修复后未还原源码、取消编译未终止子进程、并发 revision 检查失效；临时测试文件已清理 |

rtex 使用临时下载目录，没有写入用户的引擎安装目录。ARM64 实际下载校验值为 `32aee0c610d1e130abb65109db6db340054b0b5eebc07885728113e714d8b1e3`，与源码固定值及官方资产一致；Intel 资产的固定校验值也与官方资产一致，但未执行 Intel 二进制。

打包配置静态检查确认：`prepare-release.mjs` 会复制 `resources/realtime-tex`，desktop 会为后端注入 `CBCT_NODE_BIN` 与 `CBCT_ELECTRON_AS_NODE`，已打包应用会设置 `PYTHONDONTWRITEBYTECODE=1`。本次没有用旧的 1.0.1 安装包代替最新源码做验收。

## 缺陷与优先级

### P1：每次重新启动随机端口，浏览器本地数据随 origin 隔离

- 位置：`macos/apps/desktop/src/main.ts:193`、`macos/apps/server/cmd/server/main.go:55`。
- 初次启动不指定端口，Go 使用端口 0；只有同一次运行中的崩溃恢复才沿用旧端口。前端通过后端 URL 加载。
- 聊天历史使用 localStorage（`macos/apps/web/src/hooks/useChat.ts:34`），摸鱼文库使用 IndexedDB（`macos/apps/web/src/components/slack/db.ts:12`）。相同磁盘 profile 下，更换端口会进入另一份浏览器存储。
- 本次在隔离 Electron 中复测：origin A 写入聊天标记及一条书目，origin B 读取为 `chat: null, books: 0`，返回 A 又恢复为 `chat: saved, books: 1`。这是 origin 隔离的直接验证；结合启动代码可判定应用重启存在数据不可见风险，不是证明磁盘数据已被删除。
- 修复方向：为前端提供稳定 origin，或把持久数据迁至独立于端口的存储层；同时考虑已有不同 origin 数据的迁移。

### P1：取消 AI 自动修复后，回滚也使用已取消的 context

- 位置：`macos/apps/server/internal/latex/autofix.go:149`、`:161`、`:178`。
- 在源码已写入、进入编译时取消操作，回滚继续使用同一 `ctx`。
- 本次真实 TeX 项目复现：返回“编译无法启动（context canceled），且回滚失败（context canceled）”，磁盘上仍保留未验证的修改。
- 修复方向：用独立且有超时的清理 context 完成回滚，保留 revision 冲突保护；补充写入后取消的回归测试。

### P2：revision 比较与文件替换之间没有原子保护

- 位置：`macos/apps/server/internal/latex/files.go:179` 至文件替换逻辑。
- 两个保存请求可以同时读到旧 revision，然后分别写入，后写者覆盖先写者。
- 本次复现：24 个写入者携带同一旧 revision，**10 个成功**，应只允许 1 个。
- 修复方向：对单项目/单文件的比较、写入及替换实施一致的并发保护，并覆盖自动保存与 AI 修改并发场景。

### P2：macOS 取消编译只终止父进程

- 位置：`macos/apps/server/internal/latex/compile.go:526`。
- 当前只有 Windows 调用 `taskkill /T`；macOS 的 `exec.CommandContext` 不负责结束所有后代进程。
- 本次用合成 shell 编译进程复现：父进程取消退出后，子进程仍继续运行并写出标记文件。
- 修复方向：为 macOS 使用进程组终止及有界等待，验证 latexmk / TeX 子进程退出。

### 发布准备已修复：默认测试门禁缺少新组件 mock 与平台图标断言

- 两项 App 加载测试补入 `ResearchWorkbench`、`FocusPendant` 和工作台 hook 的 mock。
- 图标测试现在在 macOS 检查 ICNS 头、资源长度及 PNG fallback；默认桌面测试包含该测试文件。
- 学术工作台单元测试加入默认 `npm test`。更新后的完整 `npm test`、更新 UI smoke 及新打包 smoke 均通过。

### P2：macOS 图形界面启动下的系统代理支持不完整

- 位置：`macos/apps/server/internal/httpapi/proxy_other.go`。
- 非 Windows 分支不读取系统代理，只使用 `http.ProxyFromEnvironment`。仅在系统设置中配置代理、通过 Finder 启动且没有代理环境变量时，书源网络请求无法自动采用该设置。
- 这是源码确认的两端差异；本次没有用真实代理书源做网络成功率验收。rtex 下载器在此类环境中的在线安装也需补测，临时目录预下载成功不能替代应用内下载验收。

以上 Go / Web 数据缺陷也存在于同步的 Windows 核心源码，macOS 检查发现并不意味着只影响 macOS。

## 仍需人工或补充环境验证

1. 修复 P1 后，关闭并重开真实桌面进程，检查聊天、摸鱼文库及迁移后的历史数据；当前 desktop smoke 的崩溃恢复沿用原端口，覆盖不到冷启动 origin 变化。
2. 真实 Zotero 客户端的权限、批量导入、大附件、重复项及异常恢复；本次只覆盖模拟本地 API 和真实文件读取。
3. rtex 前端完整画布、中文字体、TikZ、多文件、参考文献、长文编辑及异常断线重连；本次真实引擎验证覆盖简单公式的后端初次布局与增量更新，没有完成这些视觉验收。
4. DMG 挂载后从新挂载副本安装到隔离 Applications 目录、Finder 首次启动，以及通过 GitHub Release 执行真实更新交接；本次签名验证检查了生成的 app，但没有做这些人工安装步骤。
5. Apple Developer ID 正式签名、公证与 Gatekeeper。当前 `mac.identity` 为 `-`，是 ad-hoc 签名，不能据此宣称正式分发签名已完成。
6. Intel Mac 原生运行；此次只在 ARM64 真机运行。
7. 真实模型、OCR、全文翻译与真实论文图表/公式质量；没有把已有测试或源码同步当成此次端到端质量验收。

## 本次证据

本机临时日志前缀：`/tmp/readx-macos-integrity-20261026-`。主要文件：`tests.log`、`build.log`、`desktop-unit.log`、`workbench.log`、`books.log`、`icons.log`、`import-ui.log`、`update-ui-retry.log`、`native.log`、`live.log`、`regressions.log`。这些日志位于临时目录，不属于仓库长期归档。

原生阅读器截图：`macos/.tmp-smoke/desktop-86696/reader.png`。目录为隔离测试数据，不是用户书库。

## v1.0.2 发布准备补充

- macOS 根工作区和 Electron 包版本均改为 1.0.2，与已存在的 Windows v1.0.2 Release 对齐。
- `npm test` 全部通过：Go 20 个有测试的包、shared 58 项、LaTeX 15 项、书源 9 项、学术工作台 13 项、更新器与图标 40 项及类型检查。
- `check:runtime`、`test:updates`、`test:desktop`、`test:packaged` 通过；后者检查打包版页面、preload、后端和运行资源。
- 本机产物为 arm64：DMG 约 291 MB，ZIP 约 297 MB。DMG SHA-256：`54560bb5cd536f1d544fd3c8984e8ab015212eb4798f2e7277c3d5a4a9367194`；ZIP SHA-256：`536e8c93b56cd86610ebb1e04e7e4d5547ae286e993cc2d261b09f464100fb66`。未公证，仍需首次启动 Gatekeeper 验收。
