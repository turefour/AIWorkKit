#!/usr/bin/env python
"""
@name dxf_draw
@category cad
@purpose DXF 绘图原语与 A3/A4 图框：线 / 折线 / 矩形 / 圆 / 十字中心线 / 文字 /
         剖面线 / 箭头 / 水平与竖直尺寸标注 / 标题栏。从 handdelete 里 35 份
         重复实现中提炼（2026-11-13）。
@input  import dxf_draw as dd
@usage  doc, msp = dd.new_drawing()
         dd.frame_a3(msp)
         dd.line(msp, 0, 0, 120, 0)
         dd.dim_h(msp, 0, 120, y_ref=0, y=-12, label="120")
         doc.saveas("part.dxf")
@reuse  yes

CLI:
    python py/dxf_draw.py --demo out.dxf        # 生成一份带图框的示例

Why this exists:
    Every drawing script re-declared L/PL/T/RECT/C/arrow/dim_h/dim_v with slightly
    different layer names ("OUTLINE" vs "1_VIS_HARD" vs "VIS"). The geometry is
    identical; only the layer naming differed. One module + a semantic layer map
    removes the duplication without changing the drawings.
"""

import argparse
import sys

import ezdxf
from ezdxf.enums import TextEntityAlignment

# Semantic layer names -> (dxf layer name, ACI colour)
DEFAULT_LAYERS = {
    "outline": ("OUTLINE", 7),      # visible hard edges
    "hidden": ("HIDDEN", 8),        # dashed
    "center": ("CENTER", 4),        # centre / symmetry lines
    "dim": ("DIM", 1),              # dimensions and arrows
    "text": ("TEXT", 3),            # annotations
    "hatch": ("HATCH", 9),          # section fills
    "frame": ("FRAME", 7),          # border + title block
}

A3 = (420.0, 297.0)
A4 = (297.0, 210.0)


# ---------------------------------------------------------------- document

def new_drawing(layers=None, units=6):
    """
    Create a document with the standard layer set.

    units=6 means metres by default in DXF; drawings here are millimetres, so the
    caller usually wants units=4 (mm). Defaults keep the historical behaviour.
    """
    doc = ezdxf.new("R2010", setup=True)
    doc.units = units
    doc.layers.add("HIDDEN", color=8, linetype="DASHED")

    for key, (name, color) in (layers or DEFAULT_LAYERS).items():
        if name not in doc.layers:
            doc.layers.add(name, color=color)
    return doc, doc.modelspace()


def lname(key, layers=None):
    """Map a semantic key ("outline") to the actual DXF layer name."""
    table = layers or DEFAULT_LAYERS
    entry = table.get(key)
    return entry[0] if entry else key


# ---------------------------------------------------------------- primitives

def line(msp, x1, y1, x2, y2, layer="outline", layers=None):
    return msp.add_line((x1, y1), (x2, y2), dxfattribs={"layer": lname(layer, layers)})


def polyline(msp, points, layer="outline", close=False, layers=None):
    return msp.add_lwpolyline(points, close=close, dxfattribs={"layer": lname(layer, layers)})


def rect(msp, x, y, w, h, layer="outline", layers=None):
    return polyline(msp, [(x, y), (x + w, y), (x + w, y + h), (x, y + h)], layer, True, layers)


def circle(msp, cx, cy, r, layer="outline", layers=None):
    return msp.add_circle((cx, cy), r, dxfattribs={"layer": lname(layer, layers)})


def cross(msp, cx, cy, size=2.0, layer="center", layers=None):
    """Centre mark: two short crossing lines (the usual CAD convention)."""
    line(msp, cx - size, cy, cx + size, cy, layer, layers)
    line(msp, cx, cy - size, cx, cy + size, layer, layers)


def text(msp, s, x, y, h=3.0, layer="text", align=TextEntityAlignment.LEFT, rot=0, layers=None):
    entity = msp.add_text(str(s), height=h, dxfattribs={"layer": lname(layer, layers), "rotation": rot})
    entity.set_placement((x, y), align=align)
    return entity


def solid(msp, points, layer="dim", layers=None):
    """Filled triangle/quad — used for arrow heads."""
    return msp.add_solid(points, dxfattribs={"layer": lname(layer, layers)})


def hatch(msp, points, scale=0.55, angle=0, layer="hatch", layers=None):
    """Section fill inside a closed polyline path."""
    entity = msp.add_hatch(color=9, dxfattribs={"layer": lname(layer, layers)})
    entity.set_pattern_fill("ANSI31", scale=scale, angle=angle)
    entity.paths.add_polyline_path(points, is_closed=True)
    return entity


# ---------------------------------------------------------------- dimensions

def arrow_head(msp, x, y, angle_deg, size=2.6, layer="dim", layers=None):
    """Filled arrow head pointing along `angle_deg` (0 = +X)."""
    import math

    rad = math.radians(angle_deg)
    dx, dy = math.cos(rad), math.sin(rad)
    # base width is a third of the length; the three points form the triangle
    px, py = -dy * size * 0.33, dx * size * 0.33
    solid(
        msp,
        [
            (x, y),
            (x - dx * size + px, y - dy * size + py),
            (x - dx * size - px, y - dy * size - py),
        ],
        layer,
        layers,
    )


