# ReadX 双平台架构

## 运行架构

Windows / macOS 都使用 Electron → React / PDF.js → 本机 Go HTTP API → SQLite / 本机文库。Electron 负责窗口、服务生命周期、Token 注入与更新；Go 管理导入、任务、存储、AI 接入及处理子进程。

PDF 主处理链为 Lee Python provider-case：PaddleOCR → document.v1 → 翻译 / 修复 → Node RPR / Typst 排版。阅读器加载整本译文 PDF，段落使用标准化块和坐标。上游 RetainPDF 的 Rust API、账户和任务服务器不在 ReadX 启动链中。

LaTeX Studio 是并列的第二条链路，与阅读链路没有共享语义：Go 侧 `internal/latex` 负责项目 / 文件 / 编译，源码落在数据根下的 `latex-projects/<id>/src`，产物落在同项目的 `build/<buildId>`（每项目保留最近 10 次）。文件路径一律按项目内相对路径校验（`..`、绝对路径、盘符、符号链接、保留设备名拒绝），写入走临时文件 + 重命名并带内容指纹；编译调用本机 TeX 发行版，可执行文件来自白名单且不经 shell，latexmk 实测可运行时优先用它，否则走内置多趟并自行决定何时跑 bibtex/biber。前端编辑器（Monaco）与 PDF 预览（PDF.js，与阅读器共用同一份 worker）都随该工作区懒加载。

LaTeX 的 AI 参与分两种力度，区别写在 API 边界上：`/v1/ai/latex-fix` 只返回建议，由用户确认后走普通保存路径落盘；`/v1/ai/latex-autofix` 会真的写盘，因此额外要求项目显式开启 `ai_auto_fix`（默认关闭），并且**只能在 `Service.ApplyAndVerify` 这一个入口写**：先建源码快照（`latex_snapshots` + 项目内 `snapshots/<id>/src`），再原子写入，然后强制起一次真实编译，按「错误有没有减少」的固定规则决定保留还是回滚（回滚即 `RestoreSnapshot`，并如实报告被移除的新增文件）。发给模型的编译日志在服务端经 `RedactLog` 脱敏（家目录 / 用户名 / 项目绝对路径替换、厂商环境噪声剔除），客户端无法绕过。

LaTeX 还可以带自己的模型渠道：`app/config.json` 里的 `latexAI` 段（provider/baseURL/model/reasoningEffort）覆盖全局设置，缺省即「跟随全局」。三个 LaTeX AI 接口统一走 `Server.latexAIConfig()`（有覆盖就派生一份、没有就用全局），密钥不另存，仍在 `connections` 的「渠道|地址」命名空间里查表，因此「绝不把别的地址的 Key 发到当前地址」这条规则对 LaTeX 同样成立；设置入口只接受 HTTP 渠道（CLI 渠道在后台服务里通常不可用）。

## 源码一致性

为保留原有平台入口和 Windows 打包路径，当前不搬动 Windows 工程。`windows/` 是核心源码的唯一编辑入口，`macos/` 是可独立构建的受管镜像。共享范围由 `scripts/sync-platforms.mjs` 列出，CI 用字节比较拒绝遗漏、变更或多余的核心文件。

受管目录：`apps/server`、`apps/web`、`apps/desktop/src`、`packages/shared`、`resources`、`vendor`。公共构建、运行时诊断和回归脚本也受管。运行时缓存、node_modules、构建产物不参与同步。

平台差异保留在：顶层与 desktop 包配置、图标、运行时安装与打包脚本、系统启动器和平台文档。公共代码内部通过平台判断处理 CLI、Python、Typst、数据目录与进程行为。不要向 macOS 副本独立添加业务实现。

```sh
node scripts/sync-platforms.mjs
node scripts/sync-platforms.mjs --check
```

## 开发 / 打包运行时

两端独立执行 npm ci。macOS 运行时在 `.retain-runtime` 与 `.retain-python`，Windows 在 `.retain-runtime`。开发服务通过显式工作区路径定位 Lee 引擎与资源；Electron 打包后从 Resources 定位，避免依赖编译机的绝对源码路径。

macOS 安装包使用可重定位的 Python，保留相对符号链接；将 venv 的二进制依赖复制到包内 Python。安装包包含 Node 依赖、字体、Typst 和引擎 CLI，不依赖用户 PATH 中的 Python / Node。Intel 与 Apple Silicon 分别原生构建。

## 服务生命周期

正常退出先设置 stopping，关闭 stdin 后等待 Go 清理 SQLite；不会将主动停机报成异常。意外退出记录原因和 stderr 尾部，最多一分钟重启三次，复用端口 / Token。不会重放中断的请求。macOS 关闭最后一个窗口保留服务，Dock activate 重新创建窗口；退出应用才停止服务。

## 验证边界

CI 分别运行 Windows 和 macOS 原生构建 / 测试，并独立验证源码一致性。macOS 额外验证 Python / Typst / Node 资源、浏览器导入交互、真实 Electron 与后端恢复、应用目录打包。真实服务授权、模型输出质量、长期运行稳定性、Intel 运行、正式签名 / 公证和更新安装仍需要相应环境的验收，不能由源码一致性推出。
