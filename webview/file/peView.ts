// DLL / EXE (PE) and PDB pages for the universal viewer.
import { $, el, locale, setStatus, showBanner, t, vscode } from '../common/bridge';
import { parsePdb, parsePe, type PeInfo } from './pe';

type Tabs = (labels: [string, string], onChange: (second: boolean) => void) => { group: HTMLElement; start(): void };

interface Deps {
  fileName: string;
  fmtSize(n: number): string;
  renderHex(): void;
  setExtra(...nodes: Node[]): void;
  toggle: Tabs;
}

/** Asks the extension to decompile a type (or the whole DLL) with ILSpy and show the C#. */
const decompile = (typeName?: string, member?: string) => vscode.postMessage({ type: 'tool', id: 'decompile', typeName, member });

const norm = (s: string) => s.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');

function table(rows: [string, string | undefined][]): HTMLElement {
  const tbl = el('table', { className: 'pe-table' });
  for (const [k, v] of rows) {
    if (!v) continue;
    tbl.append(el('tr', {}, [el('th', { textContent: k }), el('td', { textContent: v })]));
  }
  return tbl;
}

function section(title: string, body: Node, open = true): HTMLElement {
  const d = el('details', { className: 'vsix-section', open });
  d.append(el('summary', { textContent: title }), body);
  return d;
}

function summary(info: PeInfo): string {
  const parts = [info.dotnet ? t('peDotnet') : t('peNative')];
  parts.push(info.dotnet ? (info.dotnet.isApp ? t('peApp') : t('peLibrary')) : info.kind === 'dll' ? t('peLibrary') : t('peApp'));
  if (info.dotnet?.framework) parts.push(info.dotnet.framework);
  parts.push(info.dotnet ? info.dotnet.platform : `${info.machine}, ${info.bits}-bit`);
  return parts.join(' · ');
}

/** Types grouped by namespace, with a filter box in the toolbar. */
function typesSection(info: PeInfo): { section: HTMLElement; filter: HTMLInputElement } | null {
  const types = info.dotnet?.types ?? [];
  if (!types.length) return null;
  const body = el('div', { className: 'pe-types' });
  const empty = el('p', { className: 'settings-note', textContent: t('peNoTypes') });

  const render = (query: string) => {
    const q = norm(query);
    const byNs = new Map<string, HTMLElement[]>();
    for (const type of types) {
      const full = type.ns ? `${type.ns}.${type.name}` : type.name;
      const typeHit = !q || norm(full).includes(q);
      const methods = typeHit ? type.methods : type.methods.filter((m) => norm(m).includes(q));
      if (!typeHit && !methods.length) continue;
      const item = el('details', { className: `pe-type${type.isPublic ? '' : ' private'}`, open: !!q && !typeHit });
      const cs = el('button', { className: 'cs-btn', textContent: t('decompileBtn'), title: t('decompileTitle') });
      cs.addEventListener('click', (e) => {
        e.preventDefault(); // don't toggle the <details>
        // Nested types are decompiled with their top-level type, then scrolled to.
        decompile(type.outer, type.fullName === type.outer ? undefined : type.name.split('.').pop());
      });
      const head = el('summary', { title: full + (type.isPublic ? '' : ` (${t('peNonPublic')})`) }, [el('span', { textContent: type.name }), cs]);
      item.append(head);
      if (methods.length) {
        const ul = el('ul');
        for (const m of methods) {
          const hidden = m.endsWith(' ·');
          const name = hidden ? m.slice(0, -2) : m;
          const li = el('li', {
            className: `method${hidden ? ' private' : ''}`,
            textContent: name,
            title: `${t('methodTitle')}${hidden ? ` (${t('peNonPublic')})` : ''}`,
            tabIndex: 0,
          });
          const open = () => decompile(type.outer, name);
          li.addEventListener('click', open);
          li.addEventListener('keydown', (e) => e.key === 'Enter' && open());
          ul.append(li);
        }
        item.append(ul);
      }
      const ns = type.ns || '(global)';
      byNs.set(ns, [...(byNs.get(ns) ?? []), item]);
    }
    body.replaceChildren();
    if (!byNs.size) body.append(empty);
    for (const [ns, items] of [...byNs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const group = el('details', { className: 'pe-ns', open: !!q || byNs.size <= 3 });
      group.append(el('summary', { textContent: `${ns} (${items.length})` }), ...items);
      body.append(group);
    }
  };

  const filter = el('input', { type: 'search', className: 'filter-input', placeholder: t('peFilter') });
  filter.setAttribute('aria-label', t('peFilter'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  filter.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => render(filter.value.trim()), 150);
  });
  render('');
  return { section: section(t('peTypes', types.length.toLocaleString(locale)), body), filter };
}

