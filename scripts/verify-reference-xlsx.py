"""Verify the generated XLSX against a sanitized Google Sheets style reference.
No paid calls, no network access, no mutation of either file.
"""
import sys
from copy import copy
from pathlib import Path
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

TABS=['Прямые покупатели','Лизинг','Посредники','Статистика','Легенда цветов']
COLS=[21,27,26,6,4]

def verify(template, output, names):
    source=load_workbook(template)
    produced=load_workbook(output)
    assert source.sheetnames==TABS, 'Template tabs differ from the five-sheet reference'
    assert produced.sheetnames==TABS, 'Generated tabs differ from the reference'
    for name,count in zip(TABS,COLS):
        s=source[name]
        t=produced[name]
        assert s.max_column==t.max_column==count, name+': columns'
        assert [s.cell(1,i).value for i in range(1,count+1)]==[
            t.cell(1,i).value for i in range(1,count+1)], name+': header order'
        assert s.freeze_panes==t.freeze_panes, name+': frozen panes'
        assert s.sheet_view.showGridLines==t.sheet_view.showGridLines, name+': gridlines'
        assert s.row_dimensions[1].height==t.row_dimensions[1].height, name+': header height'
        assert copy(s.cell(1,1).fill)==copy(t.cell(1,1).fill), name+': header fill'
        assert copy(s.cell(1,1).font)==copy(t.cell(1,1).font), name+': header font'
        assert len(s.conditional_formatting)==len(t.conditional_formatting), name+': formatting rules'
        for i in range(1,count+1):
            col=get_column_letter(i)
            assert s.column_dimensions[col].width==t.column_dimensions[col].width, (
                name+': width '+col)
    for tab,expected in zip(TABS[:3],names):
        if not expected:continue
        sh=produced[tab]
        columns={str(c.value or ''):c.column for c in sh[1]}
        actual=sh.cell(2,columns['Организация']).value
        assert actual==expected, tab+': company value does not match result'
        assert sh.cell(2,columns['ИНН']).number_format=='@',tab+': INN must be text'
        assert sh.cell(2,1).comment is not None,tab+': note missing in first column'
        assert sh.cell(2,columns['Организация']).comment is not None,tab+': note missing in organization cell'
    leg=produced['Легенда цветов']
    for row in range(2,8):
        assert str(leg.cell(row,4).value or '').startswith('=COUNTIF('), (
            'Legend formula missing in row '+str(row))
    assert produced['Прямые покупатели'].conditional_formatting, 'Conditional colors missing'
    print('PASS: 5 sheets, exact header order, widths, header style, frozen rows,')
    print('      conditional formatting, INN text, comments and legend formulas.')
    print('OUTPUT:',Path(output).resolve())

if __name__=='__main__':
    if len(sys.argv)!=6:raise SystemExit(
        'Usage: verify-reference-xlsx.py TEMPLATE.xlsx OUTPUT.xlsx BUYER_NAME LEASING_NAME INTERMEDIARY_NAME')
    verify(sys.argv[1],sys.argv[2],sys.argv[3:])
