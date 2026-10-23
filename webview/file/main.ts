// Universal viewer: code / text, Markdown, images, audio, video, fonts, zip-like
// archives, OpenDocument text, RTF, and a hex view for everything else.
import JSZip from 'jszip';
import { marked } from 'marked';
import { highlightCode } from '../../shared/highlight';
import type { Key } from '../../shared/i18n';
import { $, bytesToBase64, el, locale, setStatus, showBanner, startViewer, t, vscode } from '../common/bridge';
import { sanitizeHtml } from '../common/sanitize';

type Kind = 'text' | 'markdown' | 'svg' | 'image' | 'audio' | 'video' | 'font' | 'zip' | 'odf' | 'rtf' | 'binary';

const IMAGE = ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'ico', 'cur', 'avif', 'apng'];
const AUDIO = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'weba'];
const VIDEO = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv'];
const FONT = ['ttf', 'otf', 'woff', 'woff2'];
const ZIP = ['zip', 'jar', 'war', 'ear', 'apk', 'aab', 'nupkg', 'whl', 'xpi', 'epub', 'crx', 'sketch', 'docm', 'xlsm', 'pptm'];
const ODF = ['odt', 'odp', 'odg', 'ott'];
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', cur: 'image/x-icon', avif: 'image/avif', apng: 'image/apng', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg', mkv: 'video/x-matroska',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};

const MAX_TEXT = 5 * 1024 * 1024; // decode at most 5 MB of a text file
const LINES_PER_CHUNK = 4000;
const HEX_CHUNK = 64 * 1024;

let fileName = '';
let ext = '';
let kind: Kind = 'binary';
let blobUrls: string[] = [];
let renderedLines: HTMLElement[] = [];
let pendingLines: string[] = [];
let lineContainer: HTMLElement | undefined;

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} KB` : `${(n / 1024 ** 2).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;

function blobUrl(bytes: Uint8Array, mime: string): string {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }));
  blobUrls.push(url);
  return url;
}

// ---------- Detection ----------

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** Text decoded from the bytes, or undefined when it looks binary. */
function decodeText(bytes: Uint8Array): { text: string; encoding: string; truncated: boolean } | undefined {
  const truncated = bytes.length > MAX_TEXT;
  const part = truncated ? bytes.subarray(0, MAX_TEXT) : bytes;
  if (startsWith(part, [0xff, 0xfe])) return { text: new TextDecoder('utf-16le').decode(part), encoding: 'UTF-16 LE', truncated };
  if (startsWith(part, [0xfe, 0xff])) return { text: new TextDecoder('utf-16be').decode(part), encoding: 'UTF-16 BE', truncated };
  const sample = part.subarray(0, 8192);
  if (sample.includes(0)) return undefined; // NUL bytes: binary
  try {
    // A cut multi-byte character at the end of a truncated file is fine.
    const text = new TextDecoder('utf-8', { fatal: !truncated }).decode(part);
    return { text: text.replace(/^\uFEFF/, ''), encoding: startsWith(part, [0xef, 0xbb, 0xbf]) ? 'UTF-8 BOM' : 'UTF-8', truncated };
  } catch {
    // Not UTF-8: accept as Windows-1254 (Turkish) / 1252 text if it is mostly printable.
    let ctrl = 0;
    for (const b of sample) if (b < 9 || (b > 13 && b < 32)) ctrl++;
    if (ctrl > sample.length * 0.02) return undefined;
    return { text: new TextDecoder('windows-1254').decode(part), encoding: 'Windows-1254', truncated };
  }
}

