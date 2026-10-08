# UI 设计与对齐验收

## Figma 对齐复审（本轮）

用户指出上一轮界面对齐不合格。本轮复审覆盖先前关于布局正常的判断；旧截图保留为改造前基线。

使用 Figma 插件创建 [CBCT Daily · 对齐与响应式重设计](https://www.figma.com/design/vwOFX2jzCM2mewpmsSdrjO?node-id=5-12)。桌面画板 `5:12`、手机画板 `5:182`，使用可编辑文本与 Auto Layout；建立颜色语义变量和 Button/Pill 变体，间距复用 Simple Design System 的 8/12/16/24/32 变量。保留原 SVG 的视觉风格，插画从设计节点导出为本地 `app/public/figma-hero.svg`，原生打包同一资源。

主要改动：列宽在扣除间距后按 12 列的 5/3/4 分配；三列共享 520px 高度，中列分为 224 + 24 + 272px；插画与右侧卡片共用列宽；统一 24px 卡片内边距、24px 圆角、40px 导航/按钮高度。Tiny takeaway 限制两行摘要，长标题最多三行；主题标签两列等宽，长名称保留完整提示；主题图不重复添加 CBCT 根主题。

| 实际 Web 窗口 | 三列卡片底边 | 插画/知识卡片左边 | 页面 clientWidth / scrollWidth | 内容溢出 |
| --- | --- | --- | --- | --- |
| 1440px | 均为 880px | 965.336 / 965.328px | 1440 / 1440 | 无 |
| 1000px | 均为 880px | 672.008 / 672.000px | 1000 / 1000 | 无 |
| 390px | 单列排列，统一左右边距 16px | 同一左边线 | 390 / 390 | 无 |

顶部四个导航、搜索与头像的实际高度都为 40px，桌面中心线均为 72px。六个主题、公开 NAF 长标题均已检查。Web 点击主题会清除旧搜索并返回对应论文；All topics 可打开主题页。浏览器检查确认插画已加载，长主题文字未溢出圆节点。

原生最终 release 在独立 bundle 和完整六主题测试画像中检查：1000px 与放大至 1470px 的窗口，纵向滚动后确认三列底边完全一致，主题胶囊两列等宽；Tiny takeaway 与 Idea 计数底栏留在卡片内。点击 Deep Read 后实际进入第②步，原文/笔记、方法与公式、实验配置、结果分析、论文与代码入口仍可访问。正式数据与密钥未改写。release 编译通过、JS 语法/安全/活体服务冒烟通过，安装产物与 release 的 Mach-O UUID 均为 `E1FCCCCF-9228-3539-8F32-215EC9451DDD`，签名检查通过。

最终截图与 DOM 测量保存在 `figma-alignment/`：`web-1440.jpg`、`web-1000.jpg`、`web-390.jpg`、对应 JSON，以及原生的 `native-1000-top.png` / `native-1000-bottom.png`、`native-expanded-top.png` / `native-expanded.png`。上一轮 40 项原生离线回归作为功能基线保留；本轮界面调整未声称重新完成科学质量或完整 PRD 验收。

限制：Figma Starter MCP 额度在完成两个画板后耗尽。桌面三列/插画的结构对齐已核对；手机画板最后的画布高度修正与标题行高微调未能写回，底部仍有裁切。修正脚本保存在 `assets/design/figma-alignment/finish-mobile.js`，节点与变量记录在 `state.json`。实际项目已经完成相应修正并在 390px 检查通过，不能将 Figma 手机稿表述为最终验收版。

## 上一轮 SVG 改造记录

用户要求：界面按照 `CBCT_Daily_FUN_Kids_4K.svg` 设计。原始 3840×2160 SVG 保存在 `assets/design/`；只作为布局与视觉数据读取。实现使用可交互的原生组件与 HTML/CSS，Web 装饰图复用 SVG 的 hero 区域。

## 已实现

奶油色背景、黑色圆角描边、无衬线粗体、紫色主视觉和粉彩卡片；顶部品牌/Today/Library/Topics/Notebook、搜索与头像/设置入口；左右 hero 文案与图形；Adventure、Reading streak、Topic garden、Knowledge playground 三栏结构。小屏 Web 按列堆叠，搜索仍可访问。

设计中的示例论文、5 days、18 ideas 使用实际论文/阅读记录/已保存关联 Idea 替代。每周圆点由完成日期计算，主题来自画像权重。主题图的边表示 CBCT 分类，Idea↔Paper 展示已保存材料关系，没有将其宣称为引用演化图。

原生 Library、Profile、Compare、Ideas 编辑和精读模块沿用真实功能；对比、导入、导出、AI 设置位于更多菜单。精读室统一字体、配色和卡片。Web Notebook 当前展示已保存研究想法，编辑仍在原生端；结果分析/代码映射尚未移植到 Web。

## 检查

- 最终原生 release 编译并安装到 `~/Applications/CBCT每日精读.app`；正式运行中的旧进程未强制关闭。测试在独立 bundle/数据根目录中进行。
- 40 项原生离线回归通过，JS 语法/安全/活体服务冒烟通过。正式 API Key、笔记、进度、Ideas 未被测试改写。
- 原生 1000px 窗口：实际截图确认导航、hero、三栏均正常，内容可纵向滚动；Start today 恢复当前精读步骤，搜索 NAF 返回论文，Implicit 主题筛选正常，Notebook 保留查看/编辑与导出。
- 放大原生窗口后确认三栏、Tiny takeaway 和主题卡完整展示；Deep Read 进入第②步，保留原文/笔记、方法与公式、实验配置、结果分析、论文与代码入口。
- 最终构建的主题图辅助标签已分别标识 Sparse-view/Implicit/Low-dose/Diffusion 筛选按钮。
- Web 1440px 与 390px 实际浏览器检查；390px 的页面 clientWidth/scrollWidth 都为 390，无横向溢出。验证主题筛选、搜索无匹配结果、Notebook 展示、Connect 立即进入第④步。
- Web 草稿验证：输入隔离测试批注，导航到 Notebook 后再进入 Connect，批注保留；未标记阅读完成。延迟元数据只更新相应论文，不覆盖研究笔记或工作台页面。浏览器无 JS error。

实际截图保存在 `ui-design/`：`native-home.png`、`native-home-expanded.png`、`web-desktop.jpg`、`web-mobile.jpg`。截图使用公开 NAF 与隔离测试材料。UI 验收不代表 PRD 的 Web 完整功能、引用图谱、账号同步或科学质量验收完成。

最终发布核对：安装版与 release 产物的 Mach-O UUID 一致（`20BC23C4-A530-3ABD-9CB0-C3E2278EDE5B`），安装包签名检查通过。最后一次离线回归为 40 passed / 0 failed。
