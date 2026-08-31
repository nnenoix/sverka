// rules.js — the moat. A rules engine over parsed WB report rows that flags
// disputable charges, plus a претензия (dispute) draft generator.
// Pure and DOM-free -> unit-tested. RULESET is data you keep sharpening.

export const RULESET = {
  // Recognised penalty grounds WB actually uses. A penalty row whose ground
  // matches none of these (or is blank) is suspicious and worth disputing.
  knownPenaltyGrounds: [
    'маркировк', 'штрихкод', 'штрих-код', 'габарит', 'подмен', 'брак', 'просроч',
    'самовыкуп', 'недостач', 'излишк', 'характеристик', 'отказ', 'este', 'киз',
    'этикет', 'вложени', 'упаковк', 'принудительн',
  ],
  logisticsOutlier: { factor: 3, minAbs: 100 }, // > 3x subject median AND > 100 ₽
  storageAttention: 500, // surface storage total above this
  disputeWindowDays: 10, // WB replies to a претензия within ~10 days
};

const round2 = (n) => Math.round(n * 100) / 100;

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// --- individual rules -------------------------------------------------------

function rulePenaltyNoGround(rows) {
  const items = rows
    .filter((r) => r.penalties > 0)
    .filter((r) => {
      const g = (r.opType || r.ground || '').toLowerCase().replace(/ё/g, 'е');
      if (!g.trim()) return true;
      return !RULESET.knownPenaltyGrounds.some((k) => g.includes(k));
    })
    .map((r) => ({ srid: r.srid, article: r.article, subject: r.subject, amount: round2(r.penalties), detail: r.opType || '(причина не указана)' }));
  if (!items.length) return null;
  const amount = round2(items.reduce((a, i) => a + i.amount, 0));
  return {
    id: 'penalty-no-ground',
    severity: 'high',
    title: 'Штрафы без понятного основания',
    amount,
    count: items.length,
    items,
    argument:
      'В отчёте начислены штрафы, у которых в графе «Виды логистики, штрафов и доплат» ' +
      'не указано или не читается допустимое основание. По оферте удержание должно быть ' +
      'обоснованным. Прошу предоставить основание по каждой операции и при отсутствии — сделать перерасчёт и вернуть удержанную сумму.',
  };
}

function ruleDuplicateCharges(rows) {
  const CHARGES = [
    ['logistics', 'логистика'],
    ['penalties', 'штраф'],
    ['storage', 'хранение'],
    ['acceptance', 'платная приёмка'],
    ['other', 'прочее удержание'],
  ];
  const seen = new Map();
  for (const r of rows) {
    for (const [key, label] of CHARGES) {
      const val = r[key];
      if (!val) continue;
      if (!r.srid) continue;
      const k = `${r.srid}|${key}|${round2(val)}|${(r.opType || '').toLowerCase()}`;
      if (!seen.has(k)) seen.set(k, { srid: r.srid, article: r.article, subject: r.subject, label, amount: round2(val), n: 0 });
      seen.get(k).n++;
    }
  }
  const dups = [...seen.values()].filter((d) => d.n >= 2);
  if (!dups.length) return null;
  const items = dups.map((d) => ({ srid: d.srid, article: d.article, subject: d.subject, amount: round2(d.amount * (d.n - 1)), detail: `${d.label} ×${d.n} по одной операции (Srid)` }));
  const amount = round2(items.reduce((a, i) => a + i.amount, 0));
  return {
    id: 'duplicate-charges',
    severity: 'high',
    title: 'Дублирующиеся удержания по одной операции',
    amount,
    count: items.length,
    items,
    argument:
      'По одному и тому же Srid одно и то же удержание списано более одного раза с идентичной суммой. ' +
      'Это признак технической ошибки/двойного списания. Прошу отменить повторные удержания и вернуть излишне удержанную сумму.',
  };
}

function ruleLogisticsOutlier(rows) {
  const bySubject = new Map();
  for (const r of rows) {
    if (r.logistics <= 0) continue;
    const key = r.subject || '—';
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(r);
  }
  const items = [];
  for (const [subject, list] of bySubject) {
    if (list.length < 4) continue; // need a baseline
    const med = median(list.map((r) => r.logistics));
    if (med <= 0) continue;
    for (const r of list) {
      if (r.logistics > med * RULESET.logisticsOutlier.factor && r.logistics - med > RULESET.logisticsOutlier.minAbs) {
        items.push({ srid: r.srid, article: r.article, subject, amount: round2(r.logistics - med), detail: `логистика ${round2(r.logistics)} ₽ при типичных ${round2(med)} ₽ для «${subject}»` });
      }
    }
  }
  if (!items.length) return null;
  const amount = round2(items.reduce((a, i) => a + i.amount, 0));
  return {
    id: 'logistics-outlier',
    severity: 'medium',
    title: 'Логистика выше типичной по категории',
    amount,
    count: items.length,
    items,
    argument:
      'Стоимость логистики по указанным операциям существенно превышает типичную для этой категории товара в том же отчёте. ' +
      'Частая причина — неверно учтённые габариты/вес. Прошу проверить и пересчитать логистику по фактическим габаритам упаковки.',
  };
}

