import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, buildPnL, parseNumber, normHeader } from '../parse.js';
import { runRules, buildClaim } from '../rules.js';
import { matrix } from './fixture.js';

const NOW = new Date('2026-08-31T10:00:00Z');

test('parseNumber handles RU formats', () => {
  assert.equal(parseNumber('1 234,56'), 1234.56);
  assert.equal(parseNumber('1 234,56'), 1234.56);
  assert.equal(parseNumber('-'), 0);
  assert.equal(parseNumber(''), 0);
  assert.equal(parseNumber('700'), 700);
  assert.equal(parseNumber(60), 60);
});

test('normHeader normalizes ё, case, punctuation', () => {
  assert.equal(normHeader('Вайлдберриз реализовал Товар (Пр)'), 'вайлдберризреализовалтоварпр');
  assert.equal(normHeader('Общая сумма штрафов'), 'общаясуммаштрафов');
});

test('parseReport detects header and rows', () => {
  const p = parseReport(matrix());
  assert.equal(p.ok, true);
  assert.equal(p.headerRow, 0);
  assert.equal(p.rows.length, 10);
  assert.equal(p.reportId, '12345');
  assert.equal(p.rows[0].isSale, true);
  assert.equal(p.rows[4].isReturn, true);
  assert.equal(p.rows[0].toTransfer, 700);
  assert.equal(p.rows[3].logistics, 600);
});

test('parseReport fails cleanly on garbage', () => {
  assert.equal(parseReport([['a', 'b'], [1, 2]]).ok, false);
  assert.equal(parseReport([]).ok, false);
});

test('buildPnL reconciliation totals match the WB formula', () => {
  const p = parseReport(matrix());
  const { totals } = buildPnL(p);
  assert.equal(totals.realizedNet, 2700); // 3600 sales - 900 return
  assert.equal(totals.toTransferNet, 2100); // 2800 - 700
  assert.equal(totals.logistics, 1080); // 180 + 600 + 60 + 240
  assert.equal(totals.penalties, 2300); // 1500 + 800
  assert.equal(totals.storage, 700);
  // 2100 - 1080 - 2300 - 700 + 0 = -1980
  assert.equal(totals.computedPayout, -1980);
});

test('buildPnL groups per article', () => {
  const p = parseReport(matrix());
  const { pnl } = buildPnL(p);
  const noski = pnl.find((a) => a.article === 'ART-1');
  assert.ok(noski);
  assert.equal(noski.qty, 3); // 4 sales - 1 return
  assert.equal(noski.subject, 'Носки');
});

test('rules: flags penalty without ground, keeps known-ground penalty', () => {
  const p = parseReport(matrix());
  const flags = runRules(p, buildPnL(p));
  const pen = flags.find((f) => f.id === 'penalty-no-ground');
  assert.ok(pen, 'penalty-no-ground flag present');
  assert.equal(pen.amount, 1500); // only the blank-ground one; 800 "Маркировка" excluded
  assert.equal(pen.count, 1);
});

test('rules: detects duplicate charges on same Srid', () => {
  const p = parseReport(matrix());
  const flags = runRules(p, buildPnL(p));
  const dup = flags.find((f) => f.id === 'duplicate-charges');
  assert.ok(dup);
  assert.equal(dup.amount, 120); // one extra 120 charge
});

test('rules: flags logistics outlier vs category median', () => {
  const p = parseReport(matrix());
  const flags = runRules(p, buildPnL(p));
  const out = flags.find((f) => f.id === 'logistics-outlier');
  assert.ok(out);
  assert.equal(out.amount, 540); // 600 - median 60
});

test('rules: surfaces storage for review', () => {
  const p = parseReport(matrix());
  const flags = runRules(p, buildPnL(p));
  assert.ok(flags.find((f) => f.id === 'storage-attention'));
});

test('rules: sorted high severity first, then by amount', () => {
  const p = parseReport(matrix());
  const flags = runRules(p, buildPnL(p));
  assert.equal(flags[0].severity, 'high');
  assert.equal(flags[0].id, 'penalty-no-ground'); // 1500 > duplicate 120
});

test('buildClaim produces a filled претензия', () => {
  const p = parseReport(matrix());
  const flags = runRules(p, buildPnL(p));
  const pen = flags.find((f) => f.id === 'penalty-no-ground');
  const claim = buildClaim(pen, { reportId: p.reportId, date: NOW });
  assert.match(claim, /№ 12345/);
  assert.match(claim, /1\s?500,00 ₽/);
  assert.match(claim, /Недельные отчёты/);
  assert.match(claim, /Srid SRID6/);
});
