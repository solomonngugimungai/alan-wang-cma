#!/usr/bin/env python3
"""
CMA PROCESSOR
=============
Turns a manually-exported MLS comp file into a finished, Alan-approved
Comparative Market Analysis report.

COMPLIANCE NOTE (read this):
  This tool NEVER touches the MLS directly. A human exports comps from
  proMLS using the MLS's own "export" button (a sanctioned use), and this
  tool processes that file. Do NOT add code that logs into or scrapes the
  MLS without explicit written permission from the brokerage / MLS, or a
  sanctioned RESO Web API / RETS feed. See HANDOFF.md.

USAGE:
  python cma_processor.py --input comps.csv
  python cma_processor.py --input comps.csv --pdf   (also render a PDF)

Everything you'd normally change lives in config.yaml, not here.
"""

import argparse
import datetime as dt
import re
import statistics
import sys
from pathlib import Path

try:
    import pandas as pd
    import yaml
except ImportError:
    sys.exit("Missing dependencies. Run:  pip install -r requirements.txt")


class CMAError(Exception):
    """Raised when the analysis cannot produce a defensible result."""


# ───────────────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────────────────────────────
def _norm(s):
    """Normalize for fuzzy, case/space/underscore-insensitive matching."""
    return re.sub(r"[\s_]+", "", str(s).strip().lower())


def _money(x):
    return f"${x:,.0f}" if x is not None else "—"


def _money_m(x):
    """$1,395,000 → '$1.395M'; $1,250,000 → '$1.25M'; $2,000,000 → '$2M'."""
    if x is None:
        return "—"
    s = f"{x/1_000_000:.3f}".rstrip("0").rstrip(".")
    return f"${s}M"


def find_column(df, aliases):
    """Return the actual df column matching any alias, else None."""
    norm_map = {_norm(c): c for c in df.columns}
    for a in aliases:
        if _norm(a) in norm_map:
            return norm_map[_norm(a)]
    return None


def to_number(val):
    """Parse '$1,234,000', '1,480 sqft', '3.0' etc. into a float, or None."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    s = re.sub(r"[^0-9.\-]", "", str(val))
    if s in ("", "-", "."):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_date(val):
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        return pd.to_datetime(val).date()
    except Exception:
        return None


def classify_status(raw, status_map):
    n = _norm(raw)
    for canonical, variants in status_map.items():
        if any(_norm(v) == n for v in variants):
            return canonical
    for canonical, variants in status_map.items():
        if any(_norm(v) in n for v in variants):
            return canonical
    return "active"  # safest default: treat unknown as competition, not value


def weighted_median(values, weights):
    """More defensible than weighted mean — a single outlier can't drag the result."""
    pairs = sorted(zip(values, weights))
    total = sum(weights)
    running = 0.0
    for v, w in pairs:
        running += w
        if running >= total / 2:
            return v
    return pairs[-1][0]


# ───────────────────────────────────────────────────────────────────────────
# Core CMA logic
# ───────────────────────────────────────────────────────────────────────────
def load_config(path):
    with open(path) as f:
        return yaml.safe_load(f)


