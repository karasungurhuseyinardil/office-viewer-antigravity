// Shared webview helpers: messaging with the extension host and the top toolbar.
import { isLang, LANG_NAMES, LANGS, LOCALES, translate, type Key, type Lang } from '../../shared/i18n';

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

/** UI language, set by the extension on <body data-lang>. */
export const lang: Lang = isLang(document.body.dataset.lang) ? document.body.dataset.lang : 'en';
export const locale = LOCALES[lang];
export const t = (key: Key, ...args: (string | number)[]) => translate(lang, key, ...args);

export interface InitMessage {
  type: 'init';
  fileName: string;
  /** Workspace-relative path parts, e.g. ["Frontend", "Notlar", "a.docx"]. */
  crumbs?: string[];
  ext: string;
  editable: boolean;
  /** Open straight in edit mode (setting or new meeting note). */
  startEditing?: boolean;
  /** Text to jump to after rendering (from "Notlarda ara"). */
  find?: string;
  /** 1-based line to show after rendering (code files opened from a text editor). */
  line?: number;
  /** Full size when only the beginning of a huge file was sent. */
  totalSize?: number;
  base64: string;
}

export interface FormatHandlers {
  /** Render the file. Called again on revert. */
  render(bytes: Uint8Array, init: InitMessage): Promise<void>;
  /** Switch between view and edit mode (editable formats only). */
  setEditing?(on: boolean): void;
  /** Return current content for saving. */
  getContent?(): Promise<{ html?: string; base64?: string }>;
  /** Format-specific entries for the Araçlar menu (e.g. İçindekiler). */
  localTools?: LocalTool[];
  /** Hide the Edit / Open in default app buttons (e.g. .vsix packages). */
  noEdit?: boolean;
  /**
   * Replaces the Edit button (e.g. "Edit in editor" for code). Called after each
   * render; returning null hides the button.
   */
  editAction?: () => { label: string; title: string; run(): void } | null;
  /** Export formats for the Tools menu when they depend on the content, not the extension. */
  exports?: () => [format: string, label: Key][];
  /** Scroll to a 1-based line. */
  gotoLine?(line: number): void;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

export function assetUrl(file: string): string {
  const base = document.body.dataset.assetBase ?? '';
  return base.replace(/\/?$/, '/') + file;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function showBanner(text: string, kind: 'info' | 'warn' | 'error' = 'info') {
  const b = $('#banner');
  b.textContent = text;
  b.className = `banner-${kind}`;
  b.hidden = !text;
}

export function showError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  $('#content').replaceChildren(el('div', { className: 'error', textContent: t('openFailed', message) }));
  vscode.postMessage({ type: 'error', message });
}

/** Tell the host the document changed. Sent on every edit: the host marks the
 * tab dirty once and restarts the "Yazmayı bırakınca" auto save timer. */
export function markDirty() {
  vscode.postMessage({ type: 'dirty' });
  saveBtn?.removeAttribute('disabled');
}

let saveBtn: HTMLButtonElement | undefined;

/** Mirrors ViewerSettings in src/settings.ts. */
export interface ViewerSettings {
  autoSave: { useEditorSetting: boolean; triggers: string[] };
  view: { pageTheme: 'light' | 'dark' | 'auto'; fullWidth: boolean; fontScale: number };
  openInEditMode: boolean;
  createBackup: boolean;
  language: Lang;
  openAllFiles: boolean;
}

/** Page look: body classes + font scale variable read by styles.css. */
function applyView(view: ViewerSettings['view']) {
  const b = document.body.classList;
  b.toggle('page-dark', view.pageTheme === 'dark');
  b.toggle('page-auto', view.pageTheme === 'auto');
  b.toggle('full-width', view.fullWidth);
  document.body.style.setProperty('--font-scale', String(view.fontScale));
}

/** Setting keys (officeViewer.*) and how to read each from ViewerSettings. */
const SETTING_KEYS: [key: string, get: (s: ViewerSettings) => unknown][] = [
  ['useEditorAutoSave', (s) => s.autoSave.useEditorSetting],
  ['autoSaveTriggers', (s) => s.autoSave.triggers],
  ['view.pageTheme', (s) => s.view.pageTheme],
  ['view.fullWidth', (s) => s.view.fullWidth],
  ['view.fontScale', (s) => s.view.fontScale],
  ['openInEditMode', (s) => s.openInEditMode],
  ['docx.createBackup', (s) => s.createBackup],
  ['language', (s) => s.language],
  ['openAllFiles', (s) => s.openAllFiles],
];

/** Keys whose value differs between the saved settings and the draft. */
function changedValues(saved: ViewerSettings, draft: ViewerSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, get] of SETTING_KEYS) {
    if (JSON.stringify(get(saved)) !== JSON.stringify(get(draft))) out[key] = get(draft);
  }
  return out;
}

