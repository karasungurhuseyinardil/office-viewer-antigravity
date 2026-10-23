import * as vscode from 'vscode';
import { openAndFind } from '../providers/base';
import { collectFiles, dateFromName, fileName, normalize, SEARCH_EXTS, textCache, viewTypeFor } from './index';
import { t } from '../lang';

interface Doc {
  uri: vscode.Uri;
  text: string;
  norm: string;
  date?: Date;
}

interface Item extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

const SNIPPET = 60;

/** Snippet of `doc.text` around the first match of `query` (both normalized 1:1 for Turkish). */
function snippet(doc: Doc, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET);
  const end = Math.min(doc.text.length, at + length + SNIPPET);
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '') + flat(doc.text.slice(start, end)).trim() + (end < doc.text.length ? '…' : '');
}

function countMatches(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1 && n < 999; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * "Notlarda Ara": full-text search over Word / Excel / CSV / PowerPoint files
 * (in `folder`, or the workspace). Picking a result opens it at the match.
 */
export async function searchNotes(folder?: vscode.Uri): Promise<void> {
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = folder ? t('searchTitleIn', fileName(folder)) : t('searchTitle');
  qp.placeholder = t('searchPlaceholder');
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.busy = true;
  qp.show();

  const docs: Doc[] = [];
  let disposed = false;
  qp.onDidHide(() => {
    disposed = true;
    qp.dispose();
  });

  const refresh = () => {
    const raw = qp.value.trim();
    if (raw.length < 2) {
      qp.items = [];
      qp.title = t('searchFiles', folder ? t('searchTitleIn', fileName(folder)) : t('searchTitle'), docs.length);
      return;
    }
    const q = normalize(raw);
    const hits: (Item & { score: number; time: number })[] = [];
    for (const doc of docs) {
      const nameHit = normalize(fileName(doc.uri)).includes(q);
      const at = doc.norm.indexOf(q);
      if (at === -1 && !nameHit) continue;
      const count = at === -1 ? 0 : countMatches(doc.norm, q);
      const rel = vscode.workspace.asRelativePath(vscode.Uri.joinPath(doc.uri, '..'), false);
      hits.push({
        uri: doc.uri,
        label: `$(file) ${fileName(doc.uri)}`,
        description: `${rel}${count ? ` · ${t('matches', count)}` : ''}`,
        detail: at === -1 ? t('inFileName') : snippet(doc, at, raw.length),
        alwaysShow: true, // we filter ourselves (content, not just the label)
        score: count + (nameHit ? 1000 : 0),
        time: doc.date?.getTime() ?? 0,
      });
    }
    // Newest notes first, then by match count.
    hits.sort((a, b) => b.time - a.time || b.score - a.score);
    qp.items = hits.slice(0, 200);
    qp.title = t('foundIn', hits.length);
  };
  qp.onDidChangeValue(refresh);

  qp.onDidAccept(async () => {
    const pick = qp.selectedItems[0];
    if (!pick) return;
    const query = qp.value.trim();
    qp.hide();
    const viewType = viewTypeFor(pick.uri.path);
    if (viewType) await openAndFind(pick.uri, viewType, query);
    else await vscode.commands.executeCommand('vscode.open', pick.uri);
  });

  // Index in the background; results update as files are read.
  const files = await collectFiles(SEARCH_EXTS, folder);
  let i = 0;
  for (const uri of files) {
    if (disposed) return;
    const text = await textCache.get(uri);
    if (text !== undefined) {
      const name = fileName(uri);
      docs.push({ uri, text, norm: normalize(text), date: dateFromName(name) });
    }
    if (++i % 25 === 0) refresh();
  }
  qp.busy = false;
  refresh();
  if (!files.length) qp.title = t('noOfficeFiles');
}
