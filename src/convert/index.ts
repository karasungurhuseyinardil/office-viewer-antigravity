import * as vscode from 'vscode';
import * as XLSX from 'xlsx';
import { marked } from 'marked';
import { htmlToDocx } from '../providers/docx';
import { htmlToPdf, standaloneHtml } from './pdf';
import { t } from '../lang';
import type { Key } from '../../shared/i18n';
import {
  docxToHtml,
  docxToText,
  extOf,
  htmlToMarkdown,
  pptxToSlides,
  readWorkbook,
  sheetsToCsv,
  sheetsToHtml,
  slidesToMarkdown,
  slidesToText,
  escapeHtml,
} from './text';
import { HIGHLIGHT_CSS, HIGHLIGHT_LIGHT_VARS, highlightCode, languageFor } from '../../shared/highlight';

/** UTF-8 (or UTF-16 with BOM) text, or undefined for binary data. */
function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return undefined;
  }
}

/** Code / text file → highlighted HTML page (for HTML and PDF export). */
function codePage(code: string, fileName: string): string {
  const { html } = highlightCode(code, fileName);
  const css =
    `.code{font-family:Consolas,'Cascadia Mono',monospace;font-size:9.5pt;line-height:1.45;white-space:pre-wrap;` +
    `overflow-wrap:anywhere;background:#f8f8f8;border:1px solid #ddd;border-radius:4px;padding:10px}` +
    `body{${HIGHLIGHT_LIGHT_VARS}}${HIGHLIGHT_CSS}h1{font-size:14pt}`;
  return standaloneHtml(fileName, `<h1>${escapeHtml(fileName)}</h1><pre class="code"><code>${html}</code></pre>`, css);
}

const FENCE = '```';

export type Target = 'pdf' | 'md' | 'html' | 'txt' | 'csv' | 'xlsx' | 'docx';

const LABEL_KEYS: Record<Target, Key> = {
  pdf: 'fmtPdf',
  md: 'fmtMd',
  html: 'fmtHtml',
  txt: 'fmtTxt',
  csv: 'fmtCsv',
  xlsx: 'fmtXlsx',
  docx: 'fmtDocx',
};
const label = (target: Target) => `${t(LABEL_KEYS[target])}${target === 'xlsx' || target === 'docx' ? '' : ` (.${target})`}`;

/** Which formats a file can be turned into. */
export function targetsFor(ext: string): Target[] {
  switch (ext) {
    case 'docx':
      return ['pdf', 'md', 'html', 'txt'];
    case 'xlsx':
      return ['csv', 'pdf', 'html'];
    case 'xls':
    case 'ods':
      return ['xlsx', 'csv', 'pdf', 'html'];
    case 'csv':
      return ['xlsx', 'pdf', 'html'];
    case 'pptx':
      return ['md', 'txt'];
    case 'md':
    case 'markdown':
      return ['docx', 'html', 'pdf'];
    default:
      return [];
  }
}

const baseName = (uri: vscode.Uri) => decodeURIComponent(uri.path.split('/').pop() ?? 'file').replace(/\.[^.]+$/, '');

/** Asks which sheet to export when a workbook has several. */
async function pickSheet(wb: XLSX.WorkBook): Promise<string | undefined> {
  if (wb.SheetNames.length < 2) return wb.SheetNames[0];
  return vscode.window.showQuickPick(wb.SheetNames, { placeHolder: t('pickSheet') });
}

/** Converts file bytes. Returns undefined when the user cancels a choice. */
export async function convertBytes(bytes: Uint8Array, ext: string, target: Target, title: string): Promise<Uint8Array | undefined> {
  const text = (s: string) => new TextEncoder().encode(s);
  const withBom = (s: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...text(s)]);

  if (ext === 'docx') {
    if (target === 'txt') return text(await docxToText(bytes));
    const html = await docxToHtml(bytes);
    if (target === 'md') return text(htmlToMarkdown(html));
    if (target === 'html') return text(standaloneHtml(title, html));
    if (target === 'pdf') return htmlToPdf(standaloneHtml(title, html));
  }

  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' || ext === 'ods') {
    const { wb, csvSep } = readWorkbook(bytes, ext);
    if (target === 'csv') {
      const sheet = await pickSheet(wb);
      if (!sheet) return undefined;
      // Turkish Excel opens ';' + UTF-8 BOM correctly.
      const sep = ext === 'csv' ? csvSep : ';';
      return withBom(sheetsToCsv({ ...wb, SheetNames: [sheet] }, sep)[0].csv + '\n');
    }
    if (target === 'xlsx') return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    if (target === 'html') return text(standaloneHtml(title, sheetsToHtml(wb)));
    if (target === 'pdf') return htmlToPdf(standaloneHtml(title, sheetsToHtml(wb)));
  }

  if (ext === 'pptx') {
    const slides = await pptxToSlides(bytes);
    if (target === 'md') return text(slidesToMarkdown(slides));
    if (target === 'txt') return text(slidesToText(slides));
  }

  if (ext === 'md' || ext === 'markdown') {
    const html = await marked.parse(new TextDecoder().decode(bytes), { gfm: true });
    if (target === 'docx') return htmlToDocx(html);
    if (target === 'html') return text(standaloneHtml(title, html));
    if (target === 'pdf') return htmlToPdf(standaloneHtml(title, html));
  }

  // Any other text / code file: highlighted HTML or PDF, or a Markdown code block.
  const code = decodeText(bytes);
  if (code !== undefined && (target === 'html' || target === 'pdf' || target === 'md')) {
    const fileName = ext ? `${title}.${ext}` : title;
    if (target === 'md') return text(`# ${fileName}\n\n${FENCE}${languageFor(fileName) ?? ''}\n${code}\n${FENCE}\n`);
    const page = codePage(code, fileName);
    return target === 'html' ? text(page) : htmlToPdf(page);
  }
  throw new Error(t('cannotConvertTo', ext, label(target)));
}

/**
 * Converts `uri` to `target` (asked with a QuickPick when not given),
 * asks where to save, writes the file and offers to open it.
 */
export async function convertFile(uri: vscode.Uri, target?: Target): Promise<void> {
  const ext = extOf(uri.path);
  const targets = targetsFor(ext);
  // A format chosen in a viewer (e.g. code → PDF) is checked by convertBytes itself.
  if (!targets.length && !target) {
    vscode.window.showWarningMessage(t('cannotConvertExt', ext));
    return;
  }
  if (!target) {
    const pick = await vscode.window.showQuickPick(
      targets.map((target) => ({ label: label(target), target })),
      { placeHolder: t('convertPick', `${baseName(uri)}.${ext}`) },
    );
    if (!pick) return;
    target = pick.target;
  }

  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(uri, '..', `${baseName(uri)}.${target}`),
    filters: { [label(target)]: [target] },
    saveLabel: t('exportSaveLabel'),
  });
  if (!dest) return;

  const out = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('creating', label(target)) },
    async () => convertBytes(await vscode.workspace.fs.readFile(uri), ext, target!, baseName(uri)),
  );
  if (!out) return;
  await vscode.workspace.fs.writeFile(dest, out);

  const open = t('open');
  const reveal = t('revealInFolder');
  const pick = await vscode.window.showInformationMessage(t('savedFile', decodeURIComponent(dest.path.split('/').pop() ?? '')), open, reveal);
  if (pick === open) await vscode.commands.executeCommand('vscode.open', dest);
  if (pick === reveal) await vscode.commands.executeCommand('revealFileInOS', dest);
}