def read_comps(input_path, cfg):
    df = pd.read_csv(input_path)
    cols = cfg["columns"]
    resolved = {field: find_column(df, aliases) for field, aliases in cols.items()}

    required = ("address", "status", "beds", "baths", "sqft", "sale_price")
    missing = [f for f in required if resolved.get(f) is None]
    if missing:
        print("WARNING: could not find columns for:", ", ".join(missing))
        print("Found headers:", list(df.columns))
        print("Add the real header names to config.yaml under 'columns:' and re-run.")

    subj_sub = _norm(cfg.get("subject_subdivision", "") or "")
    comps = []
    for _, row in df.iterrows():
        def g(field):
            c = resolved.get(field)
            return row[c] if c and c in row else None

        status = classify_status(g("status"), cfg["status_map"])
        sale = to_number(g("sale_price"))
        list_p = to_number(g("list_price"))

        # Pending listings often have no recorded sale price yet — fall back to list.
        if status == "pending" and sale is None and list_p is not None:
            sale = list_p

        # Same-complex: explicit flag column wins; otherwise match the subject's
        # subdivision against the comp's subdivision or address.
        same_complex = False
        flag = g("same_complex_flag")
        if flag is not None and str(flag).strip().lower() in ("y", "yes", "true", "1"):
            same_complex = True
        elif subj_sub:
            subdiv = g("subdivision")
            addr = g("address")
            hay = _norm(f"{subdiv or ''} {addr or ''}")
            if subj_sub in hay:
                same_complex = True

        comps.append({
            "address": str(g("address") or "Unknown"),
            "status": status,
            "beds": to_number(g("beds")),
            "baths": to_number(g("baths")),
            "sqft": to_number(g("sqft")),
            "sale_price": sale,
            "list_price": list_p,
            "dom": to_number(g("dom")),
            "close_date": to_date(g("close_date")),
            "same_complex": same_complex,
        })
    return comps


def adjust_comp(comp, subj, adj, today):
    """
    Return (net_adjustment, adjusted_value).
    Direction: comp SUPERIOR to subject -> subtract; INFERIOR -> add.
    Time adjustment nudges earlier closings up in a rising market.
    """
    if comp["sale_price"] is None:
        return None, None
    net = 0.0
    if comp["sqft"] is not None:
        net += (subj["sqft"] - comp["sqft"]) * adj["dollars_per_sqft"]
    if comp["beds"] is not None:
        net += (subj["beds"] - comp["beds"]) * adj["dollars_per_bed"]
    if comp["baths"] is not None:
        net += (subj["baths"] - comp["baths"]) * adj["dollars_per_bath"]
    drift = adj.get("monthly_market_drift_pct", 0) or 0
    if drift and comp["close_date"]:
        months_old = (today - comp["close_date"]).days / 30.4375
        if months_old > 0:
            net += comp["sale_price"] * (drift / 100.0) * months_old
    return net, comp["sale_price"] + net


def _range_band(vals):
    """Middle-50% (IQR) band when we have enough comps, else min-max."""
    if len(vals) >= 4:
        q = statistics.quantiles(sorted(vals), n=4)
        return q[0], q[2]
    return min(vals), max(vals)


def analyze(comps, cfg):
    subj = cfg["subject"]
    adj = cfg["adjustments"]
    today = dt.date.today()
    include_pending = cfg["pricing"]["include_pending_in_value"]

    valued = []
    for c in comps:
        c["net_adj"], c["adjusted"] = adjust_comp(c, subj, adj, today)
        c["ppsf"] = (c["sale_price"] / c["sqft"]) if (c["sale_price"] and c["sqft"]) else None
        c["s2l"] = (c["sale_price"] / c["list_price"]) if (c["sale_price"] and c["list_price"]) else None
        if c["status"] == "sold" or (include_pending and c["status"] == "pending"):
            if c["adjusted"] is not None:
                valued.append(c)

    if not valued:
        raise CMAError(
            "No closed/pending comps with prices found — cannot compute a value. "
            "Check the CSV's Status column and config.yaml's status_map."
        )

    weights = [adj["same_complex_weight"] if c["same_complex"] else adj["default_weight"]
               for c in valued]
    vals = [c["adjusted"] for c in valued]

    rec = weighted_median(vals, weights)
    round_to = cfg["pricing"]["round_to"]
    rec = round(rec / round_to) * round_to

    sold = [c for c in comps if c["status"] == "sold"]
    sold_ppsf = [c["ppsf"] for c in sold if c["ppsf"]]
    doms = [c["dom"] for c in valued if c["dom"] is not None]
    s2ls = [c["s2l"] for c in valued if c["s2l"] is not None]
    actives = [c for c in comps if c["status"] == "active"]

    lo, hi = _range_band(vals)

    return {
        "comps": comps,
        "valued": valued,
        "rec": rec,
        "range_low": lo,
        "range_high": hi,
        "avg_ppsf": statistics.mean(sold_ppsf) if sold_ppsf else None,
        "median_dom": statistics.median(doms) if doms else None,
        "avg_s2l": statistics.mean(s2ls) if s2ls else None,
        "actives": actives,
        "n_sold": len(sold),
    }


