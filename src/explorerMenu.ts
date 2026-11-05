import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { t } from './lang';

// "Open with <editor>" in the Windows File Explorer right-click menu (current user only, no admin).

function reg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('reg', args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `reg exit code ${code}`))));
  });
}

/** The running editor's executable, e.g. "...\Antigravity IDE\Antigravity IDE.exe". */
function editorExe(): string | undefined {
  const exe = process.execPath; // the extension host runs inside the editor's own exe
  return /\.exe$/i.test(exe) && existsSync(exe) ? exe : undefined;
}

/** Registry key name for this editor, e.g. "AntigravityIDE". */
const keyName = () => vscode.env.appName.replace(/[^A-Za-z0-9]/g, '') || 'Editor';

const targets = () => {
  const base = 'HKCU\\Software\\Classes';
  const name = keyName();
  return [
    { key: `${base}\\Directory\\shell\\${name}`, arg: '%V' }, // right-click a folder
    { key: `${base}\\Directory\\Background\\shell\\${name}`, arg: '%V' }, // empty space inside a folder
    { key: `${base}\\Drive\\shell\\${name}`, arg: '%V' }, // a drive (C:\)
    { key: `${base}\\*\\shell\\${name}`, arg: '%1' }, // any file
  ];
};

export async function addExplorerMenu(): Promise<void> {
  if (process.platform !== 'win32') {
    vscode.window.showWarningMessage(t('explorerOnlyWindows'));
    return;
  }
  const exe = editorExe();
  if (!exe) throw new Error('editor executable not found');
  const label = t('openWithApp', vscode.env.appName);
  for (const { key, arg } of targets()) {
    await reg(['add', key, '/ve', '/d', label, '/f']);
    await reg(['add', key, '/v', 'Icon', '/d', `"${exe}",0`, '/f']);
    await reg(['add', `${key}\\command`, '/ve', '/d', `"${exe}" "${arg}"`, '/f']);
  }
  vscode.window.showInformationMessage(t('explorerAdded', label));
}

export async function removeExplorerMenu(): Promise<void> {
  if (process.platform !== 'win32') {
    vscode.window.showWarningMessage(t('explorerOnlyWindows'));
    return;
  }
  for (const { key } of targets()) await reg(['delete', key, '/f']).catch(() => undefined); // missing key: fine
  vscode.window.showInformationMessage(t('explorerRemoved'));
}