export function renderPe(bytes: Uint8Array, deps: Deps): boolean {
  let info: PeInfo;
  try {
    info = parsePe(bytes);
  } catch {
    return false;
  }
  const v = info.version;
  const d = info.dotnet;
  const page = el('div', { className: 'vsix-page pe-page' });
  page.append(
    el('div', { className: 'vsix-title' }, [
      el('h1', { textContent: d?.assembly?.name || deps.fileName }),
      el('div', { className: 'settings-note', textContent: summary(info) }),
      v.FileDescription && v.FileDescription !== (d?.assembly?.name ?? '') ? el('p', { textContent: v.FileDescription }) : '',
    ]),
  );
  page.append(
    table([
      [t('peAssembly'), d?.assembly ? `${d.assembly.name}, ${t('peVersion')}=${d.assembly.version}, Culture=${d.assembly.culture}` : undefined],
      [t('peFramework'), d?.framework],
      [t('pePlatform'), d ? d.platform : undefined],
      [t('peMachine'), `${info.machine} (${info.bits}-bit)`],
      [t('peSubsystem'), info.subsystem],
      [t('peFileVersion'), v.FileVersion],
      [t('peProductVersion'), v.ProductVersion],
      [t('peProduct'), v.ProductName],
      [t('peCompany'), v.CompanyName],
      [t('peCopyright'), v.LegalCopyright],
      [t('peRuntime'), d?.runtime],
      [t('peBuilt'), info.built?.toLocaleString(locale)],
    ]),
  );

  if (d?.references.length) {
    const ul = el('ul', { className: 'pe-list' });
    for (const ref of d.references) ul.append(el('li', {}, [el('span', { textContent: ref.name }), el('small', { textContent: ` ${ref.version}` })]));
    page.append(section(t('peReferences', d.references.length), ul));
  } else if (info.imports.length) {
    const ul = el('ul', { className: 'pe-list' });
    for (const name of info.imports) ul.append(el('li', { textContent: name }));
    page.append(section(t('peImports', info.imports.length), ul, info.imports.length <= 30));
  }

  const types = typesSection(info);
  if (types) page.append(types.section);

  const secs = el('ul', { className: 'pe-list' });
  for (const s of info.sections) secs.append(el('li', {}, [el('span', { textContent: s.name || '(unnamed)' }), el('small', { textContent: ` ${deps.fmtSize(s.size)}` })]));
  page.append(section(t('peSections', info.sections.length), secs, false));

  const whole = el('button', { textContent: t('decompileAll'), title: t('decompileAllTitle') });
  whole.addEventListener('click', () => decompile());
  const tabs = deps.toggle([t('peTabInfo'), t('peTabHex')], (hex) => {
    if (hex) {
      deps.renderHex();
      showBanner('');
      deps.setExtra(tabs.group);
    } else {
      $('#content').replaceChildren(page);
      deps.setExtra(...[tabs.group, ...(types ? [types.filter] : []), ...(d ? [whole] : [])]);
      setStatus(`${summary(info)} · ${deps.fmtSize(bytes.length)}`);
    }
  });
  tabs.start();
  return true;
}

export function renderPdb(bytes: Uint8Array, deps: Deps): boolean {
  let info;
  try {
    info = parsePdb(bytes);
  } catch {
    return false;
  }
  const page = el('div', { className: 'vsix-page pe-page' });
  page.append(
    el('div', { className: 'vsix-title' }, [
      el('h1', { textContent: deps.fileName }),
      el('div', { className: 'settings-note', textContent: info.format === 'portable' ? t('pdbPortable') : t('pdbWindows') }),
      el('p', { textContent: t('pdbNote') }),
    ]),
  );
  page.append(table([[t('pdbId'), info.id]]));

  if (info.sources.length) {
    // Show paths relative to their common folder; full path on hover.
    const split = info.sources.map((s) => s.split(/[\\/]/));
    let common = split[0].length - 1;
    for (const parts of split) {
      let i = 0;
      while (i < common && parts[i] === split[0][i]) i++;
      common = i;
    }
    const sep = info.sources[0].includes('\\') ? '\\' : '/';
    const root = split[0].slice(0, common).join(sep);
    const ul = el('ul', { className: 'pe-list' });
    for (const [i, parts] of split.entries()) ul.append(el('li', { textContent: parts.slice(common).join(sep), title: info.sources[i] }));
    const body = el('div', {}, [root ? el('div', { className: 'settings-note pe-root', textContent: root + sep }) : '', ul]);
    page.append(section(t('pdbSources', info.sources.length), body));
  }

  const tabs = deps.toggle([t('peTabInfo'), t('peTabHex')], (hex) => {
    if (hex) {
      deps.renderHex();
      showBanner('');
    } else {
      $('#content').replaceChildren(page);
      setStatus(`${info.format === 'portable' ? 'Portable PDB' : 'Windows PDB'} · ${deps.fmtSize(bytes.length)}`);
    }
    deps.setExtra(tabs.group);
  });
  tabs.start();
  return true;
}