def draft_narrative(a, cfg):
    """Deterministic, defensible pricing rationale. No API key required.
    (For AI-written version see draft_narrative_ai() and HANDOFF.md.)"""
    rec = _money(a["rec"])
    lo, hi = _money_m(a["range_low"]), _money_m(a["range_high"])
    parts = [
        f"Adjusted comparable sales cluster between {lo} and {hi}, with same-complex "
        f"sales weighted as the strongest anchor."
    ]
    high_actives = [c for c in a["actives"]
                    if c["list_price"] and c["list_price"] > a["range_high"]]
    stale = [c for c in high_actives if c["dom"] and c["dom"] >= 21]
    if stale:
        worst = max(stale, key=lambda c: c["dom"])
        extra = f" (plus {len(stale) - 1} similar)" if len(stale) > 1 else ""
        parts.append(
            f"The competing active at {_money(worst['list_price'])} has sat {int(worst['dom'])} "
            f"days{extra} — that ceiling is testing the market and stalling."
        )
    if a["avg_s2l"]:
        pct = a["avg_s2l"] * 100
        if pct >= 100:
            parts.append(
                f"Comparable sales are closing at {pct:.0f}% of list, signalling a strong "
                f"seller's market that supports pricing at the upper end of the range."
            )
        else:
            parts.append(
                f"Comparable sales are closing at {pct:.0f}% of list, so pricing realistically "
                f"within the supported range will drive a cleaner, faster sale."
            )
    if a["median_dom"] is not None:
        parts.append(
            f"With a median {int(a['median_dom'])} days on market in this segment, a list at "
            f"{rec} positions inside the supported range and reflects current absorption."
        )
    else:
        parts.append(f"A list at {rec} positions squarely within the supported range.")
    return " ".join(parts)


# ───────────────────────────────────────────────────────────────────────────
# Render
# ───────────────────────────────────────────────────────────────────────────
def comp_row_html(c):
    pill = {"sold": ("sold", "Sold"), "active": ("active", "Active"),
            "pending": ("pend", "Pending")}[c["status"]]
    sub = "Same complex" if c["same_complex"] else ""
    beds = f"{c['beds']:g}" if c["beds"] is not None else "?"
    baths = f"{c['baths']:g}" if c["baths"] is not None else "?"
    sqft = f"{c['sqft']:,.0f}" if c["sqft"] is not None else "—"
    ppsf = f"${c['ppsf']:,.0f}" if c["ppsf"] else "—"
    dom = f"{c['dom']:.0f}" if c["dom"] is not None else "—"
    price = _money(c["sale_price"] or c["list_price"])
    if c["status"] == "active":
        net, adjv = "—", "competition"
    else:
        net = (f'<span class="adj-pos">+{_money(c["net_adj"])}</span>'
               if (c["net_adj"] or 0) >= 0
               else f'<span class="adj-neg">−{_money(abs(c["net_adj"]))}</span>')
        adjv = _money(c["adjusted"])
    return f"""<tr>
      <td><div class="addr-cell"><b>{c['address']}</b><span>{sub}</span></div></td>
      <td><span class="pill {pill[0]}">{pill[1]}</span></td>
      <td class="num">{beds} / {baths}</td><td class="num">{sqft}</td>
      <td class="num">{ppsf}</td><td class="num">{dom}</td>
      <td class="num">{price}</td><td class="num">{net}</td><td class="num">{adjv}</td>
    </tr>"""


