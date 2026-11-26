#!/usr/bin/env python3
"""Scan official XML ZIP members in place; retain only study-specific legal-entity hits."""
import hashlib
import json
import os
import ssl
import time
from http.client import IncompleteRead, RemoteDisconnected
from collections import OrderedDict
from urllib.error import HTTPError, URLError
import re
import shutil
import sys
import tempfile
import unicodedata
import urllib.request
import zipfile
from datetime import date, datetime
from pathlib import Path
from xml.etree import ElementTree as ET

GIB=1024**3
RESERVE=2*GIB
MAX_HITS=24
FORMS=[
 ("фгуп","федеральное государственное унитарное предприятие"),
 ("гуп","государственное унитарное предприятие"),
 ("муп","муниципальное унитарное предприятие"),
 ("ооо","общество с ограниченной ответственностью"),
 ("пао","публичное акционерное общество"),
 ("оао","открытое акционерное общество"),
 ("зао","закрытое акционерное общество"),
 ("ао","акционерное общество")]

def clean(v):
    return " ".join(unicodedata.normalize("NFKC",str(v or "")).split())

def name_key(v):
    s=" ".join(re.findall(r"[a-zа-я0-9]+",clean(v).lower().replace("ё","е")))
    for form,long in FORMS:
        for p in (long,form):
            if s.startswith(p+" "):
                return form+":"+s[len(p)+1:]
        if s.endswith(" "+form):
            return form+":"+s[:-len(form)-1]
    return ""

def region_key(v):
    t=re.findall(r"[a-zа-я0-9]+",clean(v).lower().replace("ё","е"))
    aliases={"обл":"область","респ":"республика","окр":"округ","авт":"автономный"}
    return " ".join(sorted({aliases.get(x,x) for x in t if x not in ("г","город")}))

def inn_ok(v):
    return bool(re.fullmatch(r"[0-9]{10}",v or "")) and v!="0000000000" and (
        sum(int(a)*b for a,b in zip(v[:9],[2,4,10,3,5,9,4,6,8]))%11%10==int(v[9]))

def ogrn_ok(v):
    return bool(re.fullmatch(r"[0-9]{13}",v or "")) and v!="0000000000000" and int(v[:12])%11%10==int(v[12])

def as_date(v):
    for fmt in ("%d.%m.%Y","%Y-%m-%d"):
        try:
            return datetime.strptime(v or "",fmt).date()
        except ValueError:
            pass
    return None

def integer(v):
    return int(v) if re.fullmatch(r"[0-9]{1,9}",v or "") else None

def one(node,tag):
    a=node.findall(tag)
    return a[0] if len(a)==1 else None

def format_spec(kind,url):
    dataset={"sshr":"sshr2019","rsmp":"rsmp"}.get(kind)
    if not dataset:
        raise ValueError("FNS_DATASET_UNSUPPORTED")
    base="https://file.nalog.ru/opendata/7707329152-"+dataset+"/"
    m=re.fullmatch(re.escape(base)+r"data-([0-9]{8})-structure-([0-9]{8})\.zip",url)
    if not m:
        raise ValueError("FNS_ARCHIVE_URL_UNTRUSTED")
    release=datetime.strptime(m[1],"%Y%m%d" if kind=="sshr" else "%d%m%Y").date()
    return base+"structure-"+m[2]+".xsd",release

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        raise ValueError("FNS_ARCHIVE_REDIRECT_UNTRUSTED")

def fetch(url,path,limit):
    opener=urllib.request.build_opener(NoRedirect())
    req=urllib.request.Request(url,headers={"User-Agent":"RegionalResearch/2.1"})
    digest=hashlib.sha256()
    with opener.open(req,timeout=60) as res:
        length=res.headers.get("Content-Length","")
        if res.status!=200 or res.geturl()!=url or not re.fullmatch(r"[0-9]{1,12}",length):
            raise ValueError("FNS_ARCHIVE_HTTP_OR_SIZE_UNPROVEN")
        size=int(length)
        if not 0<size<=limit:
            raise ValueError("FNS_ARCHIVE_SIZE_LIMIT")
        if shutil.disk_usage(path.parent).free<size+RESERVE:
            raise ValueError("FNS_DISK_RESERVE")
        count=0
        with path.open("xb") as dst:
            while True:
                chunk=res.read(1024*1024)
                if not chunk:
                    break
                count+=len(chunk)
                if count>size or shutil.disk_usage(path.parent).free<RESERVE+len(chunk):
                    raise ValueError("FNS_DISK_OR_DOWNLOAD_LIMIT")
                dst.write(chunk)
                digest.update(chunk)
        if count!=size:
            raise ValueError("FNS_ARCHIVE_TRUNCATED")
    return {"bytes":size,"sha256":digest.hexdigest()}

