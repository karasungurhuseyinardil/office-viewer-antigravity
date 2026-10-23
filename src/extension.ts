import * as vscode from 'vscode';
import { activeViewerUri, crumbUri, OfficeEditorProvider } from './providers/base';
import { htmlToDocx } from './providers/docx';
import { registerAutoSaveSync } from './autoSave';
import { newMeetingNote } from './meetingNote';
import { readSettings } from './settings';
import { convertFile, type Target } from './convert/index';
import { compareFile, registerCompareProvider } from './compare';
import { searchNotes } from './notes/search';
import { showActionList } from './notes/actions';
import { registerOpenAll } from './openAll';
import { t } from './lang';
import type { Key } from '../shared/i18n';

/** File for commands run from the palette: the open viewer, else the active text editor. */
function currentFile(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  return activeViewerUri() ?? vscode.window.activeTextEditor?.document.uri;
}

/** Runs a command and shows errors as messages instead of failing silently. */
const safe =
  <A extends unknown[]>(name: Key, fn: (...args: A) => Promise<unknown>) =>
  (...args: A) =>
    fn(...args).catch((e) => vscode.window.showErrorMessage(`${t(name)}: ${e instanceof Error ? e.message : String(e)}`));

/**
 * Uri passed by a menu, or the file in the focused viewer. A right-click on a
 * breadcrumb part passes its `officeViewerCrumb` index (from data-vscode-context).
 */
function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const uri = activeViewerUri();
  if (!uri) {
    vscode.window.showWarningMessage(t('noOpenFile'));
    return undefined;
  }
  const depth = (arg as { officeViewerCrumb?: unknown } | undefined)?.officeViewerCrumb;
  return typeof depth === 'number' ? crumbUri(uri, depth) : uri;
}

export function activate(context: vscode.ExtensionContext) {
  registerAutoSaveSync(context);
  registerOpenAll(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('officeViewer.revealInExplorer', (arg?: unknown) => {
      const uri = targetUri(arg);
      // Built-in command: opens Explorer/Finder with the file selected.
      if (uri) vscode.commands.executeCommand('revealFileInOS', uri);
    }),
    vscode.commands.registerCommand('officeViewer.copyPath', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (!uri) return;
      await vscode.env.clipboard.writeText(uri.fsPath);
      vscode.window.setStatusBarMessage(t('pathCopied'), 2000);
    }),
    registerCompareProvider(),
    vscode.commands.registerCommand(
      'officeViewer.searchNotes',
      safe('cmdSearch', async (arg?: unknown) => searchNotes(arg instanceof vscode.Uri ? arg : undefined)),
    ),
    vscode.commands.registerCommand(
      'officeViewer.actionList',
      safe('cmdActions', async (arg?: unknown) => showActionList(context, arg instanceof vscode.Uri ? arg : undefined)),
    ),
    vscode.commands.registerCommand(
      'officeViewer.convert',
      safe('cmdConvert', async (arg?: unknown, format?: unknown) => {
        const uri = currentFile(arg);
        if (!uri) return vscode.window.showWarningMessage(t('noFileToConvert'));
        // Explorer multi-select passes an array as the 2nd argument; only a string is a format.
        return convertFile(uri, typeof format === 'string' ? (format as Target) : undefined);
      }),
    ),
    vscode.commands.registerCommand(
      'officeViewer.compare',
      safe('cmdCompare', async (arg?: unknown) => {
        const uri = currentFile(arg);
        if (!uri) return vscode.window.showWarningMessage(t('noFileToCompare'));
        return compareFile(uri);
      }),
    ),
    vscode.commands.registerCommand('officeViewer.newMeetingNote', (arg?: unknown) =>
      newMeetingNote(arg).catch((e) => vscode.window.showErrorMessage(t('meetingNoteFailed', (e as Error).message))),
    ),
    OfficeEditorProvider.register(context, {
      viewType: 'officeViewer.docx',
      script: 'docx',
      editable: true,
      toBytes: (payload) => htmlToDocx(payload.html ?? ''),
      // HTML -> docx loses some formatting, so keep the original once (can be turned off).
      beforeFirstSave: async (doc) => {
        if (!readSettings().createBackup) return;
        const backup = doc.uri.with({ path: doc.uri.path + '.bak' });
        try {
          await vscode.workspace.fs.stat(backup);
        } catch {
          await vscode.workspace.fs.copy(doc.uri, backup, { overwrite: false });
        }
      },
    }),
    OfficeEditorProvider.register(context, {
      viewType: 'officeViewer.sheet',
      script: 'sheet',
      editable: true,
      toBytes: async (payload) => Buffer.from(payload.base64 ?? '', 'base64'),
    }),
    OfficeEditorProvider.register(context, { viewType: 'officeViewer.pdf', script: 'pdf', editable: false }),
    OfficeEditorProvider.register(context, { viewType: 'officeViewer.pptx', script: 'pptx', editable: false }),
    OfficeEditorProvider.register(context, { viewType: 'officeViewer.vsix', script: 'vsix', editable: false }),
    // Universal viewer: "officeViewer.binary" opens binary types by default, "officeViewer.file" any file on request.
    OfficeEditorProvider.register(context, { viewType: 'officeViewer.binary', script: 'file', editable: false, maxBytes: 100 * 1024 * 1024 }),
    OfficeEditorProvider.register(context, { viewType: 'officeViewer.file', script: 'file', editable: false, maxBytes: 100 * 1024 * 1024 }),
    vscode.commands.registerCommand(
      'officeViewer.installVsix',
      safe('vsixInstall', async (arg?: unknown) => {
        const uri = currentFile(arg);
        if (!uri || !uri.path.toLowerCase().endsWith('.vsix')) return;
        await vscode.commands.executeCommand('workbench.extensions.installExtension', uri);
        const reload = t('reloadWindow');
        const pick = await vscode.window.showInformationMessage(t('vsixInstalled', decodeURIComponent(uri.path.split('/').pop() ?? '')), reload);
        if (pick === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }),
    ),
  );
}

export function deactivate() {}
