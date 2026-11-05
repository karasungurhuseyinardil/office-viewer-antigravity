import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { t } from './lang';
import { fileName } from './notes/index';

// C# decompiling with ILSpy's command-line tool (ilspycmd, a .NET global tool).

const SCHEME = 'office-decompiled';
const exe = process.platform === 'win32' ? '.exe' : '';
const texts = new Map<string, string>(); // virtual document id -> C#
const cache = new Map<string, string>(); // dll|mtime|type -> C#
let nextId = 1;

export function registerDecompiledProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent: (uri) => texts.get(uri.query) ?? '',
  });
}

/** ilspycmd from the setting, PATH, or the default .NET tools folder. */
function findIlspy(): string | undefined {
  const custom = vscode.workspace.getConfiguration('officeViewer').get<string>('decompiler.path', '').trim();
  if (custom) return existsSync(custom) ? custom : undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, `ilspycmd${exe}`);
    if (dir && existsSync(p)) return p;
  }
  const tools = join(homedir(), '.dotnet', 'tools', `ilspycmd${exe}`);
  return existsSync(tools) ? tools : undefined;
}

/** Runs a program (no shell) and returns stdout. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size < 200 * 1024 * 1024) out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`));
    });
  });
}

/** Finds ilspycmd, offering to install it (dotnet tool install) when it is missing. */
async function ensureIlspy(): Promise<string | undefined> {
  const found = findIlspy();
  if (found) return found;
  const install = t('ilspyInstall');
  const pick = await vscode.window.showInformationMessage(t('ilspyMissing'), { modal: true }, install);
  if (pick !== install) return undefined;
  try {
    await run('dotnet', ['--version'], 30_000);
  } catch {
    const open = t('open');
    if ((await vscode.window.showErrorMessage(t('noDotnet'), open)) === open) {
      await vscode.env.openExternal(vscode.Uri.parse('https://dotnet.microsoft.com/download'));
    }
    return undefined;
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('ilspyInstalling') }, () =>
    run('dotnet', ['tool', 'install', '--global', 'ilspycmd'], 300_000),
  );
  return findIlspy();
}

/** Line of `member` (method, property or nested type) in the C#, if found. */
export function findMember(code: string, member: string): number | undefined {
  const name = member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns =
    member === '.ctor' || member === '.cctor'
      ? [] // constructors: the type line is a fine target
      : [
          new RegExp(`\\b(class|struct|interface|enum|record)\\s+${name}\\b`),
          new RegExp(`\\b${name}\\s*(<[^>]*>)?\\s*\\(`),
          new RegExp(`\\b${name}\\b`),
        ];
  const lines = code.split('\n');
  for (const re of patterns) {
    const i = lines.findIndex((l) => re.test(l) && !/^\s*(\/\/|using\b)/.test(l));
    if (i >= 0) return i;
  }
  return undefined;
}

/**
 * Decompiles `typeName` (or the whole assembly) of the .NET file at `uri` and
 * opens the C# read-only beside the viewer, at `member` when given.
 */
export async function decompile(uri: vscode.Uri, typeName?: string, member?: string): Promise<void> {
  if (uri.scheme !== 'file') return;
  const ilspy = await ensureIlspy();
  if (!ilspy) return;
  const { mtime } = await vscode.workspace.fs.stat(uri);
  const key = `${uri.toString()}|${mtime}|${typeName ?? '*'}`;
  let code = cache.get(key);
  if (code === undefined) {
    const args = ['--disable-updatecheck', ...(typeName ? ['-t', typeName] : []), uri.fsPath];
    code = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('decompiling', typeName ?? fileName(uri)) },
      () => run(ilspy, args, 180_000),
    );
    if (cache.size > 50) cache.delete(cache.keys().next().value!);
    cache.set(key, code);
  }

  const id = String(nextId++);
  texts.set(id, code);
  if (texts.size > 50) texts.delete(texts.keys().next().value!);
  const asm = fileName(uri).replace(/\.(dll|exe)$/i, '');
  const shortName = (typeName ?? asm).split(/[.+]/).pop() || asm;
  const docUri = vscode.Uri.from({ scheme: SCHEME, path: `/${asm}/${shortName}.cs`, query: id });
  const doc = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(docUri), 'csharp');
  const line = member ? findMember(code, member) : undefined;
  const pos = new vscode.Position(line ?? 0, 0);
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
    selection: new vscode.Range(pos, pos),
  });
  if (line !== undefined) vscode.commands.executeCommand('revealLine', { lineNumber: line, at: 'center' });
}
