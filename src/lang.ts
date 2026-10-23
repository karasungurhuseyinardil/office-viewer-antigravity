import * as vscode from 'vscode';
import { isLang, translate, type Key, type Lang } from '../shared/i18n';

/** UI language from `officeViewer.language` (English by default). */
export function currentLang(): Lang {
  const v = vscode.workspace.getConfiguration('officeViewer').get<string>('language', 'en');
  return isLang(v) ? v : 'en';
}

export const t = (key: Key, ...args: (string | number)[]) => translate(currentLang(), key, ...args);

