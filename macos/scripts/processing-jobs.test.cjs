const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/src/components/processingJobs.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = { exports: {}, Error };
vm.runInNewContext(code, sandbox);
const { stoppedDocumentJobs, reprocessStoppedJobs } = sandbox.exports;
const job = (key, status, documentKey, stages = []) => ({ key, name: key, status, documentKey, stages });

test('batch selects failed and interrupted documents once, without touching running or cancelled work', () => {
  const jobs = [
    job('failed', 'failed', 'a'), job('interrupted', 'interrupted', 'b'),
    job('duplicate', 'failed', 'a'), job('cancelled', 'cancelled', 'c'),
    job('cancelled-with-failed-stage', 'cancelled', 'z', [{ status: 'failed' }]),
    job('running', 'running', 'd'), job('old-failure', 'failed', 'd'),
    job('active-stage', 'failed', 'e', [{ status: 'running' }]),
    job('stale-stage', 'done', 'f', [{ status: 'interrupted' }]),
    job('done', 'done', 'g'),
  ];
  assert.deepEqual(Array.from(stoppedDocumentJobs(jobs), x => x.key), ['failed', 'interrupted', 'stale-stage']);
});

test('submission continues after a failure and reports the actual result for each document', async () => {
  const jobs = [job('one', 'failed', 'a'), job('two', 'interrupted', 'b'), job('three', 'failed', 'c')];
  const sent = [], progress = [];
  const result = await reprocessStoppedJobs(jobs, async key => { sent.push(key); if (key === 'b') throw new Error('书库中没有这篇论文'); }, (done, total) => progress.push(`${done}/${total}`));
  assert.deepEqual(sent, ['a', 'b', 'c']);
  assert.equal(result.submitted, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].title, 'two');
  assert.equal(result.failures[0].message, '书库中没有这篇论文');
  assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
});