function ruleNegativeSalePayout(rows) {
  const items = rows
    .filter((r) => r.isSale && r.toTransfer < 0)
    .map((r) => ({ srid: r.srid, article: r.article, subject: r.subject, amount: round2(r.toTransfer), detail: 'по продаже «к перечислению» отрицательное' }));
  if (!items.length) return null;
  return {
    id: 'negative-sale-payout',
    severity: 'medium',
    title: 'Отрицательная выплата по продаже',
    amount: round2(items.reduce((a, i) => a + i.amount, 0)),
    count: items.length,
    items,
    argument:
      'По операциям типа «Продажа» поле «К перечислению за товар» отрицательное, что для обычной продажи некорректно. ' +
      'Прошу разъяснить расчёт и при ошибке — скорректировать.',
  };
}

function ruleOtherDeductions(totals) {
  if (!totals || totals.other <= RULESET.storageAttention) return null;
  return {
    id: 'other-attention',
    severity: 'info',
    title: 'Проверить прочие удержания',
    amount: round2(totals.other),
    count: 1,
    items: [{ detail: `прочие удержания за период: ${round2(totals.other)} ₽ — откройте расшифровку суммы (кликабельна в кабинете) и сверьте каждую операцию по номеру документа` }],
    argument:
      'Сумма по графе «Удержания» заметная. Это продвижение, подписки, тарифные опции и разовые операции. ' +
      'Откройте расшифровку и проверьте каждое списание — по оферте оно должно быть обоснованным; спорные позиции запросите на перерасчёт.',
  };
}

function ruleStorageAttention(totals) {
  if (!totals || totals.storage <= RULESET.storageAttention) return null;
  return {
    id: 'storage-attention',
    severity: 'info',
    title: 'Проверить платное хранение',
    amount: round2(totals.storage),
    count: 1,
    items: [{ detail: `хранение за период: ${round2(totals.storage)} ₽ — сверьте с отчётом «Платное хранение» по дням и остаткам` }],
    argument:
      'Сумма платного хранения за период заметная. Сверьте её с детальным отчётом «Платное хранение»: ' +
      'частые ошибки — хранение по уже проданным/вывезенным остаткам и скачки коэффициента склада.',
  };
}

/**
 * Run all rules. `pnl` is buildPnL() output. Returns flags sorted by severity
 * then by disputable amount (desc).
 */
export function runRules(parsed, pnl) {
  const rows = parsed.rows || [];
  const flags = [
    rulePenaltyNoGround(rows),
    ruleDuplicateCharges(rows),
    ruleLogisticsOutlier(rows),
    ruleNegativeSalePayout(rows),
    ruleStorageAttention(pnl && pnl.totals),
    ruleOtherDeductions(pnl && pnl.totals),
  ].filter(Boolean);

  const rank = { high: 0, medium: 1, info: 2 };
  flags.sort((a, b) => rank[a.severity] - rank[b.severity] || Math.abs(b.amount) - Math.abs(a.amount));
  return flags;
}

// --- dispute draft ----------------------------------------------------------

function fmtRub(n) {
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' ₽';
}

/**
 * Build a ready-to-send претензия for one flag.
 * meta: { reportId, sellerName?, date? (Date) }
 */
export function buildClaim(flag, meta = {}) {
  const date = meta.date || new Date();
  const dateStr = date.toLocaleDateString('ru-RU');
  const report = meta.reportId ? `№ ${meta.reportId}` : '(укажите номер отчёта)';
  const lines = [];
  lines.push(`Претензия по еженедельному отчёту реализации Wildberries ${report}`);
  lines.push(`Дата: ${dateStr}`);
  lines.push('');
  lines.push(`Основание: ${flag.title}. Оспариваемая сумма: ${fmtRub(Math.abs(flag.amount))}.`);
  lines.push('');
  lines.push(flag.argument);
  lines.push('');
  if (flag.items && flag.items.length) {
    lines.push('Спорные операции:');
    for (const it of flag.items.slice(0, 40)) {
      const parts = [];
      if (it.srid) parts.push(`Srid ${it.srid}`);
      if (it.article) parts.push(`арт. ${it.article}`);
      if (it.subject) parts.push(it.subject);
      if (it.detail) parts.push(it.detail);
      if (typeof it.amount === 'number') parts.push(fmtRub(it.amount));
      lines.push(`— ${parts.join('; ')}`);
    }
    if (flag.items.length > 40) lines.push(`… и ещё ${flag.items.length - 40}`);
    lines.push('');
  }
  lines.push(
    'Прошу рассмотреть претензию, предоставить основания по каждой операции и сделать перерасчёт с возвратом излишне удержанных средств.'
  );
  lines.push(
    `Куда подать: WB Партнёры → Поддержка → категория «Недельные отчёты». Срок ответа WB — до ${RULESET.disputeWindowDays} дней.`
  );
  return lines.join('\n');
}