def render(a, cfg, template_path):
    subj, brand = cfg["subject"], cfg["branding"]
    html = Path(template_path).read_text()

    if a["avg_s2l"]:
        third = ("Avg Sale-to-List", f"{a['avg_s2l']*100:.0f}%",
                 "Across closed comps")
    else:
        third = ("Median Days on Market",
                 f"{int(a['median_dom'])}" if a["median_dom"] is not None else "—",
                 "Comparable segment")

    ppsf_note = (f"× {subj['sqft']:,} sf ≈ {_money(a['avg_ppsf']*subj['sqft'])}"
                 if a["avg_ppsf"] else "insufficient data")
    spread = a["range_high"] - a["range_low"]
    range_note = ("Tight cluster — high confidence" if spread < 0.04 * a["rec"]
                  else "Wider spread — review comps")

    rows = "\n".join(comp_row_html(c) for c in a["comps"])

    today = dt.date.today()
    date_str = f"{today.strftime('%B')} {today.day}, {today.year}"

    repl = {
        "FIRM": brand["firm"], "OFFICE": brand["office"], "PREP_NAME": brand["prepared_by"],
        "DATE": date_str,
        "SUBJECT_ADDR": subj["address"], "SUBJECT_CITY_TYPE": subj["city_type"],
        "BEDS": f"{subj['beds']:g}", "BATHS": f"{subj['baths']:g}",
        "SQFT": f"{subj['sqft']:,}", "YEAR": str(subj["year_built"]),
        "HOA": str(subj["hoa_monthly"]), "PARKING": subj["parking"],
        "RANGE_LOW": _money_m(a["range_low"]), "RANGE_HIGH": _money_m(a["range_high"]),
        "REC_PRICE": _money(a["rec"]),
        "COMP_COUNT": str(len(a["comps"])), "COMP_ROWS": rows,
        "ADJ_RANGE": f"{_money_m(a['range_low'])}–{_money_m(a['range_high'])}",
        "ADJ_RANGE_NOTE": range_note,
        "AVG_PPSF": _money(a["avg_ppsf"]) if a["avg_ppsf"] else "—",
        "PPSF_CALC": ppsf_note,
        "THIRD_METRIC_LABEL": third[0], "THIRD_METRIC_VALUE": third[1],
        "THIRD_METRIC_NOTE": third[2],
        "NARRATIVE": draft_narrative(a, cfg),
        "DISCLAIMER": "Estimate of value based on available comparable data; not an appraisal.",
    }
    for k, v in repl.items():
        html = html.replace("{{" + k + "}}", str(v))
    return html


def draft_narrative_ai(a, cfg):
    """Optional Claude-written narrative — see HANDOFF.md to enable."""
    raise NotImplementedError("Enable per HANDOFF.md if the team wants AI narratives.")


# ───────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Generate a CMA from an MLS export CSV.")
    ap.add_argument("--input", required=True, help="Path to the MLS export CSV")
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--template", default="template.html")
    ap.add_argument("--out", default="CMA_report.html")
    ap.add_argument("--pdf", action="store_true", help="Also render a PDF (needs playwright)")
    args = ap.parse_args()

    cfg = load_config(args.config)
    comps = read_comps(args.input, cfg)
    try:
        a = analyze(comps, cfg)
    except CMAError as e:
        sys.exit(f"ERROR: {e}")
    html = render(a, cfg, args.template)
    Path(args.out).write_text(html)
    print(f"✓ Report written: {args.out}")
    print(f"  Recommended list price: {_money(a['rec'])}")
    print(f"  Supported range: {_money(a['range_low'])} – {_money(a['range_high'])}")
    print(f"  Comps used for value: {len(a['valued'])} (of {len(comps)} total)")

    if args.pdf:
        try:
            from playwright.sync_api import sync_playwright
            pdf_path = str(Path(args.out).with_suffix(".pdf"))
            with sync_playwright() as p:
                b = p.chromium.launch()
                pg = b.new_page()
                pg.goto(Path(args.out).resolve().as_uri())
                pg.wait_for_timeout(1200)
                pg.pdf(path=pdf_path, format="Letter", print_background=True,
                       margin={"top": "0", "bottom": "0", "left": "0", "right": "0"})
                b.close()
            print(f"✓ PDF written: {pdf_path}")
        except Exception as e:
            print(f"(PDF skipped: {e}. Open the HTML and print to PDF instead.)")


if __name__ == "__main__":
    main()
