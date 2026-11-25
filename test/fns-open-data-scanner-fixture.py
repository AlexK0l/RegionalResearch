import sys, json, importlib.util, zipfile, tempfile
from pathlib import Path
from datetime import date
spec=importlib.util.spec_from_file_location("scanner",sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
sshr='<Файл ТипИнф="ОТКРДАННЫЕ3" КолДок="2"><Документ ИдДок="1" ДатаСост="31.12.2025"><СведНП ИННЮЛ="4706000909" НаимОрг="АКЦИОНЕРНОЕ ОБЩЕСТВО &quot;ПРИМЕР&quot;"/><СведССЧР КолРаб="0"/></Документ><Документ ИдДок="2" ДатаСост="31.12.2024"><СведНП ИННЮЛ="4706000909" НаимОрг="АО ПРИМЕР"/><СведССЧР КолРаб="99"/></Документ></Файл>'
rsmp='<Файл ТипИнф="РЕЕСТРМСП" КолДок="2"><Документ ВидСубМСП="1" ДатаСост="10.11.2026" ССЧР="0"><ОргВклМСП ИННЮЛ="4706000909" ОГРН="1024701329377" НаимОрг="АКЦИОНЕРНОЕ ОБЩЕСТВО &quot;ПРИМЕР&quot;" НаимОргСокр="АО ПРИМЕР"/><СведМН КодРегион="47"><Регион Наим="Ленинградская" Тип="обл."/><Город Наим="Кировск"/></СведМН></Документ><Документ ВидСубМСП="2"><ИПВклМСП ИННФЛ="000000000000"/></Документ></Файл>'
targets={"inns":["4706000909"],"ogrns":["1024701329377"],"names":["АО ПРИМЕР"],"region":"Ленинградская область"}
out={}
with tempfile.TemporaryDirectory() as tmp:
    for kind,xml,release in [("sshr",sshr,date(2026,10,25)),("rsmp",rsmp,date(2026,11,10))]:
        p=Path(tmp)/(kind+".zip")
        with zipfile.ZipFile(p,"w",zipfile.ZIP_DEFLATED) as z:
            z.writestr("fixture.xml",xml.encode("utf8"))
        out[kind]=m.scan_archive(p,kind,release,2025,targets)
    p=Path(tmp)/"bad.zip"
    with zipfile.ZipFile(p,"w") as z:
        z.writestr("bad.xml",'<!DOCTYPE x [<!ENTITY a "b">]>'+sshr)
    try:
        m.scan_archive(p,"sshr",date(2026,10,25),2025,targets)
    except ValueError as e:
        assert str(e)=="FNS_XML_UNSAFE_DECLARATION"
    else:
        raise AssertionError("DTD accepted")
print(json.dumps(out))