const TRIGGERS: [value: string, label: Key, hint: Key][] = [
  ['afterDelay', 'trigAfterDelay', 'trigAfterDelayHint'],
  ['onFocusChange', 'trigFocus', 'trigFocusHint'],
  ['onWindowChange', 'trigWindow', 'trigWindowHint'],
];

const GEAR_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9.1 4.4 8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.8-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2ZM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.5.4v2.8l-2.5.5L14 12l-2 2-2.1-1.4-.5 2.5H6.6l-.5-2.5L4 14l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2.1 4l2-2 2.1 1.4.4-2.4h2.8Zm.6 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>';

function checkbox(label: string, hint?: string) {
  const input = el('input', { type: 'checkbox' });
  const text = el('span', {}, [label]);
  if (hint) text.append(el('small', { textContent: hint }));
  const row = el('label', { className: 'settings-option' }, [input, text]);
  return { input, row };
}

function section(title: string, className = '') {
  const s = el('section', { className: `settings-section ${className}` });
  s.append(el('div', { className: 'settings-title', textContent: title }));
  return s;
}

/**
 * ⚙ button + popup. Changes are kept in a draft (view changes are previewed live)
 * and only written to settings with "Kaydet". "Vazgeç" or closing the menu drops them.
 */
function buildSettingsMenu() {
  let saved: ViewerSettings = {
    autoSave: { useEditorSetting: true, triggers: [] },
    view: { pageTheme: 'light', fullWidth: false, fontScale: 1 },
    openInEditMode: false,
    createBackup: true,
    language: lang,
    openAllFiles: true,
  };
  let draft: ViewerSettings = structuredClone(saved);
  let saving = false;

  const button = el('button', { className: 'icon settings-btn', title: t('settingsTitle') });
  button.innerHTML = GEAR_SVG;
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');

  const menu = el('div', { className: 'settings-menu' });
  menu.hidden = true;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', t('settingsTitle'));

  /** Apply a change to the draft and redraw. */
  const edit = (fn: (d: ViewerSettings) => void) => {
    fn(draft);
    render();
  };

  // --- Otomatik kaydetme (editable formats only) ---
  const autoSec = section(t('autoSaveSection'), 'editable-only');
  const useEditor = checkbox(t('useEditorAutoSave'), t('useEditorAutoSaveHint'));
  useEditor.input.addEventListener('change', () => edit((d) => (d.autoSave.useEditorSetting = useEditor.input.checked)));
  autoSec.append(useEditor.row);
  const triggerBoxes = TRIGGERS.map(([value, label, hint]) => {
    const box = checkbox(t(label), t(hint));
    box.row.classList.add('indent');
    box.input.value = value;
    box.input.addEventListener('change', () =>
      edit((d) => {
        const set = new Set(d.autoSave.triggers);
        if (box.input.checked) set.add(value);
        else set.delete(value);
        d.autoSave.triggers = TRIGGERS.map(([v]) => v).filter((v) => set.has(v));
      }),
    );
    autoSec.append(box.row);
    return box;
  });
  const autoNote = el('div', { className: 'settings-note' });
  autoSec.append(autoNote);

  // --- Görünüm ---
  const viewSec = section(t('viewSection'));
  const themeRow = el('div', { className: 'settings-row' }, [el('span', { textContent: t('pageLabel') })]);
  const themeGroup = el('div', { className: 'segmented' });
  themeGroup.setAttribute('role', 'radiogroup');
  const themeBtns = (
    [
      ['light', t('themeLight')],
      ['dark', t('themeDark')],
      ['auto', t('themeAuto')],
    ] as const
  ).map(([value, label]) => {
    const b = el('button', { textContent: label, title: value === 'auto' ? t('themeAutoTitle') : t('themeTitle', label) });
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => edit((d) => (d.view.pageTheme = value)));
    themeGroup.append(b);
    return [value, b] as const;
  });
  themeRow.append(themeGroup);

  const fullWidth = checkbox(t('fullWidth'), t('fullWidthHint'));
  fullWidth.input.addEventListener('change', () => edit((d) => (d.view.fullWidth = fullWidth.input.checked)));

  const scaleLabel = el('span', { className: 'scale-label' });
  const scaleBy = (delta: number) =>
    edit((d) => (d.view.fontScale = Math.round(Math.min(2, Math.max(0.7, d.view.fontScale + delta)) * 10) / 10));
  const smaller = el('button', { className: 'icon', textContent: 'A−', title: t('smaller') });
  const bigger = el('button', { className: 'icon', textContent: 'A+', title: t('bigger') });
  smaller.addEventListener('click', () => scaleBy(-0.1));
  bigger.addEventListener('click', () => scaleBy(0.1));
  const scaleRow = el('div', { className: 'settings-row' }, [
    el('span', { textContent: t('fontSize') }),
    el('div', { className: 'scale' }, [smaller, scaleLabel, bigger]),
  ]);
  viewSec.append(themeRow, fullWidth.row, scaleRow);

  // --- Açılış ve yedek (editable formats only) ---
  const openSec = section(t('openSection'));
  const openEdit = checkbox(t('openEdit'), t('openEditHint'));
  openEdit.input.addEventListener('change', () => edit((d) => (d.openInEditMode = openEdit.input.checked)));
  const backup = checkbox(t('backup'), t('backupHint'));
  backup.input.addEventListener('change', () => edit((d) => (d.createBackup = backup.input.checked)));
  const openAll = checkbox(t('openAll'), t('openAllHint'));
  openAll.input.addEventListener('change', () => edit((d) => (d.openAllFiles = openAll.input.checked)));
  openSec.append(openEdit.row, backup.row, openAll.row);

  // --- Language ---
  const langSec = section(t('languageSection'));
  const langSelect = el('select', { className: 'lang-select' });
  langSelect.setAttribute('aria-label', t('languageSection'));
  for (const code of LANGS) langSelect.append(el('option', { value: code, textContent: LANG_NAMES[code] }));
  langSelect.addEventListener('change', () => edit((d) => (d.language = isLang(langSelect.value) ? langSelect.value : 'en')));
  langSec.append(langSelect);

  // --- Kaydet / Vazgeç ---
  const status = el('div', { className: 'settings-status' });
  status.setAttribute('role', 'status');
  const saveSettingsBtn = el('button', { className: 'primary', textContent: t('save') });
  const cancelBtn = el('button', { textContent: t('cancel') });
  saveSettingsBtn.addEventListener('click', () => {
    const values = changedValues(saved, draft);
    if (!Object.keys(values).length) return;
    saving = true;
    setStatus(t('saving'));
    render();
    vscode.postMessage({ type: 'saveSettings', values });
  });
  cancelBtn.addEventListener('click', () => {
    discard();
    setStatus('');
  });
  const actions = el('div', { className: 'settings-actions' }, [saveSettingsBtn, cancelBtn]);

  const allBtn = el('button', {
    className: 'settings-link',
    textContent: t('openSettings'),
    title: t('openSettingsTitle'),
  });
  allBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
    toggle(false);
  });

  menu.append(autoSec, viewSec, openSec, langSec, actions, status, allBtn);

  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  function setStatus(text: string, kind: 'ok' | 'error' | '' = '') {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.className = `settings-status ${kind}`;
    if (kind === 'ok') statusTimer = setTimeout(() => setStatus(''), 2500);
  }

  const isDirty = () => Object.keys(changedValues(saved, draft)).length > 0;

  function discard() {
    draft = structuredClone(saved);
    render();
  }

  const toggle = (open: boolean) => {
    if (open) closeMenus(closeSettings);
    if (!open && !menu.hidden && isDirty() && !saving) discard(); // closed without saving
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('active', open);
    if (open) setStatus(status.classList.contains('error') ? status.textContent ?? '' : '', status.classList.contains('error') ? 'error' : '');
  };
  const closeSettings = () => toggle(false);
  menuClosers.add(closeSettings);
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(menu.hidden);
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      toggle(false);
      button.focus();
    }
  });

  function render() {
    const s = draft;
    const { useEditorSetting, triggers } = s.autoSave;
    useEditor.input.checked = useEditorSetting;
    // The editor's "focus change" mode also saves on window change, so that box follows it.
    const focus = triggers.includes('onFocusChange');
    for (const box of triggerBoxes) {
      const v = box.input.value;
      box.input.checked = triggers.includes(v) || (v === 'onWindowChange' && focus);
      box.input.disabled = useEditorSetting || (v === 'onWindowChange' && focus);
      box.row.classList.toggle('disabled', box.input.disabled);
    }
    autoNote.textContent = useEditorSetting
      ? t('autoNoteEditor')
      : triggers.length
        ? t('autoNoteOn')
        : t('autoNoteOff');

    for (const [value, b] of themeBtns) {
      b.classList.toggle('active', s.view.pageTheme === value);
      b.setAttribute('aria-checked', String(s.view.pageTheme === value));
    }
    fullWidth.input.checked = s.view.fullWidth;
    scaleLabel.textContent = `${Math.round(s.view.fontScale * 100)}%`;
    smaller.disabled = s.view.fontScale <= 0.7;
    bigger.disabled = s.view.fontScale >= 2;
    openEdit.input.checked = s.openInEditMode;
    backup.input.checked = s.createBackup;
    langSelect.value = s.language;
    openAll.input.checked = s.openAllFiles !== false;

    const dirty = isDirty();
    saveSettingsBtn.disabled = !dirty || saving;
    cancelBtn.disabled = !dirty || saving;
    menu.classList.toggle('has-changes', dirty);
    applyView(s.view); // live preview; reverted by discard()
  }

  return {
    button,
    menu,
    /** Saved settings from the host (initial load and after every change). */
    update(s: ViewerSettings) {
      // Keep unsaved choices while the menu is open (also when a save failed).
      const keepDraft = isDirty() && !menu.hidden;
      saved = structuredClone({ ...s, language: isLang(s.language) ? s.language : lang, openAllFiles: s.openAllFiles !== false });
      if (!keepDraft) draft = structuredClone(s);
      render();
    },
    saved() {
      saving = false;
      draft = structuredClone(saved);
      render();
      setStatus(t('saved'), 'ok');
    },
    failed(message: string) {
      saving = false;
      render();
      setStatus(t('saveFailed', message), 'error');
    },
  };
}

