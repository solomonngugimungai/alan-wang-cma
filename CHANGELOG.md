# Changelog

## v1.2.0 — 2026-06-11

- **Scoring weights updated per TJ Hufanga** (total = 100):
  - School zone match · **25**
  - SqFt variance · **25**
  - Beds match · **25**
  - Baths match · **20**
  - DOM · **5**
- **Download HTML** button on the report screen produces a standalone, emailable file with all styles inlined — no `Print → PDF` ceremony if the recipient just wants to view it in a browser.
- **Modular code**: all JS extracted from `index.html` into `cma.js`. `index.html` now references it via `<script src="cma.js">`.
- **Test suite** in `tests.html` — open in a browser, see pass/fail for the parser, scorer, formatters, and URL helpers.
- **CI** via GitHub Actions runs structural checks and executes `tests.html` headlessly with Playwright on every push and PR to `main`.

## v1.1.0 — 2026-06-10

- Every comp's address is now a clickable link to Zillow, with a small `RF` pill beside it for Redfin.
- Survives Print → PDF as clickable links inside the saved file.

## v1.0.0 — 2026-06-09

- Initial release. Single-file static HTML app:
  - Paste-text input from MLSListings PDFs (no upload, no OCR).
  - Three-screen flow: paste → review & filter comps with 0–100 scoring → generated report.
  - School-zone auto-detect via the Census Geocoder API (free, no key, CORS-friendly with JSONP fallback).
  - Keller Williams palette: charcoal/black primary, KW brand red accent, print-ready Letter layout.
