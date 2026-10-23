// .vsix (extension package) viewer: manifest summary, contributed features, README and file list.
import JSZip from 'jszip';
import { marked } from 'marked';
import { $, el, lang, locale, startViewer, t, vscode } from '../common/bridge';
import { sanitizeHtml } from '../common/sanitize';

type Json = Record<string, unknown>;
let blobUrls: string[] = [];

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} KB` : `${(n / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;

/** Uncompressed size of a zip entry (JSZip keeps it on an internal field). */
const sizeOf = (f: JSZip.JSZipObject) => (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;

/** Finds a zip entry case-insensitively (README.md vs readme.md). */
function findEntry(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const want = path.toLowerCase();
  return zip.file(new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'))[0] ?? null;
}

async function blobUrl(file: JSZip.JSZipObject, type = ''): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const mime = type || (ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : '');
  const url = URL.createObjectURL(new Blob([await file.async('arraybuffer')], { type: mime }));
  blobUrls.push(url);
  return url;
}

/** "%key%" placeholders in package.json resolved from package.nls(.lang).json. */
function resolver(nls: Json): (v: unknown) => string {
  return (v) => {
    const s = typeof v === 'string' ? v : '';
    const m = s.match(/^%(.+)%$/);
    if (!m) return s;
    const hit = nls[m[1]];
    return typeof hit === 'string' ? hit : typeof hit === 'object' && hit && 'message' in hit ? String((hit as Json).message) : s;
  };
}

/**
 * README HTML from the package: drop scripts, frames, inline handlers and
 * javascript: links; point relative images at the files inside the package.
 */
async function safeReadme(html: string, zip: JSZip, baseDir: string): Promise<DocumentFragment> {
  const frag = sanitizeHtml(html);
  for (const img of Array.from(frag.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!src || /^[a-z]+:/i.test(src)) continue; // remote images are blocked by the page's security policy
    const entry = findEntry(zip, `${baseDir}${src.replace(/^\.\//, '')}`);
    if (entry) img.src = await blobUrl(entry);
  }
  return frag;
}

function row(label: string, value: string | Node | undefined) {
  if (!value) return null;
  return el('div', { className: 'vsix-row' }, [el('span', { className: 'vsix-label', textContent: label }), typeof value === 'string' ? el('span', { textContent: value }) : value]);
}

function list(title: string, items: string[]) {
  if (!items.length) return null;
  const d = el('details', { className: 'vsix-section', open: items.length <= 12 });
  d.append(el('summary', { textContent: `${title} (${items.length})` }));
  const ul = el('ul');
  for (const i of items) ul.append(el('li', { textContent: i }));
  d.append(ul);
  return d;
}

const installBtn = el('button', { className: 'primary', textContent: t('vsixInstall'), title: t('vsixInstallTitle') });
installBtn.addEventListener('click', () => vscode.postMessage({ type: 'tool', id: 'installVsix' }));

startViewer(
  {
    noEdit: true,
    async render(bytes) {
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
      blobUrls = [];
      const zip = await JSZip.loadAsync(bytes);
      const pkgFile = zip.file('extension/package.json');
      if (!pkgFile) throw new Error(t('vsixNotVsix'));
      const pkg = JSON.parse(await pkgFile.async('string')) as Json;

      // Localized manifest strings: package.nls.<lang>.json, then package.nls.json.
      const readJson = async (p: string) => {
        const f = zip.file(p);
        try {
          return f ? (JSON.parse(await f.async('string')) as Json) : {};
        } catch {
          return {};
        }
      };
      const nls = { ...(await readJson('extension/package.nls.json')), ...(await readJson(`extension/package.nls.${lang}.json`)) };
      const r = resolver(nls);

      const name = r(pkg.displayName) || String(pkg.name ?? '');
      const publisher = String(pkg.publisher ?? '');
      const contributes = (pkg.contributes ?? {}) as Json;
      const arr = (v: unknown) => (Array.isArray(v) ? (v as Json[]) : []);

      // Header
      const header = el('div', { className: 'vsix-header' });
      const iconPath = typeof pkg.icon === 'string' ? `extension/${pkg.icon.replace(/^\.\//, '')}` : '';
      const iconFile = iconPath ? findEntry(zip, iconPath) : null;
      if (iconFile) header.append(el('img', { className: 'vsix-icon', src: await blobUrl(iconFile), alt: '' }));
      else header.append(el('div', { className: 'vsix-icon vsix-icon-empty', textContent: '🧩' }));
      header.append(
        el('div', { className: 'vsix-title' }, [
          el('h1', { textContent: name }),
          el('div', { className: 'settings-note', textContent: `${publisher ? t('vsixBy', publisher) + ' · ' : ''}${publisher}.${String(pkg.name ?? '')}` }),
          el('p', { textContent: r(pkg.description) }),
        ]),
      );

      const engines = (pkg.engines ?? {}) as Json;
      const categories = arr(pkg.categories).map(String).join(', ');
      const meta = el('div', { className: 'vsix-meta' });
      for (const item of [
        row(t('vsixVersion'), String(pkg.version ?? '')),
        row(t('vsixEngine'), engines.vscode ? `VS Code ${String(engines.vscode)}` : undefined),
        row(t('vsixLicense'), pkg.license ? String(pkg.license) : undefined),
        row(t('vsixCategories'), categories || undefined),
      ]) {
        if (item) meta.append(item);
      }

      // Contributed features
      const features = el('section', { className: 'vsix-features' }, [el('h2', { textContent: t('vsixFeatures') })]);
      const commands = arr(contributes.commands).map((c) => `${r(c.category) ? r(c.category) + ': ' : ''}${r(c.title)}  —  ${String(c.command)}`);
      const editors = arr(contributes.customEditors).map((e) => {
        const pats = arr(e.selector).map((s) => String(s.filenamePattern ?? '')).filter(Boolean).join(', ');
        return `${r(e.displayName)}${pats ? `  (${pats})` : ''}`;
      });
      const config = contributes.configuration as Json | Json[] | undefined;
      const configBlocks = Array.isArray(config) ? config : config ? [config] : [];
      const settings = configBlocks.flatMap((b) =>
        Object.entries((b.properties ?? {}) as Record<string, Json>).map(([k, v]) => {
          const desc = r(v.markdownDescription) || r(v.description);
          return desc ? `${k} — ${desc.replace(/[`*#]/g, '')}` : k;
        }),
      );
      const languages = arr(contributes.languages).map((l) => `${String(l.id)}${arr(l.extensions).length ? ` (${arr(l.extensions).map(String).join(', ')})` : ''}`);
      const keybindings = arr(contributes.keybindings).map((k) => `${String(k.key ?? '')} → ${String(k.command ?? '')}`);
      const activation = arr(pkg.activationEvents).map(String);
      const deps = arr(pkg.extensionDependencies).map(String);
      let anyFeature = false;
      for (const block of [
        list(t('vsixCommands'), commands),
        list(t('vsixEditors'), editors),
        list(t('vsixSettings'), settings),
        list(t('vsixLanguages'), languages),
        list(t('vsixKeybindings'), keybindings),
        list(t('vsixActivation'), activation),
        list(t('vsixDependencies'), deps),
      ]) {
        if (block) {
          features.append(block);
          anyFeature = true;
        }
      }

      // README
      const readmeSec = el('section', { className: 'vsix-readme' }, [el('h2', { textContent: t('vsixReadme') })]);
      const readme = findEntry(zip, 'extension/readme.md') ?? findEntry(zip, 'extension/README.markdown');
      if (readme) {
        const html = await marked.parse(await readme.async('string'), { gfm: true });
        const body = el('article', { className: 'vsix-markdown' });
        body.append(await safeReadme(html, zip, 'extension/'));
        readmeSec.append(body);
      } else {
        readmeSec.append(el('p', { className: 'settings-note', textContent: t('vsixNoReadme') }));
      }

      // Files
      const files = Object.values(zip.files).filter((f) => !f.dir).sort((a, b) => a.name.localeCompare(b.name));
      const total = files.reduce((n, f) => n + sizeOf(f), 0);
      const filesSec = el('details', { className: 'vsix-section vsix-files' });
      filesSec.append(el('summary', { textContent: t('vsixFiles', files.length, fmtSize(total)) }));
      const table = el('table', { className: 'grid vsix-file-table' });
      const tbody = el('tbody');
      for (const f of files) tbody.append(el('tr', {}, [el('td', { textContent: f.name }), el('td', { className: 'num', textContent: fmtSize(sizeOf(f)) })]));
      table.append(tbody);
      filesSec.append(table);

      const page = el('div', { className: 'vsix-page' }, [header, meta, el('div', { className: 'vsix-actions' }, [installBtn])]);
      if (anyFeature) page.append(features);
      page.append(readmeSec, filesSec);
      $('#content').replaceChildren(page);
    },
  },
);
