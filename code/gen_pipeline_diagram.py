# -*- coding: utf-8 -*-
"""The 1.2.0 data pipeline, drawn as the cyclic ring it actually is.

Why a ring and not a flowchart: the pipeline never finishes. Accounts that do not clear the
readiness bar go round again, verification decays so even Ready accounts eventually re-enter, and
the Scanner keeps injecting fresh signals. A left-to-right "snake" would imply an end that does not
exist.

The other thing prose keeps losing, and the reason this is worth a picture at all: the four sources
do NOT all feed the front of the pipeline. They enter at different points, according to what they
actually produce.

Layout is computed once and rendered twice - SVG for the repo and for reading on screen, PNG for
embedding in the Word version - so the two can never disagree.

    set PYTHONDONTWRITEBYTECODE=1
    python code/gen_pipeline_diagram.py

Writes docs/pipeline-ring.svg and docs/pipeline-ring.png.
"""

import math
import os

from PIL import Image, ImageDraw, ImageFont

# SIX stages, not seven, and the reason is geometric as much as conceptual: at 60 degrees apart the
# left of the ring (180 degrees) falls cleanly BETWEEN two boxes, which is the gap the Scanner's
# arrow needs to reach the working set in the middle without cutting across anything.
W, H = 1400, 940
CX, CY = 660, 480
RX, RY = 370, 250
BOX_W, BOX_H = 252, 64
GAP_DEG = 17.0

# The ring is deliberately BROKEN on its left side, between these two angles. The Scanner's signals
# enter the cycle there, and an arrow reaching the middle has to cross the ring somewhere - better a
# clean, intentional gap than a line drawn over an arc.
BREAK_AT = (176.5, 183.5)
BREAK_EDGE = 4

INK = "#1f2933"
MUTED = "#5c6b7a"
RING = "#7b8b9a"
STAGE_FILL = "#ffffff"
STAGE_EDGE = "#3d5a73"
CORE_FILL = "#eaf4ec"
CORE_EDGE = "#2e7d32"
DECAY = "#b26a00"

SOURCE_COLORS = {
    "import": "#1155cc",
    "discovery": "#0f8a7e",
    "web": "#8e44ad",
    "scanner": "#c0392b",
}

# The ring, clockwise from the top. Each stage is where one kind of work happens; the existing
# jobs slot into them rather than being replaced.
STAGES = [
    ["Collect", "new accounts and contacts arrive"],
    ["Clean & normalise", "numbers, currencies, junk values"],
    ["Resolve identity", "LinkedIn IDs, links, duplicates"],
    ["Enrich", "size, contacts, firmographics"],
    ["Reconcile & score", "settle conflicts, set priority"],
    ["Readiness gate", "Ready / Usable / Incomplete"],
]

# Each source, where it enters, and why there.
SOURCES = [
    {
        "key": "import",
        "at": (236, 158),
        "into": 0,
        "lines": ["Imported workbook", "breadth, unverified"],
    },
    {
        "key": "discovery",
        "at": (1255, 605),
        "into": 2,
        "lines": ["LinkedIn Discovery", "arrives already identified"],
    },
    {
        "key": "web",
        "at": (660, 862),
        "into": 3,
        "lines": ["Web Research", "depth on accounts we have"],
    },
    {
        "key": "scanner",
        "at": (152, 480),
        # No stage: the Scanner's product is signals on accounts already being worked, so it feeds
        # the working set straight through the break in the ring. It does also turn up companies
        # nobody had yet; that is said in the caption rather than drawn, because the extra arrow
        # crossed two boxes and cost more clarity than it bought.
        "into": None,
        "lines": ["Scanner", "signals, continuously"],
    },
]


def ellipse_point(deg, rx=RX, ry=RY):
    r = math.radians(deg)
    return CX + rx * math.cos(r), CY + ry * math.sin(r)


