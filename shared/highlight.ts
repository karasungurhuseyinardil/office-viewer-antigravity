// Syntax highlighting for code files (webview viewer + HTML/PDF export).
import hljs from 'highlight.js/lib/common';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import dos from 'highlight.js/lib/languages/dos';
import gradle from 'highlight.js/lib/languages/gradle';
import groovy from 'highlight.js/lib/languages/groovy';
import scala from 'highlight.js/lib/languages/scala';
import properties from 'highlight.js/lib/languages/properties';
import fsharp from 'highlight.js/lib/languages/fsharp';
import protobuf from 'highlight.js/lib/languages/protobuf';
import nginx from 'highlight.js/lib/languages/nginx';
import elixir from 'highlight.js/lib/languages/elixir';
import haskell from 'highlight.js/lib/languages/haskell';
import cmake from 'highlight.js/lib/languages/cmake';
import latex from 'highlight.js/lib/languages/latex';

for (const [name, lang] of Object.entries({ dart, dockerfile, powershell, dos, gradle, groovy, scala, properties, fsharp, protobuf, nginx, elixir, haskell, cmake, latex })) {
  hljs.registerLanguage(name, lang);
}

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', ipynb: 'json',
  py: 'python', pyw: 'python', pyi: 'python', rb: 'ruby', php: 'php',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'gradle',
  cs: 'csharp', csx: 'csharp', vb: 'vbnet', fs: 'fsharp', fsx: 'fsharp',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', ino: 'cpp',
  m: 'objectivec', mm: 'objectivec', swift: 'swift', go: 'go', rs: 'rust', dart: 'dart',
  lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', ex: 'elixir', exs: 'elixir', hs: 'haskell',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'dos', cmd: 'dos',
  html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', vbproj: 'xml', props: 'xml', targets: 'xml', plist: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown', tex: 'latex',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', editorconfig: 'ini', env: 'properties', properties: 'properties',
  diff: 'diff', patch: 'diff', cmake: 'cmake', wat: 'wasm',
};

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', 'cmakelists.txt': 'cmake',
  gemfile: 'ruby', rakefile: 'ruby', jenkinsfile: 'groovy', 'nginx.conf': 'nginx',
  '.gitignore': 'bash', '.npmrc': 'ini', '.env': 'properties',
};

/** highlight.js language for a file name, if known. */
export function languageFor(fileName: string): string | undefined {
  const name = fileName.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('dockerfile')) return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return BY_EXT[ext];
}

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Highlighted HTML (spans with hljs-* classes). Very large files are only escaped. */
export function highlightCode(code: string, fileName: string): { html: string; language: string } {
  const lang = languageFor(fileName);
  if (code.length > 1_500_000) return { html: escape(code), language: lang ?? 'plaintext' };
  try {
    if (lang && hljs.getLanguage(lang)) return { html: hljs.highlight(code, { language: lang, ignoreIllegals: true }).value, language: lang };
    if (code.length < 200_000) {
      const auto = hljs.highlightAuto(code);
      if (auto.relevance >= 5) return { html: auto.value, language: auto.language ?? 'plaintext' };
    }
  } catch {
    // fall through to plain text
  }
  return { html: escape(code), language: 'plaintext' };
}

/** Theme for hljs classes: VS Code Dark+ / Light+ like colours. */
export const HIGHLIGHT_CSS = `
.hljs-comment,.hljs-quote{color:var(--hl-comment);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-tag,.hljs-name{color:var(--hl-keyword)}
.hljs-string,.hljs-template-tag,.hljs-addition{color:var(--hl-string)}
.hljs-number,.hljs-symbol,.hljs-bullet{color:var(--hl-number)}
.hljs-title,.hljs-title.function_,.hljs-section{color:var(--hl-function)}
.hljs-type,.hljs-built_in,.hljs-title.class_,.hljs-class .hljs-title{color:var(--hl-type)}
.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-params,.hljs-property,.hljs-selector-class,.hljs-selector-id{color:var(--hl-attr)}
.hljs-meta,.hljs-meta .hljs-keyword,.hljs-subst{color:var(--hl-meta)}
.hljs-regexp,.hljs-link,.hljs-deletion{color:var(--hl-regexp)}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:bold}
`;
export const HIGHLIGHT_LIGHT_VARS =
  '--hl-comment:#008000;--hl-keyword:#0000ff;--hl-string:#a31515;--hl-number:#098658;--hl-function:#795e26;--hl-type:#267f99;--hl-attr:#001080;--hl-meta:#af00db;--hl-regexp:#811f3f;';
