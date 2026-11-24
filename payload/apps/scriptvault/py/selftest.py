#!/usr/bin/env python
"""
@name py-selftest
@category test
@purpose 回归测试：excel_report 与 dxf_draw 两个模块生成产物后回读校验，
         确认排版原语与图元数量没有在重构中走样。
@input  无（自建临时文件）
@usage  python py/selftest.py
@reuse  yes

Runs with the standard library only; openpyxl / ezdxf are the modules under test.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dxf_draw
import excel_report

results = []


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))


def test_excel():
    path = os.path.join(tempfile.gettempdir(), "selftest-excel.xlsx")
    excel_report._demo(path)

    import openpyxl

    wb = openpyxl.load_workbook(path)
    ws = wb.active

    check("excel: 工作表名", ws.title == "示例", ws.title)
    check("excel: 标题合并 A1:F1", "A1:F1" in [str(r) for r in ws.merged_cells.ranges])
    check("excel: 标题加粗 14pt", ws["A1"].font.bold and ws["A1"].font.size == 14)
    check("excel: 表头底色 NAVY", ws["A3"].fill.start_color.rgb.endswith(excel_report.NAVY))
    check("excel: 表头白色字体", ws["A3"].font.color.rgb.endswith("FFFFFF"))
    check("excel: 列宽 C=34", ws.column_dimensions["C"].width == 34.0)
    check("excel: 冻结窗格 A4", ws.freeze_panes == "A4")
    check("excel: 网格线关闭", ws.sheet_view.showGridLines is False)
    check("excel: 数据行写入", ws["B4"].value == "E+H", ws["B4"].value)

    os.remove(path)


def test_dxf():
    path = os.path.join(tempfile.gettempdir(), "selftest-dxf.dxf")
    dxf_draw._demo(path)

    import ezdxf

    doc = ezdxf.readfile(path)
    msp = doc.modelspace()

    layers = {layer.dxf.name for layer in doc.layers}
    for expected in ("OUTLINE", "HIDDEN", "CENTER", "DIM", "TEXT", "HATCH", "FRAME"):
        check(f"dxf: 图层 {expected}", expected in layers)

    texts = [e.dxf.text for e in msp if e.dxftype() == "TEXT"]
    check("dxf: 标题栏名称", "标定罩" in texts)
    check("dxf: 图号", "GH-2026-001" in texts)

    dim_texts = sorted(e.dxf.text for e in msp if e.dxftype() == "TEXT" and e.dxf.layer == "DIM")
    check("dxf: 三个尺寸标注", dim_texts == ["160", "60", "80"], str(dim_texts))

    arrows = [e for e in msp if e.dxftype() == "SOLID"]
    check("dxf: 箭头数量 6", len(arrows) == 6, str(len(arrows)))

    hatches = [e for e in msp if e.dxftype() == "HATCH"]
    check("dxf: 剖面线 1 个且为 ANSI31",
          len(hatches) == 1 and hatches[0].dxf.pattern_name == "ANSI31",
          str(len(hatches)))

    check("dxf: 实体总数 > 30", len(msp) > 30, str(len(msp)))

    os.remove(path)


def main():
    test_excel()
    test_dxf()

    width = max(len(name) for name, _, _ in results) + 2
    failed = 0
    for name, ok, detail in results:
        if not ok:
            failed += 1
        print(("  [PASS] " if ok else "  [FAIL] ") + name.ljust(width) + ("" if ok else str(detail)))

    total = len(results)
    print("")
    print(f"  {total - failed}/{total} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
