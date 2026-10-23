import * as vscode from 'vscode';
import { activeViewerUri, requestEditOnOpen } from './providers/base';
import { htmlToDocx } from './providers/docx';
import { t } from './lang';

const pad = (n: number) => String(n).padStart(2, '0');

/** Replaces DD / MM / YYYY in the configured file name with today's date. */
export function formatDateName(pattern: string, date: Date): string {
  const name = (pattern || 'DD.MM.YYYY')
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MM/g, pad(date.getMonth() + 1))
    .replace(/DD/g, pad(date.getDate()));
  // Characters Windows does not allow in file names.
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'meeting';
}

export function defaultTemplateHtml(dateText: string): string {
  // Headings follow the UI language; the action list recognises the table headers in every language.
  return `<h1>${t('mnTitle', dateText)}</h1>
<p><strong>${t('mnParticipants')}:</strong> …</p>
<h2>${t('mnSummary')}</h2>
<p>…</p>
<h2>${t('mnAgenda')}</h2>
<ul><li>…</li></ul>
<h2>${t('mnDecisions')}</h2>
<ol><li>…</li></ol>
<h2>${t('mnActions')}</h2>
<table>
<tr><td><strong>${t('mnColTask')}</strong></td><td><strong>${t('mnColOwner')}</strong></td><td><strong>${t('mnColDue')}</strong></td></tr>
<tr><td>…</td><td>…</td><td>…</td></tr>
</table>`;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Folder to create the note in: right-clicked item, the open document's folder, or a picked one. */
async function targetFolder(arg: unknown): Promise<vscode.Uri | undefined> {
  let uri = arg instanceof vscode.Uri ? arg : activeViewerUri() ?? vscode.window.activeTextEditor?.document.uri;
  if (uri && uri.scheme === 'file') {
    const stat = await vscode.workspace.fs.stat(uri).then(undefined, () => undefined);
    if (stat && stat.type !== vscode.FileType.Directory) uri = vscode.Uri.joinPath(uri, '..');
    if (stat) return uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    openLabel: t('mnCreateHere'),
  });
  return picked?.[0];
}

async function templateBytes(dateText: string): Promise<Uint8Array> {
  const path = vscode.workspace.getConfiguration('officeViewer').get<string>('meetingNote.template', '').trim();
  if (path) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const isAbsolute = /^([a-zA-Z]:[\\/]|\/)/.test(path);
    const uri = isAbsolute ? vscode.Uri.file(path) : root ? vscode.Uri.joinPath(root, path) : undefined;
    if (uri) {
      try {
        return await vscode.workspace.fs.readFile(uri);
      } catch {
        vscode.window.showWarningMessage(t('mnTemplateMissing', path));
      }
    }
  }
  return htmlToDocx(defaultTemplateHtml(dateText));
}

export async function newMeetingNote(arg?: unknown): Promise<void> {
  const folder = await targetFolder(arg);
  if (!folder) return;

  const now = new Date();
  const pattern = vscode.workspace.getConfiguration('officeViewer').get<string>('meetingNote.fileName', 'DD.MM.YYYY');
  const base = formatDateName(pattern, now);
  let file = vscode.Uri.joinPath(folder, `${base}.docx`);

  if (await exists(file)) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: t('mnOpenExisting'), id: 'open' },
        { label: t('mnCreateNew'), description: `${base} (2).docx`, id: 'new' },
      ],
      { placeHolder: t('mnExists', base) },
    );
    if (!choice) return;
    if (choice.id === 'open') {
      await vscode.commands.executeCommand('vscode.openWith', file, 'officeViewer.docx');
      return;
    }
    let n = 2;
    while (await exists((file = vscode.Uri.joinPath(folder, `${base} (${n}).docx`)))) n++;
  }

  const dateText = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
  await vscode.workspace.fs.writeFile(file, await templateBytes(dateText));
  requestEditOnOpen(file);
  await vscode.commands.executeCommand('vscode.openWith', file, 'officeViewer.docx');
}
