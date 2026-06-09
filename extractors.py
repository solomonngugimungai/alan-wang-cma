"""
File → DataFrame extractors for the CMA app.

  CSV / Excel  → pandas directly (no API needed)
  PDF          → try pdfplumber's text-table extraction first, fall back to
                 Claude vision on rendered page images
  Image        → Claude vision (needs ANTHROPIC_API_KEY)

The output is always a pandas DataFrame whose columns will be matched against
config.yaml's `columns:` aliases by cma_processor.parse_comps_df.
"""

import base64
import io
import os

import pandas as pd


class ExtractionError(Exception):
    """Raised when a file can't be parsed into a comp DataFrame."""


VISION_MODEL = "claude-sonnet-4-6"

EXTRACTION_PROMPT = """Extract all real estate comparable property data from this image into CSV format.

Columns (exact order, exact names):
Address,Status,Beds,Baths,SqFt,List Price,Sale Price,DOM,Close Date,Subdivision

Rules:
- Output the header row first, then one row per property.
- Status: Sold, Pending, or Active. Infer from context.
- Prices: plain integers, no $ or commas (e.g. 1395000). Blank if unknown.
- Beds / Baths: numbers (e.g. 2 or 2.5).
- SqFt: integer.
- DOM: integer days on market. Blank if not shown.
- Close Date: YYYY-MM-DD format. Blank if not shown or not sold.
- Subdivision: subdivision / complex / community name. Blank if not shown.
- Use blank for any field not visible — never invent.

Output ONLY the CSV. No markdown code fences. No commentary."""


# ───────────────────────────────────────────────────────────────────────────
# Dispatcher
# ───────────────────────────────────────────────────────────────────────────
def file_to_df(uploaded_file):
    """Take a Streamlit UploadedFile (or anything with .name + .getvalue())
    and return a pandas DataFrame of comp rows."""
    name = uploaded_file.name.lower()
    data = uploaded_file.getvalue()

    if name.endswith(".csv"):
        return pd.read_csv(io.BytesIO(data))
    if name.endswith((".xlsx", ".xls")):
        return pd.read_excel(io.BytesIO(data))
    if name.endswith(".pdf"):
        return _pdf_to_df(data, uploaded_file.name)
    if name.endswith((".png", ".jpg", ".jpeg", ".webp")):
        media = "image/png" if name.endswith(".png") else \
                "image/webp" if name.endswith(".webp") else "image/jpeg"
        return _image_to_df(data, media)

    raise ExtractionError(f"Unsupported file type: {uploaded_file.name}")


# ───────────────────────────────────────────────────────────────────────────
# Claude vision
# ───────────────────────────────────────────────────────────────────────────
def _claude_client():
    try:
        import anthropic
    except ImportError:
        raise ExtractionError(
            "PDF/image extraction needs the anthropic SDK. "
            "Run: pip install anthropic"
        )
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise ExtractionError(
            "PDF/image extraction needs ANTHROPIC_API_KEY in your environment. "
            "See HANDOFF.md for setup."
        )
    return anthropic.Anthropic()


def _vision_extract(image_bytes, media_type):
    """Call Claude vision on a single image, return DataFrame."""
    client = _claude_client()
    b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    resp = client.messages.create(
        model=VISION_MODEL,
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": b64,
                    },
                },
                {"type": "text", "text": EXTRACTION_PROMPT},
            ],
        }],
    )
    text = resp.content[0].text.strip()
    # Strip any stray code fences just in case the model adds them.
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0].strip()
    try:
        return pd.read_csv(io.StringIO(text))
    except Exception as e:
        raise ExtractionError(
            f"Couldn't parse extracted CSV: {e}\n\nGot:\n{text[:500]}"
        )


def _image_to_df(data, media_type):
    return _vision_extract(data, media_type)


# ───────────────────────────────────────────────────────────────────────────
# PDF — text-table fast path, vision fallback
# ───────────────────────────────────────────────────────────────────────────
def _pdf_to_df(data, filename):
    try:
        import pdfplumber
    except ImportError:
        raise ExtractionError("PDF support needs pdfplumber. Run: pip install pdfplumber")

    dfs = []
    fallback_pages = []

    with pdfplumber.open(io.BytesIO(data)) as pdf:
        # Fast path: pdfplumber's built-in table extraction (no API call).
        for page in pdf.pages:
            tables = page.extract_tables() or []
            page_got_table = False
            for table in tables:
                if not table or len(table) < 2:
                    continue
                header = [str(h or "").strip() for h in table[0]]
                # Heuristic: a real comp table has an Address-ish column.
                if any(("address" in h.lower() or "street" in h.lower())
                       for h in header if h):
                    df = pd.DataFrame(table[1:], columns=header)
                    dfs.append(df)
                    page_got_table = True
            if not page_got_table:
                fallback_pages.append(page)

        # Slow path: render unparsed pages and run vision on each.
        if fallback_pages and not dfs:
            try:
                _claude_client()  # raise early if no key, so user gets one clear error
            except ExtractionError as e:
                raise ExtractionError(
                    f"Couldn't find a comp table in {filename} via text extraction. "
                    f"To enable vision fallback: {e}"
                )
            for page in fallback_pages:
                img = page.to_image(resolution=150).original
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                try:
                    dfs.append(_vision_extract(buf.getvalue(), "image/png"))
                except ExtractionError:
                    continue  # skip a page we can't read; raise below if NONE worked

    if not dfs:
        raise ExtractionError(
            f"Could not extract any comp rows from {filename}."
        )
    return pd.concat(dfs, ignore_index=True)
