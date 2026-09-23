# -*- coding: utf-8 -*-
"""Markdown -> .docx, for any document in this repo.

gen_release_notes_docx.py does this for RELEASE_NOTES.md alone and predates there being more than
one hand-written markdown document. This is the same approach generalised: same styling, same zoom
fix, plus the two things the release notes never needed - level-3 headings and tables.

    set PYTHONDONTWRITEBYTECODE=1
    python code/gen_md_docx.py DATA_PIPELINE_REQUIREMENTS.md

The output path is the input with .docx in place of .md, next to it. Pass a second argument to put
it somewhere else.

Styling matches "AI Product Requirements Doc Template.docx": Arial 11pt body, Heading 1 bold blue
(0000FF), Heading 2 bold medium-blue (1155CC).

PYTHONDONTWRITEBYTECODE=1 matters whenever this is run from inside code/: a __pycache__ directory
there breaks Chrome's "Load unpacked", because the name is reserved.
"""

import os
import re
import shutil
import sys
import zipfile

import docx
from docx.shared import Inches, Pt, RGBColor

BODY_FONT = "Arial"
BODY_SIZE = Pt(11)
H1_COLOR = RGBColor(0x00, 0x00, 0xFF)
H2_COLOR = RGBColor(0x11, 0x55, 0xCC)

TOKEN_RE = re.compile(r"\*\*(.+?)\*\*|`([^`]+)`")
# ![alt](path) on a line of its own becomes an embedded picture, scaled to the text width.
IMAGE_RE = re.compile(r"^!\[(?P<alt>[^\]]*)\]\((?P<src>[^)]+)\)\s*$")


def fix_zoom(path):
    """python-docx's bundled template omits w:percent, which fails OOXML schema validation."""
    tmp = path + ".tmp"
    shutil.copy(path, tmp)
    with zipfile.ZipFile(tmp, "r") as zin:
        names = zin.namelist()
        settings = zin.read("word/settings.xml").decode("utf-8")
        if "<w:zoom" not in settings:
            m = re.search(r"(<w:settings[^>]*>)", settings)
            if m:
                settings = settings[: m.end()] + '<w:zoom w:percent="100"/>' + settings[m.end():]
        else:
            settings = re.sub(r"<w:zoom(?![^>]*w:percent)", '<w:zoom w:percent="100"', settings)
        data = {n: zin.read(n) for n in names}
        data["word/settings.xml"] = settings.encode("utf-8")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            zout.writestr(n, data[n])
    os.remove(tmp)


def add_inline_runs(paragraph, text, bold=False):
    """**bold** and `code` spans become real runs; everything else is plain."""
    pos = 0
    for m in TOKEN_RE.finditer(text):
        if m.start() > pos:
            r = paragraph.add_run(text[pos:m.start()])
            r.bold = bold
        if m.group(1) is not None:
            r = paragraph.add_run(m.group(1))
            r.bold = True
        else:
            r = paragraph.add_run(m.group(2))
            r.font.name = "Consolas"
            r.bold = bold
        pos = m.end()
    if pos < len(text):
        r = paragraph.add_run(text[pos:])
        r.bold = bold


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_divider(line):
    return bool(re.match(r"^\|?[\s:|-]+\|[\s:|-]*$", line.strip())) and "-" in line


def apply_styles(doc):
    normal = doc.styles["Normal"]
    normal.font.name = BODY_FONT
    normal.font.size = BODY_SIZE
    for level, color in ((1, H1_COLOR), (2, H2_COLOR), (3, H2_COLOR)):
        style = doc.styles["Heading %d" % level]
        style.font.name = BODY_FONT
        style.font.bold = True
        style.font.color.rgb = color


def convert(md_path, out_path):
    with open(md_path, encoding="utf-8") as f:
        lines = f.read().splitlines()

    doc = docx.Document()
    apply_styles(doc)

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()

        # A table: a header row, a divider, then body rows until the block ends.
        if line.startswith("|") and i + 1 < len(lines) and is_divider(lines[i + 1]):
            header = split_row(line)
            rows = []
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i]))
                i += 1
            table = doc.add_table(rows=1, cols=len(header))
            table.style = "Table Grid"
            for cell, text in zip(table.rows[0].cells, header):
                cell.text = ""
                add_inline_runs(cell.paragraphs[0], text, bold=True)
            for row in rows:
                cells = table.add_row().cells
                for cell, text in zip(cells, row):
                    cell.text = ""
                    add_inline_runs(cell.paragraphs[0], text)
            doc.add_paragraph()
            continue

        if not line or line == "---":
            i += 1
            continue

        img = IMAGE_RE.match(line)
        if img:
            src = os.path.join(os.path.dirname(md_path), img.group("src").replace("/", os.sep))
            if os.path.exists(src):
                doc.add_picture(src, width=Inches(6.3))
                doc.paragraphs[-1].alignment = 1
                if img.group("alt"):
                    cap = doc.add_paragraph()
                    cap.alignment = 1
                    r = cap.add_run(img.group("alt"))
                    r.italic = True
                    r.font.size = Pt(9)
            else:
                add_inline_runs(doc.add_paragraph(), "[missing image: %s]" % img.group("src"))
            i += 1
            continue

        if line.startswith("### "):
            add_inline_runs(doc.add_heading(level=3), line[4:])
        elif line.startswith("## "):
            add_inline_runs(doc.add_heading(level=2), line[3:])
        elif line.startswith("# "):
            add_inline_runs(doc.add_heading(level=1), line[2:])
        elif line.startswith("> "):
            p = doc.add_paragraph(style="Intense Quote")
            add_inline_runs(p, line[2:])
        elif re.match(r"^\d+\.\s", line):
            p = doc.add_paragraph(style="List Number")
            add_inline_runs(p, re.sub(r"^\d+\.\s", "", line))
        elif line.startswith("- "):
            p = doc.add_paragraph(style="List Bullet")
            add_inline_runs(p, line[2:])
        else:
            add_inline_runs(doc.add_paragraph(), line)
        i += 1

    for section in doc.sections:
        section.top_margin = Pt(50)
        section.bottom_margin = Pt(50)

    doc.save(out_path)
    fix_zoom(out_path)
    return out_path


def main():
    if len(sys.argv) < 2:
        sys.exit("Usage: python code/gen_md_docx.py <file.md> [out.docx]")
    md_path = os.path.abspath(sys.argv[1])
    out_path = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.splitext(md_path)[0] + ".docx"
    convert(md_path, out_path)
    print("Saved %s" % out_path)


if __name__ == "__main__":
    main()
