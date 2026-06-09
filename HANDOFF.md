# CMA Processor — Handoff Guide

This tool turns an MLS comp export into a finished CMA report.
The team's job is exporting the comps and filling in one block of config; everything else is automated.

## What it does

1. Reads a CSV the agent exports from proMLS.
2. Classifies each comp as sold / pending / active and parses its numbers.
3. Adjusts each comp toward the subject property (sqft, beds, baths, time-on-market drift).
4. Computes a defensible recommended price (weighted **median**, same-complex comps weighted heavier) and a supported range (IQR of adjusted values).
5. Writes a print-ready HTML report. Optional: PDF.

## Compliance — read this

This tool **does not log into the MLS, does not scrape, and does not call any MLS API**. The agent uses proMLS's own export button (a sanctioned action) and feeds the resulting CSV here.

If you ever want fully automated MLS pulls, that requires either:
- Written permission from the MLS to use a RESO Web API / RETS feed, or
- A licensed third-party data provider (Bridge, Trestle, etc.).

Do **not** modify this tool to "log in for me" or scrape. That violates MLS terms and exposes the brokerage to penalties up to and including loss of MLS access.

## One-time setup (per machine)

1. Install Python 3.10+ (`python3 --version` to check).
2. From this folder:
   ```
   pip install -r requirements.txt
   ```
3. (Optional, for PDF from the CLI): `pip install playwright && playwright install chromium`

## Daily workflow — web app (recommended)

```
python -m streamlit run app.py
```

Opens [http://localhost:8501](http://localhost:8501). Then per CMA:

1. **Export comps from proMLS** as CSV (use proMLS's own Export button).
2. **Drag the CSV** into the upload box.
3. **Fill in the subject property** (address, beds/baths/sqft, year, HOA, parking, subdivision).
4. Click **Generate CMA**. Review the preview, click **Download report**, hand to Alan.

Total time per CMA: ~1 minute after the export is in hand.

The sidebar exposes branding and adjustment values — change those if the market shifts (e.g. tune `$ per sqft`) or to use a different agent's name.

## Daily workflow — command line (power users)

1. Drop the proMLS export as `comps.csv` in this folder.
2. Edit `config.yaml` → `subject:` block.
3. Run:
   ```
   python cma_processor.py --input comps.csv
   ```
   Add `--pdf` to also generate a PDF.
4. Open `CMA_report.html`.

## Where to change what

| You want to change… | Where |
|---|---|
| Subject property details | Web app form (or `config.yaml` → `subject:`) |
| Firm / office / agent name | Web app sidebar (or `config.yaml` → `branding:`) |
| $/sqft, $/bed, $/bath adjustments | Web app sidebar (or `config.yaml` → `adjustments:`) |
| Market drift % per month | Web app sidebar (or `config.yaml` → `adjustments.monthly_market_drift_pct`) |
| Whether pending comps count toward value | Web app sidebar (or `config.yaml` → `pricing.include_pending_in_value`) |
| What MLS column names mean (if proMLS changes the export) | `config.yaml` → `columns:` |
| Visual design of the report | `template.html` |
| Pricing rationale wording | `cma_processor.py` → `draft_narrative()` |

The web app reads `config.yaml` for its initial values — anything changed in the sidebar is just for that session. To make a sidebar change permanent, edit `config.yaml`.

## Troubleshooting

- **"WARNING: could not find columns for…"** — proMLS's export uses a header name not listed in `config.yaml` → `columns:`. Open the CSV, find the actual header, add it to the alias list. Don't remove existing names.
- **"No closed/pending comps with prices found"** — the Status column has values not in `config.yaml` → `status_map:`. Add the new term under `sold`, `pending`, or `active`.
- **Recommended price seems off** — most often the `$/sqft` adjustment is wrong for the current market. Update `adjustments.dollars_per_sqft`. The market-drift setting also matters in fast-moving markets.
- **PDF generation fails** — install Chromium for playwright: `playwright install chromium`. Or just open the HTML and print to PDF via the browser.

## Optional: AI-written narrative

The default narrative is deterministic — it never invents numbers, so it's safe to ship.
To upgrade to a Claude-written narrative in Alan's voice:

1. `pip install anthropic`
2. Set the API key in your shell environment (do **not** commit it):
   ```
   export ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Implement `draft_narrative_ai()` in `cma_processor.py` (currently a stub). Feed it the `analyze()` result and have it return a short paragraph in Alan's voice. Then swap `draft_narrative(a, cfg)` for `draft_narrative_ai(a, cfg)` inside `render()`.

The deterministic version is the safe default — use AI only after the team has reviewed and approved the output style.

## If proMLS changes their export format

If column headers change, update the aliases in `config.yaml` (no Python edits). If the export format changes from CSV (e.g., to XLSX), the input parser needs updating — `read_comps()` is the place.
