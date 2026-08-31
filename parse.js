// parse.js — pure, DOM-free parsing of the Wildberries "Детализация отчёта
// о реализации" (weekly report). Operates on a matrix (array of arrays) so it
// is testable without SheetJS. The app feeds it XLSX.utils.sheet_to_json(ws,{header:1}).

// Canonical column -> normalized header aliases (see normHeader).
const COLUMN_ALIASES = {
  reportId: ['номеротчета', 'отчет', 'реализациid', 'realizationreportid'],
  docType: ['типдокумента'],
  ground: ['обоснованиедляоплаты'],
  subject: ['предмет'],
  brand: ['бренд'],
  article: ['артикулпоставщика', 'артикулпродавца', 'артикул'],
  name: ['название', 'наименование'],
  size: ['размер'],
  barcode: ['баркод', 'штрихкод'],
  srid: ['srid', 'срид'],
  qty: ['колво', 'количество'],
  price: ['ценарозничная', 'ценарозничнаявруб'],
  realized: ['вайлдберризреализовалтоварпр', 'вайлдберризреализовалтовар', 'вайлдберризреализовал'],
  commission: ['вознаграждениевайлдберризввбезндс', 'вознаграждениевайлдберризвв', 'вознаграждениевайлдберриз'],
  toTransfer: [
    'кперечислениюпродавцузареализованныйтовар',
    'кперечислениюпродавцузареализованный',
    'кперечислениюзатовар',
  ],
  logistics: ['услугиподоставкетоварапокупателю', 'стоимостьлогистики', 'логистика'],
  penalties: ['общаясуммаштрафов', 'штрафы', 'штраф'],
  storage: ['хранение', 'стоимостьхранения'],
  acceptance: ['операциинаприемке', 'платнаяприемка', 'стоимостьплатнойприемки', 'операциипоприемке', 'операцииприприемке'],
  other: ['удержания', 'прочиеудержания'],
  doplaty: ['доплаты'],
  opType: ['видылогистикиштрафовидоплат', 'видылогистикиштрафовикорректировоквв', 'видылогистикиштрафов'],
  deliveries: ['колводоставок', 'количестводоставок'],
  returns: ['количествовозврата', 'колвовозврата', 'количествовозвратов', 'колвовозвратов'],
  warehouseCoef: ['фиксированныйкоэффициентскладапопоставке', 'коэффициентсклада'],
};

// Columns that hold money we sum as charges/credits.
export const CHARGE_KEYS = ['logistics', 'penalties', 'storage', 'acceptance', 'other'];

export function normHeader(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/g, '');
}