function detect(bytes: Uint8Array): Kind {
  if (ext === 'svg') return 'svg';
  if (IMAGE.includes(ext)) return 'image';
  if (AUDIO.includes(ext)) return 'audio';
  if (VIDEO.includes(ext)) return 'video';
  if (FONT.includes(ext)) return 'font';
  if (ODF.includes(ext)) return 'odf';
  if (ZIP.includes(ext)) return 'zip';
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return 'rtf'; // {\rtf
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'zip'; // PK..
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || startsWith(bytes, [0xff, 0xd8, 0xff]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image';
  return decodeText(bytes.subarray(0, 64 * 1024)) ? 'text' : 'binary';
}

/** Human-readable type from magic bytes (binary files). */
function magicType(b: Uint8Array): string {
  const ascii = (at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
  if (startsWith(b, [0x4d, 0x5a])) return 'Windows executable / DLL (PE)';
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return 'ELF executable / library';
  if (startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xfe, 0xed, 0xfa, 0xcf]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe])) {
    return ext === 'class' ? 'Java class file' : 'Mach-O / Java class';
  }
  if (ascii(0, 16) === 'SQLite format 3\u0000') return 'SQLite database';
  if (startsWith(b, [0x00, 0x61, 0x73, 0x6d])) return 'WebAssembly module';
  if (startsWith(b, [0x1f, 0x8b])) return 'gzip archive';
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7-Zip archive';
  if (ascii(0, 4) === 'Rar!') return 'RAR archive';
  if (ascii(257, 5) === 'ustar') return 'tar archive';
  if (startsWith(b, [0x42, 0x5a, 0x68])) return 'bzip2 archive';
  if (startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a])) return 'xz archive';
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0])) return 'Microsoft Office 97-2003 (OLE) document';
  if (ascii(0, 5) === '%PDF-') return 'PDF document';
  if (ascii(0, 4) === '8BPS') return 'Photoshop image (PSD)';
  if (ascii(0, 4) === 'RIFF') return `RIFF (${ascii(8, 4).trim()})`;
  if (ascii(0, 4) === 'glTF') return 'glTF binary model';
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return 'TIFF image';
  if (ascii(4, 4) === 'ftyp') return `ISO media (${ascii(8, 4).trim()})`;
  return ext ? `.${ext}` : t('binaryFile');
}

// ---------- Code / text ----------

/**
 * Splits highlighted HTML into lines, re-opening <span>s that cross a line break,
 * so every line is valid on its own (line numbers stay aligned with wrapping).
 */
function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = '';
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!part) continue;
    if (part === '\n') {
      lines.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else if (part.startsWith('<span')) {
      open.push(part);
      cur += part;
    } else if (part === '</span>') {
      open.pop();
      cur += part;
    } else {
      cur += part;
    }
  }
  lines.push(cur + '</span>'.repeat(open.length));
  return lines;
}

function renderMoreLines() {
  if (!lineContainer) return;
  const start = renderedLines.length;
  const frag = document.createDocumentFragment();
  for (const html of pendingLines.splice(0, LINES_PER_CHUNK)) {
    const row = el('div', { className: 'ln' });
    row.dataset.n = String(renderedLines.length + 1);
    const code = el('span', { className: 'tx' });
    code.innerHTML = html || '\u200b'; // keep empty lines one line high
    row.append(code);
    renderedLines.push(row);
    frag.append(row);
  }
  lineContainer.querySelector('.more')?.remove();
  lineContainer.append(frag);
  if (pendingLines.length) {
    const more = el('button', { className: 'more', textContent: `${t('showMore')} (${pendingLines.length.toLocaleString(locale)})` });
    more.addEventListener('click', renderMoreLines);
    lineContainer.append(more);
  }
  return start;
}

function renderCode(text: string) {
  const { html, language } = highlightCode(text, fileName);
  pendingLines = splitHighlighted(html);
  renderedLines = [];
  const total = pendingLines.length;
  lineContainer = el('div', { className: 'code-view hljs' });
  lineContainer.style.setProperty('--gutter', `${String(total).length + 1}ch`);
  renderMoreLines();
  const wrap = el('input', { type: 'checkbox' });
  wrap.addEventListener('change', () => lineContainer?.classList.toggle('wrap', wrap.checked));
  const wrapControl = el('label', { className: 'inline-check', title: t('wrapLinesTitle') }, [wrap, t('wrapLines')]);
  $('#content').replaceChildren(lineContainer);
  return { total, language, wrapControl };
}

function gotoLine(line: number) {
  if (!lineContainer) return;
  while (renderedLines.length < line && pendingLines.length) renderMoreLines();
  const row = renderedLines[Math.min(line, renderedLines.length) - 1];
  if (!row) return;
  // Vertical only: scrollIntoView would also scroll sideways on long lines.
  const content = $('#content');
  content.scrollTop += row.getBoundingClientRect().top - content.getBoundingClientRect().top - content.clientHeight / 2;
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1600);
}

/** First line visible at the top of the view (for "Edit in editor"). */
function topVisibleLine(): number {
  const top = $('#content').getBoundingClientRect().top;
  for (const row of renderedLines) if (row.getBoundingClientRect().bottom > top + 4) return Number(row.dataset.n);
  return 1;
}

// ---------- Toolbar slot ----------

