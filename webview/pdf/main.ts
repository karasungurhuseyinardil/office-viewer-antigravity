import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { $, assetUrl, el, startViewer, t } from '../common/bridge';

// Webview workers can't load from the resource origin directly, so load the worker via a blob URL.
async function setupWorker() {
  const res = await fetch(assetUrl('pdf.worker.min.mjs'));
  const blob = new Blob([await res.text()], { type: 'text/javascript' });
  pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
}
const workerReady = setupWorker();

let pdf: PDFDocumentProxy | undefined;
let scale = 1.25;
let renderToken = 0;

const zoomOut = el('button', { className: 'icon', textContent: '−', title: t('zoomOut') });
const zoomLabel = el('span', { className: 'zoom-label' });
const zoomIn = el('button', { className: 'icon', textContent: '+', title: t('zoomIn') });
const fitBtn = el('button', { textContent: t('fitWidth') });
const pageInfo = el('span', { className: 'zoom-label' });
const controls = el('div', { className: 'extra' }, [zoomOut, zoomLabel, zoomIn, fitBtn, el('span', { className: 'sep' }), pageInfo]);

function setScale(s: number) {
  scale = Math.min(5, Math.max(0.25, s));
  renderAll();
}
zoomOut.addEventListener('click', () => setScale(scale / 1.2));
zoomIn.addEventListener('click', () => setScale(scale * 1.2));
fitBtn.addEventListener('click', async () => {
  if (!pdf) return;
  const page = await pdf.getPage(1);
  const width = page.getViewport({ scale: 1 }).width;
  setScale(($('#content').clientWidth - 48) / width);
});

/** Lays out page placeholders, renders each page when it scrolls into view. */
async function renderAll() {
  if (!pdf) return;
  const token = ++renderToken;
  zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  pageInfo.textContent = t('pages', pdf.numPages);

  const container = el('div', { className: 'pdf-pages' });
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        renderPage(entry.target as HTMLElement, token);
      }
    },
    { root: $('#content'), rootMargin: '600px 0px' },
  );

  const pages: [PDFPageProxy, HTMLElement][] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    if (token !== renderToken) return;
    const vp = page.getViewport({ scale });
    const holder = el('div', { className: 'pdf-page' });
    holder.style.width = `${vp.width}px`;
    holder.style.height = `${vp.height}px`;
    // pdf.js text layer sizes itself with this variable.
    holder.style.setProperty('--scale-factor', String(scale));
    holder.dataset.page = String(i);
    container.append(holder);
    observer.observe(holder);
    pages.push([page, holder]);
  }
  $('#content').replaceChildren(container);

  // Text layers for every page (not only visible ones), so Ctrl+F finds text anywhere.
  for (const [page, holder] of pages) {
    if (token !== renderToken) return;
    const layer = el('div', { className: 'textLayer' });
    holder.append(layer);
    try {
      await new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport: page.getViewport({ scale }),
      }).render();
    } catch {
      layer.remove(); // scanned page without text: canvas only
    }
  }
}

async function renderPage(holder: HTMLElement, token: number) {
  if (!pdf || token !== renderToken) return;
  const page = await pdf.getPage(Number(holder.dataset.page));
  const vp = page.getViewport({ scale });
  const ratio = window.devicePixelRatio || 1;
  const canvas = el('canvas');
  canvas.width = Math.floor(vp.width * ratio);
  canvas.height = Math.floor(vp.height * ratio);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
  if (token === renderToken) holder.prepend(canvas);
}

startViewer(
  {
    async render(bytes) {
      await workerReady;
      await pdf?.destroy();
      pdf = await pdfjs.getDocument({
        data: bytes,
        isEvalSupported: false, // hardening: never eval font code
        cMapUrl: assetUrl('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: assetUrl('standard_fonts/'),
      }).promise;
      // Start at 125%, or smaller when the panel is narrower than the page.
      const first = await pdf.getPage(1);
      const fit = ($('#content').clientWidth - 48) / first.getViewport({ scale: 1 }).width;
      scale = Math.max(0.25, Math.min(1.25, fit));
      await renderAll();
    },
  },
  controls,
);
