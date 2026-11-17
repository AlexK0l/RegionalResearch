// Real Stage13 sources: the researcher's attributed notes + Saby records.
// TORGBOX is not a current source. This module only extracts vehicle names;
// it does not establish ownership, current operation or category A/B/C.
const norm=x=>String(x||"").normalize("NFKC").toUpperCase().replace(/Ё/g,"Е")
  .replace(/[‐‑‒–—−]/g,"-").replace(/\s+/g," ").trim();
const esc=x=>x.replace(/[.*+?^$()|[\]{}]/g,"\\$&");
const MAKES_EXTRA=[
  "KÖGEL","KOGEL","KOEGEL","V-TRAILER","SCHMITZ CARGOBULL",
  "NOVTRAK","NOOTEBOOM","SCHWARZMÜLLER","SCHWARZMULLER",
  "LAMBERET","CHEREAU","GOLDHOFER","FAYMONVILLE","CIMC","KOLUMAN"
];
const VEHICLE_ANCHOR=/полуприцеп[а-яё-]*|п\s*\/\s*прицеп[а-яё]*|автопоезд[а-яё]*|тягач[а-яё]*|транспортн[а-яё]*\s+(?:средств|техник)/giu;
const MODEL_LABEL=/(?:марки|марка|модель|модели|производител[ья])\s*[:«"—-]?\s*/giu;
const NON_MAKE=/^(?:ООО|ПАО|АО|ЗАО|МУП|ОАО|ГК|ИП|ГОДА|ГОДУ|МАСЕЛ|МОЩНОСТЬЮ|ЕДИНИЦ|ТРАНСПОРТ|КОМПАНИЯ|ПРИЦЕП|ПОЛУПРИЦЕП|ТРАКТОРНЫЙ|ЗАКРЕПЛЕНЫ)$/iu;
const NON_MODEL=/^(?:ГРУЗОВОЙ|БОРТОВОЙ|ТЕНТОВЫЙ|САМОСВАЛЬНЫЙ|ШТОРА|ШТОРНИК|МОДЕЛЬ|НЕИЗВЕСТНА|ПОЛУПРИЦЕП|ПРИЦЕП|ЛИНИИ|МАСЕЛ|МОЩНОСТЬЮ)$/iu;
function modelCode(text,knownMake){
  const hit=String(text||"").match(/^\s+([\p{L}\d*./_-]{1,28})(?:\s+(\d[\p{L}\d./_-]{0,26}))?/u);
  if(!hit)return "";
  const first=hit[1],second=hit[2]||"";
  if(NON_MODEL.test(norm(first))||/^19\d\d$/.test(first)||/^20[0-3]\d$/.test(first))return "";
  // SN 24, SDP 27 and SKO 24/L are multi-token model codes.
  if(/^[\p{Lu}][\p{Lu}.]{0,9}$/u.test(first)&&
     second.length>=2)return first+" "+second;
  if(/\d/u.test(first)&&! /^\d{1,2}$/.test(first))return first;
  if(knownMake&&/^[\p{Lu}][\p{L}.]{2,24}$/u.test(first))return first;
  return "";
}
function makesFromCatalog(catalog){
  const names=new Set([...MAKES_EXTRA,...catalog.map(x=>x.brand)].map(norm));
  return [...names].filter(Boolean).sort((a,b)=>b.length-a.length);
}
function matchesKnownMake(zone,base,makes){
  const found=[];
  const upper=norm(zone);
  for(const make of makes){
    const rx=new RegExp("(^|[^\\p{L}\\p{N}])"+esc(make).replace(/\s+/g,"\\s+")+"(?=\\s|$)","gu");
    for(const m of upper.matchAll(rx)){
      const at=m.index+m[1].length;
      const name=zone.slice(at,at+make.length);
      const code=modelCode(zone.slice(at+make.length),true);
      if(code)found.push({at:base+at,model_text:name+" "+code});
    }
  }
  return found;
}
function matchesNewMake(zone,base){
  const found=[];
  // A previously unseen manufacturer is eligible only with a substantial
  // alphanumeric model code in an explicit vehicle/model context.
  const rx=/([\p{Lu}][\p{L}-]{2,24})\s+((?:[\p{Lu}]{1,9}\s+)?\d[\p{L}\d./_-]{2,26}|[\p{Lu}][\p{L}\d./_-]{0,24}\d[\p{L}\d./_-]{0,24})/gu;
  for(const m of zone.matchAll(rx)){
    if(NON_MAKE.test(norm(m[1]))||NON_MODEL.test(norm(m[2]))||
       /^\d{4}$/.test(m[2]))continue;
    found.push({at:base+m.index,model_text:m[1]+" "+m[2]});
  }
  return found;
}
/** Source text only; no free-text name extraction without vehicle context. */
export function extractStage13EvidenceModels(text,{catalog=[],limit=3}={}){
  const src=String(text||"").normalize("NFKC").replace(/https?:\/\/\S+/gi," ");
  const zones=[];
  for(const anchor of src.matchAll(VEHICLE_ANCHOR)){
    zones.push({at:anchor.index,kind:"vehicle",
      text:src.slice(anchor.index,anchor.index+185).split(/[;\n]/)[0]});
  }
  for(const anchor of src.matchAll(MODEL_LABEL)){
    zones.push({at:anchor.index,kind:"model_label",
      text:src.slice(anchor.index,anchor.index+130).split(/[;\n]/)[0]});
  }
  const makes=makesFromCatalog(catalog),found=new Map();
  for(const zone of zones){
    for(const candidate of matchesKnownMake(zone.text,zone.at,makes)){
      found.set(norm(candidate.model_text),candidate);
    }
    if(zone.kind==="model_label"||
       /полуприцеп|прицеп|тягач|транспорт/iu.test(zone.text)){
      for(const candidate of matchesNewMake(zone.text,zone.at)){
        const key=norm(candidate.model_text);
        if(!found.has(key))found.set(key,candidate);
      }
    }
  }
  return [...found.values()].sort((a,b)=>a.at-b.at)
    .slice(0,Math.max(0,limit)).map(x=>x.model_text);
}
