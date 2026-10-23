import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapeHtml } from './text';
import { currentLang, t } from '../lang';

/** Page CSS used for exported HTML and PDF. */
const PAGE_CSS = `
@page { size: A4; margin: 2cm; }
body { font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #1f1f1f; margin: 0; }
.doc { max-width: 816px; margin: 0 auto; padding: 24px; }
@media print { .doc { max-width: none; padding: 0; } }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }
h1, h2, h3 { page-break-after: avoid; }
table { border-collapse: collapse; margin: 8px 0; page-break-inside: auto; }
tr { page-break-inside: avoid; }
td, th { border: 1px solid #999; padding: 4px 8px; vertical-align: top; }
td > p, th > p { margin: 0; }
th { text-align: left; background: #f3f3f3; }
img { max-width: 100%; height: auto; }
mark { background: #fff59d; }
a { color: #0563c1; }
`;

export function standaloneHtml(title: string, bodyHtml: string, extraCss = ''): string {
  return `<!DOCTYPE html>
<html lang="${currentLang()}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}${extraCss}</style>
</head>
<body><main class="doc">
${bodyHtml}
</main></body>
</html>
`;
}

function onPath(names: string[]): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const p = join(dir, name);
      if (dir && existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Edge or Chrome, used headless to print HTML to PDF. */
export function findBrowser(): string | undefined {
  const custom = vscode.workspace.getConfiguration('officeViewer').get<string>('export.browserPath', '').trim();
  if (custom) return existsSync(custom) ? custom : undefined;

  const env = process.env;
  const candidates =
    process.platform === 'win32'
      ? [
          join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
          join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
          join(env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
          join(env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
          join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [];
  const found = candidates.find((p) => p && existsSync(p));
  if (found) return found;
  if (process.platform === 'linux') {
    return onPath(['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
  }
  return undefined;
}

/** Prints a full HTML document to PDF bytes with a headless browser. */
export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(t('noBrowser'));
  }
  const dir = await mkdtemp(join(tmpdir(), 'office-viewer-'));
  try {
    const input = join(dir, 'page.html');
    const output = join(dir, 'out.pdf');
    await writeFile(input, html, 'utf8');
    const args = [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--no-pdf-header-footer',
      `--user-data-dir=${join(dir, 'profile')}`,
      `--print-to-pdf=${output}`,
      pathToFileURL(input).href,
    ];
    await new Promise<void>((resolve, reject) => {
      // Arguments go straight to the browser (no shell).
      const child = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(t('pdfTimeout')));
      }, 60_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const pdf = await readFile(output).catch(() => undefined);
    if (!pdf || pdf.subarray(0, 4).toString() !== '%PDF') throw new Error(t('pdfFailed'));
    return new Uint8Array(pdf);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
