"""Strict styling from the user's sanitized Google Sheets -> XLSX reference.
No network calls. Never copy source companies into an output workbook.
Usage: python scripts/export-reference-xlsx.py TEMPLATE.xlsx OUTPUT.xlsx < result.json
"""
import sys, json, copy, re
from pathlib import Path
from openpyxl import load_workbook
from openpyxl.comments import Comment
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.workbook.properties import CalcProperties

SHEETS=['Прямые покупатели','Лизинг','Посредники','Статистика','Легенда цветов']
COUNTS={'Прямые покупатели':21,'Посредники':26,'Лизинг':27,'Статистика':6,'Легенда цветов':4}
SECTIONS=[('Прямые покупатели','direct_buyers'),('Посредники','intermediaries'),('Лизинг','leasing')]
CHECKS={'Прямые покупатели':(1,8),'Посредники':(1,2,10),'Лизинг':(1,2,10)}
NUMERIC={'Выручка последнего подтвержденного года','Численность'}

def validate(wb):
    if wb.sheetnames!=SHEETS:
        raise ValueError('Reference template has incorrect sheet order: '+repr(wb.sheetnames))
    for name,expected in COUNTS.items():
        ws=wb[name]
        if ws.max_column!=expected:
            raise ValueError(f'Reference {name}: expected {expected} columns, got {ws.max_column}')
    for name,_ in SECTIONS:
        header=[str(c.value or '') for c in wb[name][1]]
        if header.count('Организация')!=1 or 'ИНН' not in header or 'Основание' not in header:
            raise ValueError('Reference template missing expected columns: '+name)

def clear_existing(wb):
    # The reference may contain real companies; never use it as output data.
    for name in SHEETS:
        ws=wb[name]
        if name=='Легенда цветов':
            continue
        for row in ws.iter_rows(min_row=2):
            for c in row:
                c.value=None
                c.comment=None
                if c.hyperlink:c.hyperlink=None
        if name=='Прямые покупатели':
            # Original dropdown values may contain employee names.
            for dv in list(ws.data_validations.dataValidation):
                if 'L33' in str(dv.sqref):
                    ws.data_validations.dataValidation.remove(dv)

def get_value(row,key):
    v=row.get(key)
    if v is None:return None
    if key in NUMERIC:
        if isinstance(v,(int,float)) and not isinstance(v,bool):return v
        if isinstance(v,str) and re.fullmatch(r'\s*[+-]?\d[\d ]*(?:[,.]\d+)?\s*',v):
            return float(v.replace(' ','').replace(',','.'))
        return None
    if key=='ИНН':return str(v).strip() if v else None
    return v

def render(wb,data):
    for name,section in SECTIONS:
        ws=wb[name];records=data.get(section,[])
        if not isinstance(records,list):raise ValueError(section+' must be an array')
        headers=[str(c.value or '') for c in ws[1]]
        for ri,row in enumerate(records,2):
            if not isinstance(row,dict):raise ValueError(section+' entry is not an object')
            if ri>ws.max_row:
                for col in range(1,len(headers)+1):
                    src=ws.cell(2,col);dest=ws.cell(ri,col)
                    if src.has_style:dest._style=copy.copy(src._style)
                ws.row_dimensions[ri].height=ws.row_dimensions[2].height
            for ci,h in enumerate(headers,1):
                if h and h in row:ws.cell(ri,ci).value=get_value(row,h)
                if h=='ИНН':ws.cell(ri,ci).number_format='@'
            for ci in CHECKS[name]:ws.cell(ri,ci).value=False
            note=str(row.get('__comment') or '').strip()
            if note:
                ws.cell(ri,1).comment=Comment(note,'RegionalResearch')
                ws.cell(ri,headers.index('Организация')+1).comment=Comment(note,'RegionalResearch')
        end=max(2,len(records)+1)
        if ws.auto_filter.ref:ws.auto_filter.ref=f'A1:{get_column_letter(len(headers))}{end}'
        if name=='Прямые покупатели':
            for key in list(ws.conditional_formatting):
                rules=list(ws.conditional_formatting[key])
                del ws.conditional_formatting[str(key.sqref)]
                for rule in rules:ws.conditional_formatting.add(f'A2:U{end}',rule)
            for dv in ws.data_validations.dataValidation:
                if 'J2' in str(dv.sqref):dv.sqref=f'J2:J{end}'
        # The exported reference contains boolean cells; in XLSX they are
        # displayed as TRUE/FALSE rather than native Google Sheets checkboxes.
        if records:
            for ci in CHECKS[name]:
                dv=DataValidation(type='list',formula1='"TRUE,FALSE"',allow_blank=True)
                ws.add_data_validation(dv)
                dv.add(f'{get_column_letter(ci)}2:{get_column_letter(ci)}{end}')
    stats=wb['Статистика']
    headers=[str(c.value or '') for c in stats[1]]
    stat_rows=data.get('statistics',[])
    if not isinstance(stat_rows,list):raise ValueError('statistics must be an array')
    for ri,row in enumerate(stat_rows,2):
        if not isinstance(row,dict):raise ValueError('statistics entry is not an object')
        for ci,h in enumerate(headers,1):stats.cell(ri,ci).value=row.get(h)
    stats.auto_filter.ref=f'A1:F{max(2,len(stat_rows)+1)}'
    legend=wb['Легенда цветов']
    for ri in range(2,8):
        code=legend.cell(ri,1).value
        if code is not None:
            legend.cell(ri,4).value="=COUNTIF('Прямые покупатели'!J2:J"+str(max(2,len(data.get('direct_buyers',[]))+1))+","+str(int(code))+")"
    wb.calculation=CalcProperties(calcMode='auto',fullCalcOnLoad=True,forceFullCalc=True)

def main():
    if len(sys.argv)!=3:raise SystemExit('Usage: python export-reference-xlsx.py template.xlsx output.xlsx < result.json')
    template,out=sys.argv[1:3]
    wb=load_workbook(template)
    validate(wb)
    clear_existing(wb)
    # Node writes UTF-8 bytes to stdin. Windows text pipes may default to
    # CP1251/CP866; decoding through sys.stdin would corrupt Cyrillic keys.
    # json.load(bytes) detects UTF-8 independently of the OS text code page.
    payload=json.load(sys.stdin.buffer)
    if isinstance(payload,dict) and isinstance(payload.get('final_result'),dict):
        payload=payload['final_result']
    if not isinstance(payload,dict):raise ValueError('Result must be object')
    render(wb,payload)
    Path(out).parent.mkdir(parents=True,exist_ok=True)
    wb.save(out)

if __name__=='__main__':main()
