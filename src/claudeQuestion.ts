import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { t } from './lang';

// Claude Code shows AskUserQuestion in its own webview, which other extensions
// cannot read. The same questions are stored in its session transcripts
// (~/.claude/projects/<encoded cwd>/<session>.jsonl), so we read them from there.

interface Option {
  label?: string;
  description?: string;
}
interface Question {
  question?: string;
  header?: string;
  options?: Option[];
}

const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

/** Claude Code names a project folder after its cwd with every non-alphanumeric char replaced by '-'. */
const encodeCwd = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

async function transcripts(dir: string): Promise<{ file: string; mtime: number }[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: { file: string; mtime: number }[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, e.name);
    const st = await fs.stat(file).catch(() => undefined);
    if (st) out.push({ file, mtime: st.mtimeMs });
  }
  return out;
}

/** Transcripts newest first; those of the open workspace folders come first. */
async function candidates(): Promise<string[]> {
  const root = projectsDir();
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const wanted = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => encodeCwd(f.uri.fsPath)));
  const own: { file: string; mtime: number }[] = [];
  const rest: { file: string; mtime: number }[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const list = await transcripts(path.join(root, d.name));
    (wanted.has(d.name.toLowerCase()) ? own : rest).push(...list);
  }
  const byTime = (a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime;
  return [...own.sort(byTime), ...rest.sort(byTime)].map((x) => x.file);
}

/** AskUserQuestion input in one transcript line, if it holds one. */
function questionsInLine(line: string): Question[] | undefined {
  if (!line.includes('AskUserQuestion')) return undefined;
  try {
    const content = JSON.parse(line)?.message?.content;
    if (!Array.isArray(content)) return undefined;
    for (let j = content.length - 1; j >= 0; j--) {
      const c = content[j];
      if (c?.type === 'tool_use' && c.name === 'AskUserQuestion' && Array.isArray(c.input?.questions)) {
        return c.input.questions as Question[];
      }
    }
  } catch {
    // partial line while Claude is still writing; skip
  }
  return undefined;
}

/** Last AskUserQuestion input in a transcript, if any. */
async function lastQuestions(file: string): Promise<Question[] | undefined> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const q = questionsInLine(lines[i]);
    if (q?.length) return q;
  }
  return undefined;
}

/** Transcript folders to watch: the open workspace's, or all of them when none matches. */
async function watchedDirs(): Promise<string[]> {
  const root = projectsDir();
  const dirs = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory());
  const wanted = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => encodeCwd(f.uri.fsPath)));
  const own = dirs.filter((d) => wanted.has(d.name.toLowerCase()));
  return (own.length ? own : dirs).map((d) => path.join(root, d.name));
}

/**
 * Polls Claude Code transcripts and, when a new AskUserQuestion is written,
 * shows a notification with a Copy button. Only bytes appended after start are
 * read, so older questions never pop up.
 */
export function registerClaudeQuestionWatcher(context: vscode.ExtensionContext): void {
  const offsets = new Map<string, number>();
  let primed = false;
  let busy = false;

  const notify = async (questions: Question[]) => {
    const copy = t('copy');
    const first = questions[0]?.question ?? '';
    const preview = first.length > 80 ? first.slice(0, 79) + '…' : first;
    const pick = await vscode.window.showInformationMessage(t('claudeQuestionAsked', preview), copy);
    if (pick === copy) {
      await vscode.env.clipboard.writeText(formatQuestions(questions));
      vscode.window.setStatusBarMessage(t('claudeQuestionCopied'), 3000);
    }
  };

  const tick = async () => {
    if (busy) return;
    if (!vscode.workspace.getConfiguration('officeViewer').get<boolean>('claudeQuestionPopup', true)) {
      primed = false; // re-prime on enable so old questions don't pop up
      return;
    }
    busy = true;
    try {
      for (const dir of await watchedDirs()) {
        for (const { file } of await transcripts(dir)) {
          const st = await fs.stat(file).catch(() => undefined);
          if (!st) continue;
          const from = offsets.get(file);
          // First sight: skip existing content (new files after priming are read from 0).
          if (from === undefined && !primed) {
            offsets.set(file, st.size);
            continue;
          }
          const start = from ?? 0;
          if (st.size <= start) {
            if (st.size < start) offsets.set(file, st.size);
            continue;
          }
          const fh = await fs.open(file, 'r');
          let chunk: string;
          try {
            const buf = Buffer.alloc(st.size - start);
            await fh.read(buf, 0, buf.length, start);
            chunk = buf.toString('utf8');
          } finally {
            await fh.close();
          }
          // Keep a trailing partial line for the next tick.
          const end = chunk.lastIndexOf('\n');
          if (end < 0) continue;
          offsets.set(file, start + Buffer.byteLength(chunk.slice(0, end + 1), 'utf8'));
          for (const line of chunk.slice(0, end).split('\n')) {
            const q = questionsInLine(line);
            if (q?.length) void notify(q);
          }
        }
      }
      primed = true;
    } catch {
      // transcripts are best effort; never surface watcher errors
    } finally {
      busy = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function formatQuestions(questions: Question[]): string {
  return questions
    .map((q) => {
      const head = q.header ? `[${q.header}] ` : '';
      const opts = (q.options ?? []).map((o) => `- ${o.label ?? ''}${o.description ? ` — ${o.description}` : ''}`);
      return [`${head}${q.question ?? ''}`, ...opts].join('\n');
    })
    .join('\n\n');
}

export async function copyClaudeQuestion(): Promise<void> {
  // Only the newest few sessions matter; avoid reading every old transcript.
  for (const file of (await candidates()).slice(0, 10)) {
    const questions = await lastQuestions(file);
    if (!questions?.length) continue;
    await vscode.env.clipboard.writeText(formatQuestions(questions));
    vscode.window.setStatusBarMessage(t('claudeQuestionCopied'), 3000);
    return;
  }
  vscode.window.showWarningMessage(t('noClaudeQuestion'));
}
