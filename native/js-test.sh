#!/bin/bash
# app/ 兜底版的 JS 冒烟测试：语法 + 安全回归 + 活体服务行为。
# 不依赖浏览器，只用 node（>=18）。测试全部在临时目录运行，不触碰正式数据。
# 注意：这里刻意不用 `set -e`——某一步失败后仍要继续跑完，才能一次看到全部失败项。
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

for candidate in node /opt/homebrew/bin/node /usr/local/bin/node; do
  if command -v "$candidate" >/dev/null 2>&1; then NODE="$candidate"; break; fi
done
if [ -z "${NODE:-}" ]; then echo "SKIP: 未找到 node，跳过 JS 冒烟测试"; exit 0; fi

fail=0
ok()   { echo "  PASS: $1"; }
bad()  { echo "  FAIL: $1"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: 期望 $3，实际 $2"; fi; }

echo "[1/4] 语法检查"
"$NODE" --check app/server.js   && ok "app/server.js 语法"
"$NODE" --check app/public/app.js && ok "app/public/app.js 语法"
"$NODE" --check app/public/fun.js && ok "app/public/fun.js 语法"

echo "[2/4] 前端函数级安全回归（直接复用 app.js 中的真实实现）"
FRONT="$ROOT/app/public/app.js" "$NODE" - <<'JS'
const fs = require('fs');
const src = fs.readFileSync(process.env.FRONT, 'utf8');
// 从真实文件提取，避免测试里手抄一份走样
const escDef = src.match(/const esc = [\s\S]*?;\n/)[0];
const inlineDef = src.match(/function inline\(s\) \{[\s\S]*?\n\}/)[0];
const mod = { exports: {} };
new Function('module', escDef + '\n' + inlineDef + '\nmodule.exports = { esc, inline };')(mod);
const { esc, inline } = mod.exports;

let fail = 0;
const ok = (n, c) => { console.log((c ? '  PASS: ' : '  FAIL: ') + n); if (!c) fail++; };

const evil = 'Sparse-view CBCT " onmouseover="alert(1)" x="';
ok('H1 esc 阻断属性注入', !`<div data-ctx="${esc(evil)}">`.includes('onmouseover="alert'));
ok('H1 esc 转义单双引号', esc(`a"b'c`) === 'a&quot;b&#39;c');
ok('H1 esc 不破坏正文', esc('33.05/.96 PSNR 34.45') === '33.05/.96 PSNR 34.45');
ok('H5 链接净化阻断 handler', !inline('[click](https://a.com"onmouseover="alert(1))').includes('onmouseover="alert'));
ok('H5 正常链接保留', inline('[x](https://a.com/b?c=1)').includes('href="https://a.com/b?c=1"'));
ok('H5 javascript: 被拒', !inline('[x](javascript:alert(1))').includes('<a '));

// 真实笔记里的双引号不再撑破 data-ctx 属性
const notePath = process.env.NOTE;
if (notePath && fs.existsSync(notePath)) {
  const note = fs.readFileSync(notePath, 'utf8');
  const body = note.split('## 2. 方法核心')[1]?.split('## 3.')[0] ?? '';
  const inner = esc(body.slice(0, 1500));
  const rendered = '<div data-ctx="' + inner + '">';
  ok('H1 真实笔记 data-ctx 结构引号恰为 2', (rendered.match(/"/g) || []).length === 2);
  ok('H1 真实笔记体内引号全部转义',
     (inner.match(/&quot;/g) || []).length === (body.slice(0, 1500).match(/"/g) || []).length);
}
process.exit(fail ? 1 : 0);
JS
[ $? -eq 0 ] || fail=$((fail+1))

echo "[2b/4] Markdown 表格渲染回归"
FRONT="$ROOT/app/public/app.js" REAL="$ROOT/native/acceptance/2026-10-02/verified-v3/NAF-chat-geometry.md" "$NODE" - <<'JS'
const fs = require('fs');
const src = fs.readFileSync(process.env.FRONT, 'utf8');
const escDef = src.match(/const esc = [\s\S]*?;\n/)[0];
const from = src.indexOf('function inline(s)');
const to = src.indexOf('async function api(');
const mod = { exports: {} };
new Function('module', escDef + '\n' + src.slice(from, to) + '\nmodule.exports = { md };')(mod);
const { md } = mod.exports;
let fail = 0;
const ok = (n, c) => { console.log((c ? '  PASS: ' : '  FAIL: ') + n); if (!c) fail++; };

const gfm = '| A | B |\n|---|---:|\n| 1 | 2 |\n| 3 | 4 |';
const h = md(gfm);
ok('表格渲染为 <table>', h.includes('<table>') && h.includes('</table>'));
ok('含表头 th 与 4 个 td', h.includes('<th') && (h.match(/<td/g) || []).length === 4);
ok('右对齐生效', h.includes('text-align:right'));
ok('不再输出字面管道行', !h.includes('<p>| A | B |'));
ok('水平线 -> <hr>', md('---').includes('<hr>'));
ok('表格分隔行不被 hr 吞掉', md('| A |\n|---|\n| 1 |').includes('<table>'));
ok('含竖线普通句不误判为表格', !md('a | b | c').includes('<table>'));
ok('转义管道留在单元格', md('| A | B |\n|---|---|\n| x \\| y | z |').includes('x | y'));
ok('表格前后段落独立', (() => { const r = md('前\n| A |\n|---|\n| 1 |\n后'); return r.includes('<p>前</p>') && r.includes('<p>后</p>') && r.includes('<table>'); })());

if (process.env.REAL && fs.existsSync(process.env.REAL)) {
  const real = fs.readFileSync(process.env.REAL, 'utf8');
  const rh = md(real);
  ok('真实产物渲染出表格', rh.includes('<table>'));
  ok('真实产物保留原始数值', rh.includes('512×512×510') && rh.includes('103'));
  ok('真实产物无字面分隔线', !rh.includes('<p>---</p>'));
}
process.exit(fail ? 1 : 0);
JS
[ $? -eq 0 ] || fail=$((fail+1))

echo "[3/4] 活体服务：C3 / C4 / H7 / H8"
TMP="$(mktemp -d)"
cleanup() { [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p "$TMP/app/public" "$TMP/papers" "$TMP/library"
cp app/server.js "$TMP/app/"
cp app/public/* "$TMP/app/public/"
printf '{"papers":[{"id":"manual-1","title":"Manual"},{"arxiv":"2209.14540","title":"NAF"}]}' > "$TMP/queue.json"
printf -- '---\nid: 2022-naf\narxiv: "2209.14540"\ntitle: "NAF"\n---\n\n## 5. 我的批注\n- 原有\n' > "$TMP/papers/2022-naf.md"
printf '{"baseURL":"http://127.0.0.1:9/v1","apiKey":"sk-test","model":"m"}' > "$TMP/app/config.json"

# 用一个空闲端口，避免与遗留进程冲突
PORT="$("$NODE" -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
( cd "$TMP" && PORT="$PORT" "$NODE" app/server.js ) > "$TMP/srv.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/state" 2>/dev/null; then break; fi
  sleep 0.1
done
B="http://127.0.0.1:$PORT"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check "基础连通 /api/state" "$(code "$B/api/state")" "200"
check "C4 外源 Origin 写入被拒" \
  "$(code -X POST -H 'Origin: https://evil.example' -H 'Content-Type: text/plain' \
       --data '{"arxiv":"2209.14540","noteId":"2022-naf","text":"CSRF"}' "$B/api/reflect/2209.14540")" "403"
check "C3 __proto__ 被拒" \
  "$(code -X POST -H 'Content-Type: application/json' --data '{"step":9,"done":true}' "$B/api/progress/__proto__")" "400"
check "C3 未污染其它论文" \
  "$(curl -s "$B/api/state" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.papers.some(p=>p.done&&p.step===9)?"polluted":"clean")})')" "clean"
check "M5 无匹配笔记不写 progress" \
  "$(code -X POST -H 'Content-Type: application/json' --data '{"done":true}' "$B/api/reflect/no-such-note")" "404"
check "同源写入正常" \
  "$(code -X POST -H 'Content-Type: application/json' \
       --data '{"arxiv":"2209.14540","noteId":"2022-naf","text":"合法批注"}' "$B/api/reflect/2209.14540")" "200"
check "C1/H4 批注小节未重复" "$(grep -c '^## 5. 我的批注' "$TMP/papers/2022-naf.md")" "1"

# H7：library/ 缺失不应 500
rm -rf "$TMP/library"
check "H7 无 library/ 时 /api/state" "$(code "$B/api/state")" "200"

# H8：不可读静态文件不应让进程退出
printf 'x' > "$TMP/app/public/bad.js"; chmod 000 "$TMP/app/public/bad.js"
curl -s -m 3 -o /dev/null "$B/bad.js" || true
sleep 0.5
if kill -0 "$SRV_PID" 2>/dev/null; then ok "H8 不可读文件后进程存活"; else bad "H8 进程退出了"; fi

echo "[4/4] 结果"
if [ "$fail" -eq 0 ]; then echo "JS 冒烟测试全部通过"; exit 0; else echo "$fail 项失败"; exit 1; fi
