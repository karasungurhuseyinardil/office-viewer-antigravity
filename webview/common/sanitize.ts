// Cleans HTML that comes from files (README, Markdown): no scripts, frames,
// inline handlers or javascript: links.

export function sanitizeHtml(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, iframe, frame, object, embed, style, link, meta, form, base, noscript, template').forEach((n) => n.remove());
  for (const node of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (
        name.startsWith('on') ||
        name === 'srcdoc' ||
        name === 'formaction' ||
        ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action') && /^(javascript|vbscript|data:text)/.test(value))
      ) {
        node.removeAttribute(attr.name);
      }
    }
  }
  const frag = document.createDocumentFragment();
  frag.append(...Array.from(doc.body.childNodes));
  return frag;
}
