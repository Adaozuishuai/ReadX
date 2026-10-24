# 统一电子书书源

## 已实现的范围

「摸鱼 → 找书」通过 Go Provider Registry 检索目录、读取详情、检查来源权利、建立下载任务。下载文件通过 MIME、内容签名、EPUB 结构与 SHA-256 校验后，复用现有 `importDownloadedBook`、IndexedDB 和 `NovelReader`。不增加第二套阅读器或修改旧数据库版本。

| 入口 | 当前能力 |
|---|---|
| Project Gutenberg | Gutendex JSON 目录，搜索、分页、详情、EPUB/TXT 下载 |
| OPDS | Gutenberg 官方 Atom/OPDS 目录，搜索、分页、详情、EPUB 下载；只提供直接 EPUB/TXT acquisition 链接 |
| Z-Library | 已启用独立实现的非官方 EAPI 适配器；配置服务地址并连接自己的账号后，可搜索、查看详情及获取账号允许的 EPUB/TXT |
| 中文连载 | 保留原有 Legado 书源入口，与新 Provider API 分开 |

本地文件（EPUB/TXT/漫画）不走书源入口，统一在「我的书架」导入；PDF 请从科研书库导入。

Gutenberg 的 `copyright=false` 或官方 OPDS 详情中的 `Public domain in the USA.` 用作明确的美国公版标记；不推断其他地区的权利状态。OPDS 搜索列表常只有简略书目，需要打开详情才能获得完整格式与权利信息。未知、拒绝、不能缓存或不能阅读的条目默认不能下载。Z-Library 不提供可靠的作品许可元数据，因此需要用户逐书确认自己有权下载、保存与阅读；这份声明不会被伪装成书源已授权。明确拒绝的权利状态不能由此覆盖。

### Z-Library 连接

用户于 2026-10-23 明确同意调整原方案，允许按非官方 EAPI 协议独立实现适配。当前代码不复制第三方客户端或 Android 内置凭据，ReadX 代码许可保持 MIT。

1. 打开「摸鱼 → 找书 → Z-Library」或「书源设置」。参考服务地址 `https://z-lib.gd` 的匿名 `/eapi/info` 已实测返回有效 JSON；它的可用性不保证长期不变。可填写自己使用的 HTTPS 源站，不自动寻找或轮换镜像。
2. 点击「检查连接」确认 EAPI 信息接口可访问。这个检查不表示账号已经登录或可以下载。
3. 选择「邮箱与密码」连接，或填写自己已有会话的 ID 与 Key。EAPI 登录可能拒绝正常网页账号；此时如实显示错误，不复制应用固定授权值、不自动处理验证挑战。
4. 搜索后查看详情，确认自己的获取、保存和阅读权限，再点击「下载并阅读」。适配器再次检查账号会话和 `/file` 返回的 `allowDownload`，配额不足或账号不允许时拒绝下载。不同文件版本的 ID/hash 不会通过修改后缀互换。
5. 遇到未允许的文件主机，可在「下载源站」中显式添加自己确认使用的 HTTPS 源站。默认允许配置的服务源站及 `cdn-zlib.sk` 子域名；跨源站不携带账号凭据。

账号会话只留在 Go 后端内存，密码不写磁盘。`app/config/zlibrary.json` 仅保存源站配置；重启服务后需要重新连接。退出账号、切换地址或重新连接时，取消旧账号任务并清理对应暂存文件；失效会话不再显示为已连接。

## API

所有接口沿用本地服务的回环限制和 Bearer 鉴权。

| 方法 | 路径 | 结果 |
|---|---|---|
| GET | `/v1/book-sources` | `{ sources: [{ providerId, name, enabled, capabilities, reason }] }` |
| GET | `/v1/book-sources/{provider}/search?q=...&cursor=...` | `{ books, nextCursor? }`；游标由客户端原样传回 |
| GET | `/v1/book-sources/{provider}/books/{id}` | 统一书籍元数据和 `rights` |
| POST | `/v1/book-sources/{provider}/books/{id}/downloads` | 请求体 `{ "format": "epub" }` 或 `txt`；Z-Library 另需逐书 `userAuthorized: true`，返回 HTTP 202 和任务 |
| GET | `/v1/book-downloads/{taskId}` | `queued / running / ready / failed / cancelled`、字节进度、错误码 |
| GET | `/v1/book-downloads/{taskId}/file` | 校验后的文件；响应含 `X-Content-SHA256` |
| DELETE | `/v1/book-downloads/{taskId}?lease={leaseId}` | 释放本次请求；最后一个请求释放后取消任务并清理暂存文件 |
| GET / PUT | `/v1/book-sources/zlibrary/connection` | 读取无凭据的连接状态 / 保存服务及下载源站配置 |
| POST / DELETE | `/v1/book-sources/zlibrary/connection` | 连接自己的账号 / 断开账号 |
| POST | `/v1/book-sources/zlibrary/probe` | 只检查匿名 EAPI 信息接口 |
| GET | `/v1/book-sources/zlibrary/books/{id}/cover` | 经服务端地址、类型、2 MiB 大小限制的可选封面 |

下载创建响应含本次请求独立的 `leaseId`。同书同格式仍复用下载任务；各窗口用自己的 `leaseId` 释放引用，重复释放幂等，不会中止其他窗口仍在使用的下载。退出账号或切换源站仍取消该账号的全部任务。

