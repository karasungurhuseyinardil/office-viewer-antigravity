import * as esbuild from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

// Extension host (Node).
const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

// Webview scripts (browser). ESM so pdf.js top-level await works.
const webview = {
  ...common,
  entryPoints: {
    docx: 'webview/docx/main.ts',
    sheet: 'webview/sheet/main.ts',
    pdf: 'webview/pdf/main.ts',
    pptx: 'webview/pptx/main.ts',
    actions: 'webview/actions/main.ts',
    vsix: 'webview/vsix/main.ts',
    file: 'webview/file/main.ts',
  },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
};

function copyAssets() {
  rmSync('dist', { recursive: true, force: true });
  mkdirSync('dist/webview', { recursive: true });
  copyFileSync('webview/common/styles.css', 'dist/webview/styles.css');
  copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/webview/pdf.worker.min.mjs');
  // Needed for PDFs with CJK/Turkish CID fonts and non-embedded standard fonts.
  cpSync('node_modules/pdfjs-dist/cmaps', 'dist/webview/cmaps', { recursive: true });
  cpSync('node_modules/pdfjs-dist/standard_fonts', 'dist/webview/standard_fonts', { recursive: true });
}

copyAssets();
if (watch) {
  const a = await esbuild.context(extension);
  const b = await esbuild.context(webview);
  await Promise.all([a.watch(), b.watch()]);
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
