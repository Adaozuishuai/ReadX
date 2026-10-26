const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const filename = path.join(__dirname, '../apps/web/src/lib/researchWorkbench.ts');
const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(source, sandbox, { filename });
const model = sandbox.exports;

test('legacy academic notes migrate once while preserving counts and daily records', () => {
  const todo = { id: 't', title: 'Existing task', priority: 'high', due: '', done: false };
  const log = { id: 'l', day: '2026-10-26', text: 'Existing note', minutes: 25 };
  const data = model.normalizeWorkbench({
    todos: [todo], logs: [log], publications: 5,
    publicationRecords: 'Paper A｜MICCAI｜2025｜First author\nPaper B|Nature|2026|Coauthor',
    requirements: 'Finish coursework\n\nDefend dissertation',
  });
  assert.equal(data.todos[0], todo);
  assert.equal(data.logs[0], log);
  assert.equal(data.papers.length, 2);
  assert.equal(data.papers[1].venue, 'Nature');
  assert.equal(data.requirementItems.length, 2);
  assert.equal(model.publicationCount(data), 5);
  const reloaded = model.normalizeWorkbench(JSON.parse(JSON.stringify(data)));
  assert.equal(reloaded.papers.length, 2);
  assert.equal(reloaded.requirementItems.length, 2);
  assert.equal(model.publicationCount(reloaded), 5);
});

test('focus completion is recorded once at the scheduled date, including after reopening', () => {
  const end = new Date('2026-10-25T23:50:00').getTime();
  const data = model.normalizeWorkbench({
    todos: [{ id: 't', title: 'Read the paper', priority: 'medium', due: '', done: false }],
    focusSession: { id: 'session', minutes: 25, remaining: 1500, endsAt: end, todoId: 't' },
  });
  assert.equal(model.finishFocusSession(data, end - 1), data);
  const finished = model.finishFocusSession(data, end + 86400000);
  assert.equal(finished.focusSession, null);
  assert.equal(finished.logs.length, 1);
  assert.equal(finished.logs[0].day, '2026-10-25');
  assert.equal(finished.logs[0].minutes, 25);
  assert.ok(finished.logs[0].text.includes('Read the paper'));
  assert.equal(model.finishFocusSession(finished, end + 90000000), finished);
});

test('a paused focus session never completes while the user is away', () => {
  const data = model.normalizeWorkbench({ focusSession: { id: 'paused', minutes: 25, remaining: 300, endsAt: null, todoId: '' } });
  assert.equal(model.finishFocusSession(data, Date.now() + 86400000), data);
});

test('degree dates clamp leap days and handle enrollment in the future and completed terms', () => {
  const leap = model.studyProgress('2024-02-29', 2, new Date('2025-02-28T12:00:00'));
  assert.equal(model.localDay(leap.finish), '2026-02-28');
  assert.ok(leap.percent > 40 && leap.percent < 60);
  const future = model.studyProgress('2027-09-01', 2.5, new Date('2026-10-26T12:00:00'));
  assert.equal(future.percent, 0);
  assert.equal(future.currentYear, 0);
  assert.equal(model.localDay(future.finish), '2030-03-01');
  const past = model.studyProgress('2020-09-01', 4, new Date('2026-10-26T12:00:00'));
  assert.equal(past.percent, 100);
  assert.equal(past.remainingDays, 0);
  assert.equal(model.studyProgress('', 4), null);
});

test('deadline filters retain overdue tasks and exclude completed and unscheduled tasks', () => {
  const make = (id, due, done = false, priority = 'medium') => ({ id, title: id, due, done, priority });
  const todos = [make('later', '2026-11-10'), make('today', '2026-10-26'), make('overdue', '2026-10-25'), make('unscheduled', ''), make('done', '2026-10-26', true), make('next-week', '2026-11-01')];
  assert.deepEqual([...model.selectTodos(todos, 'today', '2026-10-26')].map(todo => todo.id), ['overdue', 'today']);
  assert.deepEqual([...model.selectTodos(todos, 'week', '2026-10-26')].map(todo => todo.id), ['today', 'next-week']);
  assert.deepEqual([...model.selectTodos(todos, 'done', '2026-10-26')].map(todo => todo.id), ['done']);
});

test('weekly focus totals use seven local calendar days, including across year boundaries', () => {
  const activity = model.weekActivity([
    { id: 'old', day: '2025-12-25', text: '', minutes: 60 },
    { id: 'a', day: '2025-12-31', text: '', minutes: 25 },
    { id: 'b', day: '2026-01-01', text: '', minutes: 45 },
    { id: 'c', day: '2026-01-01', text: '', minutes: 15 },
    { id: 'future', day: '2026-01-02', text: '', minutes: 90 },
  ], '2026-01-01');
  assert.equal(activity.length, 7);
  assert.equal(activity[0].day, '2025-12-26');
  assert.equal(activity[6].minutes, 60);
  assert.equal(activity.reduce((sum, day) => sum + day.minutes, 0), 85);
});

