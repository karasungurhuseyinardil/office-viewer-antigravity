declare module 'html-to-docx' {
  function HTMLtoDOCX(
    html: string,
    headerHtml?: string | null,
    options?: Record<string, unknown>,
    footerHtml?: string | null,
  ): Promise<ArrayBuffer | Uint8Array | Blob>;
  export default HTMLtoDOCX;
}

declare module 'seek-bzip' {
  const Bunzip: { decode(input: Uint8Array, output?: Uint8Array): Buffer };
  export default Bunzip;
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: TurndownService.Plugin;
}
