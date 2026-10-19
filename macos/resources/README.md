# 译文 PDF 渲染资源

这里放“生成保留排版的译文 PDF”所需的两个外部运行时资源，均按上游许可随应用分发：

## rendering-engine/

- 来源：[retain-pdf-rendering](https://github.com/wxyhgk/retain-pdf-rendering)（MIT），
  由 [RetainPDF](https://github.com/wxyhgk/retain-pdf) 固定在提交
  `c67f3d40a6f75c8c60423a9e5fe196341cee0fc8`（见 `engine/COMMIT`）。
- 只保留 `bin/`、`src/`、`data/`、`package.json`、`LICENSE`、`COMMIT`；
  运行时 npm 依赖（`fontkit`、`mathjax-full`）由 `windows/package.json` 安装。
- 不要直接改 `engine/` 里的文件：从上游同步后在引擎仓库改。

## fonts/

- `SourceHanSerifSC-Regular.otf` / `SourceHanSerifSC-Bold.otf`
  （思源宋体简体中文，SIL Open Font License 1.1，见同目录许可文件）。
- 引擎只支持 `Source Han Serif SC`：它自带该字体的字宽表，PDF 输出必须用这份字体。
- 约 48 MB，属于离线渲染的必要资源。
