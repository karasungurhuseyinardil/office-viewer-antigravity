import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { applySettingsFromWebview, readSettings } from '../settings';
import { currentLang, t } from '../lang';
import { lineOnOpen, textEditorAllowed } from '../textAllow';
import { open as fsOpen } from 'node:fs/promises';

/** Message the webview sends back when asked for its current content. */
export interface ContentPayload {
  /** docx: edited HTML. */
  html?: string;
  /** sheet: file bytes, base64. */
  base64?: string;
}

export interface FormatOptions {
  viewType: string;
  /** Webview bundle name in dist/webview (without .js). */
  script: string;
  /** True when the webview has an in-place edit mode. */
  editable: boolean;
  /** Turns the webview's content into file bytes. Required when editable. */
  toBytes?(payload: ContentPayload, doc: OfficeDocument): Promise<Uint8Array>;
  /** Called once before the first save of a document overwrites it. */
  beforeFirstSave?(doc: OfficeDocument): Promise<void>;
  /** Read at most this many bytes (huge files get a partial hex view). */
  maxBytes?: number;
}

export class OfficeDocument implements vscode.CustomDocument {
  savedOnce = false;
  /** Full file size when only the start of a huge file was read. */
  totalSize?: number;
  /** True between the first edit and the next save/revert. */
  dirty = false;
  /** "Yazmayı bırakınca" auto save timer. */
  saveTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    readonly uri: vscode.Uri,
    public bytes: Uint8Array,
  ) {}
  dispose(): void {}
}

type Pending = { resolve(p: ContentPayload): void; reject(e: Error): void };

/** Every open viewer panel across all formats, so commands can find the active file. */
const openPanels = new Map<vscode.WebviewPanel, vscode.Uri>();

/** Files that should open straight in edit mode (e.g. a new meeting note). */
const editOnOpen = new Set<string>();
export function requestEditOnOpen(uri: vscode.Uri) {
  editOnOpen.add(uri.toString());
}

/** Text to jump to once a file opens (from "Notlarda ara" / action list). */
const findOnOpen = new Map<string, string>();

/** Opens `uri` in its Office viewer (or focuses it), then highlights `text` or shows `line`. */
export async function openAndFind(uri: vscode.Uri, viewType: string, text?: string, line?: number, column?: vscode.ViewColumn) {
  for (const [panel, panelUri] of openPanels) {
    if (panelUri.toString() !== uri.toString()) continue;
    panel.reveal(column);
    if (text) panel.webview.postMessage({ type: 'find', text });
    if (line) panel.webview.postMessage({ type: 'gotoLine', line });
    return;
  }
  if (text) findOnOpen.set(uri.toString(), text);
  if (line) lineOnOpen.set(uri.toString(), line);
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType, column);
}


function postSettings(panel: vscode.WebviewPanel) {
  panel.webview.postMessage({ type: 'settings', settings: readSettings() });
}

/** Keeps every open viewer's settings menu in sync with the setting. */
export function broadcastSettings() {
  for (const panel of openPanels.keys()) postSettings(panel);
}

/** File shown in the currently focused viewer, if any. */
export function activeViewerUri(): vscode.Uri | undefined {
  for (const [panel, uri] of openPanels) if (panel.active) return uri;
  return undefined;
}

/** Path parts shown in the viewer's breadcrumb: workspace-relative, or just the file name. */
export function crumbParts(uri: vscode.Uri): string[] {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return [uri.path.split('/').pop() ?? ''];
  return vscode.workspace.asRelativePath(uri, false).split('/');
}

/** Uri of breadcrumb part `depth` (0 = top folder, last = the file itself). */
export function crumbUri(uri: vscode.Uri, depth: number): vscode.Uri {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const parts = crumbParts(uri);
  if (!folder || !Number.isInteger(depth) || depth < 0 || depth >= parts.length - 1) return uri;
  return vscode.Uri.joinPath(folder.uri, ...parts.slice(0, depth + 1));
}

/**
 * One provider class for every format. Read-only formats just never report
 * edits, so they are never dirty.
 */
