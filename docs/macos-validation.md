# macOS 同步验收记录

日期：2026-10-19。环境：Apple Silicon macOS、Node.js 22.23.2、Go 1.27.0、Python 3.12.14、Typst 0.15.1、Electron 44.2.0。

## 已执行

- `node scripts/sync-platforms.mjs --check`：3001 个受管文件一致，另检查平台 package.json 的版本、依赖及契约字段。
- `npm ci`：使用与 Windows 相同的锁文件安装依赖。
- `npm test`：Go 全套测试、39 个 shared 测试、shared / web / desktop 类型检查通过。
- `npm run build`：共享包、生产 React 页面、Electron 与原生 Go 后端构建通过。
- `npm run check:runtime`：Python 模块、Lee 入口、Typst、Node 排版依赖及字体检查通过。
- `npm run test:import`：六组真实 Chromium 交互回归通过；网络与模型为模拟输入。
- `npm run test:desktop`：真实 Electron 主进程、preload、Go、SQLite、PDF 阅读、位置保存、SIGKILL 后自动恢复、Dock 重开及正常退出通过。使用合成 PDF 和隔离书库。
- `npm run build:release` / `package:mac`：生成 ARM64 app、DMG、ZIP、blockmap 与本地更新元数据。
- `npm run test:packaged`：真实安装包页面、preload、后端、OCR 配置读取、渲染资源检查及后端 SIGKILL 后恢复通过，调试实例测试后关闭。
- Windows amd64 后端交叉编译通过；这不等于 Windows 本机运行验收。
- PaddleOCR 真实服务测试：使用不含私人内容的单页合成 PDF，提交 HTTP 200，任务 done，结果下载 HTTP 200。令牌只保存在用户数据目录，不在仓库或此记录中。

## 修复的具体问题

- 主动停机晚于退出事件才设置 stopping，可能误报“本地服务已停止”。现已提前设置，并对真正异常实施有限重启；原端口 / Token 保持不变，不自动重放请求。
- macOS 缺少 Windows 的 OCR / Lee / 渲染 / 模型控制 / 重译等实现。已由受管镜像统一源码和依赖，CI 增加一致性及 macOS 原生验证。
- 仓库忽略了上游渲染引擎 bin 目录。已从原固定提交恢复 CLI，并修正忽略规则。
- 打包前端、Go、Python / Typst 路径不完整，以及 Python 复制时将相对符号链接变成构建机绝对路径。已修正并检查包内导入。
- 打包目录未复制渲染 node_modules，以及 Go 只查找开发目录中的依赖。已显式打包，并补充开发 / 安装包目录回归测试。
- 开发桌面版和打包版统一使用 macOS 的 ReadX 用户数据目录，避免 OCR 配置落到临时书库。

## 未验证或未提供

- Intel Mac 的实际运行与原生打包。
- Windows 机器上的完整运行回归。
- Apple Developer 正式签名、公证、Gatekeeper 分发与线上自动更新安装。
- 长期运行稳定性、真实论文集合及真实翻译模型的质量验收。
- GitHub Actions 尚未由本次本地修改触发；工作流配置完成不代表远端 CI 已运行。

OCR 可用不等于全文翻译已配置。用户仍需在 AI 助手设置中选择可用的模型渠道。
