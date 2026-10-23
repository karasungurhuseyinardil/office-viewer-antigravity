import HTMLtoDOCX from 'html-to-docx';
import JSZip from 'jszip';

const HIGHLIGHT = '#ffff00';

/**
 * html-to-docx writes background colours as cell-style shading, which Word shows
 * but mammoth ignores. Turn yellow shading on text runs into a real Word
 * highlight so it survives save + reopen.
 */
async function shadingToHighlight(docx: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);
  const file = zip.file('word/document.xml');
  if (!file) return docx;
  const xml = await file.async('string');
  const fixed = xml.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (rpr, inner: string) =>
    /<w:shd w:val="clear" w:fill="ffff00"\/>/i.test(inner)
      ? `<w:rPr>${inner.replace(/<w:shd w:val="clear" w:fill="ffff00"\/>/i, '<w:highlight w:val="yellow"/>')}</w:rPr>`
      : rpr,
  );
  if (fixed === xml) return docx;
  zip.file('word/document.xml', fixed);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** Converts the edited HTML from the webview back into a .docx file. */
export async function htmlToDocx(bodyHtml: string): Promise<Uint8Array> {
  // <mark> (how highlights are shown) -> background colour html-to-docx understands.
  const body = bodyHtml.replace(/<mark\b[^>]*>/gi, `<span style="background-color: ${HIGHLIGHT}">`).replace(/<\/mark>/gi, '</span>');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${body}</body></html>`;
  const result = await HTMLtoDOCX(html, null, {
    font: 'Calibri',
    fontSize: 22, // half-points = 11pt
    table: { row: { cantSplit: true } },
  });
  let bytes: Uint8Array;
  if (result instanceof ArrayBuffer) bytes = new Uint8Array(result);
  else if (result instanceof Uint8Array) bytes = result;
  // Blob (browser build) — not expected in Node, but handle it anyway.
  else bytes = new Uint8Array(await (result as Blob).arrayBuffer());
  return shadingToHighlight(bytes);
}
