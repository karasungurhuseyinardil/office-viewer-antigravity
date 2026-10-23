<img src="images/icon.png" width="96" alt="Office Viewer icon" align="right">

# Office Viewer (Antigravity / VS Code)

Opens Word, Excel, PowerPoint, PDF — and every other file type, code included — inside the editor, instead of the
"The file is not displayed in the text editor because it is either binary…" screen.
UI in English, Español, Français and Türkçe.

| Format | View | Edit |
|---|---|---|
| `.docx` | Formatted document | **Edit** button: edit text, headings, lists. Save with **Save** or Ctrl+S. |
| `.xlsx`, `.xls`, `.csv` | Sheet tabs + grid | **Edit** button: edit cells (`=` for formulas), add rows/columns. |
| `.pdf` | Pages, zoom, fit width | **Edit ↗** opens the default PDF app. |
| `.pptx` | Slide preview (text, pictures, tables, notes) | **Edit ↗** opens PowerPoint. |
| `.vsix` | Extension package: icon, version, commands, editors, settings, README, file list | **Install extension** button (also: right-click a `.vsix` → Install Extension from This File) |

**Open in default app** opens the file in its default Windows/macOS/Linux app.

## Every other file
- **Code and text** (any language): syntax colours, line numbers, wrap toggle. **Edit in editor** opens the normal Antigravity
  editor at the same line (IntelliSense, refactoring…). Tools → export to PDF / HTML / Markdown.
- **Markdown**: rendered preview + source; export to Word / PDF / HTML.
- **Images** (png, jpg, gif, webp, svg, ico, bmp, avif…), **audio** (mp3, wav, ogg, flac…), **video** (mp4, webm…), **fonts** (ttf, otf, woff).
- **Archives** (zip, jar, apk, nupkg, whl, epub…): file list, preview inside, save single files.
- **OpenDocument** (.odt / .odp text preview, .ods in the spreadsheet viewer), **RTF** (text preview).
- **Anything else** (exe, dll, db, iso…): file type from its signature + hex view. Huge files: only the beginning is read.

**Open all files here** (⚙ menu, on by default): files that open in the text editor switch to Office Viewer.
Diff views, unsaved tabs, debugging, and files you chose to edit ("Edit in editor", "Reopen Editor With…") stay in the text editor.
Right-click any file → **Open in Office Viewer** / **Edit in Text Editor**.

## Language
English (default), Español, Français, Türkçe — ⚙ menu → Language, or the `officeViewer.language` setting.
Open viewers reload in the new language (files with unsaved edits switch when reopened).
Command and setting names in Antigravity's own menus follow the editor display language (`package.nls.*.json`).

## Features
- **Breadcrumb** in the toolbar: click a part to show it in File Explorer; right-click for **Reveal in File Explorer** / **Copy Path**.
- **Search**: Ctrl+F in every format (PDF too, via a text layer).
- **New Meeting Note**: right-click a folder in the Explorer → creates today's note (e.g. `22.10.2026.docx`) from a template and opens it in edit mode.
- **Tools ▾** (top-right):
  - *Export*: docx → PDF / Markdown / HTML / TXT; xlsx → CSV / PDF / HTML; xls → XLSX; csv → XLSX / PDF / HTML; pptx → Markdown / TXT.
    PDF is printed with the installed Microsoft Edge or Chrome (headless, offline). Also in the Explorer: right-click a file → **Convert…** (Markdown → Word too).
  - *Compare with version*: diff against the `.bak` backup, the last Git commit or another file (text, in the built-in diff view).
  - *Outline* (Word): heading outline; word / character count in the bottom bar.
  - *Search notes*: full-text search in all Word / Excel / CSV / PowerPoint files (Turkish-aware: "ozet" finds "Özet"); opens the file at the match.
  - *Action list*: collects every table with a "Task" column (Owner / Due / Status optional; also Görev, Tarea, Tâche…) from the notes; filter, sort, export to Excel.
- **Word editing**: highlight, ☐ to-do boxes (click to tick), links, insert table, add / remove rows and columns.
- **Excel / CSV**: click a column letter to sort, filter box, fixed header row (view only, the file is not reordered).
- **⚙ menu** (top-right):
  - *Auto save* — "use the editor setting", or any mix of: after typing stops, on tab/panel change, on leaving the window.
    Separate from the global `files.autoSave` (stored as a `[office-document]` language override).
  - *Appearance* — light / dark / theme page, full width, font size.
  - *Opening and backup* — open in edit mode, `.docx.bak` backup on first save.
  - *Language* — English, Español, Français, Türkçe.
  - **Save / Cancel** — changes are only written when you press Save.
  - **Open settings in Antigravity** — all settings (`officeViewer.*`) in the Settings editor.

## Limits
- `.docx` saving converts the page back to Word. Text, headings, bold/italic, lists and tables are kept;
  headers/footers, comments and custom styles can be lost. The first save keeps the original as `<name>.docx.bak` (can be turned off).
- `.xlsx` saving keeps values and formulas; cell colours and fonts can be lost.
- `.pptx` preview does not draw themes, charts, SmartArt or animations.

## Install in Antigravity
1. `npm install`
2. `npm run package` → creates `office-viewer-antigravity-<version>.vsix`
3. Antigravity → Extensions panel → `...` menu → **Install from VSIX…** → pick the file.
4. Reload the window. Open any `.docx` file.

To go back to the text editor for a file: right-click the tab → **Reopen Editor With…** → **Text Editor**.

## Develop
Requires Node.js 18+.
- `npm install`, then `npm run watch` and press F5 in VS Code ("Run Extension").
- `npm run typecheck` — TypeScript check; `npm run package` — builds the `.vsix`.
- Sample files are in `samples/`.

```
src/                extension host (Node)
  providers/        custom editor provider (open / save / backup) and docx writer
  convert/          export: PDF (headless Edge/Chrome), Markdown, HTML, CSV, …
  notes/            search notes, action list
  openAll.ts        "Open all files here"
  compare.ts        compare with .bak / Git HEAD / another file
webview/            browser side, one bundle per viewer
  common/           toolbar, ⚙ and Tools menus, styles, HTML sanitizer
  docx/ sheet/ pdf/ pptx/ vsix/ file/ actions/
shared/             code used by both sides: translations (i18n.ts), syntax highlighting
package.nls*.json   command / setting names for the editor's own menus
```
