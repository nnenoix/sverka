import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, buildPnL } from '../parse.js';
import { runRules } from '../rules.js';

const H = ['Тип документа', 'Обоснование для оплаты', 'Артикул поставщика', 'Предмет', 'Srid', 'Кол-во', 'Вайлдберриз реализовал Товар (Пр)', 'К перечислению Продавцу за реализованный Товар', 'Удержания'];

test('"Возмещение за выдачу и возврат товаров на ПВЗ" is NOT counted as a return', () => {
  const matrix = [
    H,
    ['Продажа', 'Продажа', 'A', 'Носки', 'S1', 1, 900, 700, 0],
    ['', 'Возмещение за выдачу и возврат товаров на ПВЗ', 'A', 'Носки', 'S2', 1, 0, 0, 0],
  ];
  const p = parseReport(matrix);
  const pnl = buildPnL(p);
  assert.equal(pnl.salesCount, 1);
  assert.equal(pnl.returnsCount, 0); // reimbursement line excluded from returns
  assert.equal(p.rows[1].isReturn, false);
});

test('large "Прочие удержания" is surfaced for review', () => {
  const matrix = [
    H,
    ['Продажа', 'Продажа', 'A', 'Носки', 'S1', 1, 900, 700, 0],
    ['Удержание', 'Удержание', '', '', '', 0, 0, 0, 5000],
  ];
  const p = parseReport(matrix);
  const pnl = buildPnL(p);
  assert.equal(pnl.totals.other, 5000);
  const flag = runRules(p, pnl).find((f) => f.id === 'other-attention');
  assert.ok(flag, 'other-attention flag present');
  assert.equal(flag.amount, 5000);
});
