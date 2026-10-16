# CBCT 精读

基于 React、Go 和 Electron 的本地论文阅读工作区，支持 PDF / EPUB、按原论文版面显示译文、段落翻译与提问、目录跳转、五重奏精读和复现任务清单。

本仓库分别维护 Windows 版和 macOS 原生版：Windows 版位于 `windows/`，macOS 版位于 `macos/`。Windows 版完整说明见 [windows/README.md](windows/README.md)。

## 启动

需要 Node.js 20.19+ 和 Go 1.27+。

```powershell
cd windows
npm ci
npm start
```

Windows 也可在安装依赖后双击 `windows/启动 CBCT 精读 v2.cmd`。首次启动自动构建，之后仅在源码变化时重新构建。

## 本机数据

论文副本默认存放在仓库根目录的 library/，配置位于 app/config.json，阅读数据位于 app/data/v2/reader.db。这些目录不随源码提交；原有本机论文、笔记和数据库继续保留。可在应用的“AI 设置”中配置模型。

Windows 版内保留旧数据的兼容导入器，首次运行不需要旧客户端代码或旧队列。回收站清空仅移除书库记录和关联阅读数据，保留论文原文件及副本。

## 开发与验证

```powershell
cd windows
npm run dev
npm test
npm run build
```

测试使用 Windows 版内的固定样本和模拟模型服务。详细模块结构、AI 接入和功能边界见 [Windows 版使用说明](windows/README.md)。
