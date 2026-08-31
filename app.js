// app.js — UI wiring. Pure logic in parse.js/rules.js; XLSX parsing via SheetJS.
import { parseReport, buildPnL } from './parse.js';
import { runRules, buildClaim } from './rules.js';
import { SAMPLE } from './sample.js';

const $ = (id) => document.getElementById(id);
const stages = { upload: $('stage-upload'), processing: $('stage-processing'), report: $('stage-report') };
const show = (name) => { for (const [k, el] of Object.entries(stages)) el.classList.toggle('hidden', k !== name); };

const rub = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
const rub2 = (n) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' ₽';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

let state = null; // { parsed, pnl, flags }

function matrixFromArrayBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

async function handleFile(file) {
  if (!file) return;
  show('processing');
  $('procStatus').textContent = `Читаю «${file.name}»…`;
  try {
    const buf = await file.arrayBuffer();
    process(matrixFromArrayBuffer(buf));
  } catch (e) {
    console.error(e);
    toast('Не удалось прочитать файл. Нужен XLSX или CSV детализации WB.');
    show('upload');
  }
}

function process(matrix) {
  const parsed = parseReport(matrix);
  if (!parsed.ok) {
    toast('Это не похоже на детализацию отчёта WB. Проверьте, что загрузили отчёт-реализацию.');
    show('upload');
    return;
  }
  const pnl = buildPnL(parsed);
  const flags = runRules(parsed, pnl);
  state = { parsed, pnl, flags };
  render();
  show('report');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  const { parsed, pnl, flags } = state;
  const disputable = flags.filter((f) => f.severity !== 'info').reduce((a, f) => a + Math.abs(f.amount), 0);
  const disputableCount = flags.filter((f) => f.severity !== 'info').length;

  // KPIs
  $('kpis').innerHTML = `
    <div class="kpi"><p class="kpi__label">Строк обработано</p><div class="kpi__value">${pnl.rowCount}</div></div>
    <div class="kpi kpi--pay"><p class="kpi__label">Расчётное к перечислению</p><div class="kpi__value">${rub(pnl.totals.computedPayout)}</div></div>
    <div class="kpi kpi--found"><p class="kpi__label">Найдено спорного</p><div class="kpi__value">${disputable > 0 ? rub(disputable) : '—'}</div></div>`;

  // Reconciliation
  const t = pnl.totals;
  const line = (label, val, cls) => `<div class="recon-row"><span>${label}</span><span class="${cls || ''}">${rub2(val)}</span></div>`;
  $('reconciliation').innerHTML = `
    <h3>Сверка расчёта (${pnl.salesCount} продаж, ${pnl.returnsCount} возвратов)</h3>
    ${line('Реализовано (продажи − возвраты)', t.realizedNet)}
    ${line('К перечислению за товар', t.toTransferNet)}
    ${line('− Логистика', -t.logistics, 'neg')}
    ${line('− Штрафы', -t.penalties, 'neg')}
    ${line('− Хранение', -t.storage, 'neg')}
    ${line('− Платная приёмка', -t.acceptance, 'neg')}
    ${line('− Прочие удержания', -t.other, 'neg')}
    ${line('+ Доплаты', t.doplaty, 'pos')}
    <div class="recon-row total"><span>Расчётное к перечислению</span><span class="${t.computedPayout < 0 ? 'neg' : 'pos'}">${rub2(t.computedPayout)}</span></div>`;

  // Flags summary badge
  $('flagsSum').textContent = disputableCount ? `${disputableCount} на ${rub(disputable)}` : 'спорного не найдено';

  // Flags
  const sevLabel = { high: 'Высокий приоритет', medium: 'Стоит проверить', info: 'К сведению' };
  $('flags').innerHTML = flags.length
    ? flags.map((f, i) => flagCard(f, i)).join('')
    : `<div class="card"><p style="margin:0;color:var(--ink-2)">Автоматических спорных удержаний не найдено. Сверьте расчёт выше вручную — Сверка ищет только высоко-уверенные признаки.</p></div>`;

  flags.forEach((f, i) => {
    const btn = $(`claim-btn-${i}`);
    if (btn) btn.onclick = () => toggleClaim(f, i);
  });

  // PnL table
  const head = ['Артикул', 'Предмет', 'Кол-во', 'Реализовано', 'К перечисл.', 'Логистика', 'Штрафы', 'Хранение'];
  $('pnlTable').innerHTML =
    '<thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
    pnl.pnl.slice(0, 500).map((a) => `<tr>
      <td>${esc(a.article)}</td><td>${esc(a.subject || '')}</td><td>${a.qty}</td>
      <td>${rub(a.realized)}</td><td>${rub(a.toTransfer)}</td><td>${rub(a.logistics)}</td>
      <td>${rub(a.penalties)}</td><td>${rub(a.storage)}</td></tr>`).join('') +
    '</tbody>';

  function flagCard(f, i) {
    const items = (f.items || []).slice(0, 8).map((it) => {
      const parts = [];
      if (it.srid) parts.push(`Srid ${esc(it.srid)}`);
      if (it.article) parts.push(esc(it.article));
      if (it.detail) parts.push(esc(it.detail));
      if (typeof it.amount === 'number') parts.push(`<b>${rub2(it.amount)}</b>`);
      return `<li>${parts.join(' · ')}</li>`;
    }).join('');
    const more = f.items && f.items.length > 8 ? `<li>… и ещё ${f.items.length - 8}</li>` : '';
    const amountHtml = f.severity === 'info' ? '' : `<div class="flag__amount">${rub(Math.abs(f.amount))}</div>`;
    return `<div class="card flag ${f.severity}">
      <span class="chip-tag">${sevLabel[f.severity]}</span>
      <div class="flag__head"><div><p class="flag__title">${esc(f.title)}</p><p class="flag__sub">${f.count} ${f.count === 1 ? 'операция' : 'операций'}</p></div>${amountHtml}</div>
      <ul class="flag__items">${items}${more}</ul>
      <div class="flag__actions"><button class="btn btn--soft btn--sm" id="claim-btn-${i}">Показать претензию</button></div>
      <div class="claim hidden" id="claim-box-${i}"></div>
    </div>`;
  }
}

