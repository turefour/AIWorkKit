#!/usr/bin/env python
"""
@name excel_report
@category data
@purpose Excel 报表排版原语：标题 / 说明 / 表头 / 数据行 / 列宽 / 冻结 / 斑马纹，
         从 handdelete 里 96 份重复实现中提炼（2026-11-13）。不再逐个项目重写排版。
@input  import excel_report as xl
@usage  wb = xl.new_workbook()
         ws = xl.new_sheet(wb, "比价表")
         xl.title_row(ws, "选型比价表", 24)
         xl.head_row(ws, 3, headers)
         xl.body_rows(ws, 4, rows, 24)
         xl.widths(ws, {"A": 6, "B": 14})
@reuse  yes

CLI:
    python py/excel_report.py --demo out.xlsx     # 生成一份示例，验证依赖与排版

Why this exists:
    The same five helpers (title / subtitle / head / body / widths) were copied into
    96 scripts under handdelete, each with slightly different colours and heights.
    They are pure formatting, so one module replaces all of them.
"""

import argparse
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

# ---------------------------------------------------------------- defaults

FONT_NAME = "微软雅黑"
NAVY = "1B3A5C"          # header fill / title colour
GREY = "595959"          # subtitle colour
BORDER_COLOR = "BFBFBF"  # thin grid
ZEBRA_COLOR = "F4F7FA"   # even-row background

_THIN = Side(style="thin", color=BORDER_COLOR)
BORDER = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


def new_workbook(default_sheet=True):
    """Create a workbook, removing the default sheet when asked."""
    wb = Workbook()
    if not default_sheet:
        wb.remove(wb.active)
    return wb


def new_sheet(wb, title, freeze="A2", tab_color=None):
    """
    Add a worksheet with sensible defaults.

    The first call reuses the auto-created sheet so `wb.active` stays predictable
    (openpyxl always starts with one sheet called "Sheet").
    """
    if len(wb.sheetnames) == 1 and wb.active.max_row == 1 and wb.active["A1"].value is None:
        ws = wb.active
        ws.title = title
    else:
        ws = wb.create_sheet(title)

    ws.sheet_view.showGridLines = False
    if freeze:
        ws.freeze_panes = freeze
    if tab_color:
        ws.sheet_properties.tabColor = tab_color
    return ws


def title_row(ws, text, ncols, row=1, height=30, size=14, color=NAVY):
    """Merged, centred, bold title across `ncols` columns."""
    if ncols > 1:
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=ncols)
    cell = ws.cell(row=row, column=1, value=text)
    cell.font = Font(name=FONT_NAME, size=size, bold=True, color=color)
    cell.alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[row].height = height
    return row + 1


def subtitle(ws, text, ncols, row=2, height=30, align="left"):
    """Merged note line under the title (small, italic, grey)."""
    if ncols > 1:
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=ncols)
    cell = ws.cell(row=row, column=1, value=text)
    cell.font = Font(name=FONT_NAME, size=9, italic=True, color=GREY)
    cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = height
    return row + 1


def head_row(ws, row, headers, height=44, fill=NAVY, color="FFFFFF", size=9):
    """Header row: dark fill, white bold text, wrapped, bordered."""
    for index, header in enumerate(headers, start=1):
        cell = ws.cell(row=row, column=index, value=header)
        cell.font = Font(name=FONT_NAME, size=size, bold=True, color=color)
        cell.fill = PatternFill("solid", start_color=fill)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[row].height = height
    return row + 1


def body_row(ws, row, ncols, height=46, align="center", zebra=None, size=9):
    """Style one data row (font / border / wrap). Call before writing values."""
    for index in range(1, ncols + 1):
        cell = ws.cell(row=row, column=index)
        cell.font = Font(name=FONT_NAME, size=size)
        cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)
        cell.border = BORDER
        if zebra:
            cell.fill = PatternFill("solid", start_color=zebra)
    ws.row_dimensions[row].height = height
    return row


def body_rows(ws, start_row, rows, ncols, height=46, align="center", zebra=ZEBRA_COLOR, size=9):
    """
    Write and style a list of rows in one call.

    `rows` may be lists or dicts keyed by column letter; values are written as-is
    so the caller keeps control over formatting of individual cells afterwards.
    """
    row = start_row
    for offset, values in enumerate(rows):
        body_row(ws, row, ncols, height=height, align=align, zebra=zebra if offset % 2 else None, size=size)
        if isinstance(values, dict):
            for key, value in values.items():
                ws[f"{key}{row}"] = value
        else:
            for index, value in enumerate(values, start=1):
                ws.cell(row=row, column=index, value=value)
        row += 1
    return row


def widths(ws, mapping):
    """
    Set column widths. `mapping` keys are letters ("A") or 1-based indexes (1),
    because the extracted scripts used both spellings.
    """
    for key, width in mapping.items():
        letter = get_column_letter(key) if isinstance(key, int) else str(key)
        ws.column_dimensions[letter].width = width


def build_table(wb, title, headers, rows, subtitle_text=None, tab="表1",
                sheet_title=None, widths_map=None, row_height=46):
    """One-shot builder: title + optional note + header + zebra data rows."""
    ncols = len(headers)
    ws = new_sheet(wb, sheet_title or tab)
    row = title_row(ws, title, ncols)
    if subtitle_text:
        row = subtitle(ws, subtitle_text, ncols, row=row)
    row = head_row(ws, row, headers)
    row = body_rows(ws, row, rows, ncols, height=row_height)
    if widths_map:
        widths(ws, widths_map)
    ws.freeze_panes = f"A{row - len(rows)}" if rows else "A2"
    return ws


# ---------------------------------------------------------------- demo

def _demo(path):
    """Generate a small workbook so the module can be verified end to end."""
    wb = new_workbook()
    ws = build_table(
        wb,
        title="通用报表排版示例",
        subtitle_text="这份文件由 ScriptVault/py/excel_report.py 生成，用于验证排版原语可用。",
        headers=["序号", "品牌", "型号 / 规格", "参考价(元/台)", "交期(周)", "备注"],
        rows=[
            [1, "E+H", "FMR50-AAACCABPBCK+AK", 16800, 4, "进口代理"],
            [2, "西门子", "SITRANS LR250", 21500, 6, "需订货"],
            [3, "麦克", "MPM489", 3200, 2, "国产现货"],
        ],
        tab="示例",
        widths_map={"A": 6, "B": 12, "C": 34, "D": 16, "E": 10, "F": 20},
    )
    ws["A8"] = "说明：列宽、表头底色、斑马纹、冻结窗格均由模块统一处理。"
    ws["A8"].font = Font(name=FONT_NAME, size=9, italic=True, color=GREY)
    wb.save(path)
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description="Excel report primitives")
    parser.add_argument("--demo", metavar="OUT.xlsx", help="write a demo workbook")
    args = parser.parse_args(argv)

    if not args.demo:
        parser.print_help()
        return 0

    path = _demo(args.demo)
    print(f"[ok] demo written: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
