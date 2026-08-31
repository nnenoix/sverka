import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, buildPnL } from '../parse.js';

const H = ['Тип документа', 'Обоснование для оплаты', 'Артикул поставщика', 'Предмет', 'Srid', 'Кол-во', 'Вайлдберриз реализовал Товар (Пр)', 'К перечислению Продавцу за реализованный Товар'];
const build = (returnRealized, returnToTransfer) => [
  H,
  ['Продажа', 'Продажа', 'A', 'Носки', 'S1', 1, 900, 700],
  ['Возврат', 'Возврат', 'A', 'Носки', 'S2', 1, returnRealized, returnToTransfer],
];

test('reconciliation is robust to return sign convention', () => {
  const pos = buildPnL(parseReport(build(900, 700))).totals; // raw WB: returns positive
  const neg = buildPnL(parseReport(build(-900, -700))).totals; // processed export: returns negative
  assert.equal(pos.toTransferNet, 0); // 700 - 700
  assert.equal(neg.toTransferNet, 0); // 700 - |−700|
  assert.equal(pos.realizedNet, 0);
  assert.equal(neg.realizedNet, 0);
  assert.deepEqual(pos, neg);
});

test('per-article P&L nets a return regardless of its sign', () => {
  const a1 = buildPnL(parseReport(build(900, 700))).pnl.find((x) => x.article === 'A');
  const a2 = buildPnL(parseReport(build(-900, -700))).pnl.find((x) => x.article === 'A');
  assert.equal(a1.qty, 0); // 1 sale - 1 return
  assert.equal(a2.qty, 0);
  assert.equal(a1.toTransfer, 0);
  assert.equal(a2.toTransfer, 0);
});
