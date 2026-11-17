// Stage13 inventory: model TYPE and evidence of ownership are separate facts.
// Do not use TORGBOX. Saby (грузовые) lists trucks, not semitrailers.
const norm=x=>String(x??"").normalize("NFKC").toLocaleUpperCase("ru-RU")
  .replace(/Ё/g,"Е").replace(/[‐‑‒–—−]/g,"-").replace(/\s+/g," ").trim();
const esc=x=>x.replace(/[|\\{}()[\]^$+*?.]/g,"\\$&");
const EXTRA=["KÖGEL","KOGEL","KOEGEL","V-TRAILER","SCHMITZ CARGOBULL",
  "SCHMITZ","WIELTON","KRONE","ТОНАР","TONAR","НЕФАЗ","NEFAZ","MEGA",
  "BONUM","GRUNWALD","STAS","LAMBERET","CHEREAU","GOLDHOFER","FAYMONVILLE",
  "KOLUMAN","NOOTEBOOM","SCHWARZMÜLLER","SCHWARZMULLER","KRAKER",
  "KNAPEN","МАЗ","MAZ","DAF","MAN","SCANIA","VOLVO","KAMAZ","КАМАЗ",
  "SITRAK","YAROSLAVICH"];
const CONTEXT=/полуприцеп|п\s*\/\s*прицеп|прицеп|сортиментовоз|автопоезд|седельн[а-яё]*\s+тягач|цистерн|трал|контейнеровоз|шторн|грузов[а-яё]*\s+автомоб|транспортн[а-яё]*\s+(?:средств|техник)|марки|модел[ьи]|лизинг|автотранспорт/iu;
const NON_MODEL=/^(?:VIN|ИНН|ОБЪЕМОМ[А-ЯЁ]*|CARGOBULL|ЛЕСОВОЗ[А-ЯЁ]*|САМОСВАЛ[А-ЯЁ]*|ПОЛУПРИЦЕП[А-ЯЁ]*|ПРИЦЕП[А-ЯЁ]*|СЕДЕЛЬН[А-ЯЁ]*|ТЯГАЧ[А-ЯЁ]*|ГРУЗОВ[А-ЯЁ]*|ТЕНТОВ[А-ЯЁ]*|БОРТОВ[А-ЯЁ]*|ШТОРН[А-ЯЁ]*|ЦИСТЕРН[А-ЯЁ]*|ТРАНСПОРТ[А-ЯЁ]*|АВТОМОБИЛ[А-ЯЁ]*|ТОНН[А-ЯЁ]*|МОДЕЛЬ|МОДЕЛИ|МАРКА|МАРКИ|КОМПАНИИ|МОЩНОСТЬЮ|ОБОРУДОВАНИЕ|ЛИНИИ|НЕИЗВЕСТНА|МЕЖДУНАРОДНЫХ)$/iu;
const NON_MAKE=/^(?:VIN|ИНН|ОБЪЕМОМ[А-ЯЁ]*|АСМАП|ПОЛУПРИЦЕП[А-ЯЁ-]*|КАМАЗ-САМОСВАЛ|ООО|АО|ПАО|ОАО|ЗАО|ГК|ИП|МУП|ГОДА|ГОДУ|СУД|ДОГОВОР|ТЕХНИКА|МОДЕЛЬ|ПРИЦЕП|КОМПАНИЯ|ТРАКТОРНЫЙ|ЗАКРЕПЛЕНЫ|МОЩНОСТЬЮ|МАСЕЛ)$/iu;
const EVENT=/приобр|купил|купила|куплен|лизингополуч|лизинг|в\s+собственност|собственн|владен|владеет|зарегистрирован|закреплен|закреплён|эксплуатир|использу|суд\s+установ|парк\s+(?:содержит|включает|состоит)|переданы|получил|выполнял[а-яё]*\s+перевоз/iu;
const UNPROVEN=/планир[а-яё]*\s+(?:приобр|закуп|купить)|план\s+закуп|запрос\s+цен|тендер\s+на|потенциал|предположител|потенциальн|возможн[а-яё]*\s+использован|не\s+(?:подтвержд[а-яё]*|установлен[а-яё]*|найден[а-яё]*|раскрыт[а-яё]*|доказан[а-яё]*|принадлеж[а-яё]*|имеет)|нет\s+(?:данных|сведений|подтверждения)|отсутств[а-яё]*/iu;
const EXPIRED=/договор[а-яё]*[^.;\n]{0,110}(?:заверш[а-яё]*|прекращ[а-яё]*|ист[её]к[а-яё]*)|(?:заверш[а-яё]*|ист[её]к[а-яё]*)[^.;\n]{0,110}договор/iu;
const urlIn=text=>(String(text||"").match(/https?:\/\/[^\s<>\])]+/i)?.[0]||"")
  .replace(/[.,;!?]+$/,"");
