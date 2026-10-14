/**
 * Parity oracle：把旧版 TS 校验链当作基准，对同一份 fixture 输出判定结果。
 *
 * Go 侧的 parity 测试会 spawn 这个脚本，逐条比对 ok 与错误文案——
 * 文案必须逐字相同，因为前端把诊断原文回给模型做修复轮，措辞漂移会让修复提示失效。
 *
 * 用法：node v2/scripts/parity-oracle.cjs <fixture.json> [...]
 */
const path = require('node:path');
const fs = require('node:fs');

const windowsDir = process.env.CBCT_WINDOWS_DIR || path.resolve(__dirname, '..', '..', 'windows');
const evidence = require(path.join(windowsDir, 'dist', 'core', 'evidence.js'));
const result = require(path.join(windowsDir, 'dist', 'core', 'result.js'));
const reproduction = require(path.join(windowsDir, 'dist', 'core', 'reproduction.js'));
const idea = require(path.join(windowsDir, 'dist', 'core', 'idea.js'));
const ai = require(path.join(windowsDir, 'dist', 'main', 'ai.js'));

function run(fixture) {
  const { kind, source, payload, visuals } = fixture;
  if (kind === 'prune-experiment' || kind === 'prune-results') {
    const pruned = ai.pruneGenerated(kind.slice('prune-'.length), typeof payload === 'string' ? payload : JSON.stringify(payload), source);
    if (!pruned) return { pruned: null };
    return { pruned: { value: JSON.parse(pruned.value), demoted: pruned.demoted } };
  }
  switch (kind) {
    case 'extraction':
      evidence.validateExtraction(payload, source);
      evidence.validateConfiguration(payload);
      return;
    case 'evidence':
      evidence.validateEvidence(payload, source);
      return;
    case 'results': {
      const analysis = result.decodeResultsAnalysis(JSON.stringify(payload));
      result.validateBindings(analysis, visuals ?? []);
      result.validateResults(analysis, source);
      return;
    }
    case 'reproduction': {
      const analysis = reproduction.decodeReproductionAnalysis(JSON.stringify(payload));
      reproduction.validateReproductionAnalysis(analysis, source);
      return;
    }
    case 'idea':
      idea.validateIdeaEvidence(payload, source);
      return;
    default:
      throw new Error(`未知 fixture kind: ${kind}`);
  }
}

for (const file of process.argv.slice(2)) {
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  let line;
  if (fixture.kind === 'prune-experiment' || fixture.kind === 'prune-results') {
    const outcome = run(fixture);
    line = { name: fixture.name, kind: fixture.kind, pruned: outcome.pruned };
  } else {
    let verdict = { name: fixture.name, ok: true, error: '' };
    try {
      run(fixture);
    } catch (error) {
      verdict = { name: fixture.name, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    line = verdict;
  }
  process.stdout.write(JSON.stringify(line) + '\n');
}
