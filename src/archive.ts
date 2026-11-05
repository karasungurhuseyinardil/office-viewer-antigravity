// Archives the webview can't open itself (rar, 7z, tar.*, iso, cab, ...), read with
// the system's bsdtar (libarchive): Windows 10+ ships it as System32\tar.exe, macOS as tar.
// Encrypted RAR / 7z need 7-Zip (libarchive can't decrypt them); encrypted zip works with bsdtar.
// Single compressed files (.gz .zst .bz2 .xz) are inflated here.
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as zlib from 'node:zlib';
import Bunzip from 'seek-bzip';
import { XzReadableStream } from 'xz-decompress';
import { t } from './lang';

export interface ArchiveEntry {
  name: string;
  size: number;
}

/** password: archive is encrypted, ask for one · wrongPassword: retry · need7zip: offer to install 7-Zip */
export type ArchiveErrorCode = 'password' | 'wrongPassword' | 'need7zip';

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly code?: ArchiveErrorCode,
  ) {
    super(message);
  }
}

const ENCRYPTED = /passphrase|password|encrypt|crypto/i;
const MAX_OUT = 200 * 1024 * 1024;

function bsdtar(): string {
  if (process.platform === 'win32') {
    const p = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    return existsSync(p) ? p : 'tar';
  }
  return process.platform === 'darwin' ? 'tar' : 'bsdtar';
}

/** 7-Zip: setting, the usual install folders, then PATH. */
export function findSevenZip(): string | undefined {
  const configured = vscode.workspace.getConfiguration('officeViewer').get<string>('sevenZip.path')?.trim();
  if (configured && existsSync(configured)) return configured;
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe'),
          join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', '7-Zip', '7z.exe'),
          join(process.env.ProgramW6432 ?? 'C:\\Program Files', '7-Zip', '7z.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', '7z.exe'),
        ]
      : ['/opt/homebrew/bin/7zz', '/usr/local/bin/7zz', '/usr/bin/7zz', '/usr/local/bin/7z', '/usr/bin/7z'];
  const found = candidates.find((p) => p && existsSync(p));
  if (found) return found;
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const exe of process.platform === 'win32' ? ['7z.exe'] : ['7zz', '7z']) {
      if (dir && existsSync(join(dir, exe))) return join(dir, exe);
    }
  }
  return undefined;
}

