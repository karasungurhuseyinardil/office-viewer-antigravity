import mammoth from 'mammoth';
import { $, el, locale, markDirty, setStatus, showBanner, startViewer, t } from '../common/bridge';

let page: HTMLElement | undefined;
let toc: HTMLElement | undefined;
let editing = false;
/** null = automatic (shown on wide panels with headings). */
let tocWanted: boolean | null = null;

const changed = () => {
  markDirty();
  scheduleRefresh();
};

// ---------- Selection helpers ----------

/** Range saved before a popover takes the focus, restored afterwards. */
let savedRange: Range | undefined;
function saveSelection() {
  const sel = getSelection();
  if (sel?.rangeCount && page?.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
}
function restoreSelection() {
  if (!savedRange) return;
  page?.focus();
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(savedRange);
}

function currentCell(): HTMLTableCellElement | null {
  const node = getSelection()?.anchorNode;
  const elm = node instanceof Element ? node : node?.parentElement;
  const cell = elm?.closest('td, th') as HTMLTableCellElement | null;
  return cell && page?.contains(cell) ? cell : null;
}

const exec = (command: string, value?: string) => () => {
  document.execCommand(command, false, value);
  page?.focus();
};

// ---------- Tables ----------

const emptyCell = (tag: 'td' | 'th' = 'td') => {
  const c = document.createElement(tag);
  c.innerHTML = '<br>';
  return c;
};

function insertTable() {
  const head = `<tr>${[1, 2, 3].map((n) => `<td><strong>${t('tableHeader', n)}</strong></td>`).join('')}</tr>`;
  const row = '<tr><td><br></td><td><br></td><td><br></td></tr>';
  document.execCommand('insertHTML', false, `<table><tbody>${head}${row}</tbody></table><p><br></p>`);
  changed();
}

function tableOp(op: 'addRow' | 'addCol' | 'delRow' | 'delCol') {
  const cell = currentCell();
  if (!cell) return;
  const row = cell.parentElement as HTMLTableRowElement;
  const table = cell.closest('table')!;
  const col = cell.cellIndex;
  if (op === 'addRow') {
    const next = document.createElement('tr');
    for (let i = 0; i < row.cells.length; i++) next.append(emptyCell());
    row.after(next);
  } else if (op === 'addCol') {
    for (const r of Array.from(table.rows)) {
      const ref = r.cells[col];
      const c = emptyCell();
      if (ref) ref.after(c);
      else r.append(c);
    }
  } else if (op === 'delRow') {
    row.remove();
    if (!table.rows.length) table.remove();
  } else {
    for (const r of Array.from(table.rows)) r.cells[col]?.remove();
    if (!table.rows[0]?.cells.length) table.remove();
  }
  changed();
  updateTableButtons();
}

// ---------- Link popover ----------

const linkInput = el('input', { type: 'url', placeholder: 'https://…', className: 'link-input' });
const linkAdd = el('button', { className: 'primary', textContent: t('linkAdd') });
const linkRemove = el('button', { textContent: t('linkRemove') });
const linkError = el('div', { className: 'settings-note' });
const linkPop = el('div', { className: 'link-pop' }, [el('label', { textContent: t('linkAddress') }), linkInput, el('div', { className: 'link-actions' }, [linkAdd, linkRemove]), linkError]);
linkPop.hidden = true;
linkPop.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => (linkPop.hidden = true));

