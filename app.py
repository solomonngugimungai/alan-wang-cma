"""
CMA Generator — web UI for the CMA processor.

Run locally:
    streamlit run app.py

Deploys for free at share.streamlit.io once this repo is on GitHub.
"""

import datetime as dt
from pathlib import Path

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components

import cma_processor as cma
import extractors

HERE = Path(__file__).parent
DEFAULTS = cma.load_config(HERE / "config.yaml")

st.set_page_config(
    page_title="CMA Generator — Alan Wang Realty",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Sidebar: set-once settings ────────────────────────────────────────────
with st.sidebar:
    st.subheader("Branding")
    firm = st.text_input("Firm", value=DEFAULTS["branding"]["firm"])
    office = st.text_input("Office", value=DEFAULTS["branding"]["office"])
    prepared_by = st.text_input("Prepared by", value=DEFAULTS["branding"]["prepared_by"])

    st.divider()
    st.subheader("Adjustment values")
    a_def = DEFAULTS["adjustments"]
    dpsf = st.number_input("$ per sqft", value=int(a_def["dollars_per_sqft"]), step=25)
    dpb = st.number_input("$ per bedroom", value=int(a_def["dollars_per_bed"]), step=5000)
    dpba = st.number_input("$ per bathroom", value=int(a_def["dollars_per_bath"]), step=5000)
    drift = st.number_input("Monthly market drift (%)",
                            value=float(a_def["monthly_market_drift_pct"]), step=0.1)
    sc_weight = st.number_input("Same-complex weight (×)",
                                value=float(a_def["same_complex_weight"]), step=0.5)

    st.divider()
    st.subheader("Pricing rules")
    p_def = DEFAULTS["pricing"]
    include_pending = st.checkbox("Include pending comps in value",
                                  value=p_def["include_pending_in_value"])
    round_to = st.number_input("Round to nearest $",
                               value=int(p_def["round_to"]), step=1000)

# ── Main ──────────────────────────────────────────────────────────────────
st.title("CMA Generator")
st.caption("Upload a proMLS comp export, fill in the subject property, get a print-ready CMA.")

st.subheader("1. Comps")
uploaded = st.file_uploader(
    "CSV, Excel, PDF, or images. Upload multiple files and they'll be combined.",
    type=["csv", "xlsx", "xls", "pdf", "png", "jpg", "jpeg", "webp"],
    accept_multiple_files=True,
)
st.caption(
    "CSV / Excel parse instantly. PDFs and images use Claude vision "
    "(needs `ANTHROPIC_API_KEY` set in your environment)."
)

st.subheader("2. Subject property")
s_def = DEFAULTS["subject"]
col_left, col_right = st.columns(2)
with col_left:
    address = st.text_input("Address", value=s_def["address"])
    city_type = st.text_input("City · property type", value=s_def["city_type"])
    subdivision = st.text_input(
        "Subdivision (used to flag same-complex comps; leave blank to disable)",
        value=DEFAULTS.get("subject_subdivision", "") or "",
    )
with col_right:
    g1, g2 = st.columns(2)
    with g1:
        beds = st.number_input("Beds", value=float(s_def["beds"]), step=1.0)
        sqft = st.number_input("Square feet", value=int(s_def["sqft"]), step=10)
        hoa = st.number_input("HOA $/month", value=int(s_def["hoa_monthly"]), step=25)
    with g2:
        baths = st.number_input("Baths", value=float(s_def["baths"]), step=0.5)
        year_built = st.number_input("Year built", value=int(s_def["year_built"]), step=1)
        parking = st.text_input("Parking", value=s_def["parking"])

st.write("")
go = st.button("Generate CMA", type="primary",
               use_container_width=True, disabled=not uploaded)

# ── Action ────────────────────────────────────────────────────────────────
if go and uploaded:
    cfg = {
        "subject": {
            "address": address, "city_type": city_type,
            "beds": beds, "baths": baths, "sqft": sqft,
            "year_built": int(year_built),
            "hoa_monthly": int(hoa), "parking": parking,
        },
        "subject_subdivision": subdivision,
        "branding": {"firm": firm, "office": office, "prepared_by": prepared_by},
        "adjustments": {
            "dollars_per_sqft": dpsf,
            "dollars_per_bed": dpb,
            "dollars_per_bath": dpba,
            "monthly_market_drift_pct": drift,
            "same_complex_weight": sc_weight,
            "default_weight": 1.0,
        },
        "pricing": {
            "include_pending_in_value": include_pending,
            "round_to": round_to,
        },
        "columns": DEFAULTS["columns"],
        "status_map": DEFAULTS["status_map"],
    }

    dfs = []
    with st.spinner(f"Extracting comps from {len(uploaded)} file(s)…"):
        for f in uploaded:
            try:
                dfs.append(extractors.file_to_df(f))
            except extractors.ExtractionError as e:
                st.error(f"**{f.name}** — {e}")
                st.stop()
            except Exception as e:
                st.error(f"**{f.name}** — unexpected error: {e}")
                st.stop()

    combined_df = pd.concat(dfs, ignore_index=True)

    try:
        comps = cma.parse_comps_df(combined_df, cfg)
        result = cma.analyze(comps, cfg)
    except cma.CMAError as e:
        st.error(str(e))
        st.stop()
    except Exception as e:
        st.error(f"Could not analyze comps: {e}")
        st.stop()

    html = cma.render(result, cfg, HERE / "template.html")

    st.success(
        f"Generated from {len(result['valued'])} value-driving comps "
        f"(of {len(comps)} total, across {len(uploaded)} uploaded file(s))."
    )

    m1, m2, m3 = st.columns(3)
    m1.metric("Recommended list price", cma._money(result["rec"]))
    m2.metric("Supported range",
              f"{cma._money_m(result['range_low'])} – {cma._money_m(result['range_high'])}")
    m3.metric("Avg $/SF (closed)",
              cma._money(result["avg_ppsf"]) if result["avg_ppsf"] else "—")

    safe_addr = "".join(ch if ch.isalnum() else "_" for ch in address).strip("_")
    download_name = f"CMA_{safe_addr}_{dt.date.today().isoformat()}.html"
    st.download_button(
        "Download report (HTML)",
        data=html,
        file_name=download_name,
        mime="text/html",
        use_container_width=True,
    )

    st.subheader("Preview")
    components.html(html, height=1200, scrolling=True)
