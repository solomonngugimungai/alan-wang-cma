# Changelog

## v2.0.0 — 2026-06-11

**Major shift** — moves from "comparability scoring + manual price entry" to **dollar-adjusted recommended price + supported range**, matching how Alan actually hand-prices. The 0–100 match score stays as a filter heuristic; the headline output is now the algorithmic recommendation.

### Per-comp adjustments (Pass 1)

- **Condition rebuilt** as a 3-tier system: **Move-in ready / Medium / Poor** (default Medium). Per Alan's logic, condition is a **dollar adjustment** based on remodel-cost remaining (kitchen + baths drive it). A comp in worse condition than the subject is adjusted **up** by the difference; a comp in better condition is adjusted **down**.
- **Across-divider flag** per comp (El Camino, Willow, tracks, downtown edge). Controlled by editable setting: default mode is **exclude**; alternative is **down-weight** by an editable factor.
- **Location haircut %** per comp (e.g. `-15` for tracks-adjacent). Applied to the base price before condition adjustment. Blank = 0.
- **Recency weighting**: comps older than the (editable) window are multiplied by an (editable) factor. Default window 6 months, default factor 0.5.

### Summary-level intelligence (Pass 2)

- **Lot-size mismatch flag** when a comp's lot differs from the subject's by more than an editable threshold (default 30%). Warning only — never excludes. Skipped when lot is unknown (condos).
- **Status-aware market read**: counts Expired / Cancelled / Withdrawn against Sold and labels the market **Soft / Balanced / Strong**. Threshold ratio editable.
- **Zillow reference field** per comp — surfaced in the report **as reference only**, with a clear tag. Never used in any pricing calculation.
- **Data-quality warnings** at the bottom of the review and at the top of the report: fires when fewer than 3 value comps are used, or when the adjusted range spread exceeds 25% of the recommended price ("tighten comp selection"). Both thresholds editable.
- **Realist-profile note** added to the subject card, calling out that characteristics should come from the official record, not a prior listing.

### Computed output

- **Recommended Price** = weighted average of adjusted value comps (Sold + Pending/Contingent only). Pending comps are valued off list price (no sale price exists yet).
- **Supported Range** = min / max of those adjusted values.
- Both are computed live on every change and surfaced in the review panel and the printed report (alongside the agent's optional "Suggested List Price" override).

### Settings

A new gear icon on the subject card opens a settings modal. Everything below is editable and persisted to localStorage (per-browser):

| Setting | Default |
|---|---|
| Condition · Poor → Move-in ($) | 80,000 |
| Condition · Medium → Move-in ($) | 25,000 |
| Divider mode | exclude |
| Divider down-weight factor | 0.5 |
| Recency window (months) | 6 |
| Recency factor (older than window) | 0.5 |
| Lot mismatch threshold | 30% |
| Soft market threshold | 0.5 |
| Data-quality min value comps | 3 |
| Data-quality range spread | 25% |

### Breaking

- The old 4-tier High / Mid-High / Mid / Low condition rubric is gone; existing reports won't carry the old labels. Re-rate on the new 3-tier system.
- Condition is no longer a ±5 score modifier — score is now purely the comparability heuristic.

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