// ---------- Araçlar menu, find, status bar ----------

/** Menus close each other when one opens. */
const menuClosers = new Set<() => void>();
function closeMenus(except?: () => void) {
  for (const close of menuClosers) if (close !== except) close();
}

export interface LocalTool {
  label: string;
  run(): void;
}

type ToolEntry = { label: string; id: string; format?: string } | { label: string; local: LocalTool } | 'sep' | { heading: string };

const EXPORTS: Record<string, [format: string, label: Key][]> = {
  docx: [['pdf', 'fmtPdf'], ['md', 'fmtMd'], ['html', 'fmtHtml'], ['txt', 'fmtTxt']],
  xlsx: [['csv', 'fmtCsv'], ['pdf', 'fmtPdf'], ['html', 'fmtHtml']],
  xls: [['xlsx', 'fmtXlsx'], ['csv', 'fmtCsv'], ['pdf', 'fmtPdf'], ['html', 'fmtHtml']],
  csv: [['xlsx', 'fmtXlsx'], ['pdf', 'fmtPdf'], ['html', 'fmtHtml']],
  ods: [['xlsx', 'fmtXlsx'], ['csv', 'fmtCsv'], ['pdf', 'fmtPdf'], ['html', 'fmtHtml']],
  pptx: [['md', 'fmtMd'], ['txt', 'fmtTxt']],
};