export function parseNumber(v) {
  if (v == null || v === '' || v === '-') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).replace(/[\s ]/g, '');
  // Russian decimal comma -> dot; strip everything but digits, dot, minus.
  s = s.replace(',', '.').replace(/[^0-9.\-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Find the header row (the one matching the most known aliases) and build a
// map canonicalKey -> column index.
export function detectHeader(matrix) {
  const flatAliases = Object.entries(COLUMN_ALIASES);
  let best = { row: -1, score: 0, cols: {} };
  const scanTo = Math.min(matrix.length, 15);
  for (let r = 0; r < scanTo; r++) {
    const row = matrix[r] || [];
    const normed = row.map(normHeader);
    const cols = {};
    let score = 0;
    for (const [key, aliases] of flatAliases) {
      const idx = normed.findIndex((h) => h && aliases.includes(h));
      if (idx !== -1) {
        cols[key] = idx;
        score++;
      }
    }
    if (score > best.score) best = { row: r, score, cols };
  }
  return best;
}

function isSaleGround(g) {
  return /продаж/i.test(g) && !/возмещ/i.test(g);
}
function isReturnGround(g) {
  // Exclude "Возмещение за выдачу и возврат товаров на ПВЗ" — it contains
  // "возврат" but is a reimbursement line, not an actual return.
  return /возврат/i.test(g) && !/возмещ/i.test(g);
}

/**
 * Parse a WB detalization matrix into normalized rows + column map.
 * Returns { ok, headerRow, columns, rows, reportId }.
 */
export function parseReport(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return { ok: false, reason: 'empty', rows: [] };
  const head = detectHeader(matrix);
  if (head.score < 4) return { ok: false, reason: 'headers-not-found', score: head.score, rows: [] };

  const c = head.cols;
  const get = (row, key) => (c[key] != null ? row[c[key]] : undefined);
  const num = (row, key) => parseNumber(get(row, key));
  const str = (row, key) => {
    const v = get(row, key);
    return v == null ? '' : String(v).trim();
  };

  const rows = [];
  let reportId = '';
  for (let r = head.row + 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || row.every((v) => v == null || v === '')) continue;
    const ground = str(row, 'ground');
    const docType = str(row, 'docType');
    if (!reportId) reportId = str(row, 'reportId');
    rows.push({
      index: r,
      reportId: str(row, 'reportId'),
      docType,
      ground,
      opType: str(row, 'opType'),
      subject: str(row, 'subject'),
      article: str(row, 'article'),
      name: str(row, 'name'),
      barcode: str(row, 'barcode'),
      srid: str(row, 'srid'),
      qty: num(row, 'qty'),
      price: num(row, 'price'),
      realized: num(row, 'realized'),
      commission: num(row, 'commission'),
      toTransfer: num(row, 'toTransfer'),
      logistics: num(row, 'logistics'),
      penalties: num(row, 'penalties'),
      storage: num(row, 'storage'),
      acceptance: num(row, 'acceptance'),
      other: num(row, 'other'),
      doplaty: num(row, 'doplaty'),
      isSale: isSaleGround(ground),
      isReturn: isReturnGround(ground),
    });
  }
  return { ok: true, headerRow: head.row, columns: c, rows, reportId };
}

const sum = (rows, key) => rows.reduce((a, r) => a + (r[key] || 0), 0);
const sumAbs = (rows, key) => rows.reduce((a, r) => a + Math.abs(r[key] || 0), 0);

/**
 * Aggregate the reconciliation totals and a per-article P&L.
 * computedPayout follows the WB formula:
 *   (К перечислению за товар: продажи - возвраты)
 *   - логистика - хранение - приёмка - штрафы - прочие удержания + доплаты
 */
export function buildPnL(parsed) {
  const rows = parsed.rows || [];
  const sales = rows.filter((r) => r.isSale);
  const returns = rows.filter((r) => r.isReturn);

  // Returns reduce payout by their magnitude, whether the export stores return
  // values as positive (raw WB) or already-negative (some processed exports).
  const realizedNet = sum(sales, 'realized') - sumAbs(returns, 'realized');
  const toTransferNet = sum(sales, 'toTransfer') - sumAbs(returns, 'toTransfer');
  const logistics = sum(rows, 'logistics');
  const penalties = sum(rows, 'penalties');
  const storage = sum(rows, 'storage');
  const acceptance = sum(rows, 'acceptance');
  const other = sum(rows, 'other');
  const doplaty = sum(rows, 'doplaty');

  const computedPayout = toTransferNet - logistics - penalties - storage - acceptance - other + doplaty;

  // Per-article P&L
  const byArticle = new Map();
  for (const r of rows) {
    const key = r.article || r.barcode || r.srid || '—';
    if (!byArticle.has(key)) {
      byArticle.set(key, { article: key, subject: r.subject, qty: 0, realized: 0, toTransfer: 0, logistics: 0, penalties: 0, storage: 0, other: 0 });
    }
    const a = byArticle.get(key);
    if (r.isSale) a.qty += r.qty;
    if (r.isReturn) a.qty -= Math.abs(r.qty);
    a.realized += r.isReturn ? -Math.abs(r.realized) : r.realized;
    a.toTransfer += r.isReturn ? -Math.abs(r.toTransfer) : r.toTransfer;
    a.logistics += r.logistics;
    a.penalties += r.penalties;
    a.storage += r.storage;
    a.other += r.other;
    if (!a.subject && r.subject) a.subject = r.subject;
  }
  const pnl = [...byArticle.values()].sort((x, z) => z.realized - x.realized);

  return {
    totals: { realizedNet, toTransferNet, logistics, penalties, storage, acceptance, other, doplaty, computedPayout },
    salesCount: sales.length,
    returnsCount: returns.length,
    rowCount: rows.length,
    pnl,
  };
}
