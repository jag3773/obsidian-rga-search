# End-to-end tests

These tests run RGA Search inside real Obsidian desktop, using [WebdriverIO](https://webdriver.io) and [wdio-obsidian-service](https://jesse-r-s-hines.github.io/wdio-obsidian-service/wdio-obsidian-service/README.html). The unit tests (`npm test`) stay the fast check; these cover what they can't: the search box, Obsidian's PDF viewer, and finding reference notes through the metadata cache.

They run the real `rga`, so install it (and `pdftotext`) first.

## Running them

```sh
npm run build        # the tests load the built main.js
npm run test:e2e     # Obsidian minAppVersion and latest
OBSIDIAN_VERSIONS="latest/latest" npm run test:e2e   # just the latest
```

The first run downloads Obsidian into `.obsidian-cache/` (ignored by git). On Linux without a display, run under `xvfb-run -a`.

## Layout

| Path | What it holds |
|---|---|
| `wdio.conf.mts` | The runs: one per Obsidian version |
| `vaults/library/` | The fixture vault: a three-page PDF in `archive/zotero/`, a reference note linking it through `pdf`, and a note that mentions the search term (which must not be found). Each run works on a copy |
| `specs/` | The specs |
