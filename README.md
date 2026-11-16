# RGA Search

Full-text search inside the PDFs, EPUBs and other documents in your Obsidian vault, powered by [ripgrep-all](https://github.com/phiresky/ripgrep-all) (`rga`).

Type a phrase, see the matching lines with the page they're on, and press Enter to open the PDF at that page. If a note in your vault links to the PDF (for example a reference note made by [Stacks](https://github.com/jag3773/obsidian-stacks)), the result shows that note's title and citekey, and Shift+Enter opens the note instead.

RGA Search is **desktop only**. It runs `rga`, a separate program you install yourself.

## How it works

- **Search runs `rga --json`** over the folders you choose. `rga` extracts the text of each document (with `pdftotext` for PDFs, `pandoc` for EPUB and Office files), then ripgrep searches it. Each keystroke cancels the previous search.
- **Results show pages.** `rga` labels each line of a PDF with its page number, so a result opens `file.pdf#page=N` in Obsidian's PDF viewer.
- **The cache lives outside your vault.** `rga` keeps extracted text in its own cache folder (`~/Library/Caches/ripgrep-all` on macOS, `~/.cache/ripgrep-all` on Linux, `%LOCALAPPDATA%\ripgrep-all` on Windows). Nothing is added to your vault and nothing syncs. The first search over a large library extracts every document and can take a while (over an hour for about 950 PDFs on a recent Mac); later searches read the cache. Run **Warm the cache** to do that first pass ahead of time, or turn on **Warm the cache at startup**. RGA Search raises `rga`'s cache size limit so very large books are cached too; by default `rga` re-extracts any document whose text compresses to more than 2 MB on every search.
- **Damaged files don't stop a search.** A file `rga` can't read (a damaged PDF, an EPUB pandoc rejects) is skipped, and the search box names it.
- **Notes are left to Obsidian.** By default only `*.pdf` and `*.epub` files are searched, because Obsidian's own search already covers Markdown.

## Install

1. Install ripgrep-all and the PDF text extractor:
   - macOS: `brew install ripgrep-all poppler` (add `pandoc` for EPUB and Office files)
   - Linux: `rga` from its [releases](https://github.com/phiresky/ripgrep-all/releases) or your package manager, plus `ripgrep` and `poppler-utils`
   - Windows: `scoop install rga` or a release from GitHub, plus poppler
2. Install RGA Search (from Community plugins once it's listed; until then, see [Building](#building)).
3. Open **Settings → RGA Search**. The status line should show the `rga` version. If `rga` isn't found, enter its full path (for example `/opt/homebrew/bin/rga`).

Obsidian started from the Dock or Finder doesn't see your shell's `PATH`. RGA Search adds the usual Homebrew, Cargo and Scoop folders itself, so this normally just works.

## Use

| Command | What it does |
|---|---|
| **Search inside documents** | Opens the search box (also on the ribbon). Starts with the selected text, if any. |
| **Search inside documents for the selection** | Same, from the editor. |
| **Warm the cache** | Extracts any new documents now, so later searches are fast. |

In the search box: **Enter** opens the document at the matching page, **Cmd/Ctrl+Enter** opens it in a new tab, and **Shift+Enter** opens the note that links to it.

Lowercase queries ignore case; a query with a capital letter matches case exactly (ripgrep's "smart case"). Turn on **Regular expressions** in settings to use ripgrep's regex syntax.

## Settings

- **Folders**: where to search, for example `archive/zotero`. Empty searches the whole vault.
- **File types**: glob patterns, matched ignoring case (`*.pdf` also finds `Scan.PDF`). Add `*.docx`, `*.odt` or `*.zip` to search those too.
- **Maximum results** and **Matches per file**: keep the list short on common words.
- **Reference notes**: the properties that link a note to its document (`pdf` and `attachments` by default), and the title and citekey properties to show. With **Use Stacks' properties** on, RGA Search reads Stacks' own field mapping first, so renamed properties still work, and falls back to these names for notes written before a rename. Links can be wikilinks or Markdown links (`[Smith](Smith%20(2020).pdf "Title")`).

## Working with Stacks

[Stacks](https://github.com/jag3773/obsidian-stacks) files each PDF in your vault and links it from its reference note's `pdf` property. RGA Search uses that link to show the reference's title and citekey on each result, and Shift+Enter jumps from a hit on page 47 straight to the reference note. RGA Search doesn't need Stacks; any note that links to a document through a property works the same way.

## Compared with Omnisearch

[Omnisearch](https://github.com/scambier/obsidian-omnisearch) is a search engine for your notes, and it can include PDFs through a text-extraction plugin. RGA Search does one narrower job: exact phrase and regex search inside documents, with page numbers, using a command-line tool you already trust. The two can be used side by side, Omnisearch for notes and RGA Search for the library.

## Limits

- **Scanned PDFs** with no text layer have nothing to search. Add a text layer first, for example with [OCRmyPDF](https://ocrmypdf.readthedocs.io).
- **Pages** are known for PDFs only. EPUB and Office results open the file.
- **Desktop only**: mobile apps can't run other programs.

## Building

```sh
npm install
npm run build                        # main.js
npm run deploy -- "/path/to/vault"   # copy main.js, manifest.json and styles.css into the vault's plugin folder
```

## Development

| Command | What it runs |
|---|---|
| `npm test` | Unit tests (`node:test`). The runner tests also use the real `rga` on a fixture PDF when it's installed. |
| `npm run lint` | ESLint with the Obsidian community rules |
| `npm run lint:scanner` | ESLint the way the community directory scans a release |
| `npm run test:e2e` | End-to-end tests in real Obsidian; see [test/e2e/README.md](test/e2e/README.md) |

CI runs lint, unit tests, build and the scanner lint on every push and pull request, and the e2e suite in real Obsidian (minAppVersion and latest). Merging a version bump to `main` (`manifest.json`, `package.json` and `versions.json`) publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`, with build provenance attested.

## License

[MIT](LICENSE). ripgrep-all, ripgrep, poppler and pandoc are separate programs under their own licences; RGA Search runs them but doesn't include them.
