// "Aksiyonlar" panel: action rows collected from all meeting notes.
import { $, el, locale, t, vscode } from '../common/bridge';

interface ActionRow {
  task: string;
  owner: string;
  due: string;
  status: string;
  file: string;
  fileLabel: string;
  folder: string;
  noteTime: number;
}

type Key = 'task' | 'owner' | 'due' | 'status' | 'noteTime';
const COLUMNS: [Key, string][] = [
  ['task', t('colTask')],
  ['owner', t('colOwner')],
  ['due', t('colDue')],
  ['status', t('colStatus')],
  ['noteTime', t('colMeeting')],
];

let rows: ActionRow[] = [];
let sortKey: Key = 'noteTime';
let sortDir: 1 | -1 = -1; // newest meetings first
let ownerFilter = '';
let text = '';
let scope = '';

const norm = (s: string) => s.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(locale);

// ---------- Toolbar ----------
const title = el('span', { className: 'title', textContent: t('actionsTitle') });
const search = el('input', { type: 'search', placeholder: t('actionsSearch'), className: 'filter-input' });
search.setAttribute('aria-label', t('actionsSearchLabel'));
const owner = el('select', { title: t('ownerFilterTitle') });
owner.setAttribute('aria-label', t('owner'));
const refresh = el('button', { textContent: t('refresh'), title: t('refreshTitle') });
const exportBtn = el('button', { textContent: t('exportXlsx'), title: t('exportXlsxTitle') });
$('#toolbar').append(title, el('div', { className: 'extra' }, [search, owner]), el('div', { className: 'spacer' }), refresh, exportBtn);
$('#toolbar').classList.add('plain');

search.addEventListener('input', () => {
  text = norm(search.value.trim());
  render();
});
owner.addEventListener('change', () => {
  ownerFilter = owner.value;
  render();
});
refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
exportBtn.addEventListener('click', () => vscode.postMessage({ type: 'exportXlsx', rows: visibleRows() }));

function visibleRows(): ActionRow[] {
  let out = rows;
  if (ownerFilter) out = out.filter((r) => (ownerFilter === '\u0000' ? !r.owner : r.owner === ownerFilter));
  if (text) out = out.filter((r) => norm(`${r.task} ${r.owner} ${r.due} ${r.status} ${r.fileLabel}`).includes(text));
  return [...out].sort((a, b) => {
    const cmp = sortKey === 'noteTime' ? a.noteTime - b.noteTime : collator.compare(a[sortKey] || '￿', b[sortKey] || '￿');
    return cmp * sortDir || b.noteTime - a.noteTime;
  });
}

function fillOwners() {
  const names = [...new Set(rows.map((r) => r.owner).filter(Boolean))].sort(collator.compare);
  const keep = ownerFilter;
  owner.replaceChildren(el('option', { value: '', textContent: t('everyone') }));
  for (const n of names) owner.append(el('option', { value: n, textContent: n }));
  if (rows.some((r) => !r.owner)) owner.append(el('option', { value: '\u0000', textContent: t('noOwner') }));
  owner.value = [...owner.options].some((o) => o.value === keep) ? keep : '';
  ownerFilter = owner.value;
}

function render() {
  const list = visibleRows();
  if (!rows.length) {
    $('#content').replaceChildren(
      el('div', { className: 'empty-state' }, [
        el('p', { textContent: t('noActions') }),
        el('p', { className: 'settings-note', textContent: t('noActionsHint') }),
      ]),
    );
    return;
  }
  const table = el('table', { className: 'grid actions-grid' });
  const head = el('tr');
  for (const [key, label] of COLUMNS) {
    const arrow = sortKey === key ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
    const th = el('th', { className: 'sortable', textContent: label + arrow });
    th.setAttribute('aria-sort', sortKey === key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
    th.addEventListener('click', () => {
      if (sortKey === key) sortDir = sortDir === 1 ? -1 : 1;
      else [sortKey, sortDir] = [key, key === 'noteTime' ? -1 : 1];
      render();
    });
    head.append(th);
  }
  table.append(el('thead', {}, [head]));
  const body = el('tbody');
  for (const r of list) {
    const tr = el('tr', { className: 'action-row', tabIndex: 0, title: t('openRowTitle', `${r.folder}/${r.fileLabel}`) });
    tr.append(
      el('td', { textContent: r.task }),
      el('td', { textContent: r.owner }),
      el('td', { textContent: r.due }),
      el('td', { textContent: r.status }),
      el('td', {}, [el('span', { textContent: fmtDate(r.noteTime) }), el('small', { textContent: ` ${r.fileLabel}` })]),
    );
    const open = () => vscode.postMessage({ type: 'open', file: r.file, text: r.task });
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    body.append(tr);
  }
  table.append(body);
  $('#content').replaceChildren(el('div', { className: 'actions-meta settings-note', textContent: t('actionsMeta', scope, list.length, rows.length) }), table);
  exportBtn.disabled = !list.length;
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type === 'loading') {
    refresh.disabled = true;
    title.textContent = t('actionsScanning');
  } else if (msg?.type === 'rows') {
    rows = Array.isArray(msg.rows) ? msg.rows : [];
    scope = String(msg.scope ?? '');
    refresh.disabled = false;
    title.textContent = t('actionsTitle');
    fillOwners();
    render();
  }
});

vscode.postMessage({ type: 'ready' });
