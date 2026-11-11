import * as vscode from 'vscode';
import { activeViewerUri, openAndFind } from './providers/base';
import { viewTypeFor } from './notes/index';
import { textEditorAllowed } from './textAllow';

const enabled = () => vscode.workspace.getConfiguration('officeViewer').get<boolean>('openAllFiles', true);

/** Office formats keep their own viewer; everything else uses the universal one. */
const viewerFor = (uri: vscode.Uri) => viewTypeFor(uri.path) ?? 'officeViewer.file';

const isOurViewer = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType.startsWith('officeViewer.');

function textTabsFor(key: string): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);
}

/**
 * Closes the file's unsaved-free text tabs in one column. Looked up fresh each time: a preview
 * tab may already have been replaced by the viewer, and closing a stale tab throws.
 */
async function closeTextTabs(key: string, column: vscode.ViewColumn) {
  for (const tab of textTabsFor(key)) {
    if (tab.isDirty || tab.group.viewColumn !== column) continue;
    await vscode.window.tabGroups.close(tab, true).then(undefined, () => undefined);
  }
}

/** Replaces the text editor tab of `uri` with the viewer, keeping the cursor line. */
async function swapToViewer(uri: vscode.Uri, column: vscode.ViewColumn) {
  const key = uri.toString();
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
  const line = editor ? editor.selection.active.line + 1 : undefined;
  await openAndFind(uri, viewerFor(uri), undefined, line && line > 1 ? line : undefined, column);
  await closeTextTabs(key, column);
}

/**
 * "Open all files here": when a file opens in the normal text editor, show it in
 * Office Viewer instead. Diff views, unsaved tabs, debugging and files the user
 * chose to edit ("Edit in editor", "Reopen Editor With…") are left alone.
 */
export function registerOpenAll(context: vscode.ExtensionContext) {
  const swapping = new Set<string>();
  const reopenedWhileSwapping = new Set<string>();

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      // Text tab closed: next time the file opens in the viewer again.
      for (const tab of e.closed) {
        if (tab.input instanceof vscode.TabInputText) {
          const key = tab.input.uri.toString();
          if (!textTabsFor(key).length) textEditorAllowed.delete(key);
        }
      }
      if (!enabled()) return;

      // A viewer closed and a text tab opened for the same file in one step = "Reopen Editor With → Text Editor".
      const reopened = new Set(e.closed.filter(isOurViewer).map((t) => (t.input as vscode.TabInputCustom).uri.toString()));

      for (const tab of e.opened) {
        if (!(tab.input instanceof vscode.TabInputText)) continue; // diffs, notebooks, settings… stay as they are
        const uri = tab.input.uri;
        const key = uri.toString();
        if (uri.scheme !== 'file') continue;
        if (reopened.has(key)) {
          textEditorAllowed.add(key);
          continue;
        }
        if (textEditorAllowed.has(key) || tab.isDirty || vscode.debug.activeDebugSession) continue;
        const column = tab.group.viewColumn;
        if (swapping.has(key)) {
          // Opened again while the viewer is coming up (e.g. by an agent): close it once that is done.
          reopenedWhileSwapping.add(key);
          continue;
        }
        swapping.add(key);
        // Let the editor settle (cursor position) before swapping.
        setTimeout(() => {
          swapToViewer(uri, column)
            .catch((err) => console.error('Office Viewer: could not open in viewer', err))
            .finally(async () => {
              swapping.delete(key);
              if (reopenedWhileSwapping.delete(key) && !textEditorAllowed.has(key)) await closeTextTabs(key, column);
            });
        }, 30);
      }
    }),

    // Edited in a text editor (typing, refactoring): keep it there.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length || e.document.uri.scheme !== 'file') return;
      const key = e.document.uri.toString();
      if (textTabsFor(key).length) textEditorAllowed.add(key);
    }),

    vscode.commands.registerCommand('officeViewer.openInViewer', async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (!uri) return;
      const key = uri.toString();
      textEditorAllowed.delete(key);
      const tab = textTabsFor(key)[0];
      if (tab && !tab.isDirty) await swapToViewer(uri, tab.group.viewColumn);
      else await openAndFind(uri, viewerFor(uri));
    }),

    vscode.commands.registerCommand('officeViewer.openInTextEditor', async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : activeViewerUri();
      if (!uri) return;
      textEditorAllowed.add(uri.toString());
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
  );
}