def stage_angles():
    step = 360.0 / len(STAGES)
    return [-90.0 + i * step for i in range(len(STAGES))]


def arc_points(a0, a1, steps=28):
    return [ellipse_point(a0 + (a1 - a0) * i / steps) for i in range(steps + 1)]


def arrow_head(p_from, p_to, size=13):
    dx, dy = p_to[0] - p_from[0], p_to[1] - p_from[1]
    length = math.hypot(dx, dy) or 1.0
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    base = (p_to[0] - ux * size, p_to[1] - uy * size)
    return [p_to, (base[0] + px * size * 0.52, base[1] + py * size * 0.52),
            (base[0] - px * size * 0.52, base[1] - py * size * 0.52)]


def loop_arrow(cx, cy, r=16, steps=30):
    """A small circle with a gap and an arrowhead - "this happens again and again".

    Every source is repeatable: a workbook is imported more than once, Discovery and Web Research are
    re-run as the universe grows, and the Scanner runs continuously. Drawing them as plain one-way
    arrows made them look like a single event at setup time.
    """
    pts = []
    for i in range(steps + 1):
        t = math.radians(50 + (330 - 50) * i / steps)
        pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    return pts


def box_edge_point(center, target, w=BOX_W, h=BOX_H, pad=8):
    """Where a line from `target` meets the border of a box centred at `center`."""
    cx, cy = center
    dx, dy = target[0] - cx, target[1] - cy
    if dx == 0 and dy == 0:
        return center
    hw, hh = w / 2.0 + pad, h / 2.0 + pad
    scale = min(hw / abs(dx) if dx else 1e9, hh / abs(dy) if dy else 1e9)
    return cx + dx * scale, cy + dy * scale


def build():
    angles = stage_angles()
    centers = [ellipse_point(a) for a in angles]

    # (points, draws_an_arrowhead). The broken edge becomes two arcs and only the second one
    # actually arrives at a stage, so only that one gets a head.
    ring_edges = []
    for i, a in enumerate(angles):
        a_next = a + 360.0 / len(STAGES)
        start, end = a + GAP_DEG, a_next - GAP_DEG
        if i == BREAK_EDGE:
            ring_edges.append((arc_points(start, BREAK_AT[0]), False))
            ring_edges.append((arc_points(BREAK_AT[1], end), True))
        else:
            ring_edges.append((arc_points(start, end), True))

    core = (CX, CY)
    gate_center = centers[5]

    feeds = []
    for src in SOURCES:
        if src["into"] is None:
            continue  # the Scanner is a two-way exchange with the working set, built below
        target = box_edge_point(centers[src["into"]], src["at"])
        start = box_edge_point(src["at"], target, 216, 62)
        feeds.append({"src": src, "start": start, "end": target})

    # THE SCANNER IS NOT JUST AN INPUT. It reads the working set to know which accounts to scan -
    # it needs a resolved LinkedIn company id and a priority on each one - and returns signals to
    # that same set. Garbage in, garbage out: the quality of what it finds is bounded by the quality
    # of what it was given, which is the strongest argument there is for the readiness bar.
    scanner = SOURCES[3]
    sx = box_edge_point(scanner["at"], core, 216, 62)
    cxp = box_edge_point(core, scanner["at"], 330, 104)
    scanner_out = [(sx[0], CY + 9), (cxp[0], CY + 9)]          # signals ->
    scanner_in = [(cxp[0], CY - 9), (sx[0], CY - 9)]           # <- which accounts to scan

    # Each source repeats; the little loop sits just above its box.
    loops = [(src, loop_arrow(src["at"][0] - 74, src["at"][1] - 50)) for src in SOURCES]

    return {
        "centers": centers,
        "ring_edges": ring_edges,
        "core": core,
        # readiness gate -> the working set in the middle
        "to_core": (box_edge_point(gate_center, core), box_edge_point(core, gate_center, 330, 104)),
        # and back out again: verification expires, so a Ready account eventually needs re-enriching
        "decay": (box_edge_point(core, centers[3], 330, 104), box_edge_point(centers[3], core)),
        "feeds": feeds,
        "scanner_out": scanner_out,
        "scanner_in": scanner_in,
        "loops": loops,
    }


