import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHeader, parseReport, buildPnL } from '../parse.js';

// The EXACT header row of a real WB "Детализация отчёта о реализации"
// (from a real report in the owner's Drive, «Отчет 16.02-22.02 ….xlsx»).
// 81 columns. This locks the parser to the real schema.
const REAL_HEADER = [
  '№', 'Номер поставки', 'Предмет', 'Код номенклатуры', 'Бренд', 'Артикул поставщика', 'Название', 'Размер', 'Баркод',
  'Тип документа', 'Обоснование для оплаты', 'Дата заказа покупателем', 'Дата продажи', 'Кол-во', 'Цена розничная',
  'Вайлдберриз реализовал Товар (Пр)', 'Согласованный продуктовый дисконт, %', 'Промокод, %',
  'Итоговая согласованная скидка, %', 'Цена розничная с учетом согласованной скидки',
  'Размер снижения кВВ из-за рейтинга, %', 'Размер изменения кВВ из-за акции, %', 'Скидка постоянного Покупателя (СПП), %',
  'Размер кВВ, %', 'Размер кВВ без НДС, % Базовый', 'Итоговый кВВ без НДС, %',
  'Вознаграждение с продаж до вычета услуг поверенного, без НДС', 'Возмещение за выдачу и возврат товаров на ПВЗ',
  'Эквайринг/Комиссии за организацию платежей', 'Размер комиссии за эквайринг/Комиссии за организацию платежей, %',
  'Экваринг с цены реализации', 'Эквайринг с цены до вычета СПП', 'Тип платежа за Эквайринг/Комиссии за организацию платежей',
  'Вознаграждение Вайлдберриз (ВВ), без НДС', 'НДС с Вознаграждения Вайлдберриз',
  'К перечислению Продавцу за реализованный Товар', 'Количество доставок', 'Количество возврата',
  'Услуги по доставке товара покупателю', 'Дата начала действия фиксации', 'Дата конца действия фиксации',
  'Признак услуги платной доставки', 'Общая сумма штрафов', 'Корректировка Вознаграждения Вайлдберриз (ВВ)',
  'Виды логистики, штрафов и корректировок ВВ', 'Стикер МП', 'Наименование банка-эквайера', 'Номер офиса',
  'Наименование офиса доставки', 'ИНН партнера', 'Партнер', 'Склад', 'Страна', 'Тип коробов',
  'Номер таможенной декларации', 'Номер сборочного задания', 'Код маркировки', 'ШК', 'Srid',
  'Возмещение издержек по перевозке/по складским операциям с товаром', 'Организатор перевозки', 'Хранение',
  'Удержания', 'Операции на приемке', 'Фиксированный коэффициент склада по поставке',
  'Признак продажи юридическому лицу', 'Номер короба для обработки товара', 'Скидка по программе софинансирования',
  'Скидка Wibes, %', 'Компенсация скидки по программе лояльности', 'Стоимость участия в программе лояльности',
  'Сумма удержанная за начисленные баллы программы лояльности', 'Id корзины заказа',
  'Разовое изменение срока перечисления денежных средств', 'Id собственной акции продавца с дополнительной скидкой',
  'Размер дополнительной скидки по собственной акции продавца, %', 'Способы продажи и тип товара',
  'Уникальный идентификатор скидки лояльности от продавца', 'Размер скидки лояльности от продавца,%',
  'Id промокода', 'Скидка за промокод, %',
];

test('detectHeader maps every critical column to its real index (81-col schema)', () => {
  const { row, cols, score } = detectHeader([REAL_HEADER]);
  assert.equal(row, 0);
  assert.ok(score >= 15, `expected many matches, got ${score}`);
  const expect = {
    subject: 2, article: 5, barcode: 8, docType: 9, ground: 10, qty: 13, price: 14,
    realized: 15, commission: 33, toTransfer: 35, deliveries: 36, returns: 37,
    logistics: 38, penalties: 42, opType: 44, srid: 58, storage: 61, other: 62,
    acceptance: 63, warehouseCoef: 64,
  };
  for (const [key, idx] of Object.entries(expect)) {
    assert.equal(cols[key], idx, `column "${key}" should map to index ${idx}, got ${cols[key]}`);
  }
  // "Цена розничная" (14) must win over "Цена розничная с учетом…" (19)
  assert.equal(cols.price, 14);
});

test('parseReport + buildPnL work on real-schema rows (sale + separate logistics row)', () => {
  const row = (over) => {
    const r = new Array(81).fill('');
    r[9] = over.doc || ''; r[10] = over.ground || '';
    r[13] = over.qty ?? 0; r[14] = over.price ?? 0; r[15] = over.realized ?? 0;
    r[35] = over.toTransfer ?? 0; r[38] = over.logistics ?? 0; r[42] = over.penalties ?? 0;
    r[58] = over.srid || ''; r[61] = over.storage ?? 0; r[63] = over.acceptance ?? 0;
    r[5] = over.article || ''; r[2] = over.subject || '';
    return r;
  };
  const matrix = [
    REAL_HEADER,
    row({ doc: 'Продажа', ground: 'Продажа', article: 'braidp2_gray', subject: 'Оплетки', qty: 1, price: 769, realized: 489, toTransfer: 549.33, srid: 'S1' }),
    row({ ground: 'Логистика', article: 'braidp2_gray', subject: 'Оплетки', logistics: 222.64, srid: 'S1' }),
    row({ ground: 'Хранение', article: 'braidp2_gray', subject: 'Оплетки', storage: 413.21 }),
    row({ doc: 'Продажа', ground: 'Продажа', article: 'toy', subject: 'Игрушка', qty: 1, price: 3486, realized: 3104, toTransfer: 2211, srid: 'S2', acceptance: 15 }),
  ];
  const p = parseReport(matrix);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 4);
  const { totals } = buildPnL(p);
  assert.equal(totals.toTransferNet, 549.33 + 2211);
  assert.equal(totals.logistics, 222.64);
  assert.equal(totals.storage, 413.21);
  assert.equal(totals.acceptance, 15); // "Операции на приемке" now detected
  // 2760.33 - 222.64 - 0 - 413.21 - 15 = 2109.48
  assert.equal(Math.round(totals.computedPayout * 100) / 100, 2109.48);
});
