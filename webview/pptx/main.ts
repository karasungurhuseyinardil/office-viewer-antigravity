import JSZip from 'jszip';
import { $, el, showBanner, startViewer, t } from '../common/bridge';

// Simple PowerPoint preview: shape positions, text and pictures per slide.
// Themes, charts, SmartArt and effects are not drawn.

const EMU_PER_PT = 12700;

type Rels = Map<string, string>; // rId -> zip path
interface Box { x: number; y: number; w: number; h: number }

const kids = (node: Element, name: string) => Array.from(node.children).filter((c) => c.localName === name);
const kid = (node: Element | undefined | null, name: string) => (node ? kids(node, name)[0] : undefined);
const all = (node: Element | Document, name: string) => Array.from(node.getElementsByTagNameNS('*', name));
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function readXml(zip: JSZip, path: string): Promise<Document | undefined> {
  const f = zip.file(path);
  return f ? parse(await f.async('string')) : undefined;
}

async function readRels(zip: JSZip, partPath: string): Promise<Rels> {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const name = partPath.split('/').pop();
  const doc = await readXml(zip, `${dir}/_rels/${name}.rels`);
  const rels: Rels = new Map();
  if (!doc) return rels;
  for (const r of all(doc, 'Relationship')) {
    if (r.getAttribute('TargetMode') === 'External') continue;
    rels.set(r.getAttribute('Id')!, resolvePath(partPath, r.getAttribute('Target')!));
  }
  return rels;
}

/** Finds a relationship target by its Type suffix (e.g. "slideLayout"). */
function relOfType(rels: Rels, relsXml: Document | undefined, type: string): string | undefined {
  if (!relsXml) return undefined;
  for (const r of all(relsXml, 'Relationship')) {
    if (r.getAttribute('Type')?.endsWith('/' + type)) return rels.get(r.getAttribute('Id')!);
  }
  return undefined;
}

function xfrmBox(spPr: Element | undefined): Box | undefined {
  const xfrm = kid(spPr, 'xfrm');
  const off = kid(xfrm, 'off');
  const ext = kid(xfrm, 'ext');
  if (!off || !ext) return undefined;
  return { x: +off.getAttribute('x')!, y: +off.getAttribute('y')!, w: +ext.getAttribute('cx')!, h: +ext.getAttribute('cy')! };
}