# ---------------------------------------------------------------- SVG
def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def poly(pts):
    return " ".join("%.1f,%.1f" % p for p in pts)


def svg_box(cx, cy, w, h, fill, edge, lines, bold_size=15, sub_size=12, radius=10):
    out = ['<rect x="%.1f" y="%.1f" width="%d" height="%d" rx="%d" fill="%s" stroke="%s" stroke-width="2"/>'
           % (cx - w / 2.0, cy - h / 2.0, w, h, radius, fill, edge)]
    # An empty label list means the caller draws its own text inside the box (the working set does,
    # because it needs three lines rather than the usual two).
    if not lines:
        return out
    if len(lines) == 1:
        out.append('<text x="%.1f" y="%.1f" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
                   'font-size="%d" font-weight="600" fill="%s">%s</text>' % (cx, cy + 5, bold_size, INK, esc(lines[0])))
    else:
        out.append('<text x="%.1f" y="%.1f" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
                   'font-size="%d" font-weight="600" fill="%s">%s</text>' % (cx, cy - 6, bold_size, INK, esc(lines[0])))
        out.append('<text x="%.1f" y="%.1f" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
                   'font-size="%d" fill="%s">%s</text>' % (cx, cy + 17, sub_size, MUTED, esc(lines[1])))
    return out


def render_svg(layout, path):
    p = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d">' % (W, H, W, H),
         '<rect width="%d" height="%d" fill="#ffffff"/>' % (W, H)]

    p.append('<text x="%d" y="44" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
             'font-size="21" font-weight="700" fill="%s">SalesTeam data pipeline — a ring, not a line</text>' % (CX, INK))
    p.append('<text x="%d" y="68" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
             'font-size="13" fill="%s">Four sources feed in at different points. Nothing ever finishes: '
             'what is not ready goes round again, and verification expires.</text>' % (CX, MUTED))

    for pts, head in layout["ring_edges"]:
        p.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="2.6"/>' % (poly(pts), RING))
        if head:
            p.append('<polygon points="%s" fill="%s"/>' % (poly(arrow_head(pts[-3], pts[-1])), RING))

    for feed in layout["feeds"]:
        color = SOURCE_COLORS[feed["src"]["key"]]
        p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="2.6"/>'
                 % (feed["start"][0], feed["start"][1], feed["end"][0], feed["end"][1], color))
        p.append('<polygon points="%s" fill="%s"/>' % (poly(arrow_head(feed["start"], feed["end"])), color))

    sc = SOURCE_COLORS["scanner"]
    for pair, label, dx in ((layout["scanner_out"], "signals", 4), (layout["scanner_in"], "which accounts to scan", 4)):
        a, b = pair
        p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="2.6"/>'
                 % (a[0], a[1], b[0], b[1], sc))
        p.append('<polygon points="%s" fill="%s"/>' % (poly(arrow_head(a, b)), sc))
    p.append('<text x="%.1f" y="%.1f" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
             'font-size="11.5" fill="%s">signals</text>'
             % ((layout["scanner_out"][0][0] + layout["scanner_out"][1][0]) / 2, CY + 26, sc))
    p.append('<text x="%.1f" y="%.1f" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
             'font-size="11.5" fill="%s">which accounts to scan</text>'
             % ((layout["scanner_in"][0][0] + layout["scanner_in"][1][0]) / 2, CY - 18, sc))

    for src, pts in layout["loops"]:
        color = SOURCE_COLORS[src["key"]]
        p.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="2"/>' % (poly(pts), color))
        p.append('<polygon points="%s" fill="%s"/>' % (poly(arrow_head(pts[-3], pts[-1], 9)), color))

    a, b = layout["to_core"]
    p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="3"/>'
             % (a[0], a[1], b[0], b[1], CORE_EDGE))
    p.append('<polygon points="%s" fill="%s"/>' % (poly(arrow_head(a, b)), CORE_EDGE))

    a, b = layout["decay"]
    p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="2.4" stroke-dasharray="8 6"/>'
             % (a[0], a[1], b[0], b[1], DECAY))
    p.append('<polygon points="%s" fill="%s"/>' % (poly(arrow_head(a, b)), DECAY))
    mid = ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
    p.append('<text x="%.1f" y="%.1f" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
             'font-size="12.5" font-style="italic" fill="%s">verification expires</text>' % (mid[0] + 104, mid[1] + 4, DECAY))

    for center, lines in zip(layout["centers"], STAGES):
        p += svg_box(center[0], center[1], BOX_W, BOX_H, STAGE_FILL, STAGE_EDGE, lines)

    p += svg_box(CX, CY, 330, 104, CORE_FILL, CORE_EDGE, [], radius=14)
    p.append('<text x="%d" y="%d" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
             'font-size="17" font-weight="700" fill="%s">The working set</text>' % (CX, CY - 16, INK))
    p.append('<text x="%d" y="%d" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
             'font-size="12.5" fill="%s">Ready and Usable accounts — the only</text>' % (CX, CY + 8, MUTED))
    p.append('<text x="%d" y="%d" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" '
             'font-size="12.5" fill="%s">accounts the salesperson ever sees</text>' % (CX, CY + 28, MUTED))

    for src in SOURCES:
        color = SOURCE_COLORS[src["key"]]
        p += svg_box(src["at"][0], src["at"][1], 216, 62, "#ffffff", color, src["lines"], bold_size=14, sub_size=11.5)

    p.append('<text x="40" y="%d" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="%s">'
             'The Scanner both READS and FEEDS the working set — it can only scan accounts that already have a LinkedIn id and a priority, so the readiness bar is what the Scanner needs. Garbage in, garbage out.</text>' % (H - 26, MUTED))

    p.append("</svg>")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(p))
    return path


