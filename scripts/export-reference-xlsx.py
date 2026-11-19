"""Strict styling from the user's sanitized Google Sheets -> XLSX reference.
No network calls. Never copy source companies into an output workbook.
Usage: python scripts/export-reference-xlsx.py TEMPLATE.xlsx OUTPUT.xlsx < result.json
"""
import sys, json, copy, re
from pathlib import Path
from openpyxl import load_workbook
from openpyxl.comments import Comment
from openpyxl.utils import get_column_letter, column_index_from_string
from openpyxl.worksheet.cell_range import CellRange
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.workbook.properties import CalcProperties
from validate_xlsx_package import validate_xlsx_package

SHEETS=['Прямые покупатели','Лизинг','Посредники','Статистика','Легенда цветов']
COUNTS={'Прямые покупатели':21,'Посредники':26,'Лизинг':27,'Статистика':6,'Легенда цветов':4}
EMAIL_COL='Электронная почта'

# Notes are Excel's legacy comments (VML objects). The default openpyxl
# shape is only 144x79 pixels, so a long URL at the beginning hides all facts.
# Set a readable size and remove XML-invalid characters before writing.
XML_INVALID=re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]')

def safe_cell_text(value,limit=32767):
    if not isinstance(value,str):
        return value
    return XML_INVALID.sub('',value)[:limit]

def put_text(cell,value):
    value=safe_cell_text(value)
    cell.value=value
    # Untrusted source fields are data, not spreadsheet formulas. An
    # accidental leading '=' can otherwise produce a repairable Excel error.
    if isinstance(value,str) and value.startswith('='):
        cell.data_type='s'

def put_note(cell,content,author,width=460,height=260):
    value=safe_cell_text(str(content or '').strip(),16000)
    if not value:return
    comment=Comment(value,author)
    comment.width=width
    comment.height=height
    cell.comment=comment

SECTIONS=[('Прямые покупатели','direct_buyers'),('Посредники','intermediaries'),('Лизинг','leasing')]
CHECKS={'Прямые покупатели':(1,9),'Посредники':(1,2,11),'Лизинг':(1,2,11)}
NUMERIC={'Выручка последнего подтвержденного года','Численность'}

# Defense in depth: even when invoked directly (outside the Node exporter),
# the strict reference XLSX contains numbers / explicit departments only.
# This never changes template layout, styles, comments or source JSON.
PHONE_RE=re.compile(r'(?<!\d)(?:\+7|7|8)(?:[\s().-]*\d){10}(?!\d)')
LOCAL_PHONE_RE=re.compile(r'(?<!\d)(?:\(\d{3}\)|\d{3})(?:[\s().-]*\d){7}(?!\d)')
DEPT_NAMES=[
 ('отдел продаж',r'отдел\s+продаж|sales\s+department'),
 ('отдел закупок',r'отдел\s+закупок'),
 ('отдел снабжения',r'отдел\s+снабжения'),
 ('отдел логистики',r'отдел\s+логистики'),
 ('транспортный отдел',r'транспортн(?:ый|ого)\s+отдел'),
 ('коммерческий отдел',r'коммерческ(?:ий|ого)\s+отдел'),
 ('отдел кадров',r'отдел\s+кадров'),
 ('бухгалтерия',r'бухгалтер(?:ия|ии)|accounting'),
 ('приёмная',r'при[её]мн(?:ая|ой)|reception'),
 ('диспетчерская',r'диспетчерск(?:ая|ой)'),
 ('сервисный отдел',r'сервисн(?:ый|ого)\s+отдел'),
 ('отдел поддержки',r'отдел\s+поддержки|техническ(?:ая|ой)\s+поддержк'),
 ('склад',r'(?:^|[\s:])склад(?:$|[\s:.,;])'),
 ('отдел аренды',r'отдел\s+аренды'),
 ('отдел по работе с клиентами',r'отдел\s+по\s+работе\s+с\s+клиентами'),
 ('секретариат',r'секретариат'),
 ('юридический отдел',r'юридическ(?:ий|ого)\s+отдел'),
]

def phone_digits(raw):
    digits=re.sub(r'\D','',raw)
    if len(digits)==11 and digits.startswith('8'):digits='7'+digits[1:]
    if len(digits)==10:digits='7'+digits
    return digits if len(digits)==11 and digits.startswith('7') else ''

def safe_phone_cell(value):
    if value is None:return ''
    parts=value if isinstance(value,list) else [value]
    found={}
    disputed=set()
    for item in parts:
        for segment in re.split(r'[;\r\n]+',str(item)):
            segment=segment.strip()
            if not segment:continue
            matches=list(PHONE_RE.finditer(segment))
            if not matches and (re.search(r'тел(?:ефон)?\.?|факс|моб\.?|контакт|phone|call',segment,re.I) or (
                not re.search(r'(?:^|\W)(?:инн|огрн|кпп|inn)(?:\W|$)',segment,re.I)
                and re.fullmatch(r'[\s()+\d.-]{10,26}',segment))):
                matches=list(LOCAL_PHONE_RE.finditer(segment))
            labels=[label for label,rx in DEPT_NAMES if re.search(rx,segment,re.I)]
            label=labels[0] if len(labels)==1 else ''
            for match in matches:
                phone=phone_digits(match.group(0))
                if not phone:continue
                old=found.get(phone)
                if old is None:found[phone]=label
                elif old and label and old!=label:
                    found[phone]=''
                    disputed.add(phone)
                elif not old and label and phone not in disputed:found[phone]=label
    return '; '.join(phone+(' ('+dept+')' if dept else '')
                     for phone,dept in found.items())

