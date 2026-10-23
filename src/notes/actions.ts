import * as vscode from 'vscode';
import * as XLSX from 'xlsx';
import { docxToHtml } from '../convert/text';
import { openAndFind } from '../providers/base';
import { collectFiles, dateFromName, FileCache, fileName, normalize } from './index';
import { currentLang, t } from '../lang';
import { ACTION_HEADERS } from '../../shared/i18n';

export interface ActionRow {
  task: string;
  owner: string;
  due: string;
  status: string;
  /** Meeting note file. */
  file: string;
  fileLabel: string;
  folder: string;
  /** Note date (from the file name, else file time), ms. */
  noteTime: number;
}

const decode = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>\s*<p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Header words for each column (normalized, no accents). */
const COLUMNS = ACTION_HEADERS;

function columnIndex(headers: string[], words: string[]): number {
  return headers.findIndex((h) => words.some((w) => h === w || h.startsWith(w + ' ') || h.endsWith(' ' + w)));
}

/** True for template placeholders like "…", "...", "-". */
const isEmpty = (s: string) => !s || /^[.…\-–—_\s]*$/.test(s);

/** Rows of every table whose header has a "Görev" column. */
export function extractActions(html: string): Omit<ActionRow, 'file' | 'fileLabel' | 'folder' | 'noteTime'>[] {
  const out: Omit<ActionRow, 'file' | 'fileLabel' | 'folder' | 'noteTime'>[] = [];
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/g) ?? []).map((tr) =>
      (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map((td) => decode(td)),
    );
    if (rows.length < 2) continue;
    const headers = rows[0].map(normalize);
    const task = columnIndex(headers, COLUMNS.task);
    if (task === -1) continue;
    const owner = columnIndex(headers, COLUMNS.owner);
    const due = columnIndex(headers, COLUMNS.due);
    const status = columnIndex(headers, COLUMNS.status);
    for (const r of rows.slice(1)) {
      const row = {
        task: r[task] ?? '',
        owner: owner >= 0 ? (r[owner] ?? '') : '',
        due: due >= 0 ? (r[due] ?? '') : '',
        status: status >= 0 ? (r[status] ?? '') : '',
      };
      if (isEmpty(row.task)) continue;
      for (const k of ['owner', 'due', 'status'] as const) if (isEmpty(row[k])) row[k] = '';
      out.push(row);
    }
  }
  return out;
}

const actionCache = new FileCache((bytes) => docxToHtml(bytes).then(extractActions));

export async function collectActions(folder?: vscode.Uri): Promise<ActionRow[]> {
  const rows: ActionRow[] = [];
  for (const uri of await collectFiles(['docx'], folder)) {
    const found = await actionCache.get(uri);
    if (!found?.length) continue;
    const name = fileName(uri);
    let time = dateFromName(name)?.getTime();
    if (time === undefined) time = (await vscode.workspace.fs.stat(uri)).mtime;
    for (const r of found) {
      rows.push({
        ...r,
        file: uri.toString(),
        fileLabel: name,
        folder: vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..'), false),
        noteTime: time,
      });
    }
  }
  return rows;
}

let current: { panel: vscode.WebviewPanel; folder?: vscode.Uri; html: () => string } | undefined;

/** New UI language: rebuild the panel page (it asks for the rows again). */
export function reloadActionList() {
  if (current) current.panel.webview.html = current.html();
}

/** "Aksiyon Listesi" panel: all action rows from meeting notes in `folder` (or the workspace). */
export async function showActionList(context: vscode.ExtensionContext, folder?: vscode.Uri): Promise<void> {
  if (current) {
    current.folder = folder;
    current.panel.reveal();
    await sendRows();
    return;
  }
  const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
  const panel = vscode.window.createWebviewPanel('officeViewer.actions', t('actionsTitle'), vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    enableFindWidget: true,
    localResourceRoots: [distRoot],
  });
  const html = () => {
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const uri = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, f)).toString();
  return `<!DOCTYPE html>
<html lang="${currentLang()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('styles.css')}" rel="stylesheet">
</head>
<body class="actions-page" data-lang="${currentLang()}">
<header id="toolbar"></header>
<main id="content"><div class="loading">${t('scanningNotes')}</div></main>
<script type="module" nonce="${nonce}" src="${uri('actions.js')}"></script>
</body>
</html>`;
  };
  current = { panel, folder, html };
  panel.onDidDispose(() => (current = undefined));
  panel.webview.html = html();

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg?.type) {
      case 'ready':
      case 'refresh':
        await sendRows();
        break;
      case 'open': {
        const target = vscode.Uri.parse(String(msg.file));
        if (target.scheme === 'file') await openAndFind(target, 'officeViewer.docx', String(msg.text ?? ''));
        break;
      }
      case 'exportXlsx':
        await exportRows(msg.rows as ActionRow[]);
        break;
    }
  });
}

async function sendRows() {
  if (!current) return;
  const { panel, folder } = current;
  panel.webview.postMessage({ type: 'loading' });
  const rows = await collectActions(folder);
  panel.title = `${t('actionsTitle')}${folder ? ` — ${fileName(folder)}` : ''}`;
  panel.webview.postMessage({
    type: 'rows',
    rows,
    scope: folder ? vscode.workspace.asRelativePath(folder, false) : t('allWorkspace'),
  });
}

async function exportRows(rows: ActionRow[]) {
  if (!Array.isArray(rows) || !rows.length) return;
  const base = current?.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const dest = await vscode.window.showSaveDialog({
    defaultUri: base ? vscode.Uri.joinPath(base, `${t('actionsTitle')}.xlsx`) : undefined,
    filters: { Excel: ['xlsx'] },
    saveLabel: t('exportXlsx'),
  });
  if (!dest) return;
  const data = rows.map((r) => ({
    [t('colTask')]: String(r.task ?? ''),
    [t('colOwner')]: String(r.owner ?? ''),
    [t('colDue')]: String(r.due ?? ''),
    [t('colStatus')]: String(r.status ?? ''),
    [t('colMeeting')]: String(r.fileLabel ?? ''),
    [t('colFolder')]: String(r.folder ?? ''),
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 50 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 22 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t('actionsTitle').slice(0, 31));
  await vscode.workspace.fs.writeFile(dest, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
  const open = t('open');
  if ((await vscode.window.showInformationMessage(t('savedFile', fileName(dest)), open)) === open) {
    await vscode.commands.executeCommand('vscode.openWith', dest, 'officeViewer.sheet');
  }
}
