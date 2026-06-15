# Changelog

## v1.5.0 — 2026-06-11

- **Quick-select toolbar** above the comp list with three bulk actions:
  - **Strong only (70+)** — checks every comp scored 70 or higher, unchecks the rest. The default workflow Alan asked for.
  - **All** — checks every comp.
  - **Clear** — unchecks every comp (reset to nothing).
- Selection updates are one-shot; further score changes (condition or zone edits) don't auto-reapply. Click the button again after re-rating to refresh.

## v1.4.0 — 2026-06-11

Pulled in features from the MLSListings "Residential Summary" reference Alan shared.

- **$/SqFt as a real column** on every comp row (computed from headline price / sqft).
- **List Price and Sale Price are now separate columns** — for sold comps that have both numbers in the source, both show; non-sold rows show `—` for sale. Parser was extended to capture the second `$` amount when present.
- **MLS# moved under the address** (mono, dim) to free up a column slot. "Sub Type" appended on the same sub-line when present.
- **Per-group listing count** appears next to the status label and inside the Average row.
- **New "Quick Statistics" box** at the bottom of the report — Min / Max / Median for List Price and Sale Price across all included comps (Alan's reference layout).
- Tests added for two-price parsing (sold-with-both vs. active-with-list-only) and the back-compat single-price case.

Not yet implemented (held back because the parser would be guessing without a real export to verify against):
- City column, Lot (SF), Age, COE as its own date. Paste a real MLSListings PDF export and we'll wire these up.

## v1.3.0 — 2026-06-11

- **Condition rating per comp** (Alan's request). Four tiers, each with a tooltip hint:
  - **High** — Move-in ready · kitchen + baths updated · current finishes
  - **Mid-High** — Updated kitchen or baths (not both) · mostly current
  - **Mid** — Mixed updates · some original finishes
  - **Low** — Dated throughout · needs renovation
- **Optional description per comp** (free-form, up to 200 chars) — surfaces directly under the address in the generated report.
- **Subject also gets a condition rating** (next to the school zone selector).
- **Scoring modifier**: ±5 layered on top of TJ's 100, clamped to `[0, 100]`. Exact match = +5, 1 tier off = 0 (no flag), 2 tiers = −3, 3 tiers (e.g. High↔Low) = −5.
- **Review-screen summary** now also surfaces how many included comps lack a condition rating, so agents don't ship a CMA half-rated.
- Tests added for every condition modifier branch.

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