function openLinkPop(anchor: HTMLElement) {
  saveSelection();
  const existing = (getSelection()?.anchorNode?.parentElement?.closest('a') as HTMLAnchorElement | null)?.getAttribute('href');
  linkInput.value = existing ?? '';
  linkError.textContent = '';
  const r = anchor.getBoundingClientRect();
  linkPop.style.top = `${r.bottom + 4}px`;
  linkPop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 280))}px`;
  linkPop.hidden = false;
  linkInput.focus();
}

function applyLink() {
  let url = linkInput.value.trim();
  if (!url) return;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = (url.includes('@') && !url.includes('/') ? 'mailto:' : 'https://') + url;
  if (!/^(https?:|mailto:)/i.test(url)) {
    linkError.textContent = t('linkOnly');
    return;
  }
  restoreSelection();
  const sel = getSelection();
  if (sel?.isCollapsed) document.execCommand('insertHTML', false, `<a href="${url.replace(/"/g, '%22')}">${url.replace(/</g, '&lt;')}</a>`);
  else document.execCommand('createLink', false, url);
  linkPop.hidden = true;
  changed();
}
linkAdd.addEventListener('click', applyLink);
linkInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyLink();
  } else if (e.key === 'Escape') linkPop.hidden = true;
});
linkRemove.addEventListener('click', () => {
  restoreSelection();
  document.execCommand('unlink');
  linkPop.hidden = true;
  changed();
});

// ---------- Highlight and checklist ----------

function toggleHighlight() {
  const node = getSelection()?.anchorNode;
  const mark = (node instanceof Element ? node : node?.parentElement)?.closest('mark, span[style*="background"]');
  if (mark && page?.contains(mark)) {
    mark.replaceWith(...Array.from(mark.childNodes)); // remove highlight
  } else {
    document.execCommand('hiliteColor', false, '#ffff00');
  }
  changed();
}

const BOX = '☐';
const CHECKED = '☑';

/** Puts a ☐ in front of the current paragraph / list item. */
function insertCheckbox() {
  const node = getSelection()?.anchorNode;
  const block = (node instanceof Element ? node : node?.parentElement)?.closest('p, li, h1, h2, h3');
  if (!block || !page?.contains(block)) {
    document.execCommand('insertText', false, `${BOX} `);
  } else if (!/^[☐☑]/.test(block.textContent ?? '')) {
    block.prepend(`${BOX} `);
  }
  changed();
}

/** Click on ☐ / ☑ in edit mode toggles it. */
function onPageClick(e: MouseEvent) {
  if (!editing) return;
  const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (!pos || pos.startContainer.nodeType !== Node.TEXT_NODE) return;
  const text = pos.startContainer as Text;
  for (const i of [pos.startOffset, pos.startOffset - 1]) {
    const ch = text.data.charAt(i);
    if (i >= 0 && (ch === BOX || ch === CHECKED)) {
      text.replaceData(i, 1, ch === BOX ? CHECKED : BOX);
      changed();
      return;
    }
  }
}

// ---------- Format bar ----------

type Cmd = { label: string; title: string; run: (btn: HTMLButtonElement) => void; tableOnly?: boolean };
const commands: (Cmd | 'sep')[] = [
  { label: 'B', title: t('fmtBold'), run: exec('bold') },
  { label: 'I', title: t('fmtItalic'), run: exec('italic') },
  { label: 'U', title: t('fmtUnderline'), run: exec('underline') },
  { label: '🖍', title: t('fmtHighlight'), run: toggleHighlight },
  'sep',
  { label: 'H1', title: t('fmtH1'), run: exec('formatBlock', 'H1') },
  { label: 'H2', title: t('fmtH2'), run: exec('formatBlock', 'H2') },
  { label: 'H3', title: t('fmtH3'), run: exec('formatBlock', 'H3') },
  { label: '¶', title: t('fmtPara'), run: exec('formatBlock', 'P') },
  'sep',
  { label: t('bulletsLabel'), title: t('fmtBullets'), run: exec('insertUnorderedList') },
  { label: t('numbersLabel'), title: t('fmtNumbers'), run: exec('insertOrderedList') },
  { label: '☐', title: t('fmtTodo'), run: insertCheckbox },
  { label: '🔗', title: t('fmtLink'), run: (b) => openLinkPop(b) },
  'sep',
  { label: t('tableLabel'), title: t('fmtTable'), run: insertTable },
  { label: t('addRowLabel'), title: t('fmtAddRow'), run: () => tableOp('addRow'), tableOnly: true },
  { label: t('addColLabel'), title: t('fmtAddCol'), run: () => tableOp('addCol'), tableOnly: true },
  { label: t('delRowLabel'), title: t('fmtDelRow'), run: () => tableOp('delRow'), tableOnly: true },
  { label: t('delColLabel'), title: t('fmtDelCol'), run: () => tableOp('delCol'), tableOnly: true },
  'sep',
  { label: '↶', title: t('fmtUndo'), run: exec('undo') },
  { label: '↷', title: t('fmtRedo'), run: exec('redo') },
];

