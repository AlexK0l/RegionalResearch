import sys, json, importlib.util, zipfile, tempfile, io, hashlib, re
from http.client import IncompleteRead
from urllib.error import HTTPError, URLError
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
    # Two regions share a legal name; national overflow must never erase
    # the second region's local hit. Use real-checksum synthetic identifiers.
    second_ogrn="102350000000"
    second_ogrn+=str(int(second_ogrn)%11%10)
    multi_xml=rsmp.replace('КолДок="2"','КолДок="3"').replace("</Файл>",
        '<Документ ВидСубМСП="1" ДатаСост="10.11.2026" ССЧР="8"><ОргВклМСП ИННЮЛ="7810165652" ОГРН="'+second_ogrn+
        '" НаимОрг="АО ПРИМЕР" НаимОргСокр="АО ПРИМЕР"/><СведМН КодРегион="35"><Регион Наим="Вологодская" Тип="обл."/><Город Наим="Вологда"/></СведМН></Документ></Файл>')
    p=Path(tmp)/"batch.zip"
    with zipfile.ZipFile(p,"w") as z:
        z.writestr("batch.xml",multi_xml.encode("utf8"))
    saved_max=m.MAX_HITS
    try:
        m.MAX_HITS=1
        out["batch"]=m.scan_archive(p,"rsmp",date(2026,11,10),2025,{
            "inns":targets["inns"],"ogrns":targets["ogrns"],"names":targets["names"],
            "regional_targets":[{"region":"Ленинградская область","names":targets["names"]},
                                {"region":"Вологодская область","names":targets["names"]}]})
    finally:
        m.MAX_HITS=saved_max
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
        self.fault=""
    def read(self,n=-1):
        if self.fault=="incomplete":
            raise IncompleteRead(super().read(max(0,n//2)),max(0,n//2))
        if self.fault=="timeout":
            raise TimeoutError("fixture body timeout")
        return super().read(n)
    def geturl(self):
        return self.url

class Origin:
    def __init__(self,data,mode="ok"):
        self.data=data
        self.mode=mode
        self.calls=0
        self.attempts=[]
    def open(self,req,timeout):
        self.calls+=1
        h={k.lower():v for k,v in req.header_items()}
        match=re.fullmatch(r"bytes=(\d+)-(\d+)",h["range"])
        assert h["accept-encoding"]=="identity"
        a,b=map(int,match.groups())
        assert 0<=a<=b<len(self.data)
        self.attempts.append((a,b))
        if self.calls>1:
            assert h["if-match"]=='"fixture-zip"'
        body=self.data[a:b+1]
        tag='"fixture-zip"'
        if (self.mode=="changed" and self.calls>1 or
                self.mode=="change_after_truncation" and self.calls==3):
            tag='"other-zip"'
        if self.mode=="weak":
            tag='W/"fixture-zip"'
        headers={"Content-Range":f"bytes {a}-{b}/{len(self.data)}",
                 "Content-Length":str(len(body)),"ETag":tag}
        if self.mode=="wrong_range":
            headers["Content-Range"]=f"bytes 1-{b}/{len(self.data)}"
        if (self.mode=="truncated" and self.calls>1 or
                self.mode in ("once_truncated","change_after_truncation") and self.calls==2):
            body=body[:-1]
        if self.mode=="temporary_http" and self.calls==2:
            raise HTTPError(req.full_url,503,"fixture",{},None)
        if self.mode=="throttled" and self.calls==2:
            raise HTTPError(req.full_url,429,"fixture",{},None)
        if self.mode=="timeout_open" and self.calls==2:
            raise URLError(TimeoutError("fixture"))
        reply=Reply(body,req.full_url,200 if self.mode=="ignored" else 206,headers)
        if self.calls==2 and self.mode in ("incomplete","timeout"):
            reply.fault=self.mode
        return reply

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
                  ("truncated","FNS_RANGE_RETRY_EXHAUSTED"),
                  ("change_after_truncation","FNS_RANGE_REPRESENTATION_CHANGED"),
                  ("throttled","FNS_RANGE_RATE_LIMITED"),
                  ("wrong_range","FNS_RANGE_RESPONSE_UNPROVEN")]:
    try:
        with m.RangeArchive(url,1024**2,opener=Origin(data,mode),block_size=64,sleep=lambda _:None) as remote:
            m.scan_archive(remote,"rsmp",date(2026,11,10),2025,targets)
            remote.finish()
    except ValueError as e:
        assert str(e)==code,(mode,str(e))
    else:
        raise AssertionError("Untrusted range accepted: "+mode)
# Recover each observed transient failure and require a bit-identical
# archive hash and equivalent full XML scan. No actual sleeps/network.
for mode in ("once_truncated","incomplete","timeout","timeout_open","temporary_http"):
    origin=Origin(data,mode)
    notices=[]
    with m.RangeArchive(url,1024**2,opener=origin,block_size=64,
                        sleep=lambda _:None,on_retry=notices.append) as remote:
        recovered=m.scan_archive(remote,"rsmp",date(2026,11,10),2025,targets)
        meta=remote.finish()
        assert recovered==out["rsmp"],mode
        assert meta["sha256"]==hashlib.sha256(data).hexdigest(),mode
        assert meta["range_retries"]==1 and len(notices)==1,mode
        assert origin.attempts[2][0]==origin.attempts[1][0],mode
        assert meta["requested_bytes"]>=len(data),mode

# Force subrange fallback with a small test-only minimum. The returned
# logical block must be identical, and the second request smaller.
origin=Origin(data,"once_truncated")
with m.RangeArchive(url,1024**2,opener=origin,block_size=64,sleep=lambda _:None) as remote:
    remote.MIN_RETRY_RANGE=8
    recovered=m.scan_archive(remote,"rsmp",date(2026,11,10),2025,targets)
    meta=remote.finish()
    assert recovered==out["rsmp"]
    assert meta["sha256"]==hashlib.sha256(data).hexdigest()
    assert origin.attempts[2][0]==origin.attempts[1][0]
    assert origin.attempts[2][1]<origin.attempts[1][1]
out["recovered_range"]=meta

# Persistent interruption must stop after the configured finite budget.
origin=Origin(data,"truncated")
try:
    with m.RangeArchive(url,1024**2,opener=origin,block_size=64,sleep=lambda _:None) as remote:
        remote.read(32)
except ValueError as e:
    assert str(e)=="FNS_RANGE_RETRY_EXHAUSTED"
    assert origin.calls==2+m.RangeArchive.MAX_BLOCK_RETRIES
else:
    raise AssertionError("unbounded retries")
print(json.dumps(out))
