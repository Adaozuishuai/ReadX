/* Regression checks for source preservation, figure routing and the native PPTX file. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const JSZip = require('jszip');
const sizeModule = require('image-size');
const sizeOf = sizeModule.imageSize || sizeModule.default || sizeModule;
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
const design = require('../apps/web/src/lib/presentationDesign.ts');
const { buildReadingDeck, generateReadingDeck } = require('../apps/web/src/lib/presentation.ts');

async function main() {
  const allowed = new Set(['motivation', 'method', 'experiment', 'results']);
  assert.equal(design.normalizePlannedSlide({ section: 'invalid', title: 'x', bullets: ['y'] }, allowed), null);
  assert.equal(design.normalizePlannedSlide({ section: 'method', title: 'x', bullets: ['y'], layout: 'constructor' }, allowed).layout, undefined);
  const longPoints = Array.from({ length: 8 }, (_, i) => `第${i}项：保留原文数值${i + 1}.25及其对应实验条件。`);
  assert.deepEqual(design.paginatePoints(longPoints).flat(), longPoints);
  const wideTable = { header: ['方法', 'A', 'B', 'C', 'D', 'E', 'F'], rows: Array.from({ length: 8 }, (_, r) => Array.from({ length: 7 }, (_, c) => `cell-${r}-${c}`)) };
  const chunks = design.paginateTable(wideTable);
  for (const row of wideTable.rows) for (const cell of row) assert.ok(chunks.some((t) => t.rows.flat().includes(cell)), `Lost ${cell}`);

  const imagePath = process.env.READX_PPT_QA_IMAGE;
  const data = imagePath ? fs.readFileSync(imagePath) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVS8AAAAASUVORK5CYII=', 'base64');
  const imageURL = `data:image/png;base64,${data.toString('base64')}`;
  const notes = (body) => ({ value: body, narrative: body, demoted: [], validationError: null, updatedAt: '' });
  const input = {
    document: { title: 'ReadX 学术演示稿 · 版式验证样例', authors: ['ReadX'], year: 2026 },
    entries: {
      motivation: notes('问题定义：呈现论文的研究问题与适用条件。'),
      method: notes('方法流程：输入、特征表示与预测输出。'),
      experiment: notes('| 实验条件 | 设置 | 指标 |\n| --- | --- | --- |\n| 数据划分 | 固定训练集与测试集 | 保持协议一致 |\n| 图像尺寸 | 256 × 256 | 与基线相同 |\n| 实验次数 | 3 次独立实验 | 报告均值与标准差 |'),
      results: notes('示例数据，仅用于检验排版，不代表论文实验结果。'),
    },
    visuals: [{ id: 'figure-method', imageURL, extractionStatus: 'ready', reviewStatus: 'automatic' }],
    analyses: [{ id: 'figure-method', step: 'method', page: 2, caption: '原文页面：检查图像完整性与等比例显示', analysis: '保留原始图像的完整边界。\n图像与分析文字分开排布。', revision: 'fixture' }],
    plan: { slides: [
      { section: 'motivation', title: '研究问题与适用条件', layout: 'editorial', bullets: ['清晰地定义问题，是组织整场研究汇报的起点。', '问题背景：说明应用场景及其约束，保留与研究结论有关的前提。', '研究目标：准确表达论文要解决的具体问题。'], takeaway: '每页围绕一个明确的问题展开。', visualIds: ['not-a-real-figure'] },
      { section: 'motivation', title: '现有方法与研究思路', layout: 'comparison', bullets: ['现有方法：说明论文报告的适用范围与局限，保留必要的实验条件。', '研究思路：围绕这些局限提出具体方法，并由后续实验检验。'] },
      { section: 'method', title: '从输入到预测的处理流程', layout: 'process', bullets: ['输入准备：统一数据与预处理协议。', '特征表示：整理模型所需的局部与全局信息。', '预测输出：得到模型输出，并与原文定义保持一致。'] },
      { section: 'method', title: '原图与方法解释在同一页呈现', layout: 'evidence', bullets: ['原文证据：完整保留原图，不拉伸或裁去边缘信息。', '方法解释：相关说明放在原图右侧，保持稳定的阅读顺序。'], visualIds: ['figure-method', 'figure-method'] },
      { section: 'results', title: '定量结果的视觉层级（示例数据）', layout: 'metrics', bullets: ['准确率：示例值为 92.4%，需同时保留数据集与测试条件。', '图像质量：示例提升为 1.5 dB，应明确对应的比较对象。', '推理时间：示例耗时为 24 ms，需报告硬件与输入尺寸。'] },
      { section: 'results', title: '结论与证据保持一致', layout: 'focus', bullets: ['保留支持研究结论的实验条件和限制。', '将局部实验现象推广为普遍结论，需要额外证据。', '未经报告的数值和实验结果不加入演示稿。'] },
    ] },
  };
  const scenes = buildReadingDeck(input);
  const stressed = buildReadingDeck({ ...input, plan: { slides: input.plan.slides.map((slide) => ({ ...slide, bullets: slide.bullets.map((p) => p.repeat(8)), takeaway: '保留完整证据，同时维持简洁版面。'.repeat(12) })) } });
  for (const scene of stressed) for (const node of scene.nodes) if (node.kind === 'text') assert.ok(node.lines.length * node.lineHeight <= node.h + .04, `Dense-content overflow: ${scene.title} / ${node.text}`);
  const pale = design.readableTheme({ ...design.DEFAULT_PRESENTATION_THEME, accentDark: 'FFFFFF', ink: 'FFFFFF' });
  assert.notEqual(pale.accentDark, 'FFFFFF', 'A pale template still has a readable cover');
  assert.notEqual(pale.ink, 'FFFFFF', 'A white template still has readable body text');
  const images = scenes.flatMap((scene) => scene.nodes.filter((node) => node.kind === 'image'));
  assert.equal(images.length, 1, 'An original figure is embedded only once');
  assert.equal(scenes.find((scene) => scene.nodes.includes(images[0])).section, 'method');
  for (const scene of scenes) for (const node of scene.nodes) {
    assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.w <= design.SLIDE_WIDTH + .02, `${scene.title}: horizontal overflow`);
    if (node.kind !== 'line') assert.ok(node.y + node.h <= design.SLIDE_HEIGHT + .02, `${scene.title}: vertical overflow`);
    if (node.kind === 'text') assert.ok(node.lines.length * node.lineHeight <= node.h + .04, `${scene.title}: text overflow: ${node.text}`);
  }
  const output = path.resolve(__dirname, '../.codex-tmp/ppt-redesign');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'scenes.json'), JSON.stringify(scenes, null, 2));
  global.Image = class { set src(value) { const dimensions = sizeOf(Buffer.from(value.split(',')[1], 'base64')); this.naturalWidth = dimensions.width; this.naturalHeight = dimensions.height; queueMicrotask(() => this.onload()); } };
  process.chdir(output);
  const result = await generateReadingDeck(input);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(output, result.fileName)));
  const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideFiles.length, scenes.length, 'Export and preview have identical page counts');
  const xml = (await Promise.all(slideFiles.map((name) => zip.file(name).async('string')))).join('\n');
  assert.ok(xml.includes('Microsoft YaHei') && xml.includes('Times New Roman'), 'Both required fonts are present');
  for (const match of xml.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
    const value = /<a:t>([\s\S]*?)<\/a:t>/.exec(match[1])?.[1];
    if (value && /^\d/.test(value)) assert.ok(match[1].includes('Times New Roman'), `Wrong numeric font: ${value}`);
  }
  assert.ok(xml.includes('<a:tbl>'), 'Data tables remain editable native tables');
  const picture = /<p:pic>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>[\s\S]*?<\/p:pic>/.exec(xml);
  assert.ok(picture, 'The source image is embedded');
  const dimensions = sizeOf(data);
  assert.ok(Math.abs(Number(picture[1]) / Number(picture[2]) - dimensions.width / dimensions.height) < .001, 'Image aspect ratio is preserved');
  console.log(`PASS: plan validation, source pagination, figure routing, bounds, fonts, native tables and proportional images (${result.slides} slides).`);
  console.log(path.join(output, result.fileName));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
