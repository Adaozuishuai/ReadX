# CBCT 精读 v2

按 React + Go + Electron 的三件套重建精读应用（决策与阶段见仓库根 `v2-迁移计划.md`）。
本目录在 S0 阶段只做工程基座：**不读不改旧版任何数据**，`windows/` 仍是当前可用的正式版本。

## 工具链

- Node ≥ 20.19（本机 v24）、Go ≥ 1.27.0（`winget install --id GoLang.Go`）。
- 依赖管理用 **npm workspaces**：本机 `corepack enable pnpm` 会因 Program Files 权限 EPERM 失败，不引入 pnpm。
- Go 模块代理必须是 `https://goproxy.cn,direct`：直连 proxy.golang.org 在本机超时。
  `scripts/go.mjs` 已内置该兜底，并自动定位 `go.exe`（旧终端会话的 PATH 不会包含刚装的 Go）。
- SQLite 驱动用纯 Go 的 `modernc.org/sqlite`：`CGO_ENABLED=0` 也能编译，不需要本机装 GCC。

## 常用命令（都在 `v2/` 目录执行）

```bash
npm install            # 一次装齐 web / desktop / shared
npm run build          # shared → web → desktop → go server
npm test               # go test ./... + 三个 TS 包的类型检查
npm run build:go       # 只重新编译 Go server
npm run dev            # Go server + Vite + Electron 三进程热更新
npm run dev -- --built # 跑 dist 构建产物（server 由 Electron 壳托管）
```

单独跑后端：`node scripts/go.mjs test ./...`（等价于 `npm run test:go`）。

## 结构

```
apps/server     Go：只绑 127.0.0.1，启动时随机 bearer token，SQLite 在 app/data/v2/reader.db
  cmd/server      进程装配：flag 解析 → 就绪行 → 优雅关闭
  internal/config 数据根定位（与旧版同一个仓库根）、token、回环校验
  internal/db     pragma + 内嵌迁移，幂等
  internal/httpapi /healthz /v1/meta /v1/documents + 静态托管
apps/web        React 19 + Vite 8 + Tailwind 4：三栏工作区骨架
apps/desktop    Electron 壳：拉起 server、解析就绪行、把 token 经 preload 注入渲染进程
packages/shared 前后端 API 契约类型（字段名与 Go JSON tag 一一对应）
scripts         go.mjs（工具链解析）、build-server.mjs、dev.mjs（编排）
```

## 本地服务的安全边界

- 只接受回环 Host（`127.0.0.1` / `localhost` / `[::1]`），非回环 Host 一律 403，挡 DNS rebinding。
- `/v1/*` 需要 bearer token；token 每次启动随机生成，只经主进程 → preload → 渲染进程，不进 URL、不落盘。
- 纯浏览器 dev 模式下渲染进程拿不到 token：`/v1` 由 Vite dev proxy 在服务端补 `Authorization`，
  proxy 配置读取 server 写出的 `apps/server/dev-info.json`（所以 `npm run dev` 必须先起 server 再起 Vite）。
- HTML 响应由 server 下发 CSP（`script-src 'self'`），Vite 开发态不受影响。
- Electron 壳：`sandbox: true` + `contextIsolation: true`，拒绝新窗口与跨源跳转。

## 就绪协议

server 在 stdout 打印单行 `CBCT_V2_READY {"port":...,"token":"...","dataRoot":"...",...}`，
Electron 壳与 `scripts/dev.mjs` 都按这个前缀解析；人类可读日志一律走 stderr，避免污染协议。
server 带 `--exit-on-stdin-eof`：父进程一关管道就优雅退出，不会留下占着 SQLite 与端口的孤儿进程。
