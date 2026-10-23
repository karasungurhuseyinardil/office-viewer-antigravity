// Reading Office files in the extension host (Node): text, HTML and Markdown.
// Shared by search, action list, compare and export.
import mammoth from 'mammoth';
import JSZip from 'jszip';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import * as XLSX from 'xlsx';
import { t } from '../lang';

export function extOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  return name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''; // "Dockerfile" has no extension
}

const toBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// ---------- Word ----------

/** docx -> HTML. Highlighted text becomes <mark>. */
export async function docxToHtml(bytes: Uint8Array): Promise<string> {
  const result = await mammoth.convertToHtml(
    { buffer: toBuffer(bytes) },
    { styleMap: ['highlight => mark'], includeDefaultStyleMap: true },
  );
  return result.value;
}

export async function docxToText(bytes: Uint8Array): Promise<string> {
  return (await mammoth.extractRawText({ buffer: toBuffer(bytes) })).value;
}

let turndown: TurndownService | undefined;
export function htmlToMarkdown(html: string): string {
  if (!turndown) {
    turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
    turndown.use(gfm);
    turndown.addRule('mark', { filter: ['mark'], replacement: (content) => `==${content}==` });
    // Images are embedded as data URIs; keep the Markdown readable.
    turndown.addRule('img', { filter: 'img', replacement: (_c, node) => `![${(node as HTMLElement).getAttribute('alt') ?? 'image'}](image)` });
  }
  return turndown.turndown(markdownFriendlyTables(html)).trim() + '\n';
}

/**
 * Word tables come out as <td><p>…</p></td> with no header cells, which the GFM
 * plugin keeps as raw HTML. Make the first row a header and unwrap paragraphs.
 */
function markdownFriendlyTables(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (_m, inner: string) => {
    let body = inner.replace(/<(td|th)([^>]*)>([\s\S]*?)<\/(td|th)>/g, (_c, tag: string, attrs: string, cell: string) => {
      const text = cell.replace(/<\/p>\s*<p>/g, '<br>').replace(/<\/?p>/g, '').replace(/\|/g, '\\|');
      return `<${tag}${attrs}>${text}</${tag}>`;
    });
    body = body.replace(/<tr>([\s\S]*?)<\/tr>/, (_r, row: string) => `<tr>${row.replace(/<(\/?)td/g, '<$1th')}</tr>`);
    return `<table>${body}</table>`;
  });
}

// ---------- Spreadsheets ----------

/** Reads xlsx/xls bytes or csv text (Turkish delimiter/encoding aware) into a workbook. */
export function readWorkbook(bytes: Uint8Array, ext: string): { wb: XLSX.WorkBook; csvSep: string } {
  if (ext !== 'csv') return { wb: XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellText: true }), csvSep: ',' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1254').decode(bytes);
  }
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0];
  const count = (ch: string) => first.split(ch).length - 1;
  const csvSep = [';', '\t', ','].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',');
  return { wb: XLSX.read(text, { type: 'string', FS: csvSep, raw: true } as XLSX.ParsingOptions), csvSep };
}

export function sheetsToCsv(wb: XLSX.WorkBook, sep = ','): { name: string; csv: string }[] {
  return wb.SheetNames.map((name) => ({ name, csv: XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: sep }) }));
}

export function sheetsToHtml(wb: XLSX.WorkBook): string {
  return wb.SheetNames.map((name) => {
    const table = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
    const body = table.replace(/^[\s\S]*?<table/i, '<table').replace(/<\/table>[\s\S]*$/i, '</table>');
    return (wb.SheetNames.length > 1 ? `<h2>${escapeHtml(name)}</h2>` : '') + body;
  }).join('\n');
}

// ---------- PowerPoint ----------

export interface SlideText {
  index: number;
  paragraphs: string[];
  notes: string;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

function paragraphsOf(xml: string): string[] {
  const out: string[] = [];
  for (const p of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
    const text = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join('');
    if (text.trim()) out.push(text.trim());
  }
  return out;
}

function relsOf(xml: string | undefined, base: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  for (const m of xml?.matchAll(/<Relationship\b([^>]*)\/?>/g) ?? []) {
    const attr = (name: string) => m[1].match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
    const target = attr('Target');
    const parts = base.split('/').slice(0, -1);
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    map.set(attr('Id'), { target: target.startsWith('/') ? target.slice(1) : parts.join('/'), type: attr('Type') });
  }
  return map;
}

export async function pptxToSlides(bytes: Uint8Array): Promise<SlideText[]> {
  const zip = await JSZip.loadAsync(bytes);
  const read = (p: string) => zip.file(p)?.async('string');
  const pres = await read('ppt/presentation.xml');
  if (!pres) throw new Error(t('notPptx'));
  const presRels = relsOf(await read('ppt/_rels/presentation.xml.rels'), 'ppt/presentation.xml');
  const ids = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
  const slides: SlideText[] = [];
  for (const [i, id] of ids.entries()) {
    const path = presRels.get(id)?.target;
    const xml = path ? await read(path) : undefined;
    if (!path || !xml) continue;
    const rels = relsOf(await read(path.replace(/([^/]+)$/, '_rels/$1.rels')), path);
    const notesPath = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notesXml = notesPath ? await read(notesPath) : undefined;
    // Notes slide also contains the slide number placeholder; keep the body text only.
    const notes = notesXml ? paragraphsOf(notesXml).filter((t) => !/^\d+$/.test(t)).join('\n') : '';
    slides.push({ index: i + 1, paragraphs: paragraphsOf(xml), notes });
  }
  return slides;
}

export function slidesToMarkdown(slides: SlideText[]): string {
  return (
    slides
      .map((s) => {
        const [title, ...rest] = s.paragraphs;
        const lines = [`## ${s.index}. ${title ?? t('slideHeading')}`, '', ...rest.map((p) => `- ${p}`)];
        if (s.notes) lines.push('', `> ${t('notesLabel')}: ${s.notes.replace(/\n/g, '\n> ')}`);
        return lines.join('\n');
      })
      .join('\n\n') + '\n'
  );
}

export function slidesToText(slides: SlideText[]): string {
  return slides.map((s) => [`${t('slideHeading')} ${s.index}`, ...s.paragraphs, s.notes ? `${t('notesLabel')}: ${s.notes}` : ''].filter(Boolean).join('\n')).join('\n\n') + '\n';
}

// ---------- Shared ----------

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Plain text for search. */
export async function fileToSearchText(bytes: Uint8Array, ext: string): Promise<string> {
  switch (ext) {
    case 'docx':
      return docxToText(bytes);
    case 'xlsx':
    case 'xls':
    case 'csv': {
      const { wb } = readWorkbook(bytes, ext);
      return sheetsToCsv(wb, ' | ').map((s) => s.csv).join('\n');
    }
    case 'pptx':
      return slidesToText(await pptxToSlides(bytes));
    default:
      return '';
  }
}

/** Structured text for side-by-side comparison. */
export async function fileToCompareText(bytes: Uint8Array, ext: string): Promise<string> {
  switch (ext) {
    case 'docx':
      return htmlToMarkdown(await docxToHtml(bytes));
    case 'xlsx':
    case 'xls':
    case 'csv': {
      const { wb, csvSep } = readWorkbook(bytes, ext);
      const sheets = sheetsToCsv(wb, ext === 'csv' ? csvSep : ',');
      return sheets.map((s) => (sheets.length > 1 ? `## ${s.name}\n${s.csv}` : s.csv)).join('\n\n') + '\n';
    }
    case 'pptx':
      return slidesToMarkdown(await pptxToSlides(bytes));
    default:
      return '';
  }
}