错误响应为 `{ "code": "NO_PERMISSION", "error": "..." }`。未知来源、未配置、未登录或失效 (`AUTH_REQUIRED`)、无下载权、格式不支持、限流、文件过大和下载失败分别使用稳定错误码。前端不向下载任务接口提交 URL、Cookie 或站点 Token；连接表单仅将用户本次输入发送给本地连接端点，随后清空密码和 Key，不写浏览器存储。

旧 `/v1/books/search`、`/v1/books/download`、`/v1/books/fetch-web` 继续保留；旧 Gutenberg 下载路由的白名单未放宽。

## 下载与存储

- 新 Provider 仅允许明确登记的 Gutenberg/Gutendex HTTPS 主机与路径。每跳重定向检查协议、主机、路径、端口和公网 DNS 地址；直接连接重新解析并连接已校验 IP。使用用户配置的代理时，目标域名及公网地址仍检查，代理自身负责连接与解析。
- Z-Library 单独使用用户配置的源站策略，不扩大 Gutenberg 白名单。EAPI 固定路径只发往当前配置源站，禁止 API 重定向；文件可在已允许源站之间跳转，每跳检查公网地址并移除跨源凭据。只获取服务器返回且 `allowDownload` 明确允许的文件链接。
- 每个下载上限 64 MiB，同时最多两个文件任务。目录响应上限 4 MiB，重定向最多五跳，单任务超时两分钟。
- EPUB 复用 `publication.Archive` / `ParseEPUB` 的结构、资源数、解压大小和路径限制，并拒绝加密清单。TXT 只接受有效 UTF-8 文本，拒绝 HTML/XML 错误页和二进制内容。
- Gutenberg 的旧 TXT 快捷地址会跳到 HTTP；新适配器直接使用同一作品的 HTTPS 缓存文件，不允许协议降级。
- 完成文件暂存于数据根目录的 `cache/book-downloads/`，确认导入或取消后清理。任务状态仅存于进程内，服务重启后需重新下载；未完成任务不会显示为成功。终态记录十分钟后过期。
- 前端收到文件后再次核对 SHA-256。导入保留 `providerId / providerBookId / sourceUrl / sourceLicense / contentSha256 / importedAt` 可选字段。
- Z-Library 书籍引用为 `id:hash`，用户逐书确认的来源依据记录为 `user_authorized`；元数据中的未知权利状态仍保持 unknown。
- 同内容文件复用原书籍 ID，保留章节与阅读进度；不同内容或版本不按相同标题自动覆盖。已在书架的同源书籍可直接打开，也可明确选择保留旧版并导入另一版本。

## 验证命令

在 `windows/` 下执行：

```powershell
npm run test:books
node scripts/go.mjs test ./internal/booksources ./internal/httpapi
npm test
npm run typecheck
npm run build
```

真实官方目录测试需显式开启（普通单测不依赖网络）：

```powershell
$env:READX_BOOK_SOURCE_LIVE = '1'
# 如需要，设置 HTTP_PROXY / HTTPS_PROXY 为自己的代理。
node scripts/go.mjs test ./internal/booksources -run TestLiveBookSources -count=1 -v
```

真实测试使用 Project Gutenberg #11《Alice's Adventures in Wonderland》，覆盖 Gutendex 搜索/详情、EPUB/TXT 内容校验和官方 OPDS 搜索/详情/EPUB 下载。

`TestLiveZLibraryProbe` 只访问匿名信息接口。登录、搜索、分页、文件授权、下载、退出、账号失效与凭据隔离使用隔离测试响应覆盖；真实账号的搜索和下载需用户在 ReadX 内连接自己的账号后验证，不将匿名探测或模拟测试称作真实账号全链路成功。

平台同步在仓库根目录执行：

```powershell
node scripts/sync-platforms.mjs
node scripts/sync-platforms.mjs --check
```

## 实施分段对应关系

1. **Provider 框架**：`internal/booksources/provider.go`、`registry.go` 与 `httpapi/book_source_registry.go`，包含权限拒绝、API 鉴权和下载状态测试。
2. **Gutenberg 与下载**：`gutenberg.go`、`download.go`，包含 URL/IP/重定向、文件类型、ZIP 路径与大小测试。
3. **前端与导入**：`api/bookSources.ts`、`useBookDownload.ts`、`BookFinder.tsx` 与现有书架集成，包含客户端校验、取消/重试、旧记录和去重测试。
4. **OPDS**：`opds.go`，使用官方目录，支持相对链接与 Gutenberg URN；XML 禁用 DTD/实体声明，未知权利不下载。
5. **Z-Library**：`zlibrary.go`、`httpapi/zlibrary.go`、`ZLibraryConnection.tsx`，按用户后续许可启用非官方 EAPI；账号连接、搜索详情、逐书确认、服务器文件权限校验与下载导入均已实现。真实账号验收需用户自己登录。

协议依据：[Gutendex API](https://gutendex.com/)、[OPDS 1.2](https://specs.opds.io/opds-1.2)、[Gutenberg 官方 OPDS](https://www.gutenberg.org/ebooks.opds/)。

非官方 EAPI 协议参考：[baroxyton 的移动端接口记录](https://github.com/baroxyton/zlibrary-eapi-documentation)、[heartleo 的 EAPI 字段与响应说明](https://github.com/heartleo/zlib/blob/main/docs/eapi.md)。只参考协议描述，适配器由 ReadX 独立编写。
