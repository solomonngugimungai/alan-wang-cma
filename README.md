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

Single file. Open `index.html` from Finder or visit the live URL.
