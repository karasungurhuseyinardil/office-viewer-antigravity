import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extOf, fileToCompareText } from './convert/text';
import { fileName } from './notes/index';
import { t } from './lang';

const SCHEME = 'office-diff';
const texts = new Map<string, string>();
let nextId = 1;

/** Read-only text documents shown on both sides of the diff view. */
export function registerCompareProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent: (uri) => texts.get(uri.query) ?? '',
  });
}

function virtualDoc(label: string, text: string): vscode.Uri {
  const id = String(nextId++);
  texts.set(id, text);
  if (texts.size > 40) texts.delete(texts.keys().next().value!); // keep memory small
  // ".md" so the diff gets Markdown highlighting; label shows in the tab.
  return vscode.Uri.from({ scheme: SCHEME, path: `/${label}.md`, query: id });
}

/** Path of the git executable, from the built-in Git extension when available. */
async function gitPath(): Promise<string> {
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): { git: { path: string } } }>('vscode.git');
    const api = (ext?.isActive ? ext.exports : await ext?.activate())?.getAPI(1);
    if (api?.git.path) return api.git.path;
  } catch {
    // fall back to PATH
  }
  return 'git';
}

/** File content at HEAD (`git show HEAD:./name`, run in the file's folder). */
async function gitHead(uri: vscode.Uri): Promise<Uint8Array> {
  const git = await gitPath();
  const dir = vscode.Uri.joinPath(uri, '..').fsPath;
  return new Promise((resolve, reject) => {
    const child = spawn(git, ['show', `HEAD:./${fileName(uri)}`], { cwd: dir, windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(t('gitRunFailed', e.message))));
    child.on('close', (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(out)));
      else reject(new Error(/not a git repository/i.test(err) ? t('gitNotRepo') : /exists on disk, but not in|does not exist/i.test(err) ? t('gitNotCommitted') : err.trim() || t('gitExit', String(code))));
    });
  });
}

/**
 * "Sürümle Karşılaştır": shows the file next to its .bak backup, its last Git
 * commit or another file, as text in the built-in diff view.
 */
export async function compareFile(uri: vscode.Uri): Promise<void> {
  const ext = extOf(uri.path);
  if (!['docx', 'xlsx', 'xls', 'csv', 'pptx'].includes(ext)) {
    vscode.window.showWarningMessage(t('cannotCompareExt', ext));
    return;
  }
  const bak = vscode.Uri.file(uri.fsPath + '.bak');
  type Source = vscode.QuickPickItem & { id: 'bak' | 'git' | 'file' };
  const items: Source[] = [];
  if (uri.scheme === 'file' && existsSync(bak.fsPath)) items.push({ id: 'bak', label: `$(history) ${t('cmpBak')}`, description: t('cmpBakDesc') });
  items.push({ id: 'git', label: `$(git-commit) ${t('cmpGit')}`, description: t('cmpGitDesc') });
  items.push({ id: 'file', label: `$(file) ${t('cmpFile')}` });

  const pick = await vscode.window.showQuickPick(items, { placeHolder: t('cmpPick', fileName(uri)) });
  if (!pick) return;

  let otherBytes: Uint8Array;
  let otherExt = ext;
  let otherLabel: string;
  try {
    if (pick.id === 'bak') {
      otherBytes = await vscode.workspace.fs.readFile(bak);
      otherLabel = t('cmpBackupLabel', fileName(uri));
    } else if (pick.id === 'git') {
      otherBytes = await gitHead(uri);
      otherLabel = `${fileName(uri)} (HEAD)`;
    } else {
      const chosen = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.joinPath(uri, '..'),
        canSelectMany: false,
        filters: { [t('cmpOfficeFiles')]: ['docx', 'xlsx', 'xls', 'csv', 'pptx'] },
        openLabel: t('cmpOpenLabel'),
      });
      if (!chosen?.[0]) return;
      otherBytes = await vscode.workspace.fs.readFile(chosen[0]);
      otherExt = extOf(chosen[0].path);
      otherLabel = fileName(chosen[0]);
    }
  } catch (e) {
    vscode.window.showErrorMessage(t('cmpFailed', (e as Error).message));
    return;
  }

  const [left, right] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: t('cmpProgress') },
    async () =>
      Promise.all([
        fileToCompareText(otherBytes, otherExt),
        vscode.workspace.fs.readFile(uri).then((b) => fileToCompareText(b, ext)),
      ]),
  );
  await vscode.commands.executeCommand(
    'vscode.diff',
    virtualDoc(otherLabel, left),
    virtualDoc(fileName(uri), right),
    `${otherLabel} ↔ ${fileName(uri)}`,
    { preview: true },
  );
}
