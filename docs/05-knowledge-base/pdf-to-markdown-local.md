# PDF to Markdown Conversion Guide

## Setup (one time)

```bash
cd ~
python3 -m venv pdfenv2 --clear
source pdfenv2/bin/activate
pip install pymupdf4llm
```

## Create the script (one time)

```bash
nano convert2.py
```

Paste this:

```python
import pymupdf4llm
from pathlib import Path

input_dir = Path("/Users/masonomara/Documents/legal-guides")
output_dir = Path("/Users/masonomara/Documents/legal-guides-md")
output_dir.mkdir(exist_ok=True)

for pdf in input_dir.glob("*.pdf"):
    print(f"Converting: {pdf.name}")
    md = pymupdf4llm.to_markdown(str(pdf))
    (output_dir / f"{pdf.stem}.md").write_text(md)
    print(f"Done: {pdf.name}")
```

Save: `Ctrl+O`, `Enter`, `Ctrl+X`

## To convert PDFs

1. Edit `convert2.py` to update `input_dir` and `output_dir` paths if needed
2. Run:

```bash
cd ~
source pdfenv2/bin/activate
python convert2.py
```

## To find folder paths

Drag folder into terminal window — path auto-populates.