function toolsFor(ext: string, local: LocalTool[], custom?: [string, Key][]): ToolEntry[] {
  const out: ToolEntry[] = [];
  if (ext === 'vsix') return out;
  const exports = custom ?? EXPORTS[ext];
  if (exports) {
    out.push({ heading: t('toolsExport') });
    for (const [format, label] of exports) out.push({ label: t(label), id: 'export', format });
    out.push('sep');
  }
  if (['docx', 'xlsx', 'xls', 'csv', 'pptx'].includes(ext)) out.push({ label: t('toolCompare'), id: 'compare' });
  for (const tool of local) out.push({ label: tool.label, local: tool });
  out.push({ label: t('toolSearch'), id: 'searchNotes' }, { label: t('toolActions'), id: 'actionList' });
  return out;
}

function buildToolsMenu() {
  const button = el('button', { className: 'tools-btn', textContent: t('tools'), title: t('toolsTitle') });
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const menu = el('div', { className: 'tools-menu' });
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const toggle = (open: boolean) => {
    if (open) closeMenus(close);
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('active', open);
  };
  const close = () => toggle(false);
  menuClosers.add(close);
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(menu.hidden);
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      close();
      button.focus();
    }
  });

  return {
    button,
    menu,
    setItems(entries: ToolEntry[]) {
      menu.replaceChildren();
      button.hidden = !entries.length;
      for (const entry of entries) {
        if (entry === 'sep') {
          menu.append(el('div', { className: 'tools-sep' }));
        } else if ('heading' in entry) {
          menu.append(el('div', { className: 'tools-heading', textContent: entry.heading }));
        } else {
          const item = el('button', { className: 'tools-item', textContent: entry.label });
          item.setAttribute('role', 'menuitem');
          item.addEventListener('click', () => {
            close();
            if ('local' in entry) entry.local.run();
            else vscode.postMessage({ type: 'tool', id: entry.id, format: entry.format });
          });
          menu.append(item);
        }
      }
    },
  };
}

