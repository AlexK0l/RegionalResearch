import sys
from openpyxl import Workbook
from openpyxl.styles import PatternFill, Font
from openpyxl.formatting.rule import CellIsRule
from openpyxl.comments import Comment

TABS=[("Прямые покупатели",21,2,15,4),("Лизинг",27,3,5,8),
("Посредники",26,3,5,8),("Статистика",6,0,0,0),("Легенда цветов",4,0,0,0)]
wb=Workbook()
wb.remove(wb.active)
for name,width,org,inn,basis in TABS:
 ws=wb.create_sheet(name)
 ws.freeze_panes="B2"
 ws.row_dimensions[1].height=35
 for col in range(1,width+1):
  cell=ws.cell(1,col,"Поле "+str(col))
  cell.fill=PatternFill("solid",fgColor="1F4E78")
  cell.font=Font(name="Calibri",size=10,bold=True,color="FFFFFF")
  ws.column_dimensions[cell.column_letter].width=14+col
 if org:
  ws.cell(1,org,"Организация")
  ws.cell(1,inn,"ИНН")
  ws.cell(1,basis,"Основание")
  ws.cell(2,org,"OLD-COMPANY-MUST-BE-CLEARED")
  ws.cell(2,org).comment=Comment("OLD-COMMENT","Reference")
  ws.cell(2,inn,"0000000000")
 if name=="Прямые покупатели":
  ws.cell(1,3,"TORGBOX")
  ws.cell(1,10,"Цвет усл. форматирование")
  ws.conditional_formatting.add("A2:U50",CellIsRule(operator="equal",formula=["1"],
   fill=PatternFill("solid",fgColor="C6EFCE")))
 if name=="Статистика":
  for col,title in enumerate(["Показатель","Значение","Единица измерения",
   "Период / дата актуальности","Источник","Методика / примечание"],1):
   ws.cell(1,col,title)
 if name=="Легенда цветов":
  for col,title in enumerate(["Код","Цвет","Пояснение",
   "Количество на листе «Прямые покупатели»"],1):
   ws.cell(1,col,title)
  for row in range(2,8):
   ws.cell(row,1,row-2)
   ws.cell(row,2,"Тест")
   ws.cell(row,3,"Тест")
   ws.cell(row,4,0)
wb.save(sys.argv[1])