def dim_h(msp, x1, x2, y_ref, y, label=None, th=2.6, layer="dim", layers=None):
    """
    Horizontal dimension: extension lines from `y_ref`, dimension line at `y`,
    arrow heads at both ends, label centred above the line.
    """
    text_h = th
    sign = 1 if y >= y_ref else -1
    line(msp, x1, y_ref, x1, y + sign * th, layer, layers)
    line(msp, x2, y_ref, x2, y + sign * th, layer, layers)
    line(msp, x1, y, x2, y, layer, layers)
    arrow_head(msp, x1, y, 180, th, layer, layers)
    arrow_head(msp, x2, y, 0, th, layer, layers)
    text(msp, label if label is not None else f"{abs(x2 - x1):.0f}",
         (x1 + x2) / 2.0, y + sign * (th * 0.6),
         text_h, layer, TextEntityAlignment.MIDDLE_CENTER, layers=layers)


def dim_v(msp, y1, y2, x_ref, x, label=None, th=2.6, layer="dim", layers=None):
    """Vertical dimension; same convention as dim_h."""
    text_h = th
    sign = 1 if x >= x_ref else -1
    line(msp, x_ref, y1, x + sign * th, y1, layer, layers)
    line(msp, x_ref, y2, x + sign * th, y2, layer, layers)
    line(msp, x, y1, x, y2, layer, layers)
    arrow_head(msp, x, y1, 270, th, layer, layers)
    arrow_head(msp, x, y2, 90, th, layer, layers)
    text(msp, label if label is not None else f"{abs(y2 - y1):.0f}",
         x + sign * (th * 0.8), (y1 + y2) / 2.0,
         text_h, layer, TextEntityAlignment.MIDDLE_CENTER, rot=90, layers=layers)


# ---------------------------------------------------------------- frame

def frame(msp, size=A3, margin=10.0, title_block=(180.0, 32.0), meta=None, layers=None):
    """
    Draw a drawing border + title block in the lower-right corner.

    meta: dict with keys like 图号 / 名称 / 材料 / 比例 / 设计 / 日期 — written into
    the title block cells. Missing keys leave the cell blank.
    """
    width, height = size
    layer = "frame"
    rect(msp, 0, 0, width, height, layer, layers)
    rect(msp, margin, margin, width - 2 * margin, height - 2 * margin, layer, layers)

    bw, bh = title_block
    x0 = width - margin - bw
    y0 = margin
    rect(msp, x0, y0, bw, bh, layer, layers)
    # three rows: 4 columns in the top row, 2 rows below
    line(msp, x0, y0 + bh / 2, x0 + bw, y0 + bh / 2, layer, layers)
    line(msp, x0, y0 + bh / 4, x0 + bw, y0 + bh / 4, layer, layers)
    for frac in (0.18, 0.42, 0.62, 0.82):
        line(msp, x0 + bw * frac, y0 + bh / 2, x0 + bw * frac, y0 + bh, layer, layers)

    data = meta or {}
    text(msp, data.get("名称", ""), x0 + bw * 0.30, y0 + bh * 0.82, 3.5,
         "text", TextEntityAlignment.MIDDLE_CENTER, layers=layers)
    text(msp, data.get("图号", ""), x0 + bw * 0.80, y0 + bh * 0.82, 3.0,
         "text", TextEntityAlignment.MIDDLE_CENTER, layers=layers)
    text(msp, data.get("材料", ""), x0 + bw * 0.30, y0 + bh * 0.62, 3.0,
         "text", TextEntityAlignment.MIDDLE_CENTER, layers=layers)
    text(msp, data.get("比例", "1:1"), x0 + bw * 0.80, y0 + bh * 0.62, 3.0,
         "text", TextEntityAlignment.MIDDLE_CENTER, layers=layers)
    text(msp, data.get("设计", ""), x0 + bw * 0.30, y0 + bh * 0.35, 3.0,
         "text", TextEntityAlignment.MIDDLE_CENTER, layers=layers)
    text(msp, data.get("日期", ""), x0 + bw * 0.80, y0 + bh * 0.35, 3.0,
         "text", TextEntityAlignment.MIDDLE_CENTER, layers=layers)
    return x0, y0


# ---------------------------------------------------------------- demo

def _demo(path):
    doc, msp = new_drawing()
    frame(msp, A3, meta={"名称": "标定罩", "图号": "GH-2026-001", "材料": "304", "比例": "1:2",
                         "设计": "许磊", "日期": "2026-11-13"})
    # a simple bracket: outline + centre line + two dimensions
    rect(msp, 120, 150, 160, 60, "outline")
    circle(msp, 160, 180, 14, "outline")
    circle(msp, 240, 180, 14, "outline")
    cross(msp, 160, 180, 18, "center")
    cross(msp, 240, 180, 18, "center")
    hatch(msp, [(120, 150), (280, 150), (280, 162), (120, 162)], 0.8, 45, "hatch")
    dim_h(msp, 120, 280, y_ref=150, y=132, label="160")
    dim_h(msp, 160, 240, y_ref=180, y=215, label="80")
    dim_v(msp, 150, 210, x_ref=120, x=104, label="60")
    text(msp, "技术要求：未注倒角 C1，去毛刺。", 120, 240, 3.2, "text")
    doc.saveas(path)
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description="DXF drawing primitives")
    parser.add_argument("--demo", metavar="OUT.dxf", help="write a demo drawing")
    args = parser.parse_args(argv)

    if not args.demo:
        parser.print_help()
        return 0

    path = _demo(args.demo)
    print(f"[ok] demo written: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
