# Realtime LaTeX preview

Engine: [realtime-tex v0.0.5](https://github.com/HenryXiaoYang/realtime-tex), MIT.
Renderer and font loader: [realtime-tex-vsc-plugin](https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin), commit a5dc1d9ecc703a9487bd01a026317614151cc288, MIT.

ReadX adapts the host protocol to authenticated local SSE, uses its own React UI and PDF.js worker, and hides font lookup processes on Windows. The engine is downloaded separately with a pinned SHA-256 checksum.

On Windows the host writes the engine executable into `%LOCALAPPDATA%/ReadX/rtex/<SHA-256>/` before launching it. This avoids inheriting a workspace's Low integrity label, which prevents MiKTeX child processes from writing their font cache. `RTEX_TEXDIR` retains the original release's TeX support files.
