import * as vscode from 'vscode';
import { broadcastSettings, OfficeEditorProvider } from './providers/base';
import { reloadActionList } from './notes/actions';
import { migrateOldAutoSave, readSettings } from './settings';
import { t } from './lang';

/** Language id contributed in package.json for .docx/.xlsx/.xls/.csv. */
const LANGUAGE_ID = 'office-document';

/**
 * Applies the Office Viewer auto save choice as a language override of
 * `files.autoSave` (`"[office-document]": { "files.autoSave": ... }`), so Office
 * files get their own mode while other files keep the global setting.
 *
 * The editor only takes one mode, so:
 * - focus change checked  -> onFocusChange (also saves on window change)
 * - window change checked -> onWindowChange
 * - otherwise             -> off
 * "afterDelay" is combined on top by the provider's own timer (see base.ts),
 * so close / shutdown saving still comes from the editor itself.
 */
export async function syncAutoSave(): Promise<void> {
  const { useEditorSetting, triggers } = readSettings().autoSave;
  const wanted = useEditorSetting
    ? undefined
    : triggers.includes('onFocusChange')
      ? 'onFocusChange'
      : triggers.includes('onWindowChange')
        ? 'onWindowChange'
        : 'off';

  const files = vscode.workspace.getConfiguration('files', { languageId: LANGUAGE_ID });
  if (files.inspect<string>('autoSave')?.globalLanguageValue === wanted) return;
  try {
    await files.update('autoSave', wanted, vscode.ConfigurationTarget.Global, true);
  } catch (e) {
    vscode.window.showWarningMessage(t('autoSaveApplyFailed', (e as Error).message));
  }
}

export function registerAutoSaveSync(context: vscode.ExtensionContext) {
  migrateOldAutoSave()
    .catch((e) => console.error('Office Viewer: auto save migration failed', e))
    .then(syncAutoSave);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('officeViewer.useEditorAutoSave') || e.affectsConfiguration('officeViewer.autoSaveTriggers')) {
        syncAutoSave();
      }
      if (e.affectsConfiguration('officeViewer.language')) {
        OfficeEditorProvider.reloadAll();
        reloadActionList();
      }
      if (e.affectsConfiguration('officeViewer')) broadcastSettings();
    }),
  );
}