export class OfficeEditorProvider implements vscode.CustomEditorProvider<OfficeDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<OfficeDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  private readonly panels = new Map<OfficeDocument, vscode.WebviewPanel>();
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly options: FormatOptions,
  ) {}

  /** All providers, so a language change can reload every open viewer. */
  private static readonly all = new Set<OfficeEditorProvider>();

  /** Re-render open viewers (new UI language). Documents with unsaved edits keep their page until reopened. */
  static reloadAll() {
    for (const provider of OfficeEditorProvider.all) {
      for (const [doc, panel] of provider.panels) {
        if (doc.dirty) continue;
        const distRoot = vscode.Uri.joinPath(provider.context.extensionUri, 'dist', 'webview');
        panel.webview.html = provider.getHtml(panel.webview, distRoot);
      }
    }
  }

  static register(context: vscode.ExtensionContext, options: FormatOptions): vscode.Disposable {
    const provider = new OfficeEditorProvider(context, options);
    OfficeEditorProvider.all.add(provider);
    return vscode.window.registerCustomEditorProvider(
      options.viewType,
      provider,
      {
        // enableFindWidget: Ctrl+F search inside the document.
        webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<OfficeDocument> {
    const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
    const max = this.options.maxBytes;
    if (max && source.scheme === 'file') {
      const { size } = await vscode.workspace.fs.stat(source);
      if (size > max) {
        // Only the beginning of very large files (ISO images, videos, dumps...).
        const handle = await fsOpen(source.fsPath, 'r');
        try {
          const head = new Uint8Array(1024 * 1024);
          const { bytesRead } = await handle.read(head, 0, head.length, 0);
          const doc = new OfficeDocument(uri, head.subarray(0, bytesRead));
          doc.totalSize = size;
          return doc;
        } finally {
          await handle.close();
        }
      }
    }
    const bytes = await vscode.workspace.fs.readFile(source);
    return new OfficeDocument(uri, bytes);
  }

  async resolveCustomEditor(doc: OfficeDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.panels.set(doc, panel);
    openPanels.set(panel, doc.uri);
    panel.onDidDispose(() => {
      clearTimeout(doc.saveTimer);
      this.panels.delete(doc);
      openPanels.delete(panel);
    });

    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    panel.webview.options = { enableScripts: true, localResourceRoots: [distRoot] };
    panel.webview.html = this.getHtml(panel.webview, distRoot);

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case 'ready':
          postSettings(panel);
          this.postInit(doc, panel);
          break;
        case 'dirty':
          if (!this.options.editable) break;
          if (!doc.dirty) {
            doc.dirty = true;
            this.changeEmitter.fire({ document: doc });
          }
          this.scheduleDelayedSave(doc);
          break;
        case 'save':
          await vscode.commands.executeCommand('workbench.action.files.save');
          break;
        case 'openExternal':
          openInDefaultApp(doc.uri);
          break;
        case 'saveSettings':
          try {
            await applySettingsFromWebview(msg.values);
            postSettings(panel);
            panel.webview.postMessage({ type: 'settingsSaved' });
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            postSettings(panel);
            panel.webview.postMessage({ type: 'settingsError', message: reason });
            const reload = t('reloadWindow');
            vscode.window
              .showErrorMessage(
                t('settingsSaveFailed', reason),
                reload,
              )
              .then((pick) => pick === reload && vscode.commands.executeCommand('workbench.action.reloadWindow'));
          }
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'officeViewer');
          break;
        case 'tool':
          if (msg.id === 'editInTextEditor') await this.editInTextEditor(doc, panel, Number(msg.line) || 1);
          else await this.runTool(doc, String(msg.id), msg.format);
          break;
        case 'saveBytes':
          await saveBytes(doc.uri, String(msg.name ?? 'file'), String(msg.base64 ?? ''));
          break;
        case 'reveal':
          vscode.commands.executeCommand('revealFileInOS', crumbUri(doc.uri, Number(msg.depth)));
          break;
        case 'error':
          vscode.window.showErrorMessage(t('fileNotFound', String(msg.message)));
          break;
        case 'response': {
          const p = this.pending.get(msg.requestId);
          if (!p) break;
          this.pending.delete(msg.requestId);
          if (msg.error) p.reject(new Error(String(msg.error)));
          else p.resolve(msg.body as ContentPayload);
          break;
        }
      }
    });
  }

  /**
   * "Yazmayı bırakınca": save after the user stops typing for files.autoSaveDelay ms.
   * Only when Office Viewer manages auto save itself (not "use editor setting").
   */
  private scheduleDelayedSave(doc: OfficeDocument) {
    clearTimeout(doc.saveTimer);
    const { useEditorSetting, triggers } = readSettings().autoSave;
    if (useEditorSetting || !triggers.includes('afterDelay')) return;
    const delay = Math.max(200, vscode.workspace.getConfiguration('files').get<number>('autoSaveDelay', 1000));
    doc.saveTimer = setTimeout(() => {
      if (doc.dirty && this.panels.has(doc)) vscode.workspace.save(doc.uri);
    }, delay);
  }

  /** "Edit in editor": the normal text editor at the same line, replacing this viewer tab. */
  private async editInTextEditor(doc: OfficeDocument, panel: vscode.WebviewPanel, line: number) {
    textEditorAllowed.add(doc.uri.toString());
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(doc.uri, {
      viewColumn: panel.viewColumn,
      preview: false,
      selection: new vscode.Range(pos, pos),
    });
    vscode.commands.executeCommand('revealLine', { lineNumber: Math.max(0, line - 1), at: 'top' });
    panel.dispose();
  }

  /** Araçlar menu: export, compare, search, action list. */
  private async runTool(doc: OfficeDocument, id: string, format?: unknown) {
    if ((id === 'export' || id === 'compare') && doc.dirty) {
      const save = t('saveAndContinue');
      const pick = await vscode.window.showWarningMessage(
        t('unsavedWarning'),
        { modal: true },
        save,
      );
      if (pick !== save) return;
      await vscode.workspace.save(doc.uri);
    }
    const folder = vscode.Uri.joinPath(doc.uri, '..');
    switch (id) {
      case 'export':
        return vscode.commands.executeCommand('officeViewer.convert', doc.uri, typeof format === 'string' ? format : undefined);
      case 'compare':
        return vscode.commands.executeCommand('officeViewer.compare', doc.uri);
      case 'searchNotes':
        return vscode.commands.executeCommand('officeViewer.searchNotes');
      case 'actionList':
        return vscode.commands.executeCommand('officeViewer.actionList', folder);
      case 'installVsix':
        return vscode.commands.executeCommand('officeViewer.installVsix', doc.uri);
    }
  }

  private postInit(doc: OfficeDocument, panel: vscode.WebviewPanel) {
    const find = findOnOpen.get(doc.uri.toString());
    findOnOpen.delete(doc.uri.toString());
    const line = lineOnOpen.get(doc.uri.toString());
    lineOnOpen.delete(doc.uri.toString());
    const name = doc.uri.path.split('/').pop() ?? '';
    const startEditing = this.options.editable && (editOnOpen.delete(doc.uri.toString()) || readSettings().openInEditMode);
    panel.webview.postMessage({
      type: 'init',
      fileName: name,
      crumbs: crumbParts(doc.uri),
      ext: name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '',
      editable: this.options.editable,
      startEditing,
      find,
      line,
      totalSize: doc.totalSize,
      base64: Buffer.from(doc.bytes).toString('base64'),
    });
  }

  private requestContent(doc: OfficeDocument): Promise<ContentPayload> {
    const panel = this.panels.get(doc);
    if (!panel) return Promise.reject(new Error('Editor is closed.'));
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      panel.webview.postMessage({ type: 'getContent', requestId });
      setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error('Timed out waiting for editor content.'));
      }, 30_000);
    });
  }

  private async currentBytes(doc: OfficeDocument): Promise<Uint8Array> {
    if (!this.options.editable || !this.options.toBytes) return doc.bytes;
    return this.options.toBytes(await this.requestContent(doc), doc);
  }

  async saveCustomDocument(doc: OfficeDocument): Promise<void> {
    if (!this.options.editable) return;
    clearTimeout(doc.saveTimer);
    const bytes = await this.currentBytes(doc);
    if (!doc.savedOnce && this.options.beforeFirstSave) await this.options.beforeFirstSave(doc);
    await vscode.workspace.fs.writeFile(doc.uri, bytes);
    doc.bytes = bytes;
    doc.savedOnce = true;
    doc.dirty = false;
    this.panels.get(doc)?.webview.postMessage({ type: 'saved' });
  }

  async saveCustomDocumentAs(doc: OfficeDocument, destination: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.writeFile(destination, await this.currentBytes(doc));
  }

  async revertCustomDocument(doc: OfficeDocument): Promise<void> {
    clearTimeout(doc.saveTimer);
    doc.bytes = await vscode.workspace.fs.readFile(doc.uri);
    doc.dirty = false;
    const panel = this.panels.get(doc);
    if (panel) this.postInit(doc, panel);
  }

  async backupCustomDocument(
    doc: OfficeDocument,
    ctx: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(ctx.destination, await this.currentBytes(doc));
    return {
      id: ctx.destination.toString(),
      delete: () => vscode.workspace.fs.delete(ctx.destination).then(undefined, () => undefined),
    };
  }

  private getHtml(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const nonce = makeNonce();
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(distRoot, file)).toString();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data: blob:`,
      `script-src 'nonce-${nonce}'`,
      'worker-src blob:',
      `media-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${currentLang()}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${uri('styles.css')}" rel="stylesheet">