const extraSlot = el('div', { className: 'extra' });
function setExtra(...nodes: Node[]) {
  extraSlot.replaceChildren(...nodes);
}

function toggle(labels: [string, string], onChange: (second: boolean) => void, startSecond = false): { group: HTMLElement; start(): void } {
  const group = el('div', { className: 'segmented' });
  const a = el('button', { textContent: labels[0] });
  const b = el('button', { textContent: labels[1] });
  const set = (second: boolean) => {
    a.classList.toggle('active', !second);
    b.classList.toggle('active', second);
    onChange(second);
  };
  a.addEventListener('click', () => set(false));
  b.addEventListener('click', () => set(true));
  group.append(a, b);
  // Caller shows the first state after it has the element (onChange may use it).
  return { group, start: () => set(startSecond) };
}

// ---------- Other kinds ----------

function renderImage(bytes: Uint8Array, mime: string) {
  const img = el('img', { className: 'img-view fit', src: blobUrl(bytes, mime), alt: fileName });
  img.addEventListener('click', () => img.classList.toggle('fit'));
  img.addEventListener('load', () => setStatus(`${t('typeImage')} · ${img.naturalWidth} × ${img.naturalHeight} · ${fmtSize(bytes.length)}`));
  $('#content').replaceChildren(el('div', { className: 'img-stage' }, [img]));
}

function renderMedia(bytes: Uint8Array, video: boolean) {
  const media = el(video ? 'video' : 'audio', { controls: true, src: blobUrl(bytes, MIME[ext] ?? '') });
  media.className = video ? 'media-view video' : 'media-view';
  media.addEventListener('error', () => showBanner(t('mediaError'), 'warn'));
  $('#content').replaceChildren(el('div', { className: 'media-stage' }, [media]));
  setStatus(`${video ? t('typeVideo') : t('typeAudio')} · ${fmtSize(bytes.length)}`);
}

async function renderFont(bytes: Uint8Array) {
  const family = `ov-font-${Date.now()}`;
  const face = new FontFace(family, bytes.slice().buffer);
  await face.load();
  document.fonts.add(face);
  const page = el('div', { className: 'font-view' });
  page.style.fontFamily = `'${family}'`;
  for (const size of [12, 16, 24, 36, 48, 72]) {
    page.append(el('div', { className: 'font-row' }, [el('span', { className: 'font-size', textContent: `${size}px` }), el('span', { textContent: t('fontSample') })]));
    (page.lastElementChild!.lastElementChild as HTMLElement).style.fontSize = `${size}px`;
  }
  page.append(el('h3', { textContent: t('fontGlyphs') }));
  const grid = el('div', { className: 'glyphs' });
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ÇĞİÖŞÜçğıöşüÁÉÍÑÓÚáéíñóúÀÂÈÊËÎÏÔŒÙÛàâèêëîïôœùûÿ!?&@#%€$*(){}[]<>/\\'.split('')) {
    grid.append(el('span', { textContent: ch }));
  }
  page.append(grid);
  $('#content').replaceChildren(page);
  setStatus(`${t('typeFont')} · ${fileName} · ${fmtSize(bytes.length)}`);
}

async function renderZip(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files)
    .filter((f) => !f.dir)
    .sort((a, b) => a.name.localeCompare(b.name));
  const size = (f: JSZip.JSZipObject) => (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  const total = files.reduce((n, f) => n + size(f), 0);

  const list = el('div', { className: 'zip-list' });
  const preview = el('div', { className: 'zip-preview' }, [el('p', { className: 'settings-note', textContent: t('archiveSelect') })]);
  let selected: HTMLElement | undefined;
  for (const f of files) {
    const item = el('button', { className: 'zip-item', title: f.name }, [el('span', { className: 'zip-name', textContent: f.name }), el('span', { className: 'zip-size', textContent: fmtSize(size(f)) })]);
    item.addEventListener('click', async () => {
      selected?.classList.remove('active');
      selected = item;
      item.classList.add('active');
      const data = await f.async('uint8array');
      const save = el('button', { textContent: t('archiveExtract'), title: t('archiveExtractTitle') });
      save.addEventListener('click', () => vscode.postMessage({ type: 'saveBytes', name: f.name.split('/').pop(), base64: bytesToBase64(data) }));
      const head = el('div', { className: 'zip-preview-head' }, [el('strong', { textContent: f.name }), save]);
      const e = f.name.split('.').pop()?.toLowerCase() ?? '';
      let body: HTMLElement;
      if ((IMAGE.includes(e) || e === 'svg') && MIME[e]) {
        body = el('img', { className: 'img-view fit', src: blobUrl(data, MIME[e]), alt: f.name });
      } else {
        const decoded = data.length <= 2 * 1024 * 1024 ? decodeText(data) : undefined;
        if (decoded) {
          const pre = el('pre', { className: 'zip-text hljs' });
          pre.innerHTML = highlightCode(decoded.text, f.name).html;
          body = pre;
        } else {
          body = el('p', { className: 'settings-note', textContent: t('archiveNoPreview') });
        }
      }
      preview.replaceChildren(head, body);
    });
    list.append(item);
  }
  $('#content').replaceChildren(el('div', { className: 'zip-view' }, [list, preview]));
  setStatus(`${t('typeArchive')} · ${t('archiveSummary', files.length, fmtSize(total))} · ${fmtSize(bytes.length)}`);
}