function toggleClaim(flag, i) {
  const box = $(`claim-box-${i}`);
  const btn = $(`claim-btn-${i}`);
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); btn.textContent = 'Показать претензию'; return; }
  const text = buildClaim(flag, { reportId: state.parsed.reportId, date: new Date() });
  box.innerHTML = `<textarea readonly>${esc(text)}</textarea><div class="flag__actions"><button class="btn btn--primary btn--sm" id="claim-copy-${i}">Копировать претензию</button></div>`;
  box.classList.remove('hidden');
  btn.textContent = 'Скрыть претензию';
  $(`claim-copy-${i}`).onclick = async () => { await copy(text); toast('Претензия скопирована'); };
}

// Exports
function exportAllClaims() {
  const { flags, parsed } = state;
  const meta = { reportId: parsed.reportId, date: new Date() };
  const text = flags.map((f) => buildClaim(f, meta)).join('\n\n' + '—'.repeat(30) + '\n\n');
  download(`pretenzii-${parsed.reportId || 'wb'}.txt`, text || 'Спорных удержаний не найдено.', 'text/plain');
  toast('Претензии сохранены');
}
function exportPnl() {
  const rows = [['Артикул', 'Предмет', 'Кол-во', 'Реализовано', 'К перечислению', 'Логистика', 'Штрафы', 'Хранение', 'Прочие']];
  for (const a of state.pnl.pnl) rows.push([a.article, a.subject || '', a.qty, a.realized, a.toTransfer, a.logistics, a.penalties, a.storage, a.other]);
  const csv = rows.map((r) => r.map((c) => (typeof c === 'string' && /[",;\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(';')).join('\r\n');
  download(`pnl-${state.parsed.reportId || 'wb'}.csv`, '﻿' + csv, 'text/csv');
  toast('P&L сохранён');
}

// Sample — build a real .xlsx in-browser and run it through the upload path.
function loadSample() {
  try {
    const ws = XLSX.utils.aoa_to_sheet(SAMPLE);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Детализация');
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    handleFile(new File([out], 'sample-wb-report.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  } catch (e) {
    console.error(e);
    process(SAMPLE);
  }
}

// Wiring
const drop = $('drop');
$('fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
drop.addEventListener('click', (e) => { if (e.target.closest('label,button')) return; $('fileInput').click(); });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
$('sampleBtn').addEventListener('click', loadSample);
$('exportClaims').addEventListener('click', exportAllClaims);
$('exportPnl').addEventListener('click', exportPnl);
$('againBtn').addEventListener('click', () => { $('fileInput').value = ''; show('upload'); });

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
