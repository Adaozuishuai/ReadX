import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

const compile = (source) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64');
const matches = compile(await readFile(new URL('./findMatches.ts', import.meta.url), 'utf8'));
const references = await import(compile((await readFile(new URL('./pdfReferences.ts', import.meta.url), 'utf8')).replace("'./findMatches'", JSON.stringify(matches))));

const viewport = {
  width: 600, height: 800,
  convertToViewportPoint: (x, y) => [x, 800 - y],
  convertToViewportRectangle: ([x1, y1, x2, y2]) => [x1, 800 - y1, x2, 800 - y2],
};
const line = (str, y) => ({ str, hasEOL: true, transform: [1, 0, 0, 12, 40, y], height: 12 });
const page = (items = [], annotations = []) => ({
  view: [0, 0, 600, 800], getViewport: () => viewport,
  getTextContent: async () => ({ items }), getAnnotations: async () => annotations,
});

test('native named destinations resolve page refs and exact reference coordinates', async () => {
  const doc = {
    numPages: 3,
    getDestination: async (name) => { assert.equal(name, 'ref.one'); return [{ num: 8, gen: 0 }, { name: 'XYZ' }, 100, 650, null]; },
    getPageIndex: async (ref) => { assert.deepEqual(ref, { num: 8, gen: 0 }); return 1; },
    getPage: async (number) => { assert.equal(number, 2); return page(); },
  };
  assert.deepEqual(await references.resolvePDFDestination(doc, 'ref.one'), { page: 2, x: 1 / 6, y: 150 / 800 });
});

test('explicit destinations accept page index zero and FitH; invalid targets reject', async () => {
  const doc = { numPages: 2, getPage: async () => page(), getDestination: async () => null };
  assert.deepEqual(await references.resolvePDFDestination(doc, [0, { name: 'FitH' }, 500]), { page: 1, x: 0, y: 300 / 800 });
  await assert.rejects(references.resolvePDFDestination(doc, [20, { name: 'Fit' }]));
  await assert.rejects(references.resolvePDFDestination(doc, 'missing'));
});

test('annotation links retain internal targets and safe URLs with viewport geometry', async () => {
  const links = await references.pdfPageLinks(page([], [
    { subtype: 'Link', rect: [60, 700, 90, 712], dest: 'ref.one' },
    { subtype: 'Link', rect: [60, 600, 90, 612], url: 'https://doi.org/10.1000/test' },
    { subtype: 'Link', rect: [60, 500, 90, 512], url: 'javascript:alert(1)' },
  ]));
  assert.equal(links.length, 2);
  assert.deepEqual(links[0].target, { kind: 'destination', destination: 'ref.one' });
  assert.equal(links[0].x, 0.1);
  assert.equal(links[0].y, 88 / 800);
  assert.equal(links[1].url, 'https://doi.org/10.1000/test');
});

test('unlinked citations index bibliography entries, excluding in-body numbers', async () => {
  let reads = 0;
  const pages = [
    page([line('[2] A citation in the body is not a bibliography entry.', 700)]),
    page([line('7. References', 740), line('[1] First published work', 700), line('2. Second published work', 640)]),
    page([line('[12] Twelfth work', 740)]),
  ];
  const doc = { numPages: 3, getPage: async (number) => { reads++; return pages[number - 1]; } };
  const targets = await references.pdfReferenceTargets(doc);
  assert.equal(targets.get(1).page, 2);
  assert.deepEqual(targets.get(2), { page: 2, x: 40 / 600, y: 140 / 800 });
  assert.equal(targets.get(12).page, 3);
  assert.equal(await references.pdfReferenceTargets(doc), targets);
  assert.equal(reads, 3);
});
