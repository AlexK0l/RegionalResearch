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
EMAIL='Электронная почта'

def verify(template, output, names):
    source=load_workbook(template)
    produced=load_workbook(output)
    assert source.sheetnames==TABS, 'Template tabs differ from the five-sheet reference'
    assert produced.sheetnames==TABS, 'Generated tabs differ from the reference'
    for name,count in zip(TABS,COLS):
        s=source[name]
        t=produced[name]
        is_commercial=name in TABS[:3]
        src_headers=[s.cell(1,i).value for i in range(1,count+1)]
        if name=='Прямые покупатели':
            src_headers=['Наличие транспорта' if str(v or '').strip()=='TORGBOX' else v
                         for v in src_headers]
        if is_commercial:
            assert src_headers.count('Телефон')==1,name+': source phone'
            at=src_headers.index('Телефон')
            expected_headers=[*src_headers[:at],EMAIL,*src_headers[at:]]
        else:
            expected_headers=src_headers
        assert t.max_column==len(expected_headers),name+': columns'
        assert expected_headers==[
            t.cell(1,i).value for i in range(1,len(expected_headers)+1)
        ],name+': header order'
        assert s.freeze_panes==t.freeze_panes, name+': frozen panes'
        assert s.sheet_view.showGridLines==t.sheet_view.showGridLines, name+': gridlines'
        assert s.row_dimensions[1].height==t.row_dimensions[1].height, name+': header height'
        assert copy(s.cell(1,1).fill)==copy(t.cell(1,1).fill), name+': header fill'
        assert copy(s.cell(1,1).font)==copy(t.cell(1,1).font), name+': header font'
        assert len(s.conditional_formatting)==len(t.conditional_formatting), name+': formatting rules'
        for i in range(1,count+1):
            target=i+(1 if is_commercial and i>at else 0)
            src=get_column_letter(i);dst=get_column_letter(target)
            assert abs(s.column_dimensions[src].width-t.column_dimensions[dst].width)<0.01, (
                name+': width '+src+' -> '+dst)
        if is_commercial:
            email=t.cell(1,at+1)
            assert email.value==EMAIL and t.cell(1,at+2).value=='Телефон'
            assert email._style==t.cell(1,at+2)._style,name+': inserted header style'
            assert t.column_dimensions[email.column_letter].width>=25,name+': email width'
    for tab,expected in zip(TABS[:3],names):
        if not expected:continue
        sh=produced[tab]
        columns={str(c.value or ''):c.column for c in sh[1]}
        actual=sh.cell(2,columns['Организация']).value
        assert actual==expected, tab+': company value does not match result'
        assert columns[EMAIL]+1==columns['Телефон'],tab+': email before phone'
        assert sh.cell(2,columns['ИНН']).number_format=='@',tab+': INN must be text'
        assert sh.cell(2,1).comment is not None,tab+': note missing in first column'
        assert sh.cell(2,columns['Организация']).comment is not None,tab+': note missing in organization cell'
    leg=produced['Легенда цветов']
    for row in range(2,8):
        assert str(leg.cell(row,4).value or '').startswith('=COUNTIF('), (
            'Legend formula missing in row '+str(row))
    assert produced['Прямые покупатели'].conditional_formatting, 'Conditional colors missing'
    for row in range(2,8):
        assert '!K2:K' in str(leg.cell(row,4).value), 'Legend must follow shifted color column'
    for dv in produced['Прямые покупатели'].data_validations.dataValidation:
        assert 'J2:J' not in str(dv.sqref), 'Old color column validation not shifted'
    print('PASS: 5 sheets, exact header order, widths, header style, frozen rows,')
    print('      conditional formatting, INN text, comments and legend formulas.')
    print('OUTPUT:',Path(output).resolve())

if __name__=='__main__':
    if len(sys.argv)!=6:raise SystemExit(
        'Usage: verify-reference-xlsx.py TEMPLATE.xlsx OUTPUT.xlsx BUYER_NAME LEASING_NAME INTERMEDIARY_NAME')
    verify(sys.argv[1],sys.argv[2],sys.argv[3:])
