#!/usr/bin/env node
/**
 * 生成保留排版的译文 PDF。
 *
 * 这是 ReadX 与 RetainPDF 渲染引擎（retain-pdf-rendering，MIT）之间的桥：
 *   rpr_retain_input_v1 -> overlay.pdf（透明叠加层） -> 用 pdf-lib 叠回原 PDF。
 *
 * 由 Go server 以子进程调用；Electron 下用 ELECTRON_RUN_AS_NODE=1 复用自带 Node，
 * 不要求用户另装 Node。
 *
 * 用法：
 *   node render-translated-pdf.cjs --engine <dir> --input <json> --source <pdf>
 *        --output <pdf> --fonts <dir> --report <json>
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { engine: "", input: "", source: "", output: "", fonts: "", report: "", page: "", extract: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new UsageError(`unknown argument ${name}`);
    const key = name.slice(2);
    if (!(key in options)) throw new UsageError(`unknown option --${key}`);
    if (index + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
    const value = argv[++index];
    // --page 是页码（1 起），--extract 是开关：两者保留原值，其余按路径解析。
    options[key] = key === "page" || key === "extract" ? value : path.resolve(value);
  }
  for (const [key, value] of Object.entries(options)) {
    if (key === "page" || key === "extract") continue;
    if (!value) throw new UsageError(`missing --${key}`);
  }
  return options;
}

// 没有可翻译的正文（公式/表格/图片页）：原样抽出一页，不跑排版引擎。
async function copySinglePage(sourcePath, pageNumber, outputPath) {
  const { PDFDocument } = require("pdf-lib");
  const source = await PDFDocument.load(fs.readFileSync(sourcePath));
  const sourcePages = source.getPages();
  if (pageNumber < 1 || pageNumber > sourcePages.length) {
    throw new Error(`页码 ${pageNumber} 超出原 PDF 页数 ${sourcePages.length}`);
  }
  const output = await PDFDocument.create();
  const [copied] = await output.copyPages(source, [pageNumber - 1]);
  output.addPage(copied);
  fs.writeFileSync(outputPath, await output.save());
}

// --page 让阅读器能只重排一页：输入只有一页，输出也只含这一页。
// 不给 --page 时保持原行为（整份叠加层逐页合并回原 PDF）。
async function mergeOverlay(sourcePath, overlayPath, outputPath, pageNumber) {
  const { PDFDocument } = require("pdf-lib");
  const overlay = await PDFDocument.load(fs.readFileSync(overlayPath));
  const overlayPages = overlay.getPages();
  if (pageNumber > 0) {
    const source = await PDFDocument.load(fs.readFileSync(sourcePath));
    const sourcePages = source.getPages();
    if (pageNumber > sourcePages.length) {
      throw new Error(`页码 ${pageNumber} 超出原 PDF 页数 ${sourcePages.length}`);
    }
    if (overlayPages.length !== 1) {
      throw new Error(`单页渲染应只有 1 页叠加层，实际 ${overlayPages.length} 页`);
    }
    const output = await PDFDocument.create();
    const [copied] = await output.copyPages(source, [pageNumber - 1]);
    output.addPage(copied);
    const target = output.getPages()[0];
    const embedded = await output.embedPage(overlayPages[0]);
    target.drawPage(embedded, {
      x: 0,
      y: 0,
      width: target.getWidth(),
      height: target.getHeight(),
    });
    fs.writeFileSync(outputPath, await output.save());
    return;
  }
  const source = await PDFDocument.load(fs.readFileSync(sourcePath));
  const sourcePages = source.getPages();
  if (overlayPages.length !== sourcePages.length) {
    throw new Error(`叠加层页数 ${overlayPages.length} 与原 PDF 页数 ${sourcePages.length} 不一致`);
  }
  for (let index = 0; index < sourcePages.length; index += 1) {
    const target = sourcePages[index];
    const embedded = await source.embedPage(overlayPages[index]);
    target.drawPage(embedded, {
      x: 0,
      y: 0,
      width: target.getWidth(),
      height: target.getHeight(),
    });
  }
  const bytes = await source.save();
  fs.writeFileSync(outputPath, bytes);
}

function loadEngine(engineDir) {
  const root = path.join(engineDir, "engine");
  const entry = path.join(root, "src", "retain", "run.js");
  if (!fs.existsSync(entry)) throw new Error(`找不到渲染引擎入口 ${entry}`);
  for (const dependency of ["fontkit", "mathjax-full"]) {
    try {
      require.resolve(dependency, { paths: [engineDir, path.dirname(root)] });
    } catch {
      throw new Error(`渲染引擎缺少依赖 ${dependency}，请在 windows 目录运行 npm install`);
    }
  }
  return { root, runRetain: require(entry).runRetain };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.extract === "1") {
    // 没有正文可翻译：只抽出原页，报告按 0 块交付，调用方据此显示“保留原页”。
    await copySinglePage(options.source, Number(options.page || 0), options.output);
    const report = {
      engine: { name: "extract", version: "", commit: "" },
      pages: [],
      blocks: [],
      collisions: [],
      math: { failed: [] },
      timings: { totalMs: 0 },
      inputStats: { pages: 1, blocks: 0, extracted: true },
    };
    fs.writeFileSync(options.report, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ ok: true, pages: 0, blocks: 0, overflow: 0, collisions: 0, formulas_failed: 0, ms: 0, extracted: true }) + "\n");
    return;
  }
  const input = JSON.parse(fs.readFileSync(options.input, "utf8"));
  const { runRetain } = loadEngine(options.engine);
  const workDir = fs.mkdtempSync(path.join(path.dirname(options.output), ".render-"));
  try {
    const result = runRetain(input, {
      outDir: workDir,
      output: "pdf",
      typst: { fontPaths: [options.fonts] },
    });
    await mergeOverlay(options.source, result.overlayPdf, options.output, Number(options.page || 0));
    const report = {
      engine: result.report.engine,
      pages: result.report.pages,
      blocks: result.report.blocks,
      collisions: result.report.collisions,
      math: result.report.math,
      timings: result.report.timings,
      inputStats: {
        pages: input.pages.length,
        blocks: input.pages.reduce((total, page) => total + (page.blocks || []).length, 0),
      },
    };
    fs.writeFileSync(options.report, JSON.stringify(report, null, 2));
    process.stdout.write(
      JSON.stringify({
        ok: true,
        pages: report.pages.length,
        blocks: report.blocks.length,
        overflow: report.blocks.filter((block) => block.overflow).length,
        collisions: report.collisions.length,
        formulas_failed: report.math.failed.length,
        ms: report.timings.totalMs,
      }) + "\n",
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const usage = error instanceof UsageError;
  process.stderr.write(
    JSON.stringify({ error: String(error && error.message ? error.message : error).split("\n").join(" | ") }) + "\n",
  );
  process.exitCode = usage ? 2 : 1;
});
