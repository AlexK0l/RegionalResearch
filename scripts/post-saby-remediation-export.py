#!/usr/bin/env python3
"""Offline supplementary audit workbook. Does NOT modify the five-sheet CRM."""
import json,sys
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font,PatternFill,Alignment
from openpyxl.utils import get_column_letter

def safe(value):
    if value is None:return ''
    text='; '.join(map(str,value)) if isinstance(value,list) else str(value)
    if text.startswith(('=','+','-','@')):text="'"+text
    return text[:32000]

def add_sheet(wb,name,headers,records):
    ws=wb.create_sheet(name)
    ws.append(headers)
    for record in records:
        ws.append([safe(record.get(h,'')) for h in headers])
    ws.freeze_panes='A2'
    ws.sheet_view.showGridLines=False
    ws.auto_filter.ref=ws.dimensions
    ws.row_dimensions[1].height=36
    for col in ws[1]:
        col.font=Font(bold=True,color='FFFFFF')
        col.fill=PatternFill('solid',fgColor='17223A')
        col.alignment=Alignment(wrap_text=True,vertical='center')
    for i,header in enumerate(headers,1):
        ws.column_dimensions[get_column_letter(i)].width=(
            60 if 'source' in header.lower() or 'claim' in header.lower()
            else 45 if header in ('organization','action') else 22)
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment=Alignment(vertical='top',wrap_text=True)

def main():
    if len(sys.argv)!=3:raise SystemExit(
        'Usage: post-saby-remediation-export.py REPORT.json REPORT.xlsx')
    report=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
    wb=Workbook()
    wb.remove(wb.active)
    summary=[{'metric':k,'count':v} for k,v in report['summary'].items()]
    add_sheet(wb,'Сводка',['metric','count'],summary)
    add_sheet(wb,'Без ИНН',[
        'organization','section','existing_inn','decision','next_action',
        'candidates'
    ],[{**row,'candidates':'; '.join(
         str(c.get('inn',''))+' ['+str(c.get('ownership_risk',''))+']'
         for c in row.get('candidates',[]))}
       for row in report.get('missing_inn',[])])
    add_sheet(wb,'Уровень A - источники',[
        'organization','inn','original_grade','priority','issue','selected_claim',
        'potential_sources','action'
    ],report.get('a_claim_source_review',[]))
    add_sheet(wb,'Saby частичные',[
        'organization','inn','sheet','contacts','trucks','vehicles',
        'email','reason','action','saby_source_url'
    ],report.get('saby_partial',[]))
    add_sheet(wb,'Saby без карточки',[
        'organization','inn','sheet','action'
    ],report.get('saby_not_captured',[]))
    out=Path(sys.argv[2])
    out.parent.mkdir(parents=True,exist_ok=True)
    if out.exists():raise FileExistsError(out)
    wb.save(out)

if __name__=='__main__':main()
