import * as vscode from 'vscode';
import { isLang, type Lang } from '../shared/i18n';

export const AUTO_SAVE_TRIGGERS = ['afterDelay', 'onFocusChange', 'onWindowChange'] as const;
export type AutoSaveTrigger = (typeof AUTO_SAVE_TRIGGERS)[number];

/** Settings the webview shows in its ⚙ menu. */
export interface ViewerSettings {
  autoSave: { useEditorSetting: boolean; triggers: AutoSaveTrigger[] };
  view: { pageTheme: 'light' | 'dark' | 'auto'; fullWidth: boolean; fontScale: number };
  openInEditMode: boolean;
  createBackup: boolean;
  language: Lang;
  openAllFiles: boolean;
}

const cfg = () => vscode.workspace.getConfiguration('officeViewer');

export function readSettings(): ViewerSettings {
  const c = cfg();
  const triggers = c.get<string[]>('autoSaveTriggers', []).filter((t): t is AutoSaveTrigger =>
    (AUTO_SAVE_TRIGGERS as readonly string[]).includes(t),
  );
  const theme = c.get<string>('view.pageTheme', 'light');
  return {
    autoSave: { useEditorSetting: c.get<boolean>('useEditorAutoSave', true), triggers },
    view: {
      pageTheme: theme === 'dark' || theme === 'auto' ? theme : 'light',
      fullWidth: c.get<boolean>('view.fullWidth', false),
      fontScale: clampScale(c.get<number>('view.fontScale', 1)),
    },
    openInEditMode: c.get<boolean>('openInEditMode', false),
    createBackup: c.get<boolean>('docx.createBackup', true),
    language: ((v) => (isLang(v) ? v : 'en'))(c.get<string>('language', 'en')),
    openAllFiles: c.get<boolean>('openAllFiles', true),
  };
}

function clampScale(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 1;
  return Math.round(Math.min(2, Math.max(0.7, v)) * 10) / 10;
}

/** Checks one value from the webview. Returns undefined for unknown keys / bad values. */
function validate(key: string, value: unknown): { ok: true; value: unknown } | undefined {
  switch (key) {
    case 'useEditorAutoSave':
    case 'view.fullWidth':
    case 'openInEditMode':
    case 'docx.createBackup':
    case 'openAllFiles':
      return typeof value === 'boolean' ? { ok: true, value } : undefined;
    case 'autoSaveTriggers':
      return Array.isArray(value) ? { ok: true, value: AUTO_SAVE_TRIGGERS.filter((t) => value.includes(t)) } : undefined;
    case 'view.pageTheme':
      return value === 'light' || value === 'dark' || value === 'auto' ? { ok: true, value } : undefined;
    case 'view.fontScale':
      return { ok: true, value: clampScale(value) };
    case 'language':
      return isLang(value) ? { ok: true, value } : undefined;
    default:
      return undefined;
  }
}

/**
 * Writes the values from the ⚙ menu's "Kaydet" button to user settings.
 * Only whitelisted keys are accepted. Throws with a readable message on failure.
 */
export async function applySettingsFromWebview(values: unknown): Promise<void> {
  if (!values || typeof values !== 'object') return;
  const c = cfg();
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    const checked = validate(key, raw);
    if (!checked) continue;
    await c.update(key, checked.value, vscode.ConfigurationTarget.Global);
  }
}

/** Converts the old single-choice `officeViewer.autoSave` setting (v0.2) to the new keys. */
export async function migrateOldAutoSave(): Promise<void> {
  const c = cfg();
  const old = c.inspect<string>('autoSave')?.globalValue;
  if (old === undefined) return;
  if (old === 'default') {
    await c.update('useEditorAutoSave', true, vscode.ConfigurationTarget.Global);
  } else {
    await c.update('useEditorAutoSave', false, vscode.ConfigurationTarget.Global);
    const triggers = (AUTO_SAVE_TRIGGERS as readonly string[]).includes(old) ? [old] : [];
    await c.update('autoSaveTriggers', triggers, vscode.ConfigurationTarget.Global);
  }
  await c.update('autoSave', undefined, vscode.ConfigurationTarget.Global);
}