/** Runs a program (no shell, no stdin so nothing can wait for a typed password) and returns stdout. */
function run(cmd: string, args: string[], timeoutMs: number, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) {
        child.kill();
        reject(new Error(`larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else {
        const lines = err
          .replace(/^tar(\.exe)?: /gm, '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !/^(Error exit delayed|7-Zip |Scanning|Open archive|--$|Path = |Type = |Physical Size)/.test(l));
        reject(new Error(lines.slice(-2).join(' ') || `exit code ${code}`));
      }
    });
  });
}

let ansiDecoder: TextDecoder | undefined;
/**
 * bsdtar on Windows prints names in the ANSI code page (1254 Turkish, 1252 Western, ...).
 * Read it once from the registry; UTF-8 output is detected first.
 */
async function decodeNames(buf: Buffer): Promise<string> {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // not UTF-8
  }
  if (!ansiDecoder) {
    let label = 'windows-1252';
    if (process.platform === 'win32') {
      try {
        const out = (await run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], 10_000, 65536)).toString();
        const cp = Number(out.match(/ACP\s+REG_SZ\s+(\d+)/)?.[1]);
        const map: Record<number, string> = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874' };
        if (map[cp]) label = map[cp];
        else if (cp >= 1250 && cp <= 1258) label = `windows-${cp}`;
      } catch {
        // keep 1252
      }
    }
    ansiDecoder = new TextDecoder(label);
  }
  return ansiDecoder.decode(buf);
}

/** First bytes → container format (only the ones that matter for passwords). */
async function formatOf(path: string): Promise<'zip' | 'rar' | '7z' | 'other'> {
  const fh = await open(path, 'r');
  try {
    const b = Buffer.alloc(8);
    await fh.read(b, 0, 8, 0);
    if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
    if (b.toString('latin1', 0, 4) === 'Rar!') return 'rar';
    if (b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
    return 'other';
  } finally {
    await fh.close();
  }
}

// ---------- Single compressed files ----------

async function inflateXz(b: Buffer): Promise<Buffer> {
  const stream = new XzReadableStream(new Blob([new Uint8Array(b)]).stream());
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_OUT) {
      await reader.cancel();
      throw new Error(`larger than ${MAX_OUT / 1024 / 1024} MB`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
const SINGLE: [RegExp, (b: Buffer) => Buffer | Promise<Buffer>][] = [
  [/\.(gz|gzip)$/i, (b) => zlib.gunzipSync(b, { maxOutputLength: MAX_OUT })],
  [/\.bz2$/i, (b) => Bunzip.decode(b)],
  [/\.xz$/i, inflateXz],
  ...(zstd ? ([[/\.zst$/i, (b: Buffer) => zstd(b)]] as [RegExp, (b: Buffer) => Buffer][]) : []),
];

/** data.json.gz → data.json; tar.* / .tgz are real archives and go to bsdtar. */
function singleCompressed(path: string): { name: string; inflate: (b: Buffer) => Buffer | Promise<Buffer> } | undefined {
  if (/\.tar\.[^.\\/]+$|\.t(gz|bz2?|xz|zst)$/i.test(path)) return undefined;
  const hit = SINGLE.find(([re]) => re.test(path));
  if (!hit) return undefined;
  return { name: basename(path).replace(hit[0], '') || basename(path), inflate: hit[1] };
}

// Listing inflates the whole file to learn its size; keep the result for the click that follows.
let lastInflated: { path: string; mtime: number; data: Buffer } | undefined;
async function inflateSingle(path: string, inflate: (b: Buffer) => Buffer | Promise<Buffer>): Promise<Buffer> {
  const { mtimeMs, size } = await stat(path);
  if (lastInflated?.path === path && lastInflated.mtime === mtimeMs) return lastInflated.data;
  if (size > 100 * 1024 * 1024) throw new Error(t('archiveTooBig'));
  const data = await inflate(await readFile(path));
  lastInflated = { path, mtime: mtimeMs, data };
  return data;
}

// ---------- 7-Zip ----------

// No password typed yet: give 7-Zip a placeholder so it never stops to ask; an encrypted
// archive then fails with "Wrong password", which means "ask the user".
const NO_PASSWORD = 'office-viewer-no-password';

function sevenZipError(e: unknown, password: string | undefined): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (ENCRYPTED.test(msg)) throw new ArchiveError(msg, password ? 'wrongPassword' : 'password');
  throw e instanceof Error ? e : new Error(msg);
}

/** `7z l -slt` blocks after the "----------" line: "Path = a.txt", "Size = 3", "Folder = -", "Attributes = A". */
export function parseSevenZipList(text: string): ArchiveEntry[] {
  const at = text.search(/^-{10}\s*$/m);
  if (at < 0) return [];
  const entries: ArchiveEntry[] = [];
  for (const block of text.slice(at).split(/\r?\n\s*\r?\n/)) {
    const fields: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z ]+?) = (.*)$/);
      if (m) fields[m[1]] = m[2];
    }
    if (!fields.Path) continue;
    if (fields.Folder === '+' || /^D/.test(fields.Attributes ?? '')) continue;
    entries.push({ name: fields.Path.replace(/\\/g, '/'), size: Number(fields.Size) || 0 });
  }
  return entries;
}

async function sevenZipList(exe: string, path: string, password?: string): Promise<ArchiveEntry[]> {
  try {
    const out = await run(exe, ['l', '-slt', '-sccUTF-8', '-bd', `-p${password || NO_PASSWORD}`, '--', path], 180_000, 64 * 1024 * 1024);
    return parseSevenZipList(out.toString('utf8'));
  } catch (e) {
    return sevenZipError(e, password);
  }
}

async function sevenZipRead(exe: string, path: string, name: string, password?: string): Promise<Buffer> {
  try {
    // e -so: write the file to stdout · -spd: the name is literal, not a wildcard
    return await run(exe, ['e', '-so', '-spd', '-bd', '-y', `-p${password || NO_PASSWORD}`, '--', path, name], 180_000, MAX_OUT);
  } catch (e) {
    return sevenZipError(e, password);
  }
}

// ---------- bsdtar ----------

/** `-tv` line: "-rw-r--r--  0 user group  12345 Nov 05 22:00 dir/name.txt" */
const LINE = /^([-dlbcps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s(.*)$/;

async function tarList(path: string, password?: string): Promise<ArchiveEntry[]> {
  const pw = password ? ['--passphrase', password] : [];
  const text = await decodeNames(await run(bsdtar(), [...pw, '-tvf', path], 180_000, 64 * 1024 * 1024));
  const entries: ArchiveEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = raw.match(LINE);
    if (m && m[1] === 'd') continue; // folders
    let name = m ? m[3] : raw.trim();
    if (m && m[1] === 'l') name = name.replace(/ -> .*$/, '');
    name = name.replace(/^\.\//, '');
    if (!name || name.endsWith('/')) continue;
    entries.push({ name, size: m ? Number(m[2]) : 0 });
  }
  return entries;
}

async function tarRead(path: string, name: string, password?: string): Promise<Buffer> {
  const tar = bsdtar();
  const pw = password ? ['--passphrase', password] : [];
  try {
    return await run(tar, [...pw, '-xOf', path, name], 180_000, MAX_OUT);
  } catch (e) {
    // Archives created with a leading "./" keep it in the stored name.
    return run(tar, [...pw, '-xOf', path, `./${name}`], 180_000, MAX_OUT).catch(() => Promise.reject(e));
  }
}

/** bsdtar failed on an encrypted entry: say what the user can do about it. */
async function encryptedTarError(e: unknown, path: string, password?: string): Promise<never> {
  const msg = e instanceof Error ? e.message : String(e);
  if (!ENCRYPTED.test(msg)) throw e;
  const fmt = await formatOf(path).catch(() => 'other' as const);
  if (fmt === 'zip' || fmt === 'other') throw new ArchiveError(msg, password ? 'wrongPassword' : 'password');
  throw new ArchiveError(t('archiveNeed7zip'), 'need7zip'); // RAR / 7z: libarchive can't decrypt
}

/** RAR and 7z go to 7-Zip when it is installed: it handles their encryption and newer variants. */
async function sevenZipFor(path: string): Promise<string | undefined> {
  const exe = findSevenZip();
  if (!exe) return undefined;
  const fmt = await formatOf(path).catch(() => 'other' as const);
  return fmt === 'rar' || fmt === '7z' ? exe : undefined;
}

// ---------- API ----------

export async function listArchive(path: string, password?: string): Promise<ArchiveEntry[]> {
  const single = singleCompressed(path);
  if (single && !/\.(gz|gzip)$/i.test(path)) {
    // bz2 / xz / zst: bsdtar would only say "unrecognized format"
    return [{ name: single.name, size: (await inflateSingle(path, single.inflate)).length }];
  }
  const seven = await sevenZipFor(path);
  if (seven) return sevenZipList(seven, path, password);
  try {
    return await tarList(path, password);
  } catch (e) {
    if (single) return [{ name: single.name, size: (await inflateSingle(path, single.inflate)).length }];
    const exe = findSevenZip();
    if (exe && !ENCRYPTED.test(String(e))) return sevenZipList(exe, path, password).catch(() => Promise.reject(e));
    return encryptedTarError(e, path, password);
  }
}

export async function readArchiveEntry(path: string, name: string, password?: string): Promise<Buffer> {
  const single = singleCompressed(path);
  if (single && name === single.name) return inflateSingle(path, single.inflate);
  const seven = await sevenZipFor(path);
  if (seven) return sevenZipRead(seven, path, name, password);
  try {
    return await tarRead(path, name, password);
  } catch (e) {
    const exe = findSevenZip();
    if (exe && !ENCRYPTED.test(String(e))) return sevenZipRead(exe, path, name, password).catch(() => Promise.reject(e));
    return encryptedTarError(e, path, password);
  }
}

// ---------- Installing 7-Zip ----------

/** Asks, then installs 7-Zip with winget (Windows) or opens the download page. Resolves true when it is ready. */
export async function installSevenZip(): Promise<boolean> {
  if (findSevenZip()) return true;
  const install = t('sevenZipInstall');
  const page = t('sevenZipPage');
  const choice = await vscode.window.showInformationMessage(t('sevenZipAsk'), { modal: true }, ...(process.platform === 'win32' ? [install] : []), page);
  if (choice === page) {
    await vscode.env.openExternal(vscode.Uri.parse('https://www.7-zip.org/download.html'));
    return false;
  }
  if (choice !== install) return false;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('sevenZipInstalling') }, () =>
      run('winget', ['install', '--id', '7zip.7zip', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], 600_000, 16 * 1024 * 1024),
    );
  } catch (e) {
    if (!findSevenZip()) {
      const again = await vscode.window.showErrorMessage(t('sevenZipFailed', e instanceof Error ? e.message : String(e)), page);
      if (again === page) await vscode.env.openExternal(vscode.Uri.parse('https://www.7-zip.org/download.html'));
      return false;
    }
  }
  const ok = !!findSevenZip();
  if (ok) vscode.window.showInformationMessage(t('sevenZipReady'));
  return ok;
}
