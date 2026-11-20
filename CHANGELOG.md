# Changelog

Each release's notes on GitHub start with its section here.

## 0.2.0

### Search PowerPoint, Excel and Keynote files

Two new settings, both off until you turn them on:

- **PowerPoint and Excel** (`.pptx`, `.xlsx`): read with pandoc 3.8.3 or later (`brew install pandoc`).
- **Keynote** (`.key`, macOS only): text comes from Spotlight, which is built into macOS. It's fast (about a minute for 200 decks the first time), but has no slide numbers.
  - Turn on **Read Keynote decks with Keynote** to export each deck to PDF with Keynote instead. Results then show slide numbers, but Keynote opens while new decks are read, about 15–20 seconds each.
  - macOS asks once to let Obsidian control Keynote.

Their text is cached alongside your PDFs', so there's still one place to search. Results for these types open in their default app. Your own rga configuration and custom adapters are kept.

### Phrases across line breaks

- A phrase is found even where the PDF breaks it across lines or pages. Searching "wasted an interview" now finds it when "interview" starts the next line, and the result opens at the page where it starts.
- A word hyphenated at a line break is found too: `interview` matches "inter-" / "view", whether the PDF uses a hyphen, a Unicode hyphen or a soft hyphen.
- Straight quotes match curly ones, so `it's` finds `it’s`.
- Lowercase queries ignore case; a query with a capital letter matches case exactly.
- Matches on consecutive lines each get their own row and page.

## 0.1.1

- **Large books are cached.** rga only caches text that compresses to 2 MB or less, so large books were extracted again on every search. Searches over a library of about 950 PDFs went from 65 seconds to 1–2 seconds.
- **Stacks:** notes written before a Stacks property rename keep their links.
- **Unreadable files:** a file rga can't read is reported, and no longer hides other matches.
- **File types:** matched ignoring case, so `*.pdf` finds `Scan.PDF`.
- **Markdown links:** links in properties with parentheses, angle brackets or titles resolve correctly.
- **Stopping searches:** on Windows, stopping a search ends all of rga's processes. A cache warm-up stops when the plugin is disabled.

## 0.1.0

The first release. It runs ripgrep-all over chosen folders and shows each matching line with its PDF page.

- **Opening results:** Enter opens the PDF at that page. Shift+Enter opens the note that links to it, such as a Stacks reference note.
- **Warm the cache:** a command, and an optional run at startup, that reads new documents ahead of your first search.