/** Lower-case, accent-free, Turkish-aware form of one character (keeps 1:1 positions). */
function normChar(ch: string): string {
  const n = ch.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
  return n.length === 1 ? n : n.charAt(0) || ch;
}

const FIND_HIGHLIGHT = 'ov-find';

/**
 * Finds `text` in the page ("ozet" also matches "Özet"), selects it, scrolls to it
 * and briefly highlights it. Returns false when not found.
 */
export function findText(text: string): boolean {
  const query = Array.from(text.trim()).map(normChar).join('');
  if (!query) return false;
  const root = $('#content');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let hay = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data) continue;
    nodes.push(t);
    starts.push(hay.length);
    // One normalized char per UTF-16 unit keeps offsets aligned with the node text.
    hay += Array.from(t.data, (c) => normChar(c).padEnd(c.length, ' ')).join('');
  }
  const at = hay.indexOf(query);
  if (at === -1) return false;

  // Map positions in the joined text back to (node, offset).
  const locate = (pos: number): [Text, number] => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > pos) i--;
    return [nodes[i], Math.min(pos - starts[i], nodes[i].length)];
  };
  const range = document.createRange();
  range.setStart(...locate(at));
  range.setEnd(...locate(at + query.length));

  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  (range.startContainer.parentElement ?? root).scrollIntoView({ block: 'center' });

  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (highlights && HighlightCtor) {
    highlights.set(FIND_HIGHLIGHT, new HighlightCtor(range));
    setTimeout(() => highlights.delete(FIND_HIGHLIGHT), 4000);
  }
  return true;
}

let statusBar: HTMLElement | undefined;
/** Small bar at the bottom (word count, row count). Empty text hides it. */
export function setStatus(text: string) {
  if (!statusBar) {
    statusBar = el('footer', { className: 'status-bar' });
    statusBar.setAttribute('aria-live', 'polite');
    document.body.append(statusBar);
  }
  statusBar.textContent = text;
  statusBar.hidden = !text;
}

/**
 * Builds the toolbar and wires host messages to the format handlers.
 * `extra` is a slot for format-specific controls (formatting buttons, zoom, ...).
 */