# The old research placed e-mails in the organization cell's comment.
# On old SQLite continuations rehydrate only explicit email facts belonging to
# the current row, especially the exact-INN Saby card. Never scrape unrelated
# notes for a plausible address.
EMAIL_RE=re.compile(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+",re.I)

def safe_email_cell(row):
    evidence=row.get('__evidence') or {}
    saby=evidence.get('saby') or {}
    comment=str(row.get('__comment') or '')
    line=re.search(r'^Email:\s*([^\r\n]*)',comment,re.I|re.M)
    inputs=[row.get(EMAIL_COL),row.get('Email'),evidence.get('email'),
            line.group(1) if line else '']
    if (str(saby.get('inn') or '')==str(row.get('ИНН') or '').strip()
        and str(saby.get('source_url') or '').startswith('https://profile.saby.ru/')
        and (saby.get('collection') or {}).get('contacts')=='collected'):
        inputs.append(saby.get('emails'))
    found=[]
    for item in inputs:
        parts=item if isinstance(item,list) else [item]
        for part in parts:
            for match in EMAIL_RE.findall(str(part or '')[:3000]):
                addr=match.lower()
                local,domain=addr.rsplit('@',1)
                if (len(addr)>254 or len(local)>64 or local.startswith('.')
                    or local.endswith('.') or '..' in local
                    or len(found)>=20):continue
                if addr not in found:found.append(addr)
    return '; '.join(found)

def shift_range_columns(value, inserted):
    cr=CellRange(str(value))
    if cr.min_col>=inserted:
        cr.min_col+=1
        cr.max_col+=1
    elif cr.max_col>=inserted:
        cr.max_col+=1
    return str(cr)

def ensure_email_columns(wb):
    for name,_ in SECTIONS:
        ws=wb[name]
        headers=[str(cell.value or '') for cell in ws[1]]
        if EMAIL_COL in headers:
            assert headers.index(EMAIL_COL)+1==headers.index('Телефон'),name
            continue
        col=headers.index('Телефон')+1
        original_dims=[(key,copy.copy(dim)) for key,dim in ws.column_dimensions.items()]
        # Inserting at the source phone column does not modify formulas or
        # validations automatically in openpyxl, so shift these explicitly.
        validations=[(dv,[shift_range_columns(cr,col)
            for cr in dv.sqref.ranges]) for dv in ws.data_validations.dataValidation]
        old_cf=[(cf,[copy.copy(rule) for rule in rules])
            for cf,rules in ws.conditional_formatting._cf_rules.items()]
        ws.insert_cols(col)
        # openpyxl does not shift column_dimensions on insert_cols.
        # Rebuild their explicit OOXML min/max coordinates as well as keys;
        # keeping old entries creates conflicting column-width definitions.
        ws.column_dimensions.clear()
        for key,dim in original_dims:
            old_index=column_index_from_string(key)
            new_index=old_index+(1 if old_index>=col else 0)
            dim.index=get_column_letter(new_index)
            if dim.min:dim.min+=(1 if dim.min>=col else 0)
            if dim.max:dim.max+=(1 if dim.max>=col else 0)
            ws.column_dimensions[dim.index]=dim
        ws.column_dimensions[get_column_letter(col)].width=33
        for row in range(1,ws.max_row+1):
            dest=ws.cell(row,col);src=ws.cell(row,col+1)
            if src.has_style:dest._style=copy.copy(src._style)
            if row>1:dest.number_format='@'
        ws.cell(1,col).value=EMAIL_COL
        for dv,ranges in validations:dv.sqref=' '.join(ranges)
        ws.conditional_formatting._cf_rules.clear()
        for cf,rules in old_cf:
            ranges=' '.join(shift_range_columns(cr,col) for cr in cf.sqref.ranges)
            for rule in rules:
                if name=='Прямые покупатели' and rule.formula:
                    rule.formula=[re.sub(r'(?<![A-Z])(\$?)J(?=\$?\d)',r'\1K',
                        expr) for expr in rule.formula]
                ws.conditional_formatting.add(ranges,rule)

def validate(wb):
    if wb.sheetnames!=SHEETS:
        raise ValueError('Reference template has incorrect sheet order: '+repr(wb.sheetnames))
    for name,expected in COUNTS.items():
        ws=wb[name]
        has_email=name in [section[0] for section in SECTIONS] and any(
            str(cell.value or '')==EMAIL_COL for cell in ws[1])
        wanted=expected+(1 if has_email else 0)
        if ws.max_column!=wanted:
            raise ValueError(f'Reference {name}: expected {wanted} columns, got {ws.max_column}')
    for name,_ in SECTIONS:
        header=[str(c.value or '') for c in wb[name][1]]
        if header.count('Организация')!=1 or 'ИНН' not in header or 'Основание' not in header:
            raise ValueError('Reference template missing expected columns: '+name)

def rename_transport_header(wb):
    # Keep source header position, width, formatting, formulas and validation.
    # The sanitized Google Sheets reference can still have the legacy label.
    ws=wb['Прямые покупатели']
    for cell in ws[1]:
        if str(cell.value or '').strip()=='TORGBOX':
            cell.value='Наличие транспорта'

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
    if key=='Телефон':return safe_phone_cell(v)
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
                if h==EMAIL_COL:put_text(ws.cell(ri,ci),safe_email_cell(row))
                elif h and h in row:put_text(ws.cell(ri,ci),get_value(row,h))
                if h=='ИНН':ws.cell(ri,ci).number_format='@'
                # Like the original Google Sheet, "Основание" contains an
                # individualized short reason in the visible cell AND a note
                # explaining the exact saved evidence, with source links.
                # Do not add columns or replace the approved five-sheet style.
                if h=='Основание':
                    basis_note=str(row.get('__basis_comment') or '').strip()
                    if basis_note:
                        put_note(ws.cell(ri,ci),basis_note,
                                 'RegionalResearch · основания',
                                 width=500,height=300)
                # Strict customer workbook has only 22 buyer columns; the old
                # Google Sheets AK explanation column is not present. Preserve
                # the five-tab layout by attaching Stage13's explanation to E.
                if name=='Прямые покупатели' and h=='Итоговый коэффициент':
                    explanation=str(row.get('Обоснование коэффициента (Apps Script)') or '').strip()
                    if explanation:
                        put_note(ws.cell(ri,ci),explanation,
                                 'RegionalResearch · этап 13',
                                 width=460,height=300)
            for ci in CHECKS[name]:ws.cell(ri,ci).value=False
            note=str(row.get('__comment') or '').strip()
            if note:
                # The original five-sheet contract also has a comment on
                # column A. Keep it, but avoid duplicating the entire
                # source/evidence payload: show a short summary and point to
                # the full organization comment for links and requisites.
                short_lines=[line.strip() for line in note.splitlines()
                    if re.match(r'^(?:СВЕДЕНИЯ О КОМПАНИИ|Краткое основание:|Деятельность:)',line.strip(),re.I)]
                short_note='\\n'.join(short_lines[:3])[:700]
                short_note+=("\\nПодробности и источники — в примечании к названию организации.")
                put_note(ws.cell(ri,1),short_note,
                         'RegionalResearch',width=390,height=170)
                put_note(ws.cell(ri,headers.index('Организация')+1),note,
                         'RegionalResearch',width=500,height=300)
        end=max(2,len(records)+1)
        if ws.auto_filter.ref:ws.auto_filter.ref=f'A1:{get_column_letter(len(headers))}{end}'
        if name=='Прямые покупатели':
            for key in list(ws.conditional_formatting):
                rules=list(ws.conditional_formatting[key])
                del ws.conditional_formatting[str(key.sqref)]
                for rule in rules:ws.conditional_formatting.add(f'A2:{get_column_letter(len(headers))}{end}',rule)
            for dv in ws.data_validations.dataValidation:
                if 'K2' in str(dv.sqref):dv.sqref=f'K2:K{end}'
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
        for ci,h in enumerate(headers,1):put_text(stats.cell(ri,ci),row.get(h))
    stats.auto_filter.ref=f'A1:F{max(2,len(stat_rows)+1)}'
    legend=wb['Легенда цветов']
    for ri in range(2,8):
        code=legend.cell(ri,1).value
        if code is not None:
            color_col=get_column_letter([c.value for c in wb['Прямые покупатели'][1]].index('Цвет усл. форматирование')+1)
            legend.cell(ri,4).value="=COUNTIF('Прямые покупатели'!"+color_col+"2:"+color_col+str(max(2,len(data.get('direct_buyers',[]))+1))+","+str(int(code))+")"
    wb.calculation=CalcProperties(calcMode='auto',fullCalcOnLoad=True,forceFullCalc=True)

def main():
    if len(sys.argv)!=3:raise SystemExit('Usage: python export-reference-xlsx.py template.xlsx output.xlsx < result.json')
    template,out=sys.argv[1:3]
    wb=load_workbook(template)
    validate(wb)
    rename_transport_header(wb)
    clear_existing(wb)
    ensure_email_columns(wb)
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
    # Do not serve an unparseable package to Excel. Errors propagate to
    # the HTTP endpoint as a clear export failure, never a corrupt download.
    validate_xlsx_package(out)

if __name__=='__main__':main()
