# 更新与桌面回归验证

从 `macos/` 执行以下命令。核心实现与测试维护在 `windows/`，通过仓库根目录的 `scripts/sync-platforms.mjs` 管理两平台一致性。

| 命令 | 验证范围 |
| --- | --- |
| `npm test` | Go 测试、50 项共享文本/批注/PDF 版式测试、类型检查、桌面更新单元测试 |
| `npm run test:updates` | 真实 Chromium 中的更新控件、版本显示、弹窗、重试、状态恢复、事件竞争、订阅清理及更新说明 HTML 过滤 |
| `npm run test:import` | 真实 Chromium 中的导入队列、重复提交、取消与失败反馈 |
| `npm run test:presentation` | PPTX 生成、内容分页、图表路由、字体与版面边界 |
| `npm run check:runtime` | 本机 Python、Typst、Node 渲染依赖与资源 |
| `npm run test:desktop` | 合成 PDF、真实 Electron 主进程/preload、Go 服务、鉴权、阅读器、位置保存、服务崩溃恢复与 Dock 重开 |
| `npm run test:packaged` | 完整安装包的更新配置、隔离书库、preload、更新状态接口、运行时资源与服务恢复 |
| `node scripts/packaged-smoke.mjs --check-updates` | 在上述打包测试中额外联网调用真实更新源，验证并发 IPC 检查返回一致的版本结果 |

更新单元测试包含检查去重、检查超时与迟到结果、检查/下载互斥、下载失败重试、安装前置条件、重复安装保护、进度范围，以及 Mac 原生更新器确认就绪的时序。测试通过注入的更新器验证这些状态，不下载或安装线上更新。

macOS 当前采用校验后打开 DMG 的覆盖安装流程，不调用原生重启更新。新增测试使用隔离临时目录和模拟下载流，验证 Windows 独占新版不会遮住 Mac 版本、架构与 universal 匹配、正式版本数值比较、防降级、可信下载地址、SHA-256 与长度校验、损坏文件清理、缓存篡改与删除、异步打开失败及重试。真实 Chromium 测试还验证「下载安装包 / 打开安装包」文案、退出后覆盖安装的说明，以及重试不会重新检查或重复下载。打开 DMG 成功后保留 ReadX 运行，用户可先保存工作再退出。

更新测试也覆盖 GitHub API 的 403/429 限流：使用公开最新正式发行重定向和 `latest-mac.yml`，以 SHA-512 校验 DMG；缺少平台清单时仍提示暂不可用。Electron 的备用源适配使用 `net.request` 读取重定向 Location，覆盖空 `Response.url`、手动重定向取消、超时与终止事件的情况。

后台导入测试等待翻译阶段实际完成，分别验证成功译文保存、无效翻译失败及原文保留。任务状态的并发测试可在支持 Go race detector 的环境中运行：

```sh
CGO_ENABLED=1 node scripts/go.mjs test -race ./internal/httpapi \
  -run 'Test(ImportJob|FullTranslationIsSavedAfterBackgroundImport|ImportProgressDoesNotClaimBackgroundTranslationCompleted)' \
  -count=1
```

打包测试直接启动应用可执行文件，并显式设置独立数据目录与 Electron 配置目录。测试会确认后端实际采用该目录，之后才进行服务进程终止/恢复测试。退出时关闭测试实例，不操作日常书库。

完整打包使用 DMG/ZIP 目标，`--dir` 不保证包含 `app-update.yml`。CI 的安装包验证使用 ZIP，发行工作流生成 DMG 和 ZIP。缺少配置时测试直接失败。

这些检查不证明签名、公证、Gatekeeper 或跨版本安装成功。Apple Silicon 本机执行不能替代 Intel Mac、Windows 原生测试与远程 CI；真实论文的 OCR/译文质量也需要独立验收。