</head>
<body data-asset-base="${uri('')}" data-lang="${currentLang()}">
  <header id="toolbar"></header>
  <div id="banner" hidden></div>
  <main id="content"><div class="loading">${t('loading')}</div></main>
  <script type="module" nonce="${nonce}" src="${uri(this.options.script + '.js')}"></script>
</body>
</html>`;
  }
}

/** Saves bytes sent by a viewer (e.g. a file taken out of a zip) where the user chooses. */
async function saveBytes(near: vscode.Uri, name: string, base64: string) {
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_') || 'file';
  const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(near, '..', safeName) });
  if (!dest) return;
  await vscode.workspace.fs.writeFile(dest, Buffer.from(base64, 'base64'));
  const reveal = t('revealInFolder');
  if ((await vscode.window.showInformationMessage(t('savedFile', safeName), reveal)) === reveal) {
    await vscode.commands.executeCommand('revealFileInOS', dest);
  }
}

/** Opens a local file in the OS default app (Word, Excel, Acrobat, ...). */
export function openInDefaultApp(uri: vscode.Uri) {
  if (uri.scheme !== 'file') {
    vscode.env.openExternal(uri);
    return;
  }
  const file = uri.fsPath;
  // Arguments are passed directly (no shell), so file names cannot inject commands.
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [file]] :
    process.platform === 'darwin' ? ['open', [file]] :
    ['xdg-open', [file]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => vscode.window.showErrorMessage(t('openFailedApp', e.message)));
  child.unref();
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