class RangeArchive:
    """Seekable, bounded HTTP ZIP reader for low disk space.

    Require exact 206 responses and a stable strong ETag. Hash every byte
    of that representation in ascending order, including non-XML members
    and ZIP metadata. Never create a full archive file or accept a 200
    response in place of a range. Use normal HTTPS validation.
    """
    # Retry only transient transport failures. Identity and response
    # metadata failures remain immediate, non-retryable proof failures.
    MAX_BLOCK_RETRIES=5
    MAX_RUN_RETRIES=48
    MIN_RETRY_RANGE=1024**2
    RETRYABLE={"FNS_RANGE_TRUNCATED","FNS_RANGE_TRANSFER_INTERRUPTED",
               "FNS_RANGE_HTTP_TEMPORARY"}

    def __init__(self,url,limit,*,opener=None,block_size=16*1024**2,
                 progress=None,on_retry=None,sleep=time.sleep):
        self.url=url
        self.opener=opener or urllib.request.build_opener(NoRedirect())
        self.block_size=block_size
        self.progress=progress
        self.on_retry=on_retry
        self.sleep=sleep
        self.etag=""
        self.size=0
        self.pos=0
        self.closed=False
        self.cache=OrderedDict()
        self.digest=hashlib.sha256()
        self.next_block=0
        self.hashed=0
        self.wire_bytes=0
        self.requested_bytes=0
        self.requests=0
        self.retries=0
        self.hashing=False
        self.last_progress=0
        self.limit=limit
        # A one-byte request proves real range support before any large transfer.
        self._request(0,0,probe=True)
        self.blocks=(self.size+self.block_size-1)//self.block_size

    def _request(self,start,end,probe=False):
        # A logical block is returned only after all of its ranges pass
        # the existing strict response checks. Completed subranges stay
        # in memory; the incomplete range is discarded, never hashed.
        cursor=start
        window=end-start+1
        parts=[]
        failures=0
        while cursor<=end:
            last=min(end,cursor+window-1)
            try:
                body=self._request_once(cursor,last,probe=probe)
            except ValueError as exc:
                reason=str(exc)
                if reason not in self.RETRYABLE:
                    raise
                if failures>=self.MAX_BLOCK_RETRIES or self.retries>=self.MAX_RUN_RETRIES:
                    raise ValueError("FNS_RANGE_RETRY_EXHAUSTED") from exc
                failures+=1
                self.retries+=1
                # Shorter requests reduce the cost of another interruption.
                # Never enlarge a small remaining range.
                window=min(last-cursor+1,max(self.MIN_RETRY_RANGE,window//2))
                if self.on_retry:
                    self.on_retry({"reason":reason,"offset":cursor,
                        "failed_range_bytes":last-cursor+1,"next_range_bytes":window,
                        "block_retry":failures,"run_retries":self.retries})
                self.sleep(min(8,2**(failures-1)))
                continue
            parts.append(body)
            cursor=last+1
        return b"".join(parts)

    def _request_once(self,start,end,probe=False):
        # Charge all requests, including failed attempts, against a bounded
        # transfer allowance. Metadata seeks and smaller retry ranges may
        # add requests beyond the ordinary sequential block count.
        n=end-start+1
        if not probe and (self.requests>=self.blocks+32+3*self.MAX_RUN_RETRIES or
                          self.requested_bytes+n>self.size+(32+self.MAX_RUN_RETRIES)*self.block_size):
            raise ValueError("FNS_RANGE_BUDGET")
        h={"User-Agent":"RegionalResearch/2.1",
           "Accept-Encoding":"identity","Range":f"bytes={start}-{end}"}
        if not probe:
            h["If-Match"]=self.etag
        self.requests+=1
        self.requested_bytes+=n
        req=urllib.request.Request(self.url,headers=h)
        try:
            res=self.opener.open(req,timeout=60)
        except HTTPError as exc:
            retry_after=exc.headers.get("Retry-After") if exc.headers else None
            exc.close()
            if exc.code in (412,416):
                raise ValueError("FNS_RANGE_REPRESENTATION_CHANGED") from exc
            # Never retry explicit throttling or bypass a Retry-After.
            if exc.code==429 or retry_after:
                raise ValueError("FNS_RANGE_RATE_LIMITED") from exc
            if exc.code in (408,500,502,503,504):
                raise ValueError("FNS_RANGE_HTTP_TEMPORARY") from exc
            raise ValueError("FNS_RANGE_HTTP_UNAVAILABLE") from exc
        except URLError as exc:
            if isinstance(exc.reason,(TimeoutError,ConnectionError)) and not isinstance(exc.reason,ssl.SSLError):
                raise ValueError("FNS_RANGE_TRANSFER_INTERRUPTED") from exc
            raise ValueError("FNS_RANGE_HTTP_UNAVAILABLE") from exc
        except (TimeoutError,ConnectionError,RemoteDisconnected) as exc:
            raise ValueError("FNS_RANGE_TRANSFER_INTERRUPTED") from exc
        with res:
            if res.status!=206 or res.geturl()!=self.url:
                # Close without reading the body, especially for a full 200.
                raise ValueError("FNS_RANGE_UNSUPPORTED")
            content_range=res.headers.get("Content-Range","")
            m=re.fullmatch(r"bytes ([0-9]+)-([0-9]+)/([0-9]+)",content_range)
            if not m or int(m[1])!=start or int(m[2])!=end:
                raise ValueError("FNS_RANGE_RESPONSE_UNPROVEN")
            total=int(m[3])
            if not 0<total<=self.limit or end>=total:
                raise ValueError("FNS_ARCHIVE_SIZE_LIMIT")
            tag=res.headers.get("ETag","")
            if not re.fullmatch(r'"[\x21\x23-\x7e]+"',tag):
                raise ValueError("FNS_RANGE_STRONG_ETAG_REQUIRED")
            if probe and not self.etag:
                self.size=total
                self.etag=tag
            elif total!=self.size or tag!=self.etag:
                raise ValueError("FNS_RANGE_REPRESENTATION_CHANGED")
            length=res.headers.get("Content-Length")
            if (length is not None and length!=str(n)) or res.headers.get("Content-Encoding","identity").lower()!="identity":
                raise ValueError("FNS_RANGE_RESPONSE_UNPROVEN")
            try:
                body=res.read(n+1)
            except IncompleteRead as exc:
                self.wire_bytes+=len(exc.partial)
                raise ValueError("FNS_RANGE_TRUNCATED") from exc
            except (TimeoutError,ConnectionError,RemoteDisconnected) as exc:
                raise ValueError("FNS_RANGE_TRANSFER_INTERRUPTED") from exc
            self.wire_bytes+=len(body)
            if len(body)>n:
                raise ValueError("FNS_RANGE_RESPONSE_UNPROVEN")
            if len(body)<n:
                raise ValueError("FNS_RANGE_TRUNCATED")
            return body

    def _block(self,index):
        if index in self.cache:
            self.cache.move_to_end(index)
            return self.cache[index]
        start=index*self.block_size
        data=self._request(start,min(self.size,start+self.block_size)-1)
        self.cache[index]=data
        while len(self.cache)>3:
            self.cache.popitem(last=False)
        return data

    def _hash_through(self,index):
        while self.next_block<=index:
            data=self._block(self.next_block)
            self.digest.update(data)
            self.hashed+=len(data)
            self.next_block+=1
            if self.progress and (self.hashed-self.last_progress>=256*1024**2 or self.hashed==self.size):
                self.progress(self.hashed,self.size,self.requests)
                self.last_progress=self.hashed

    def start_hashing(self):
        self.hashing=True

    def finish(self):
        if not self.hashing:
            raise ValueError("FNS_RANGE_SCAN_INCOMPLETE")
        self._hash_through(self.blocks-1)
        if self.hashed!=self.size:
            raise ValueError("FNS_RANGE_HASH_INCOMPLETE")
        return {"bytes":self.size,"sha256":self.digest.hexdigest(),
                "archive_mode":"http_range","range_requests":self.requests,
                "transferred_bytes":self.wire_bytes,
                "requested_bytes":self.requested_bytes,"range_retries":self.retries}

    def tell(self):
        return self.pos

    def seekable(self):
        return True

    def readable(self):
        return True

    def seek(self,offset,whence=os.SEEK_SET):
        base={os.SEEK_SET:0,os.SEEK_CUR:self.pos,os.SEEK_END:self.size}.get(whence)
        if base is None or base+offset<0:
            raise OSError("FNS_RANGE_INVALID_SEEK")
        self.pos=base+offset
        return self.pos

    def read(self,n=-1):
        if self.closed:
            raise ValueError("FNS_RANGE_CLOSED")
        remaining=max(0,self.size-self.pos)
        n=remaining if n is None or n<0 else min(n,remaining)
        # ZIP metadata and parser reads must remain bounded.
        if n>64*1024**2:
            raise ValueError("FNS_RANGE_READ_LIMIT")
        out=[]
        while n>0:
            index,offset=divmod(self.pos,self.block_size)
            if self.hashing and index>=self.next_block:
                self._hash_through(index)
            block=self._block(index)
            take=min(n,len(block)-offset)
            out.append(block[offset:offset+take])
            self.pos+=take
            n-=take
        return b"".join(out)

    def close(self):
        self.cache.clear()
        self.closed=True

    def __enter__(self):
        return self

    def __exit__(self,*_):
        self.close()

def schema_check(path,kind):
    # Verify declarations, not full XSD validation. Check actual record scope independently.
    data=path.read_bytes()
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data or b"\x00" in data:
        raise ValueError("FNS_SCHEMA_UNSAFE_DECLARATION")
    root=ET.fromstring(data)
    ns="{http://www.w3.org/2001/XMLSchema}"
    e={x.get("name") for x in root.iter(ns+"element")}
    a={x.get("name") for x in root.iter(ns+"attribute")}
    req_e={"Файл","Документ"}|({"СведНП","СведССЧР"} if kind=="sshr" else {"ОргВклМСП","СведМН"})
    req_a={"ИННЮЛ","НаимОрг","ДатаСост"}|({"КолРаб"} if kind=="sshr" else {"ОГРН","КодРегион","ВидСубМСП"})
    if root.tag!=ns+"schema" or not req_e<=e or not req_a<=a:
        raise ValueError("FNS_SCHEMA_UNSUPPORTED")

def parse_document(doc,kind,release,year):
    observed=as_date(doc.get("ДатаСост"))
    if kind=="rsmp":
        # Do not collect personal identifiers or names.
        if doc.get("ВидСубМСП")!="1":
            return None
        org=one(doc,"ОргВклМСП")
        loc=one(doc,"СведМН")
        if org is None or loc is None or observed!=release:
            return False
        inn,ogrn=org.get("ИННЮЛ",""),org.get("ОГРН","")
        rc=loc.get("КодРегион","")
        if not inn_ok(inn) or not ogrn_ok(ogrn) or not re.fullmatch(r"[0-9]{2}",rc):
            return False
        region_el=one(loc,"Регион")
        region=clean(" ".join([region_el.get("Наим",""),region_el.get("Тип","")])) if region_el is not None else ""
        cities=[clean(e.get("Наим","")) for e in loc if e.tag in ("Город","НаселПункт") and clean(e.get("Наим",""))]
        employees=integer(doc.get("ССЧР")) if year==release.year-(1 if release.month>=7 else 2) else None
        short=clean(org.get("НаимОргСокр"))
    else:
        org=one(doc,"СведНП")
        staff=one(doc,"СведССЧР")
        if org is None or staff is None or observed not in (date(year,12,31),date(year+1,1,1)):
            return False
        inn=org.get("ИННЮЛ","")
        employees=integer(staff.get("КолРаб"))
        if not inn_ok(inn) or employees is None:
            return False
        ogrn,rc,region,short,cities="","","","",[]
    full=clean(org.get("НаимОрг"))
    if not full or len(full)>1000 or len(short)>500:
        return False
    return {"inn":inn,"ogrn":ogrn,"full_name":full,"short_name":short,
            "region_code":rc,"region_name":region,"localities":cities,
            "employees":employees,"as_of":observed.isoformat(),
            "document_id":clean(doc.get("ИдДок"))[:100]}

def scan_archive(path,kind,release,year,targets):
    inns=set(targets["inns"])
    ogrns=set(targets["ogrns"])
    names={name_key(n) for n in targets["names"]}-{""}
    region=region_key(targets.get("region",""))
    multi="regional_targets" in targets
    regional={}
    if multi:
        items=targets["regional_targets"]
        if not isinstance(items,list) or not 1<=len(items)<=6:
            raise ValueError("FNS_OPEN_DATA_BATCH_LIMIT")
        for item in items:
            rk=region_key(item["region"])
            if not rk or rk in regional or len(rk)>250:
                raise ValueError("FNS_OPEN_DATA_BATCH_TARGET_INVALID")
            regional[rk]={name_key(n) for n in item["names"]}-{""}
            if not regional[rk]<=names:
                raise ValueError("FNS_OPEN_DATA_BATCH_TARGET_INVALID")
        if len(inns)+len(ogrns)+len(names)+sum(map(len,regional.values()))>4000:
            raise ValueError("FNS_OPEN_DATA_BATCH_LIMIT")
    hits={k:{} for k in ("by_inn","by_ogrn","by_name","by_name_region")}
    overflow={k:set() for k in hits}
    signatures={k:{} for k in hits}
    stats={"xml_members":0,"documents":0,"legal_records":0,"invalid_records":0,
           "skipped_non_legal":0,"declared_count_mismatch_members":0}
    def keep(group,key,row):
        bucket=hits[group].setdefault(key,[])
        signature=tuple(row[k] if k!="localities" else tuple(row[k]) for k in (
            "inn","ogrn","full_name","short_name","region_code","region_name","localities","employees","as_of"))
        seen=signatures[group].setdefault(key,set())
        if signature in seen:
            return
        if len(bucket)>=MAX_HITS:
            overflow[group].add(key)
            return
        seen.add(signature)
        bucket.append(row)
    with zipfile.ZipFile(path) as z:
        members=[m for m in z.infolist() if not m.is_dir()]
        xmls=[m for m in members if m.filename.lower().endswith(".xml")]
        if not xmls or len(members)>30000 or len({m.filename for m in members})!=len(members):
            raise ValueError("FNS_ZIP_MEMBERS_UNPROVEN")
        if sum(m.file_size for m in xmls)>48*GIB:
            raise ValueError("FNS_ZIP_UNCOMPRESSED_LIMIT")
        if isinstance(path,RangeArchive):
            # ZIP directory is already validated. Physical order lets the
            # reader hash nearly all compressed bytes in the same pass.
            path.start_hashing()
            xmls.sort(key=lambda member:member.header_offset)
        for member in xmls:
            if member.file_size>128*1024**2 or member.flag_bits&1:
                raise ValueError("FNS_ZIP_MEMBER_LIMIT")
            with z.open(member) as stream:
                parser=ET.XMLPullParser(events=("start","end"))
                root=None
                depth=count=0
                tail=b""
                def events():
                    nonlocal root,depth,count
                    for event,el in parser.read_events():
                        if event=="start":
                            depth+=1
                            if root is None:
                                root=el
                                expected="ОТКРДАННЫЕ3" if kind=="sshr" else "РЕЕСТРМСП"
                                if root.tag!="Файл" or root.get("ТипИнф")!=expected:
                                    raise ValueError("FNS_XML_FORMAT_UNSUPPORTED")
                        else:
                            if depth==2 and el.tag=="Документ":
                                count+=1
                                stats["documents"]+=1
                                row=parse_document(el,kind,release,year)
                                if row is None:
                                    stats["skipped_non_legal"]+=1
                                elif row is False:
                                    stats["invalid_records"]+=1
                                else:
                                    stats["legal_records"]+=1
                                    row["member"]=member.filename
                                    if row["inn"] in inns:
                                        keep("by_inn",row["inn"],row)
                                    if row["ogrn"] in ogrns:
                                        keep("by_ogrn",row["ogrn"],row)
                                    for k in {name_key(row["full_name"]),name_key(row["short_name"])}&names:
                                        keep("by_name",k,row)
                                        rk=region_key(row["region_name"])
                                        # In batch mode, preserve an independent capped
                                        # bucket per requested name AND legal region.
                                        if multi and k in regional.get(rk,()):
                                            keep("by_name_region",rk+"|"+k,row)
                                        elif not multi and region and rk==region:
                                            keep("by_name_region",k,row)
                                root.remove(el)
                                el.clear()
                            depth-=1
                while True:
                    chunk=stream.read(256*1024)
                    if not chunk:
                        break
                    probe=tail+chunk
                    if b"<!DOCTYPE" in probe or b"<!ENTITY" in probe or b"\x00" in probe:
                        raise ValueError("FNS_XML_UNSAFE_DECLARATION")
                    tail=probe[-16:]
                    parser.feed(chunk)
                    events()
                parser.close()
                events()
                if root is None or count==0 or depth!=0:
                    raise ValueError("FNS_XML_EMPTY_OR_TRUNCATED")
                if integer(root.get("КолДок"))!=count:
                    stats["declared_count_mismatch_members"]+=1
                stats["xml_members"]+=1
    if stats["legal_records"]==0:
        raise ValueError("FNS_NO_USABLE_LEGAL_RECORDS")
    result={"stats":stats,"hits":hits,"overflow":{k:sorted(v) for k,v in overflow.items()}}
    if multi:
        result.update(regional_key_mode="region_name_v1",regional_keys=sorted(regional))
    return result

def main():
    c=json.load(sys.stdin)
    kind,url,year=c["kind"],c["url"],c["year"]
    if type(year) is not int or not 2000<=year<=2100:
        raise ValueError("FNS_REPORT_YEAR_INVALID")
    schema_url,release=format_spec(kind,url)
    if release>date.today() or release.year not in (year+1,year+2):
        raise ValueError("FNS_RELEASE_YEAR_INVALID")
    with tempfile.TemporaryDirectory(prefix="fns-open-data-",dir=c["workdir"]) as tmp:
        tmp=Path(tmp)
        schema_meta=fetch(schema_url,tmp/"schema.xsd",1024*1024)
        schema_check(tmp/"schema.xsd",kind)
        try:
            meta=fetch(url,tmp/"dataset.zip",3*GIB)
        except ValueError as exc:
            if str(exc)!="FNS_DISK_RESERVE":
                raise
            print("[FNS_DATASET_RANGE_FALLBACK] "+json.dumps({"kind":kind,
                "reason":"FNS_DISK_RESERVE"}),file=sys.stderr,flush=True)
            def progress(hashed,total,requests):
                print("[FNS_DATASET_RANGE_PROGRESS] "+json.dumps({"kind":kind,
                    "bytes_hashed":hashed,"total_bytes":total,"range_requests":requests}),
                    file=sys.stderr,flush=True)
            def on_retry(info):
                print("[FNS_DATASET_RANGE_RETRY] "+json.dumps({"kind":kind,**info}),
                    file=sys.stderr,flush=True)
            with RangeArchive(url,3*GIB,progress=progress,on_retry=on_retry) as remote:
                print("[FNS_DATASET_RANGE_READY] "+json.dumps({"kind":kind,"bytes":remote.size}),
                    file=sys.stderr,flush=True)
                out=scan_archive(remote,kind,release,year,c["targets"])
                meta=remote.finish()
        else:
            meta["archive_mode"]="local_zip"
            print("[FNS_DATASET_DOWNLOADED] "+json.dumps({"kind":kind,**meta}),file=sys.stderr,flush=True)
            out=scan_archive(tmp/"dataset.zip",kind,release,year,c["targets"])
        out["source"]={"kind":kind,"url":url,"schema_url":schema_url,"schema_sha256":schema_meta["sha256"],
            "release":release.isoformat(),"report_year":year,**meta}
        print(json.dumps(out,ensure_ascii=True,separators=(",",":")))

if __name__=="__main__":
    try:
        main()
    except Exception as exc:
        code=str(exc)
        if not re.fullmatch(r"FNS_[A-Z_]{1,70}",code):
            code="FNS_ARCHIVE_OR_SCHEMA_UNAVAILABLE"
        print("[FNS_DATASET_ERROR] "+json.dumps({"reason":code}),file=sys.stderr,flush=True)
        sys.exit(2)
