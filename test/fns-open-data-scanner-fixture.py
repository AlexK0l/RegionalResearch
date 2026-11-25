import sys, json, importlib.util, zipfile, tempfile, io, hashlib, re
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
# A simulated HTTP origin exercises the same urllib Request headers and
# seekable ZIP parser without contacting any external site.
class Reply(io.BytesIO):
    def __init__(self,body,url,status,headers):
        super().__init__(body)
        self.url=url
        self.status=status
        self.headers=headers
    def geturl(self):
        return self.url

class Origin:
    def __init__(self,data,mode="ok"):
        self.data=data
        self.mode=mode
        self.calls=0
    def open(self,req,timeout):
        self.calls+=1
        h={k.lower():v for k,v in req.header_items()}
        match=re.fullmatch(r"bytes=(\d+)-(\d+)",h["range"])
        assert h["accept-encoding"]=="identity"
        a,b=map(int,match.groups())
        assert 0<=a<=b<len(self.data)
        if self.calls>1:
            assert h["if-match"]=='"fixture-zip"'
        body=self.data[a:b+1]
        tag='"fixture-zip"'
        if self.mode=="changed" and self.calls>1:
            tag='"other-zip"'
        if self.mode=="weak":
            tag='W/"fixture-zip"'
        headers={"Content-Range":f"bytes {a}-{b}/{len(self.data)}",
                 "Content-Length":str(len(body)),"ETag":tag}
        if self.mode=="wrong_range":
            headers["Content-Range"]=f"bytes 1-{b}/{len(self.data)}"
        if self.mode=="truncated" and self.calls>1:
            body=body[:-1]
        return Reply(body,req.full_url,200 if self.mode=="ignored" else 206,headers)

buffer=io.BytesIO()
with zipfile.ZipFile(buffer,"w",zipfile.ZIP_DEFLATED) as z:
    z.writestr("fixture.xml",rsmp.encode("utf8"))
    z.writestr("other.txt",bytes(range(256))*6)
data=buffer.getvalue()
url="https://file.nalog.ru/opendata/fixture.zip"
with m.RangeArchive(url,1024**2,opener=Origin(data),block_size=64) as remote:
    remote_out=m.scan_archive(remote,"rsmp",date(2026,11,10),2025,targets)
    meta=remote.finish()
    assert meta["sha256"]==hashlib.sha256(data).hexdigest()
    assert meta["bytes"]==len(data)
    assert remote_out==out["rsmp"]
    assert len(remote.cache)<=3
    assert meta["transferred_bytes"]>=len(data)
out["range"]=meta
for mode,code in [("ignored","FNS_RANGE_UNSUPPORTED"),
                  ("weak","FNS_RANGE_STRONG_ETAG_REQUIRED"),
                  ("changed","FNS_RANGE_REPRESENTATION_CHANGED"),
                  ("truncated","FNS_RANGE_TRUNCATED"),
                  ("wrong_range","FNS_RANGE_RESPONSE_UNPROVEN")]:
    try:
        with m.RangeArchive(url,1024**2,opener=Origin(data,mode),block_size=64) as remote:
            m.scan_archive(remote,"rsmp",date(2026,11,10),2025,targets)
            remote.finish()
    except ValueError as e:
        assert str(e)==code,(mode,str(e))
    else:
        raise AssertionError("Untrusted range accepted: "+mode)
print(json.dumps(out))