async function renderOdf(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('content.xml')?.async('string');
  const page = el('article', { className: 'page' });
  if (xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const body = doc.getElementsByTagNameNS('*', 'body')[0];
    const walk = (node: Element) => {
      for (const child of Array.from(node.children)) {
        if (child.localName === 'h') {
          const level = Math.min(3, Math.max(1, Number(child.getAttribute('text:outline-level') ?? child.getAttributeNS('*', 'outline-level') ?? 1)));
          page.append(el(`h${level}` as 'h1', { textContent: child.textContent ?? '' }));
        } else if (child.localName === 'p') {
          page.append(el('p', { textContent: child.textContent || '\u00a0' }));
        } else if (child.localName === 'list-item') {
          page.append(el('p', { textContent: `• ${child.textContent ?? ''}` }));
        } else if (child.localName === 'table-row') {
          page.append(el('p', { textContent: Array.from(child.children).map((c) => c.textContent ?? '').join(' | ') }));
        } else {
          walk(child);
        }
      }
    };
    if (body) walk(body);
  }
  $('#content').replaceChildren(page);
  showBanner(t('odfNote'), 'info');
  setStatus(`OpenDocument · ${fmtSize(bytes.length)}`);
}

/** Very small RTF → text: drops header groups and control words, keeps paragraphs and accented letters. */
function rtfToText(rtf: string): string {
  const codepage = Number(rtf.match(/\\ansicpg(\d+)/)?.[1] ?? 1252);
  const decoder = new TextDecoder(`windows-${[1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258].includes(codepage) ? codepage : 1252}`);
  let s = rtf.replace(/\{\\\*[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
  s = s.replace(/\{\\(fonttbl|colortbl|stylesheet|info|listtable|listoverridetable)[\s\S]*?\}\s*(?=\\|\{|[^}])/g, '');
  s = s.replace(/\\par[d]?\b ?/g, '\n').replace(/\\line\b ?/g, '\n').replace(/\\tab\b ?/g, '\t');
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_m, h) => decoder.decode(new Uint8Array([parseInt(h, 16)])));
  s = s.replace(/\\u(-?\d+)\??/g, (_m, n) => String.fromCharCode((Number(n) + 65536) % 65536));
  s = s.replace(/\\[a-z]+-?\d* ?/gi, '').replace(/\\([{}\\])/g, '$1').replace(/[{}]/g, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function renderBinary(bytes: Uint8Array, totalSize = bytes.length) {
  const info = el('div', { className: 'bin-info' }, [
    el('div', {}, [el('span', { className: 'vsix-label', textContent: `${t('fileType')}: ` }), magicType(bytes)]),
    el('div', {}, [el('span', { className: 'vsix-label', textContent: `${t('fileSize')}: ` }), `${fmtSize(totalSize)} (${totalSize.toLocaleString(locale)} B)`]),
  ]);
  const pre = el('pre', { className: 'hex-view' });
  const title = el('div', { className: 'settings-note' });
  let shown = 0;
  const more = el('button', { textContent: t('showMore') });
  const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
  const addChunk = () => {
    const end = Math.min(bytes.length, shown + HEX_CHUNK);
    const lines: string[] = [];
    for (let off = shown; off < end; off += 16) {
      const row = bytes.subarray(off, Math.min(off + 16, end));
      const h = Array.from(row, (b) => hex(b, 2)).join(' ').padEnd(47, ' ');
      const a = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${hex(off, 8)}  ${h}  ${a}`);
    }
    pre.append(lines.join('\n') + '\n');
    shown = end;
    title.textContent = t('hexView', fmtSize(shown), fmtSize(totalSize));
    more.hidden = shown >= bytes.length;
  };
  more.addEventListener('click', addChunk);
  addChunk();
  $('#content').replaceChildren(el('div', { className: 'bin-view' }, [info, title, pre, more]));
  showBanner(t('cannotPreview'), 'info');
  setStatus(`${t('binaryFile')} · ${fmtSize(totalSize)}`);
}

// ---------- Viewer ----------

const CODE_EXPORTS: [string, Key][] = [
  ['pdf', 'fmtPdf'],
  ['html', 'fmtHtml'],
  ['md', 'fmtMd'],
];
const MD_EXPORTS: [string, Key][] = [
  ['docx', 'fmtDocx'],
  ['pdf', 'fmtPdf'],
  ['html', 'fmtHtml'],
];

startViewer(
  {
    async render(bytes, init) {
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
      blobUrls = [];
      lineContainer = undefined;
      fileName = init.fileName;
      ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
      kind = detect(bytes);
      setExtra();
      showBanner('');

      // Huge file: only its beginning was sent; show details + hex of that part.
      if (init.totalSize && init.totalSize > bytes.length) {
        kind = 'binary';
        renderBinary(bytes, init.totalSize);
        showBanner(t('largeFile', fmtSize(bytes.length)), 'info');
        return;
      }

      if (kind === 'image') return renderImage(bytes, MIME[ext] ?? 'image/png');
      if (kind === 'audio' || kind === 'video') return renderMedia(bytes, kind === 'video');
      if (kind === 'font') return renderFont(bytes).catch(() => renderBinary(bytes));
      if (kind === 'zip') return renderZip(bytes).catch(() => renderBinary(bytes));
      if (kind === 'odf') return renderOdf(bytes).catch(() => renderBinary(bytes));

      const decoded = decodeText(bytes);
      if (!decoded) {
        kind = 'binary';
        return renderBinary(bytes);
      }
      if (kind === 'rtf') {
        $('#content').replaceChildren(el('pre', { className: 'rtf-view', textContent: rtfToText(decoded.text) }));
        showBanner(t('rtfNote'), 'info');
        setStatus(`RTF · ${fmtSize(bytes.length)}`);
        return;
      }
      const info = (lines: number, language: string) =>
        setStatus(`${t('linesInfo', lines.toLocaleString(locale), language)} · ${decoded.encoding} · ${fmtSize(bytes.length)}`);
      if (decoded.truncated) showBanner(t('largeFile', fmtSize(MAX_TEXT)), 'info');

      if (kind === 'markdown' || kind === 'svg') {
        const previewNode =
          kind === 'markdown'
            ? (() => {
                const article = el('article', { className: 'page md-view' });
                article.append(sanitizeHtml(marked.parse(decoded.text, { gfm: true, async: false }) as string));
                return article;
              })()
            : el('div', { className: 'img-stage' }, [el('img', { className: 'img-view fit', src: blobUrl(bytes, 'image/svg+xml'), alt: fileName })]);
        const seg = toggle([t('showPreview'), t('showSource')], (source) => {
          if (source) {
            const code = renderCode(decoded.text);
            setExtra(seg.group, code.wrapControl);
            info(code.total, code.language);
          } else {
            lineContainer = undefined;
            $('#content').replaceChildren(previewNode);
            setExtra(seg.group);
            setStatus(`${kind === 'markdown' ? 'Markdown' : 'SVG'} · ${fmtSize(bytes.length)}`);
          }
        });
        seg.start();
        return;
      }

      kind = 'text';
      const { total, language, wrapControl } = renderCode(decoded.text);
      setExtra(wrapControl);
      info(total, language);
    },
    gotoLine,
    editAction() {
      if (kind === 'binary' || kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'font' || kind === 'zip' || kind === 'odf') return null;
      return {
        label: t('editInEditor'),
        title: t('editInEditorTitle'),
        run: () => vscode.postMessage({ type: 'tool', id: 'editInTextEditor', line: lineContainer ? topVisibleLine() : 1 }),
      };
    },
    exports() {
      if (kind === 'markdown') return MD_EXPORTS;
      if (kind === 'text' || kind === 'svg' || kind === 'rtf') return CODE_EXPORTS;
      return [];
    },
  },
  extraSlot,
);