export function startViewer(handlers: FormatHandlers, extra?: HTMLElement) {
  let editing = false;
  const toolbar = $('#toolbar');
  const title = el('nav', { className: 'title crumbs' });
  title.setAttribute('aria-label', t('breadcrumbLabel'));

  // Breadcrumb: click opens the part in File Explorer; right-click shows the
  // extension's "Reveal in File Explorer" / "Copy Path" menu for that part.
  const renderCrumbs = (parts: string[]) => {
    title.replaceChildren();
    parts.forEach((part, i) => {
      if (i > 0) title.append(el('span', { className: 'crumb-sep', textContent: '›' }));
      const isFile = i === parts.length - 1;
      const crumb = el('button', {
        className: isFile ? 'crumb crumb-file' : 'crumb',
        textContent: part,
        title: t('crumbTitle', parts.slice(0, i + 1).join('/')),
      });
      crumb.dataset.vscodeContext = JSON.stringify({ officeViewerCrumb: i, preventDefaultContextMenuItems: true });
      crumb.addEventListener('click', () => vscode.postMessage({ type: 'reveal', depth: i }));
      title.append(crumb);
    });
  };
  const editBtn = el('button', { className: 'primary' });
  saveBtn = el('button', { textContent: t('save'), title: t('saveTitle') });
  saveBtn.hidden = true;
  saveBtn.disabled = true;
  const externalBtn = el('button', { textContent: t('openExternal'), title: t('openExternalTitle') });

  const extraSlot = el('div', { className: 'extra' });
  if (extra) extraSlot.append(extra);

  toolbar.append(title, extraSlot, el('div', { className: 'spacer' }), editBtn, saveBtn, externalBtn);
  if (handlers.noEdit) {
    editBtn.hidden = true;
    externalBtn.hidden = true;
  }

  // Settings gear, pinned to the toolbar's top-right corner.
  const settings = buildSettingsMenu();
  const tools = buildToolsMenu();
  toolbar.append(tools.button, tools.menu, settings.button, settings.menu);
  // Keep the pinned Tools / ⚙ buttons clear of the other toolbar items (labels differ per language).
  const fitToolbar = () => {
    const right = tools.button.hidden ? 0 : tools.button.offsetWidth + 6;
    toolbar.style.paddingRight = `${right + 48}px`;
    tools.menu.style.right = '10px';
  };
  new ResizeObserver(fitToolbar).observe(tools.button);
  window.addEventListener('resize', fitToolbar);

  const refreshEditButton = (canEditInPlace: boolean) => {
    if (handlers.editAction) {
      const action = handlers.editAction();
      editBtn.hidden = !action;
      if (action) {
        editBtn.textContent = action.label;
        editBtn.title = action.title;
      }
      return;
    }
    if (!canEditInPlace) {
      editBtn.textContent = t('editExternal');
      editBtn.title = t('editExternalTitle');
      return;
    }
    editBtn.textContent = editing ? t('view') : t('edit');
    editBtn.title = editing ? t('viewTitle') : t('editTitle');
    saveBtn!.hidden = !editing;
    document.body.classList.toggle('editing', editing);
  };

  let canEdit = false;
  editBtn.addEventListener('click', () => {
    const action = handlers.editAction?.();
    if (action) {
      action.run();
      return;
    }
    if (!canEdit) {
      vscode.postMessage({ type: 'openExternal' });
      return;
    }
    editing = !editing;
    handlers.setEditing?.(editing);
    refreshEditButton(true);
  });
  saveBtn.addEventListener('click', () => vscode.postMessage({ type: 'save' }));
  externalBtn.addEventListener('click', () => vscode.postMessage({ type: 'openExternal' }));

  // Handle undo/redo (and bold/italic/underline in Word) inside editable areas
  // ourselves. Otherwise the editor gets them: Ctrl+B would toggle the sidebar
  // and Ctrl+Z would not reach the text. stopPropagation keeps them from the
  // editor's keybinding listener on window. Ctrl+S/C/V are left to the editor.
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !target.isContentEditable) return;
    const key = e.key.toLowerCase();
    let command: string | undefined;
    if (key === 'z' && !e.shiftKey) command = 'undo';
    else if (key === 'y' || (key === 'z' && e.shiftKey)) command = 'redo';
    else if (!e.shiftKey && target.closest('.page')) {
      command = ({ b: 'bold', i: 'italic', u: 'underline' } as Record<string, string>)[key];
    }
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    document.execCommand(command);
  });

  window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (msg?.type === 'init') {
      const init = msg as InitMessage;
      renderCrumbs(init.crumbs?.length ? init.crumbs : [init.fileName]);
      canEdit = init.editable && !!handlers.setEditing;
      document.body.classList.toggle('can-edit', canEdit);
      editing = false;
      saveBtn!.disabled = true;
      refreshEditButton(canEdit);
      tools.setItems(toolsFor(init.ext, handlers.localTools ?? []));
      fitToolbar();
      try {
        await handlers.render(base64ToBytes(init.base64), init);
        editing = canEdit && !!init.startEditing;
        handlers.setEditing?.(editing);
        refreshEditButton(canEdit);
        if (handlers.exports) tools.setItems(toolsFor(init.ext, handlers.localTools ?? [], handlers.exports()));
        fitToolbar();
        if (init.find) findText(init.find);
        if (init.line) handlers.gotoLine?.(init.line);
      } catch (e) {
        showError(e);
      }
    } else if (msg?.type === 'gotoLine') {
      handlers.gotoLine?.(Number(msg.line) || 1);
    } else if (msg?.type === 'find') {
      findText(String(msg.text ?? ''));
    } else if (msg?.type === 'settings') {
      settings.update(msg.settings as ViewerSettings);
    } else if (msg?.type === 'settingsSaved') {
      settings.saved();
    } else if (msg?.type === 'settingsError') {
      settings.failed(String(msg.message));
    } else if (msg?.type === 'saved') {
      saveBtn!.disabled = true;
    } else if (msg?.type === 'getContent') {
      try {
        const body = await handlers.getContent!();
        vscode.postMessage({ type: 'response', requestId: msg.requestId, body });
      } catch (e) {
        vscode.postMessage({ type: 'response', requestId: msg.requestId, error: e instanceof Error ? e.message : String(e) });
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
}