test('only accepted and published records count toward the publication target', () => {
  const data = model.normalizeWorkbench({ publicationBaseline: 2, papers: ['draft', 'submitted', 'revision', 'accepted', 'published'].map((status, index) => ({ id: String(index), title: status, venue: '', year: '', role: '', status })) });
  assert.equal(model.publicationCount(data), 4);
});

test('stopwatch keeps millisecond precision across pauses and records a short session in seconds', () => {
  let data = model.normalizeWorkbench({ focusMode: 'stopwatch', focusSession: model.startFocusSession('stopwatch', 25, '', 1000, 'up') });
  assert.equal(model.focusSeconds(data.focusSession, 1000), 0);
  data = model.toggleFocusSession(data, 6500);
  assert.equal(model.isFocusRunning(data.focusSession), false);
  assert.equal(model.focusSeconds(data.focusSession, 3606500), 5);
  data = model.toggleFocusSession(data, 3606500);
  assert.equal(model.isFocusRunning(data.focusSession), true);
  const finished = model.finishFocusSession(data, 3609500, true);
  assert.equal(finished.focusSession, null);
  assert.equal(finished.logs[0].seconds, 8);
  assert.equal(finished.logs[0].minutes, 0);
  assert.equal(model.logFocusLabel(finished.logs[0]), '8 秒');
  assert.equal(model.finishFocusSession(finished, 4000000, true), finished);
});

test('a running stopwatch survives reload and never auto-completes as a zero-minute countdown', () => {
  const initial = model.normalizeWorkbench({ focusSession: model.startFocusSession('stopwatch', 0, '', 1000, 'reload') });
  const restored = model.normalizeWorkbench(JSON.parse(JSON.stringify(initial)));
  assert.equal(restored.focusMode, 'stopwatch');
  assert.equal(model.focusSeconds(restored.focusSession, 62000), 61);
  assert.equal(model.finishFocusSession(restored, 86400000), restored);
  assert.equal(restored.logs.length, 0);
});

test('countdown pause excludes time away and early completion records only elapsed focus', () => {
  let data = model.normalizeWorkbench({ focusSession: model.startFocusSession('countdown', 25, '', 0, 'down') });
  data = model.toggleFocusSession(data, 60000);
  assert.equal(data.focusSession.remaining, 1440);
  assert.equal(model.focusSeconds(data.focusSession, 3600000), 1440);
  data = model.toggleFocusSession(data, 3600000);
  assert.equal(data.focusSession.endsAt, 5040000);
  const finished = model.finishFocusSession(data, 3660000, true);
  assert.equal(finished.logs[0].seconds, 120);
  assert.equal(finished.logs[0].minutes, 2);
});

test('both timer modes format long sessions without wrapping at sixty minutes', () => {
  assert.equal(model.formatFocusClock(0), '00:00');
  assert.equal(model.formatFocusClock(3599), '59:59');
  assert.equal(model.formatFocusClock(3661), '1:01:01');
  assert.equal(model.formatFocusClock(-5), '00:00');
});

test('short focus sessions accumulate without losing their seconds in daily totals', () => {
  const logs = Array.from({ length: 3 }, (_, i) => ({ id: String(i), day: '2026-10-26', text: '', minutes: 0, seconds: 20 }));
  assert.equal(model.totalFocusMinutes(logs), 1);
  assert.equal(model.weekActivity(logs, '2026-10-26')[6].minutes, 1);
});

test('the application controller completes countdowns without mounting the workbench view', () => {
  let now = 1000;
  let data;
  const effects = [];
  const timers = [];
  const events = new Map();
  const seed = model.normalizeWorkbench({ focusSession: model.startFocusSession('countdown', 1, '', now, 'global') });
  const dependencies = {
    react: {
      useState(initial) { data = initial(); return [data, update => { data = typeof update === 'function' ? update(data) : update; }]; },
      useEffect(effect) { effects.push(effect); },
    },
    '../lib/storage': { readJSON: () => seed, writeJSON() {}, STORAGE_KEYS: { researchWorkbench: 'test' } },
    '../lib/researchWorkbench': model,
  };
  const hookFile = path.join(__dirname, '../apps/web/src/hooks/useResearchWorkbench.ts');
  const hookSource = ts.transpileModule(fs.readFileSync(hookFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const hookSandbox = {
    exports: {}, require: name => { assert.ok(name in dependencies); return dependencies[name]; },
    Date: class extends Date { static now() { return now; } },
    window: { setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {}, addEventListener(name, fn) { events.set(name, fn); }, removeEventListener() {} },
    document: { addEventListener(name, fn) { events.set(name, fn); }, removeEventListener() {} },
  };
  vm.runInNewContext(hookSource, hookSandbox, { filename: hookFile });
  hookSandbox.exports.useResearchWorkbench();
  const cleanup = effects.map(effect => effect());
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60000);
  now = 61000;
  timers[0].fn();
  assert.equal(data.focusSession, null);
  assert.equal(data.logs[0].minutes, 1);
  events.get('focus')();
  events.get('visibilitychange')();
  assert.equal(data.logs.length, 1);
  cleanup.forEach(fn => fn?.());
});