const tableButtons: HTMLButtonElement[] = [];
const formatBar = el('div', { className: 'extra edit-only format-bar' });
for (const c of commands) {
  if (c === 'sep') {
    formatBar.append(el('span', { className: 'sep' }));
    continue;
  }
  const b = el('button', { className: 'icon', textContent: c.label, title: c.title });
  b.setAttribute('aria-label', c.title);
  // mousedown + preventDefault keeps the text selection inside the page.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    c.run(b);
  });
  if (c.tableOnly) {
    b.disabled = true;
    tableButtons.push(b);
  }
  formatBar.append(b);
}
document.body.append(linkPop);

function updateTableButtons() {
  const inTable = editing && !!currentCell();
  for (const b of tableButtons) b.disabled = !inTable;
}
document.addEventListener('selectionchange', updateTableButtons);

// ---------- İçindekiler + word count ----------

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    buildToc();
    updateCounts();
  }, 300);
}

function buildToc() {
  if (!page || !toc) return;
  const headings = Array.from(page.querySelectorAll<HTMLElement>('h1, h2, h3'));
  const list = el('ol');
  for (const h of headings) {
    const text = h.textContent?.trim();
    if (!text) continue;
    const item = el('li', { className: `toc-${h.tagName.toLowerCase()}` });
    const link = el('button', { className: 'toc-link', textContent: text, title: text });
    link.addEventListener('click', () => h.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    item.append(link);
    list.append(item);
  }
  toc.replaceChildren(el('div', { className: 'toc-title', textContent: t('tocTitle') }), list.childElementCount ? list : el('div', { className: 'settings-note', textContent: t('tocEmpty') }));
  const show = tocWanted ?? (headings.length >= 2 && $('#content').clientWidth >= 900);
  document.body.classList.toggle('toc-open', show);
}

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

function updateCounts() {
  if (!page) return;
  const text = page.innerText;
  const words = countWords(text).toLocaleString(locale);
  const chars = text.replace(/\s/g, '').length.toLocaleString(locale);
  const sel = getSelection();
  const selected = sel && !sel.isCollapsed && page.contains(sel.anchorNode) ? countWords(sel.toString()) : 0;
  setStatus(t('wordCount', words, chars) + (selected ? t('selectedWords', selected.toLocaleString(locale)) : ''));
}
document.addEventListener('selectionchange', () => {
  if (page) updateCounts();
});

// ---------- Viewer ----------

startViewer(
  {
    async render(bytes) {
      const result = await mammoth.convertToHtml(
        { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer },
        { includeDefaultStyleMap: true, styleMap: ['highlight => mark'] },
      );
      page = el('article', { className: 'page' });
      page.innerHTML = result.value || '<p></p>';
      page.addEventListener('input', changed);
      page.addEventListener('click', onPageClick);
      toc = el('nav', { className: 'toc' });
      toc.setAttribute('aria-label', t('tocTitle'));
      $('#content').replaceChildren(el('div', { className: 'doc-layout' }, [toc, page]));
      showBanner('');
      buildToc();
      updateCounts();
    },
    setEditing(on) {
      if (!page) return;
      editing = on;
      page.contentEditable = on ? 'true' : 'false';
      page.spellcheck = on;
      updateTableButtons();
      if (on) {
        page.focus();
        showBanner(t('docxEditBanner'), 'warn');
      } else {
        showBanner('');
      }
    },
    async getContent() {
      return { html: page?.innerHTML ?? '' };
    },
    localTools: [
      {
        label: t('toolToc'),
        run() {
          tocWanted = !document.body.classList.contains('toc-open');
          document.body.classList.toggle('toc-open', tocWanted);
        },
      },
    ],
  },
  formatBar,
);