# ---------------------------------------------------------------- PNG
def font(size, bold=False):
    for name in (("arialbd.ttf", "seguisb.ttf") if bold else ("arial.ttf", "segoeui.ttf")):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def png_text(d, xy, text, f, fill, anchor="mm"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def png_box(d, cx, cy, w, h, fill, edge, lines, bold_size=15, sub_size=12, radius=10):
    d.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], radius=radius,
                        fill=fill, outline=edge, width=2)
    if len(lines) == 1:
        png_text(d, (cx, cy), lines[0], font(bold_size, True), INK)
    elif len(lines) == 2:
        png_text(d, (cx, cy - 13), lines[0], font(bold_size, True), INK)
        png_text(d, (cx, cy + 14), lines[1], font(sub_size), MUTED)


def render_png(layout, path, scale=2):
    img = Image.new("RGB", (W * scale, H * scale), "white")
    d = ImageDraw.Draw(img)

    def S(pts):
        return [(x * scale, y * scale) for x, y in pts]

    png_text(d, (CX * scale, 40 * scale), "SalesTeam data pipeline — a ring, not a line",
             font(21 * scale, True), INK)
    png_text(d, (CX * scale, 66 * scale),
             "Four sources feed in at different points, over and over. Nothing ever finishes: what is not ready goes round again, and verification expires.",
             font(13 * scale), MUTED)

    for pts, head in layout["ring_edges"]:
        d.line(S(pts), fill=RING, width=int(2.6 * scale), joint="curve")
        if head:
            d.polygon(S(arrow_head(pts[-3], pts[-1])), fill=RING)

    for feed in layout["feeds"]:
        color = SOURCE_COLORS[feed["src"]["key"]]
        d.line(S([feed["start"], feed["end"]]), fill=color, width=int(2.6 * scale))
        d.polygon(S(arrow_head(feed["start"], feed["end"])), fill=color)

    sc = SOURCE_COLORS["scanner"]
    for pair in (layout["scanner_out"], layout["scanner_in"]):
        a, b = pair
        d.line(S([a, b]), fill=sc, width=int(2.6 * scale))
        d.polygon(S(arrow_head(a, b)), fill=sc)
    png_text(d, (((layout["scanner_out"][0][0] + layout["scanner_out"][1][0]) / 2) * scale, (CY + 26) * scale),
             "signals", font(int(11.5 * scale)), sc)
    png_text(d, (((layout["scanner_in"][0][0] + layout["scanner_in"][1][0]) / 2) * scale, (CY - 22) * scale),
             "which accounts to scan", font(int(11.5 * scale)), sc)

    for src, pts in layout["loops"]:
        color = SOURCE_COLORS[src["key"]]
        d.line(S(pts), fill=color, width=2 * scale, joint="curve")
        d.polygon(S(arrow_head(pts[-3], pts[-1], 9)), fill=color)

    a, b = layout["to_core"]
    d.line(S([a, b]), fill=CORE_EDGE, width=3 * scale)
    d.polygon(S(arrow_head(a, b)), fill=CORE_EDGE)

    a, b = layout["decay"]
    for seg in dashed(a, b, 8, 6):
        d.line(S(seg), fill=DECAY, width=int(2.4 * scale))
    d.polygon(S(arrow_head(a, b)), fill=DECAY)
    mid = ((a[0] + b[0]) / 2.0 + 104, (a[1] + b[1]) / 2.0 + 4)
    png_text(d, (mid[0] * scale, mid[1] * scale), "verification expires", font(12 * scale), DECAY)

    for center, lines in zip(layout["centers"], STAGES):
        png_box(d, center[0] * scale, center[1] * scale, BOX_W * scale, BOX_H * scale,
                STAGE_FILL, STAGE_EDGE, lines, 15 * scale, 12 * scale, 10 * scale)

    png_box(d, CX * scale, CY * scale, 330 * scale, 104 * scale, CORE_FILL, CORE_EDGE, [], radius=14 * scale)
    png_text(d, (CX * scale, (CY - 22) * scale), "The working set", font(17 * scale, True), INK)
    png_text(d, (CX * scale, (CY + 4) * scale), "Ready and Usable accounts — the only", font(13 * scale), MUTED)
    png_text(d, (CX * scale, (CY + 25) * scale), "accounts the salesperson ever sees", font(13 * scale), MUTED)

    for src in SOURCES:
        color = SOURCE_COLORS[src["key"]]
        png_box(d, src["at"][0] * scale, src["at"][1] * scale, 216 * scale, 62 * scale,
                "#ffffff", color, src["lines"], 14 * scale, 12 * scale, 10 * scale)

    png_text(d, (CX * scale, (H - 26) * scale),
             "The Scanner both READS and FEEDS the working set — it can only scan accounts that already have a LinkedIn id and a priority, so the readiness bar is what the Scanner needs. Garbage in, garbage out.",
             font(12 * scale), MUTED)

    img.save(path, "PNG")
    return path


def dashed(a, b, on, off):
    total = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
    ux, uy = (b[0] - a[0]) / total, (b[1] - a[1]) / total
    segs, pos = [], 0.0
    while pos < total:
        end = min(pos + on, total)
        segs.append([(a[0] + ux * pos, a[1] + uy * pos), (a[0] + ux * end, a[1] + uy * end)])
        pos = end + off
    return segs


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "docs")
    os.makedirs(out_dir, exist_ok=True)
    layout = build()
    print("Saved", render_svg(layout, os.path.join(out_dir, "pipeline-ring.svg")))
    print("Saved", render_png(layout, os.path.join(out_dir, "pipeline-ring.png")))


if __name__ == "__main__":
    main()
