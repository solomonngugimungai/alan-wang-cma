# Alan Wang CMA

A one-file Comparative Market Analysis generator for Alan Wang Realty (KW Elevate). Paste in the text from any MLSListings PDF, review and filter the comps, generate a print-ready CMA report. No install, no server, no API keys.

**Live:** https://solomonngugimungai.github.io/alan-wang-cma/

## How to use it

1. On MLSListings, open the CMA report for a property.
2. Select all text in the PDF (`⌘A`) and copy (`⌘C`).
3. Paste into the textarea, fill in agent / pricing fields, click **Review & Filter Comps**.
4. Toggle which comps to include, optionally auto-detect school zones, click **Generate Report**.
5. Print or save to PDF from your browser.

## How it works

- **Paste-text input** dodges PDF parsing and OCR entirely — the comp data already lives in the PDF's text layer.
- **Comp scoring** rates each comp 0–100 on bed/bath/sqft proximity to the subject, with DOM and school-zone bonuses.
- **Census Geocoder API** auto-detects school district for the subject and each comp (free, no key, CORS-friendly with JSONP fallback).
- **Browser print → PDF** produces the deliverable. No PDF library, no server-side render.

Open `index.html` from Finder, or visit the live URL.

## Development

```
.
├── index.html            structure + styles + onclick wiring
├── cma.js                parser, scorer, renderers, downloader
├── tests.html            browser-based test suite
├── CHANGELOG.md
└── .github/workflows/
    └── validate.yml      CI: structural checks + headless test run
```

**Run tests locally:** open `tests.html` in any browser. Green block at the bottom = all passing.

**Run tests in CI:** every push to `main` and every PR triggers `.github/workflows/validate.yml`, which:
1. Checks core functions are present in `cma.js` and that `index.html` references it.
2. Boots a headless Chromium via Playwright, loads `tests.html`, reads the result counter, fails the build if any test failed.

**Comp scoring weights** (per TJ Hufanga, max 100):

| Dimension          | Max |
|--------------------|-----|
| School zone match  | 25  |
| SqFt variance      | 25  |
| Beds match         | 25  |
| Baths match        | 20  |
| DOM                | 5   |

See `scoreComp()` in `cma.js` for the partial-credit tiers (within 10% / 20% / 30%, ±1 bed, etc.).

**Version**: shown next to the title on the start screen. Bump `VERSION` in `cma.js` and add a `CHANGELOG.md` entry when shipping notable changes.
