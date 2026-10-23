import * as vscode from 'vscode';
import { extOf, fileToSearchText } from '../convert/text';

export const SEARCH_EXTS = ['docx', 'xlsx', 'xls', 'csv', 'pptx'];
const EXCLUDE = '**/{node_modules,.git,dist,out}/**';
const MAX_FILES = 2000;

interface Cached<T> {
  mtime: number;
  value: T;
}

/** Per-file cache keyed by uri + mtime, so unchanged files are read once. */
export class FileCache<T> {
  private readonly map = new Map<string, Cached<T>>();
  constructor(private readonly load: (bytes: Uint8Array, uri: vscode.Uri) => Promise<T>) {}

  async get(uri: vscode.Uri): Promise<T | undefined> {
    try {
      const { mtime } = await vscode.workspace.fs.stat(uri);
      const hit = this.map.get(uri.toString());
      if (hit && hit.mtime === mtime) return hit.value;
      const value = await this.load(await vscode.workspace.fs.readFile(uri), uri);
      this.map.set(uri.toString(), { mtime, value });
      return value;
    } catch {
      return undefined; // unreadable / locked / broken file: skip it
    }
  }
}

export const textCache = new FileCache<string>((bytes, uri) => fileToSearchText(bytes, extOf(uri.path)));

/**
 * Office files to look at: inside `folder` when given, else the configured
 * `officeViewer.notes.searchFolders`, else the whole workspace.
 */
export async function collectFiles(exts: string[], folder?: vscode.Uri): Promise<vscode.Uri[]> {
  const glob = `**/*.{${exts.join(',')}}`;
  const roots: (vscode.Uri | undefined)[] = [];
  if (folder) roots.push(folder);
  else {
    const configured = vscode.workspace.getConfiguration('officeViewer').get<string[]>('notes.searchFolders', []);
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    for (const p of configured) {
      if (/^([a-zA-Z]:[\\/]|\/)/.test(p)) roots.push(vscode.Uri.file(p));
      else if (base) roots.push(vscode.Uri.joinPath(base, p));
    }
    if (!roots.length) roots.push(undefined);
  }
  const seen = new Map<string, vscode.Uri>();
  for (const root of roots) {
    const pattern = root ? new vscode.RelativePattern(root, glob) : glob;
    for (const uri of await vscode.workspace.findFiles(pattern, EXCLUDE, MAX_FILES)) {
      if (!/~\$/.test(uri.path)) seen.set(uri.toString(), uri); // skip Office lock files (~$name.docx)
    }
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path, 'tr'));
}

/** Lower-case, Turkish-aware, accent-free text for matching ("Özet" ~ "ozet", "İ"/"ı" ~ "i"). */
export function normalize(s: string): string {
  return s
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i');
}

/** Date from a file name like 22.10.2026 / 22-10-2026 / 2026-10-22, if any. */
export function dateFromName(name: string): Date | undefined {
  let m = name.match(/(\d{1,2})[._-](\d{1,2})[._-](\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = name.match(/(\d{4})[._-](\d{1,2})[._-](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return undefined;
}

export const fileName = (uri: vscode.Uri) => decodeURIComponent(uri.path.split('/').pop() ?? '');

export function viewTypeFor(path: string): string | undefined {
  switch (extOf(path)) {
    case 'docx':
      return 'officeViewer.docx';
    case 'xlsx':
    case 'xls':
    case 'csv':
    case 'ods':
      return 'officeViewer.sheet';
    case 'vsix':
      return 'officeViewer.vsix';
    case 'pptx':
      return 'officeViewer.pptx';
    case 'pdf':
      return 'officeViewer.pdf';
    default:
      return undefined;
  }
}
