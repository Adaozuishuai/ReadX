# ReadX 宣传片（Remotion）

基于用户提供的宣传片参考节奏重做，采用绿色背景、品牌片头片尾、顶部短标题和缓慢推近。九张功能镜头均直接使用用户提供的 ReadX 实际界面截图，没有绘制或替代产品界面。

镜头覆盖书库、导入处理、双语阅读、公式批注、AI 助教、精读五重奏、PPT 生成和 AI 助手设置。截图源文件位于 `public/screens/`。

## 使用

```powershell
npm install
npm run studio
npm run render
```

`src/ReadXPromo.tsx` 可调整镜头顺序、标题、时长和运镜。成片输出到仓库的 `output/ReadX-宣传片-绿色版-Remotion.mp4`。渲染使用 Remotion 输出逐帧图像，再由 FFmpeg 合成视频与配乐。
