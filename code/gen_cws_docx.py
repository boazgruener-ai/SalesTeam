# -*- coding: utf-8 -*-
# Builds "Chrome Web Store Listing.docx" straight from "Chrome Web Store Listing.md"
# (the .md is the single source of truth - edit that, then re-run this). Previously this
# script hand-mirrored the text and drifted; parsing the .md avoids that.
import zipfile
import shutil
import re
import os
import docx
from docx.shared import Pt

SALESTEAM_DIR = "C:/Users/41793/OneDrive/Documents/Personal/Claude Code/SalesTeam"
SOURCE_MD = SALESTEAM_DIR + "/Chrome Web Store Listing.md"
OUT_DOCX = SALESTEAM_DIR + "/Chrome Web Store Listing.docx"

BOLD_LABELS = ("WHAT IT DOES", "YOUR AI SALES TEAM", "PRIVACY")


def fix_zoom(path):
    tmp = path + ".tmp"
    shutil.copy(path, tmp)
    with zipfile.ZipFile(tmp, "r") as zin:
        names = zin.namelist()
        settings = zin.read("word/settings.xml").decode("utf-8")
        if "<w:zoom" not in settings:
            m = re.search(r"(<w:settings[^>]*>)", settings)
            if m:
                settings = settings[:m.end()] + '<w:zoom w:percent="100"/>' + settings[m.end():]
        data = {n: zin.read(n) for n in names}
        data["word/settings.xml"] = settings.encode("utf-8")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            zout.writestr(n, data[n])
    os.remove(tmp)


def is_label(line):
    if line.startswith(BOLD_LABELS):
        return True
    return line.endswith(":") and len(line) < 80


doc = docx.Document()
with open(SOURCE_MD, encoding="utf-8") as f:
    for raw in f:
        line = raw.rstrip("\n").strip()
        if not line:
            continue
        if line.startswith("# "):
            doc.add_heading(line[2:], level=1)
        elif line.startswith("## "):
            doc.add_heading(line[3:], level=2)
        elif line.startswith("- "):
            doc.add_paragraph(line[2:], style="List Bullet")
        elif is_label(line):
            doc.add_paragraph().add_run(line).bold = True
        else:
            doc.add_paragraph(line)

for section in doc.sections:
    section.top_margin = Pt(50)
    section.bottom_margin = Pt(50)

doc.save(OUT_DOCX)
fix_zoom(OUT_DOCX)
print("Saved Chrome Web Store Listing.docx")
