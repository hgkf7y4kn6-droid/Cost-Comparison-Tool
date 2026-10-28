import io

import openpyxl

CATALOG_CSV = """sku,name,description,category,tier,price,uses_per_case,format
TWL-CF-1,C-fold towel,Comparable c-fold paper towel,hand towel,good,48.00,2400,c-fold
TWL-MF-1,Multifold towel,Multifold paper towel,hand towel,better,40.00,3000,multifold
TWL-RL-1,Hardwound roll towel,Hardwound roll paper towel,hand towel,best,60.00,6000,roll
CUP-1,Hot cup 12oz,Paper hot cup,hot cups,good,30.00,1000,sleeve
"""


def xlsx_bytes(rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    for row in ws.iter_rows():
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"  # keep "=..." as text, like a file saved with the text prefix
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def upload(name, content, mime="application/octet-stream"):
    return {"file": (name, content, mime)}
