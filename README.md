# CMA Processor

Generates Comparative Market Analyses for Alan Wang Realty from MLS export CSVs.

## Two ways to run it

### Web app (recommended for the team)

```bash
pip install -r requirements.txt
python -m streamlit run app.py
```

Opens [http://localhost:8501](http://localhost:8501) in your browser.
Drag comps in (CSV, Excel, PDF, or images — multiple files combine), fill the subject property form, click **Generate CMA**, download the report.

PDFs and images use Claude vision to extract the comp data — set `ANTHROPIC_API_KEY` to enable. CSV and Excel work without any API key.

### Command line (for scripting / power users)

```bash
python cma_processor.py --input comps.csv
open CMA_report.html
```

Want a PDF too? `pip install playwright && playwright install chromium`, then add `--pdf`.

## Deploying the web app (free, public URL)

Once this repo is on GitHub:

1. Sign in at [share.streamlit.io](https://share.streamlit.io) with your GitHub account.
2. **New app** → pick this repo → branch `main` → main file `app.py` → **Deploy**.
3. Wait ~2 minutes. You'll get a public URL like `https://alan-wang-cma.streamlit.app`.

Anyone with that URL can use it — no install required.

## For day-to-day use

See [HANDOFF.md](HANDOFF.md).

## Project structure

- `app.py` — Streamlit web UI (drag-drop + form).
- `cma_processor.py` — analysis + render (also runnable as a CLI).
- `config.yaml` — defaults loaded by the app (branding, adjustment $$, MLS column aliases, status map).
- `template.html` — the report design (HTML/CSS, prints to Letter).
- `sample_comps.csv` — sample data so you can test immediately.
- `HANDOFF.md` — workflow doc for the team.
