import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import { $, bytesToBase64, el, markDirty, setStatus, showBanner, startViewer, t } from '../common/bridge';

XLSX.set_cptable(cptable);

const MAX_ROWS = 5000;
const MAX_COLS = 200;

let wb: XLSX.WorkBook | undefined;
let ext = 'xlsx';
let hadBom = false;
let csvSep = ',';
let activeSheet = 0;
let editing = false;

// Sort / filter only change what is shown, never the file.
let sortCol: number | null = null;
let sortDir: 1 | -1 = 1;
let filterText = '';
let headerRow = true;

const addRowBtn = el('button', { textContent: t('addRowLabel'), title: t('addRowEndTitle') });
const addColBtn = el('button', { textContent: t('addColLabel'), title: t('addColEndTitle') });
const editTools = el('div', { className: 'extra edit-only' }, [addRowBtn, addColBtn]);

const filterInput = el('input', { type: 'search', placeholder: t('filter'), className: 'filter-input' });
filterInput.setAttribute('aria-label', t('filterLabel'));
let filterTimer: ReturnType<typeof setTimeout> | undefined;
filterInput.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterText = norm(filterInput.value.trim());
    renderSheet();
  }, 150);
});
const headerBox = el('input', { type: 'checkbox', checked: true });
headerBox.addEventListener('change', () => {
  headerRow = headerBox.checked;
  renderSheet();
});
const headerLabel = el('label', { className: 'inline-check', title: t('headerRowTitle') }, [headerBox, t('headerRow')]);
const tools = el('div', { className: 'extra' }, [filterInput, headerLabel, editTools]);

/** Lower-case, accent-free, Turkish-aware text for filtering. */
function norm(s: string): string {
  return s.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

const collator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });

function currentSheet(): XLSX.WorkSheet {
  return wb!.Sheets[wb!.SheetNames[activeSheet]];
}

function sheetRange(ws: XLSX.WorkSheet): XLSX.Range {
  return XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1');
}

function growRange(ws: XLSX.WorkSheet, rows: number, cols: number) {
  const r = sheetRange(ws);
  r.e.r += rows;
  r.e.c += cols;
  ws['!ref'] = XLSX.utils.encode_range(r);
}

function displayText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return '';
  if (cell.v == null) return cell.f ? '=' + cell.f : ''; // formula without a cached result
  try {
    return XLSX.utils.format_cell(cell);
  } catch {
    return cell.v == null ? '' : String(cell.v);
  }
}

/** Writes typed text back into the worksheet. */
function writeCell(ws: XLSX.WorkSheet, addr: string, text: string) {
  if (text === '') {
    delete ws[addr];
    return;
  }
  if (text.startsWith('=') && text.length > 1) {
    ws[addr] = { t: 'n', f: text.slice(1) } as XLSX.CellObject;
    return;
  }
  const num = text.trim().replace(/\s/g, '');
  if (/^-?\d+([.,]\d+)?$/.test(num)) {
    ws[addr] = { t: 'n', v: Number(num.replace(',', '.')) };
    return;
  }
  // TRUE / FALSE in the UI languages (en, tr, es, fr).
  if (/^(true|false|doğru|yanlış|verdadero|falso|vrai|faux)$/i.test(text.trim())) {
    ws[addr] = { t: 'b', v: /^(true|doğru|verdadero|vrai)$/i.test(text.trim()) };
    return;
  }
  ws[addr] = { t: 's', v: text };
}

function renderTabs() {
  if (!wb || wb.SheetNames.length < 2) return null;
  const tabs = el('div', { className: 'tabs' });
  wb.SheetNames.forEach((name, i) => {
    const b = el('button', { textContent: name, className: i === activeSheet ? 'active' : '' });
    b.addEventListener('click', () => {
      activeSheet = i;
      sortCol = null;
      renderSheet();
    });
    tabs.append(b);
  });
  return tabs;
}