/** Placeholder key used to inherit position from layout / master. */
function phKey(shape: Element): { type: string; idx: string } | undefined {
  const nv = Array.from(shape.children).find((c) => c.localName.startsWith('nv'));
  const ph = nv ? all(nv, 'ph')[0] : undefined;
  if (!ph) return undefined;
  return { type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx') ?? '' };
}

function findPlaceholderBox(doc: Document | undefined, key: { type: string; idx: string }): Box | undefined {
  if (!doc) return undefined;
  const shapes = all(doc, 'sp');
  const norm = (t: string) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' ? 'body' : t);
  const match =
    shapes.find((s) => key.idx && phKey(s)?.idx === key.idx) ??
    shapes.find((s) => { const k = phKey(s); return k && norm(k.type) === norm(key.type); });
  return match ? xfrmBox(kid(match, 'spPr')) : undefined;
}

function solidColor(node: Element | undefined): string | undefined {
  const fill = kid(node, 'solidFill');
  const srgb = kid(fill, 'srgbClr');
  return srgb ? '#' + srgb.getAttribute('val') : undefined;
}

function renderText(txBody: Element, isTitle: boolean): HTMLElement {
  const wrap = el('div');
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const para = el('p');
    const algn = pPr?.getAttribute('algn');
    if (algn) para.style.textAlign = { ctr: 'center', r: 'right', just: 'justify' }[algn] ?? 'left';
    const lvl = Number(pPr?.getAttribute('lvl') ?? 0);
    if (lvl) para.style.paddingLeft = `${lvl * 1.5}em`;
    const hasBullet = !isTitle && !kid(pPr, 'buNone') && (kid(pPr, 'buChar') || kid(pPr, 'buAutoNum') || lvl > 0);
    if (hasBullet) para.append('• ');

    for (const r of Array.from(p.children)) {
      if (r.localName === 'br') { para.append(el('br')); continue; }
      if (r.localName !== 'r' && r.localName !== 'fld') continue;
      const span = el('span', { textContent: kid(r, 't')?.textContent ?? '' });
      const rPr = kid(r, 'rPr');
      const sz = rPr?.getAttribute('sz');
      // Font size is in hundredths of a point; --pt scales 1pt to the rendered slide width.
      if (sz) span.style.fontSize = `calc(${Number(sz) / 100} * var(--pt))`;
      if (rPr?.getAttribute('b') === '1') span.style.fontWeight = 'bold';
      if (rPr?.getAttribute('i') === '1') span.style.fontStyle = 'italic';
      if (rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none') span.style.textDecoration = 'underline';
      const color = solidColor(rPr);
      if (color) span.style.color = color;
      para.append(span);
    }
    if (!para.textContent) para.append(' ');
    wrap.append(para);
  }
  return wrap;
}

interface Ctx {
  zip: JSZip;
  rels: Rels;
  layout?: Document;
  master?: Document;
  slideW: number;
  slideH: number;
  blobUrls: string[];
}

async function renderShapes(tree: Element, ctx: Ctx, out: HTMLElement, map: (b: Box) => Box) {
  for (const node of Array.from(tree.children)) {
    const name = node.localName;
    if (name === 'grpSp') {
      // Group: child coordinates are in chOff/chExt space, mapped onto off/ext.
      const xfrm = kid(kid(node, 'grpSpPr'), 'xfrm');
      const off = kid(xfrm, 'off'), ext = kid(xfrm, 'ext'), chOff = kid(xfrm, 'chOff'), chExt = kid(xfrm, 'chExt');
      if (off && ext && chOff && chExt) {
        const [ox, oy, ew, eh] = [off, off, ext, ext].map((n, i) => +n.getAttribute(['x', 'y', 'cx', 'cy'][i])!);
        const [cx, cy, cw, ch] = [chOff, chOff, chExt, chExt].map((n, i) => +n.getAttribute(['x', 'y', 'cx', 'cy'][i])!);
        const sx = cw ? ew / cw : 1, sy = ch ? eh / ch : 1;
        await renderShapes(node, ctx, out, (b) => map({ x: ox + (b.x - cx) * sx, y: oy + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy }));
      } else {
        await renderShapes(node, ctx, out, map);
      }
      continue;
    }
    if (name !== 'sp' && name !== 'pic' && name !== 'graphicFrame') continue;

    const spPr = kid(node, 'spPr');
    let box = name === 'graphicFrame' ? xfrmBox(node) : xfrmBox(spPr);
    const key = phKey(node);
    if (!box && key) box = findPlaceholderBox(ctx.layout, key) ?? findPlaceholderBox(ctx.master, key);
    if (!box) continue;
    box = map(box);

    const div = el('div', { className: 'shape' });
    div.style.left = `${(box.x / ctx.slideW) * 100}%`;
    div.style.top = `${(box.y / ctx.slideH) * 100}%`;
    div.style.width = `${(box.w / ctx.slideW) * 100}%`;
    div.style.height = `${(box.h / ctx.slideH) * 100}%`;
    const bg = solidColor(spPr);
    if (bg) div.style.background = bg;

    if (name === 'pic') {
      const embed = all(node, 'blip')[0]?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      const path = embed ? ctx.rels.get(embed) : undefined;
      const file = path ? ctx.zip.file(path) : null;
      if (file && /\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(path!)) {
        const type = path!.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '';
        const url = URL.createObjectURL(new Blob([await file.async('arraybuffer')], { type }));
        ctx.blobUrls.push(url);
        div.append(el('img', { src: url, alt: '' }));
      }
    } else if (name === 'graphicFrame') {
      const tbl = all(node, 'tbl')[0];
      if (tbl) {
        const table = el('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:calc(12 * var(--pt))';
        for (const tr of kids(tbl, 'tr')) {
          const row = el('tr');
          for (const tc of kids(tr, 'tc')) {
            const td = el('td');
            td.style.cssText = 'border:1px solid #999;padding:2px 4px;vertical-align:top';
            const tx = kid(tc, 'txBody');
            if (tx) td.append(renderText(tx, false));
            row.append(td);
          }
          table.append(row);
        }
        div.append(table);
      } else {
        div.style.border = '1px dashed #9996';
        div.append(el('div', { textContent: t('chart'), className: 'slide-notes' }));
      }
    } else {
      const tx = kid(node, 'txBody');
      if (tx) {
        const isTitle = key?.type === 'title' || key?.type === 'ctrTitle';
        const text = renderText(tx, isTitle);
        // Default sizes when the run has no explicit size.
        text.style.fontSize = `calc(${isTitle ? 36 : 18} * var(--pt))`;
        div.append(text);
        const anchor = kid(tx, 'bodyPr')?.getAttribute('anchor');
        div.style.display = 'flex';
        div.style.flexDirection = 'column';
        div.style.justifyContent = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start';
        div.style.padding = '0.5% 0.8%';
      }
    }
    out.append(div);
  }
}

let blobUrls: string[] = [];

startViewer({
  async render(bytes) {
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls = [];

    const zip = await JSZip.loadAsync(bytes);
    const presPath = 'ppt/presentation.xml';
    const pres = await readXml(zip, presPath);
    if (!pres) throw new Error(t('notPptx'));
    const presRels = await readRels(zip, presPath);
    const sz = all(pres, 'sldSz')[0];
    const slideW = Number(sz?.getAttribute('cx') ?? 12192000);
    const slideH = Number(sz?.getAttribute('cy') ?? 6858000);

    const slidePaths = all(pres, 'sldId')
      .map((s) => presRels.get(s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? ''))
      .filter((p): p is string => !!p);

    const container = el('div', { className: 'slides' });
    for (const [i, path] of slidePaths.entries()) {
      const slideDoc = await readXml(zip, path);
      if (!slideDoc) continue;
      const rels = await readRels(zip, path);
      const relsXml = await readXml(zip, path.replace(/([^/]+)$/, '_rels/$1.rels'));
      const layoutPath = relOfType(rels, relsXml, 'slideLayout');
      const layout = layoutPath ? await readXml(zip, layoutPath) : undefined;
      let master: Document | undefined;
      if (layoutPath) {
        const lRels = await readRels(zip, layoutPath);
        const lRelsXml = await readXml(zip, layoutPath.replace(/([^/]+)$/, '_rels/$1.rels'));
        const masterPath = relOfType(lRels, lRelsXml, 'slideMaster');
        master = masterPath ? await readXml(zip, masterPath) : undefined;
      }

      const slide = el('div', { className: 'slide' });
      slide.style.aspectRatio = `${slideW} / ${slideH}`;
      // 1pt relative to rendered slide width.
      slide.style.setProperty('--pt', `${(100 * EMU_PER_PT) / slideW}cqw`);
      const bg = solidColor(kid(all(slideDoc, 'bg')[0], 'bgPr'));
      if (bg) slide.style.background = bg;

      const tree = all(slideDoc, 'spTree')[0];
      if (tree) await renderShapes(tree, { zip, rels, layout, master, slideW, slideH, blobUrls }, slide, (b) => b);

      const wrap = el('section', { className: 'slide-wrap' }, [el('div', { className: 'slide-num', textContent: t('slide', i + 1) }), slide]);

      // Speaker notes, if any.
      const notesPath = relOfType(rels, relsXml, 'notesSlide');
      const notes = notesPath ? await readXml(zip, notesPath) : undefined;
      if (notes) {
        const body = all(notes, 'sp').find((s) => phKey(s)?.type === 'body');
        const text = body ? kids(kid(body, 'txBody')!, 'p').map((p) => all(p, 't').map((t) => t.textContent).join('')).join('\n').trim() : '';
        if (text) wrap.append(el('div', { className: 'slide-notes', textContent: t('notes', text) }));
      }
      container.append(wrap);
    }
    $('#content').replaceChildren(container);
    showBanner(t('pptxBanner'), 'info');
  },
});
