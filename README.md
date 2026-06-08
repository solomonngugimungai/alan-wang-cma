# CMA Processor

Generates Comparative Market Analyses for Alan Wang Realty from MLS export CSVs.

## Quickstart

```bash
pip install -r requirements.txt
python cma_processor.py --input sample_comps.csv
open CMA_report.html
```

Want a PDF too? `pip install playwright && playwright install chromium`, then add `--pdf`.

## For day-to-day use

See [HANDOFF.md](HANDOFF.md).

## Project structure

- `cma_processor.py` — the script (parsing, analysis, render).
- `config.yaml` — all knobs (subject property, branding, adjustment $$, MLS column aliases).
- `template.html` — the report template (HTML/CSS, prints to Letter).
- `sample_comps.csv` — sample data so you can run the tool immediately.
- `HANDOFF.md` — workflow doc for the team.