function renderSheet() {
  if (!wb) return;
  const ws = currentSheet();
  const range = sheetRange(ws);
  const lastCol = Math.min(range.e.c, range.s.c + MAX_COLS - 1);
  const cellAt = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;

  // Rows to show: optional fixed header row, then filtered + sorted data rows.
  const all: number[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) all.push(r);
  const head = headerRow && all.length > 1 ? all.shift() : undefined;
  let rows = all;
  if (filterText) {
    rows = rows.filter((r) => {
      for (let c = range.s.c; c <= lastCol; c++) if (norm(displayText(cellAt(r, c))).includes(filterText)) return true;
      return false;
    });
  }
  if (sortCol !== null) {
    const col = sortCol;
    rows = [...rows].sort((a, b) => {
      const x = cellAt(a, col);
      const y = cellAt(b, col);
      const xs = displayText(x);
      const ys = displayText(y);
      if (!xs || !ys) return xs ? -1 : ys ? 1 : 0; // empty cells last
      const cmp = x?.t === 'n' && y?.t === 'n' ? Number(x.v) - Number(y.v) : collator.compare(xs, ys);
      return cmp * sortDir;
    });
  }
  const totalRows = rows.length;
  rows = rows.slice(0, MAX_ROWS);

  const makeRow = (r: number) => {
    const tr = el('tr', {}, [el('th', { className: 'row-head', textContent: String(r + 1) })]);
    for (let c = range.s.c; c <= lastCol; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr] as XLSX.CellObject | undefined;
      const td = el('td', { textContent: displayText(cell) });
      td.dataset.addr = addr;
      if (cell?.t === 'n') td.classList.add('num');
      if (cell?.f) td.title = '=' + cell.f;
      td.contentEditable = editing ? 'plaintext-only' : 'false';
      tr.append(td);
    }
    return tr;
  };

  const table = el('table', { className: 'grid' });
  const headRow = el('tr', {}, [el('th', { className: 'row-head' })]);
  for (let c = range.s.c; c <= lastCol; c++) {
    const arrow = sortCol === c ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
    const th = el('th', { className: 'sortable', textContent: XLSX.utils.encode_col(c) + arrow, title: t('sortTitle') });
    th.setAttribute('aria-sort', sortCol === c ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
    th.addEventListener('click', () => {
      if (sortCol !== c) [sortCol, sortDir] = [c, 1];
      else if (sortDir === 1) sortDir = -1;
      else sortCol = null;
      renderSheet();
    });
    headRow.append(th);
  }
  const thead = el('thead', {}, [headRow]);
  if (head !== undefined) {
    const fixed = makeRow(head);
    fixed.className = 'frozen';
    thead.append(fixed);
  }
  table.append(thead);

  const tbody = el('tbody');
  for (const r of rows) tbody.append(makeRow(r));
  table.append(tbody);

  const sortInfo = sortCol !== null ? t('sortedBy', XLSX.utils.encode_col(sortCol), sortDir === 1 ? '▲' : '▼') : '';
  setStatus((totalRows === all.length ? t('rows', all.length) : t('rowsOf', totalRows, all.length)) + sortInfo);

  // Cell editing: show raw formula while focused, store on blur.
  // Mark dirty while typing, so Ctrl+S works before leaving the cell.
  table.addEventListener('input', () => markDirty());
  table.addEventListener('focusin', (e) => {
    const td = e.target as HTMLElement;
    if (!editing || td.tagName !== 'TD') return;
    const cell = currentSheet()[td.dataset.addr!] as XLSX.CellObject | undefined;
    td.dataset.before = cell?.f ? '=' + cell.f : cell?.v == null ? '' : String(cell.v);
    td.textContent = td.dataset.before;
  });
  table.addEventListener('focusout', (e) => {
    const td = e.target as HTMLElement;
    if (!editing || td.tagName !== 'TD') return;
    const ws2 = currentSheet();
    const text = td.textContent ?? '';
    if (text !== td.dataset.before) {
      writeCell(ws2, td.dataset.addr!, text);
      markDirty();
    }
    const cell = ws2[td.dataset.addr!] as XLSX.CellObject | undefined;
    td.textContent = cell?.f ? '=' + cell.f : displayText(cell);
    td.classList.toggle('num', cell?.t === 'n');
  });
  table.addEventListener('keydown', (e) => {
    const td = e.target as HTMLElement;
    if (td.tagName !== 'TD') return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const next = (td.parentElement?.nextElementSibling?.children[(td as HTMLTableCellElement).cellIndex] as HTMLElement) ?? td;
      next.focus();
    } else if (e.key === 'Escape') {
      td.textContent = td.dataset.before ?? '';
      td.blur();
    }
  });

  const parts: Node[] = [];
  const tabs = renderTabs();
  if (tabs) parts.push(tabs);
  parts.push(el('div', { className: 'grid-wrap' }, [table]));
  $('#content').replaceChildren(...parts);
  // The fixed header row sticks right under the column letters.
  table.style.setProperty('--head-h', `${headRow.offsetHeight}px`);

  const clipped = totalRows > MAX_ROWS || range.e.c > lastCol;
  showBanner(
    clipped
      ? t('bigSheet', MAX_ROWS, MAX_COLS)
      : editing && ext !== 'csv'
        ? t('sheetEditBanner')
        : '',
    clipped ? 'info' : 'warn',
  );
}

addRowBtn.addEventListener('click', () => {
  growRange(currentSheet(), 1, 0);
  markDirty();
  renderSheet();
});
addColBtn.addEventListener('click', () => {
  growRange(currentSheet(), 0, 1);
  markDirty();
  renderSheet();
});

startViewer(
  {
    async render(bytes, init) {
      ext = init.ext;
      hadBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      if (ext === 'csv') {
        // Keep the original delimiter (Turkish Excel uses ';').
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          // Old Turkish Excel exports are Windows-1254. We save back as UTF-8 with BOM,
          // which Excel also opens correctly.
          text = new TextDecoder('windows-1254').decode(bytes);
          hadBom = true;
        }
        const firstLine = text.split(/\r?\n/)[0];
        const count = (ch: string) => firstLine.split(ch).length - 1;
        csvSep = [';', '\t', ','].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',');
        wb = XLSX.read(text, { type: 'string', FS: csvSep, raw: true } as XLSX.ParsingOptions);
      } else {
        wb = XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellText: true });
      }
      activeSheet = 0;
      editing = false;
      sortCol = null;
      renderSheet();
    },
    setEditing(on) {
      editing = on;
      renderSheet();
    },
    async getContent() {
      if (!wb) throw new Error('No workbook loaded');
      // Commit the cell being typed in without leaving it (auto save can run mid-typing).
      const td = document.activeElement as HTMLElement | null;
      if (td?.tagName === 'TD' && td.dataset.addr && td.textContent !== td.dataset.before) {
        writeCell(currentSheet(), td.dataset.addr, td.textContent ?? '');
        td.dataset.before = td.textContent ?? '';
      }
      if (ext === 'csv') {
        const text = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]], { FS: csvSep }) + '\n';
        const body = new TextEncoder().encode(text);
        const out = hadBom ? new Uint8Array([0xef, 0xbb, 0xbf, ...body]) : body;
        return { base64: bytesToBase64(out) };
      }
      const bookType: XLSX.BookType = ext === 'xls' ? 'biff8' : ext === 'ods' ? 'ods' : 'xlsx';
      const data = XLSX.write(wb, { type: 'array', bookType }) as ArrayBuffer;
      return { base64: bytesToBase64(new Uint8Array(data)) };
    },
  },
  tools,
);