function readCode(text){
  const m=String(text||"").match(/^[\s\-–—]*(?:№\s*)?([\p{L}\d*./_-]{2,31})(?:\s+(\d[\p{L}\d./_-]{0,25}))?/u);
  if(!m)return "";
  const first=m[1].replace(/[.,;:]+$/,""),second=m[2]||"";
  if(NON_MODEL.test(norm(first))||/^19\d\d$|^20[0-3]\d$/.test(first)||
     /^\d{1,2}$/.test(first))return "";
  if(second&&/^[\p{L}.]{1,9}$/u.test(first))return first+" "+second;
  if(/\d/u.test(first)||/\./u.test(first))return first;
  return /^\p{Lu}[\p{L}]{2,20}$/u.test(first)?first:"";
}
function scanModels(text,catalog){
  const src=String(text||"").normalize("NFKC"),upper=norm(src),
    makes=[...new Set([...EXTRA,...catalog.map(x=>x.brand)].map(norm))]
      .sort((a,b)=>b.length-a.length),found=[],occupied=[];
  for(const make of makes){
    const rx=new RegExp("(^|[^\\p{L}\\p{N}])"+esc(make).replace(/\s+/g,"\\s+")+
      "(?=\\s|[-–—]|$)","gu");
    for(const m of upper.matchAll(rx)){
      const at=m.index+m[1].length;
      if(occupied.some(x=>at>=x.start&&at<x.end))continue;
      const code=readCode(src.slice(at+make.length));
      if(!code)continue;
      found.push({model_text:src.slice(at,at+make.length)+" "+code,at});
      occupied.push({start:at,end:at+make.length});
    }
  }
  if(CONTEXT.test(src)){
    const rx=/(?<![\p{L}\p{N}])([\p{Lu}][\p{L}-]{2,23})\s+((?:[\p{Lu}]{1,9}\s+)?(?:\d[\p{L}\d./_-]{2,27}|[\p{Lu}][\p{L}\d./_-]{0,24}\d[\p{L}\d./_-]{0,24}))/gu;
    for(const m of src.matchAll(rx)){
      const at=m.index,brand=m[1],model=m[2];
      if(occupied.some(x=>at>=x.start&&at<x.end)||
         NON_MAKE.test(norm(brand))||NON_MODEL.test(norm(model))||
         /^\d{4}$/.test(model)||
         /комбайн[а-яё]*[^.;]{0,42}$/iu.test(src.slice(Math.max(0,at-48),at)))continue;
      found.push({model_text:brand+" "+model,at});
    }
  }
  return found.sort((a,b)=>a.at-b.at);
}
export function stage13ModelSignature(text){
  return norm(text).replace(/[.,;:]+$/,"")
    .replace(/^SCHMITZ CARGOBULL\s+/,"SCHMITZ ")
    .replace(/^TONAR\s+/,"ТОНАР ")
    .replace(/^KÖGEL\s+|^KOEGEL\s+|^KOGEL\s+/,"KOGEL ")
    .replace(/(?<=\p{L})\s+(?=\d)/gu,"");
}
const priority=x=>({evidence:4,a_evidence:3,basis:2,segment:1}[x.source]||0)+
  (x.evidence_eligible?20:0);
export function extractStage13ModelInventory(row,{catalog=[],maxPerBuyer=50}={}){
  const e=row?.__evidence||{},notes=Array.isArray(e.notes)?e.notes:[],
    provenance=new Map((Array.isArray(e.inline_note_provenance)?
      e.inline_note_provenance:[]).filter(x=>Number.isInteger(x?.note_index))
      .map(x=>[x.note_index,x])),sources=[];
  for(const [index,note] of notes.entries()){
    const text=String(note||"");
    sources.push({source:"evidence",index,text,
      url:urlIn(text)||provenance.get(index)?.source_url||""});
  }
  for(const [source,key] of [["a_evidence","__a_evidence"],["basis","Основание"],["segment","Техника/сегмент"]]){
    const text=String(row?.[key]||"");
    if(text)sources.push({source,index:-1,text,url:urlIn(text)});
  }
  const found=new Map();
  for(const src of sources)for(const hit of scanModels(src.text,catalog)){
    const signature=stage13ModelSignature(hit.model_text),
      known=catalog.find(x=>stage13ModelSignature(x.brand+" "+x.model)===signature),
      context=src.text.slice(Math.max(0,hit.at-120),
        Math.min(src.text.length,hit.at+hit.model_text.length+100)),
      eligible=!!src.url&&src.source!=="segment"&&EVENT.test(context)&&
        !UNPROVEN.test(context)&&!EXPIRED.test(context),
      entry={source:src.source,index:src.index,text:src.text.slice(0,750),
        model_text:hit.model_text,signature,source_url:src.url||"",
        source_status:src.url?"source_attributed_not_live_verified":"source_not_attributed",
        evidence_eligible:eligible,catalog_tier:known?.tier||null,
        verification:known?"catalog":"openai",
        reason:known?"exact_catalog_match":eligible?"attributed_vehicle_event":
          src.url?"type_only_no_confirmed_ownership":"source_not_attributed"};
    const old=found.get(signature);
    if(!old)found.set(signature,{...entry,observations:[{
      source:src.source,index:src.index,source_url:src.url,evidence_eligible:eligible
    }]});
    else{
      const observations=old.observations;
      observations.push({source:src.source,index:src.index,
        source_url:src.url,evidence_eligible:eligible});
      if(priority(entry)>priority(old))found.set(signature,{...entry,observations});
    }
  }
  const all=[...found.values()].sort((a,b)=>priority(b)-priority(a));
  return {models:all.slice(0,maxPerBuyer),found_total:all.length,
    catalog_models:all.filter(x=>x.verification==="catalog").length,
    unknown_models:all.filter(x=>x.verification==="openai").length,
    skipped_due_to_limit:all.slice(maxPerBuyer).map(x=>x.model_text),
    excluded_saby_truck_list:/^Saby\s*\(грузовые\)\s*:/i.test(row?.["Наличие транспорта"]||"")};
}
