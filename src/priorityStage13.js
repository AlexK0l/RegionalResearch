// Stage 13: deterministic color bands plus optional bounded OpenAI vehicle-type checks.
import {createHash} from "node:crypto";
import {extractStage13ModelInventory} from "./priorityStage13Inventory.js";
// The 57 explicit manufacturer/model pairs are supplied by the user.
// Never infer a model from a brand alone or promote a company grade A/B/C.
export const BANDS=Object.freeze({none:[0,19],ordinary:[20,39],white:[40,69],green:[70,100]});
export const CATALOG=Object.freeze([
["АЛЕКСЕЕВКА ХИММАШ","ЦЖУ-17.5-2.0","white"],
["ТВЕРЬСТРОЙМАШ","993931-0023","green"],
["GRUNWALD","9453-0000010-10","white"],
["GRUNWALD","9453-0000010-50","green"],
["GRUNWALD","9453-0000011-60","green"],
["ROBUSTE KAISER","S3803","green"],
["ТВЕРЬСТРОЙМАШ","993930","green"],
["GUTTRAILER","FSA453BA","white"],
["МАЗ","975830-3028-010","white"],
["YAROSLAVICH","ПС-15БМ","white"],
["БАЛТСПЕЦМАШ","945301","green"],
["СПЕЦПРИЦЕП","9942L3","green"],
["YAROSLAVICH","ПС-12","white"],
["АСТ-КАНАШ","949135","green"],
["JUTERBORG","985245","green"],
["PEZZAIOLI","SBA32U","green"],
["BONUM","914295-01","green"],
["BONUM","928111-01","white"],
["МАЗ","975800-2010","white"],
["МАЗ","975800-2012","white"],
["PEZZAIOLI","SBA63","green"],
["SCHMITZ","SCB*S3B","white"],
["SCHMITZ","SCB*S3T","white"],
["KAESSBOHRER","DL","green"],
["МАЗ","975800-030","white"],
["МАЗ","938660-044","white"],
["НЕФАЗ","96742-01","white"],
["СЕСПЕЛЬ","964827","white"],
["СЕСПЕЛЬ","DB4U50","green"],
["СЕСПЕЛЬ","DB4U51","green"],
["СЕСПЕЛЬ","DC4U55","green"],
["JM KIPPER","JML","green"],
["JM KIPPER","JMK","green"],
["SCHMITZ","SCS24","white"],
["SCHMITZ","SKO24","white"],
["BONUM","914211","white"],
["SCHMITZ","9084","white"],
["ТОНАР","952300","green"],
["ТОНАР","958920","green"],
["ТОНАР","959500","green"],
["ТОНАР","982620","green"],
["ТОНАР","998900","green"],
["WIELTON","NW-3","green"],
["АЛСА","948412","green"],
["KNAPEN","K100","green"],
["МОАРЗ","95999","green"],
["STAS","SA334K","green"],
["УЗСТ","917542","white"],
["ЧМЗАП","93853","green"],
["KRAKER","CFZ","green"],
["МАЗ","975800","white"],
["НЕФАЗ","9334","white"],
["MEGA","MNW3","green"],
["MEGA","MNW4","green"],
["MTDK","S340","green"],
["DENGA","C2","white"],
["KRONE","SD","white"]
].map(([brand,model,tier])=>Object.freeze({brand,model,tier})));
export const EXPLANATION_FIELD="Обоснование коэффициента (Apps Script)";

const str=x=>x==null?"":String(x).replace(/[\u00a0\u202f]/g," ");
const blank=x=>x==null||x==="";
const norm=x=>str(x).normalize("NFKC").toUpperCase().replace(/Ё/g,"Е")
  .replace(/[‐‑‒–—−]/g,"-").replace(/\s+/g," ").trim();
const escapeRE=s=>s.replace(/[.*+?^$()|[\]{}]/g,"\\$&");
const TRACTOR=/седельн[а-яё]*\s+тягач[а-яё]*/i;
const TRAILER=/полуприцеп[а-яё]*|п\s*\/\s*прицеп[а-яё]*/i;
const NEGATIVE=/не\s+(?:подтвержд[а-яё]*|найден[а-яё]*|установлен[а-яё]*|доказан[а-яё]*|доказыва[а-яё]*|выявлен[а-яё]*|раскрыт[а-яё]*|раскрыва[а-яё]*|указан[а-яё]*|указыва[а-яё]*|известн[а-яё]*|име[ею][а-яё]*|облада[а-яё]*)|принадлежност[а-яё]*[^.\n]{0,100}не\s+подтвержд|полуприцеп[а-яё]*[^.\n]{0,60}(?:отсутств[а-яё]*|не\s+найден[а-яё]*)|нет\s+(?:собственн[а-яё]*\s+)?полуприцеп[а-яё]*|нет\s+(?:достаточн[а-яё]*\s+)?(?:данных|сведений|подтверждения)\s+(?:о|об|для)?\s*(?:наличи[а-яё]*\s+)?(?:полуприцеп|прицепн)[а-яё]*|недостаточн[а-яё]*\s+(?:данных|сведений)|отсутстви[а-яё]*\s+(?:собственн[а-яё]*\s+)?полуприцеп[а-яё]*/i;
const POSITIVE=/зафиксирован[а-яё]*|зарегистрирован[а-яё]*|в\s+реестр[а-яё]*|в\s+залоге|эксплуатир[а-яё]*|использу[а-яё]*|принадлежит|в\s+собственност[а-яё]*|собственн[а-яё]*\s+парк|подтвержден[а-яё]*\s+(?:наличие|эксплуатац)/i;
const EXPIRED=/договор[а-яё]*[^.;\n]{0,80}(?:заверш[а-яё]*|прекращ[а-яё]*|ист[её]к[а-яё]*)|(?:заверш[а-яё]*|ист[её]к[а-яё]*)[^.;\n]{0,80}договор/i;
function startModel(line,{brand,model}){
  const full=norm(brand+" "+model);
  return line.startsWith(full)&&(line.length===full.length||/^[\s(;,]/.test(line.slice(full.length)));
}
function basisModel(text,{brand,model}){
  const full=norm(brand+" "+model);
  return new RegExp("(^|[^A-ZА-Я0-9])"+escapeRE(full).replace(/ /g,"\\s+")+
    "(?=$|[^A-ZА-Я0-9.\\-]|\\.(?=\\s|$|[,;]))").test(text);
}
function quantity(line){
  const m=line.match(/[—–-]\s*(\d+)\s*(?:шт|ед)(?:\.|иниц(?:ы|а)?)?(?=\s|$|[;,])/i);
  return m?Number(m[1]):1;
}
function parseTransport(raw){
  const res={tier:"none",green:0,white:0,ordinary:0,tractor:false,unknown:0,
    unknownExamples:[],items:[]},found=new Map();
  // Saby (грузовые) lists TRUCKS, not proven semi-trailers. It often
  // contains dozens of valid truck models; they are neither missing catalog
  // entries nor grounds for warning/priority. TORGBOX lists remain eligible.
  const parts=str(raw).split(/[\r\n;]+/).map(x=>x.trim()).filter(Boolean);
  let sabyTrucks=false;
  for(let line of parts){
    if(/^Saby\s*\((?:грузовые|автопарк)\)\s*:/i.test(line)){sabyTrucks=true;continue;}
    if(/^TORGBOX\s*:/i.test(line)){
      sabyTrucks=false;
      line=line.replace(/^TORGBOX\s*:\s*/i,"").trim();
    }
    if(sabyTrucks)continue;
    const q=quantity(line);
    if(!Number.isFinite(q)||q<1)continue;
    if(TRACTOR.test(line))res.tractor=true;
    const matched=CATALOG.find(item=>startModel(norm(line),item));
    if(matched){
      res[matched.tier]+=q;
      const key=matched.brand+" "+matched.model;
      if(!found.has(key))found.set(key,{model:key,tier:matched.tier,count:0,source:"C"});
      found.get(key).count+=q;
    }else if(TRAILER.test(line)&&!NEGATIVE.test(line))res.ordinary+=q;
    else if(!TRACTOR.test(line)){
      res.unknown++;
      if(res.unknownExamples.length<3)res.unknownExamples.push(line);
    }
  }
  res.items=[...found.values()];
  res.tier=res.green?"green":res.white?"white":res.ordinary?"ordinary":"none";
  return res;
}
function parseBasis(raw){
  const text=str(raw).split(/;\s*сегмент\s*:/i)[0],negative=NEGATIVE.test(text),
    expired=EXPIRED.test(text),hasMention=TRAILER.test(text);
  const res={tier:"none",qty:0,models:[],negative,expired,uncertain:false};
  if(POSITIVE.test(text)&&!negative&&!expired){
    for(const item of CATALOG)if(basisModel(norm(text),item))
      res.models.push({model:item.brand+" "+item.model,tier:item.tier,count:1,source:"D"});
  }
  if(res.models.length){
    res.tier=res.models.some(x=>x.tier==="green")?"green":"white";
    res.qty=1;
  }else if(hasMention&&!negative&&!expired){
    const match=TRAILER.exec(text);
    const before=text.slice(Math.max(0,match.index-50),match.index);
    const number=before.match(/(?:^|\D)(\d{1,3})\s*(?:шт\.?|ед\.?)?\s*(?:самосвальн[а-яё]*\s+)?$/i);
    res.qty=number?Number(number[1]):1;
    if(res.qty>0)res.tier="ordinary";
  }else if(hasMention&&(negative||expired))res.uncertain=true;
  return res;
}
// Final qualification may replace D with a generic statement such as
// "A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную...".
// This statement does not itself identify the trailer. Reconstruct the
// original evidentiary D from the already-saved, source-linked notes instead.
// Never treat a speculative segment description as proof.
const GENERIC_BASIS=/^\s*A\s*[—–-]\s*Конкретный evidence-note одновременно подтверждает прицепную\s*\/\s*полуприцепную технику/i;
const PROOF_NOTE=/суд\s+(?:установил|подтвердил|признал)|судебн|закупк|приобр|покупк|договор|лизинг|аренд|владени|владел|принадлеж|собственн|эксплуат|использу|зарегистр|зафиксир|в\s+залог|парк|передал|передан|в\s+реестр|выполнял[а-яё]*\s+перевоз|указан[а-яё]*\s+полуприцеп/i;
const PROSPECTIVE=/потенциальн|предположител|теоретическ|может\s+(?:потребова|использова)|вероятн\s+потребност|не\s+раскрыт[а-яё]*|не\s+подтвержд[а-яё]*/i;
// A broad job-search result does not identify this company's fleet. Mere
// appearance in a query named "водитель на полуприцепе" is not equipment proof.
const GENERIC_SEARCH_MENTION=/(?:^|\s)в\s+(?:(?:региональн|тематическ)[а-яё]*\s+)?выдач[а-яё]*/i;
// Technical classifications mention both trailers and semi-trailers even
// when the actually purchased item is explicitly a non-semi trailer.
const TAXONOMY_ONLY_TRAILER=/ОКПД\s*2?|ТН\s*ВЭД|классификатор/i;
const NON_SEMI_PURCHASE=/(?:закуп[а-яё]*|приобр[а-яё]*|постав[а-яё]*|купил[а-яё]*)[^.;\n]{0,180}(?:^|[^а-яё])прицеп[-\s]+(?:цистерн|самосвал|роспуск|платформ)[а-яё]*/i;
function normalizeNoteModel(text){
  // Canonical aliases preserve BOTH manufacturer and model; they never
  // classify on the basis of a manufacturer alone.
  return norm(text).replace(/SCHMITZ\s+CARGOBULL/g,"SCHMITZ")
    .replace(/\bSKO\s+24\b/g,"SKO24")
    .replace(/\bSCS\s+24\b/g,"SCS24");
}
// A note can prove historical ownership and then explicitly say that CURRENT
// use is not established. Remove unsupported clauses, not the valid earlier
// proof. Conversely, a purely negative clause cannot provide trailer evidence.
function affirmativeEvidence(note){
  return str(note).split(/;\s*|\.\s+(?=[А-ЯЁA-Z])|,\s*но\s+|\s+но\s+/i)
    .filter(clause=>!NEGATIVE.test(clause)&&!EXPIRED.test(clause)&&
      !PROSPECTIVE.test(clause)).join(" ");
}
function parseSourcedNotes(notes){
  const models=new Map();
  let ordinary=false;
  for(const raw of Array.isArray(notes)?notes.slice(0,150):[]){
    const note=str(raw);
    // A source URL directly in the SAME note is required; a row-level list
    // of unrelated source URLs cannot establish a model provenance.
    if(!/https?:\/\//i.test(note) || EXPIRED.test(note) ||
       GENERIC_SEARCH_MENTION.test(note) ||
       (TAXONOMY_ONLY_TRAILER.test(note) && NON_SEMI_PURCHASE.test(note)))continue;
    const claim=affirmativeEvidence(note);
    if(!PROOF_NOTE.test(claim))continue;
    const normalized=normalizeNoteModel(claim);
    const matched=CATALOG.filter(item=>basisModel(normalized,item));
    if(!matched.length && !TRAILER.test(claim))continue;
    for(const item of matched){
      const key=item.brand+" "+item.model;
      if(!models.has(key))models.set(key,{model:key,tier:item.tier,count:1,source:"evidence"});
    }
    if(!matched.length)ordinary=true;
  }
  const all=[...models.values()];
  return {tier:all.some(x=>x.tier==="green")?"green":
    all.some(x=>x.tier==="white")?"white":ordinary?"ordinary":"none",
    qty:ordinary||all.length?1:0,models:all};
}

function parseRevenue(value){
  if(typeof value==="number")return Number.isFinite(value)&&value>=0?value:null;
  const s=str(value).trim();
  if(!s)return null;
  if(/^\d[\d\s]*(?:[.,]0+)?$/.test(s)){
    const n=Number(s.replace(/\s/g,"").replace(",","."));return Number.isFinite(n)&&n>=0?n:null;
  }
  const r=s.match(/(\d[\d\s]*)(?:[.,]0+)?\s*(?:₽|руб(?:лей|ля|\.)?)/i);
  if(r)return Number(r[1].replace(/\s/g,""));
  const scaled=s.match(/(\d+(?:[.,]\d+)?)\s*(млрд|млн)(?![а-яё])/i);
  return scaled?Number(scaled[1].replace(",","."))*(scaled[2].toLowerCase()==="млрд"?1e9:1e6):null;
}
function parseStaff(value){
  if(typeof value==="number")return Number.isInteger(value)&&value>=0?value:null;
  const s=str(value).trim();
  if(!s)return null;
  if(/^\d+$/.test(s))return Number(s);
  let m=s.match(/(?:численность|персонал|штат)\s*[:—–-]?\s*(\d+)/i);
  if(!m)m=s.match(/(\d[\d\s]*)\s*(?:чел\.?|человек(?:а)?|сотрудник(?:ов|а|и)?)(?=\s|$|[,;.)])/i);
  return m?Number(m[1].replace(/\s/g,"")):null;
}
const qtyPoints=q=>q<=1?0:q<=3?4:q<=5?7:10;

/** Hash only relevant source fields: stale AI interpretations must not be reused. */
export function priority13InputHash(row){
  return createHash("sha256").update(JSON.stringify([
    str(row?.["Организация"]),
    // The new display-only all-category Saby line is deliberately excluded
    // from both scoring and AI model inventory. Appending it must not
    // invalidate previous paid model classifications or change priorities.
    str(row?.["Наличие транспорта"]||"").replace(/(?:^|\r?\n)Saby\s*\(автопарк\)\s*:[^\r\n]*/gi,"").trim(),
    str(row?.["Основание"]),
    str(row?.["Техника/сегмент"]),
    str(row?.__a_evidence),
    Array.isArray(row?.__evidence?.notes)?row.__evidence.notes:[],
    Array.isArray(row?.__evidence?.inline_note_provenance)?
      row.__evidence.inline_note_provenance:[]
  ])).digest("hex");
}

// Current RegionalResearch sources are Saby and source-attributed research
// evidence. TORGBOX is no longer used. Saby "Грузовые" identifies trucks,
// not an independent claim that a model is a semitrailer.
export function validPriority13ModelQuote(value){
  const q=str(value).trim(),first=q.split(/\s+/)[0];
  if(q.length<5||q.length>95||!/^\p{Lu}/u.test(first)||
     /^(?:ООО|АО|ПАО|ЗАО|ОАО|МУП|ИП|КОМПАНИЯ)$/iu.test(first))return false;
  const numeric=/^[\p{Lu}][\p{L}-]{2,}(?:\s+[\p{Lu}][\p{L}-]{2,})?\s+(?:[\p{Lu}]{1,8}\s+)?(?:\d[\p{L}\d*./_-]{0,25}|[\p{Lu}][\p{L}\d*./_-]{0,25}\d[\p{L}\d*./_-]{0,25})$/u;
  const letters=/^[\p{Lu}][\p{L}-]{2,}(?:\s+[\p{Lu}][\p{L}-]{2,})?\s+[\p{Lu}][\p{L}.]{2,25}$/u;
  return numeric.test(q)||letters.test(q);
}
export function exactPriority13ModelQuote(quote,text){
  const q=str(quote).trim(),s=str(text);
  if(!validPriority13ModelQuote(q))return false;
  const at=s.indexOf(q);
  if(at<0)return false;
  const part=/[\p{L}\p{N}*./_-]/u;
  return !part.test(s[at-1]||"")&&!part.test(s[at+q.length]||"");
}
const ACTUAL_EQUIPMENT_EVENT=/приобр[её]л|приобрела|приобретен|приобретён|приобретена|закупил|закупила|закуплен|купил|купила|в\s+лизинге|лизингов[а-яё]*\s+договор|арендует|арендовал|владени|владеет|принадлежит|в\s+собственност|эксплуатир|использова[а-яё]*|использует|зарегистрирован|на\s+балансе|закреплен[а-яё]*|закреплён[а-яё]*|суд\s+установил|подтвержден[а-яё]*\s+владен/i;
const UNCOMMITTED_PLAN=/планиру[а-яё]*\s+(?:приобр|закуп|купить)|план\s+закуп|намерен[а-яё]*\s+приобр|коммерческ[а-яё]*\s+предложени|запрос\s+цен|интерес\s+к\s+покупк/i;
// Inventory does NOT depend on existing ordinary/white/green tiers. A model
// absent from the fixed catalog must be typed even if the buyer already has
// an ordinary score. Type classification is NOT evidence of ownership.
export function priority13AICandidates(row,{maxPerBuyer=50}={}){
  const inventory=extractStage13ModelInventory(row,{catalog:CATALOG,maxPerBuyer});
  const fingerprint=priority13InputHash(row);
  return inventory.models.filter(m=>m.verification==="openai")
    .map(m=>({...m,fingerprint}));
}
function matchedAIInterpretations(row){
  const stored=row?.__priority13_ai;
  if(stored?.version!==1||stored.input_hash!==priority13InputHash(row)||
     !Array.isArray(stored.results))return [];
  const input=priority13AICandidates(row,{maxPerBuyer:50});
  return stored.results.flatMap(v=>{
    if(v?.kind!=="semi_trailer"||v.confidence!=="high"||
       !exactPriority13ModelQuote(v.model_quote,v.model_text))return [];
    const matched=input.find(c=>c.evidence_eligible===true&&
      c.source===v.source&&c.index===v.index&&
      c.model_text===v.model_text&&c.text.includes(v.model_quote));
    if(!matched)return [];
    // The saved OpenAI verdict identifies the model TYPE, but its original
    // source_url may be empty (the source was attributed only in a later
    // offline pass). Attach the URL from the CURRENT, validated inventory
    // match. Never modify the paid API result or the stored checkpoint.
    return [{...v,
      source_url:matched.source_url||"",
      source_status:matched.source_status||"source_not_attributed"}];
  });
}

/** Pure calculation, including model, evidence and data warnings. */
export function calculatePriority13({c="",d="",revenue="",staff="",notes=[],ai=[]}={}){
  const generic=GENERIC_BASIS.test(str(d));
  const t=parseTransport(c),b=parseBasis(generic?"":d),
    e=parseSourcedNotes(notes),ranking={none:0,ordinary:1,white:2,green:3};
  const tier=[t.tier,b.tier,e.tier,ai.length?"ordinary":"none"].reduce((best,current)=>
    ranking[current]>ranking[best]?current:best,"none");
  // Both C, D, source notes and AI type interpretations may describe the
  // SAME object; model classification is not new evidence of ownership.
  const count=Math.max(t.green+t.white+t.ordinary,b.qty,e.qty,ai.length?1:0);
  const rv=parseRevenue(revenue),pe=parseStaff(staff);
  const rp=rv===null||rv===0?0:rv<100e6?4:rv<300e6?8:rv<700e6?12:rv<1.5e9?16:20;
  const sp=pe===null||pe===0?0:pe<25?2:pe<=50?4:pe<=100?6:pe<=200?8:10;
  const tp=t.tractor?20:0,qp=tier==="none"?0:qtyPoints(count),raw=tp+rp+sp+qp;
  const band=BANDS[tier],extra=Math.round((band[1]-band[0])*Math.min(60,raw)/60),score=band[0]+extra;
  const names={none:"НЕТ ПОДТВЕРЖДЕНИЯ ПОЛУПРИЦЕПА",
    ordinary:"ОБЫЧНЫЙ ПОЛУПРИЦЕП",white:"БЕЛЫЙ СПИСОК",green:"ЗЕЛЁНЫЙ СПИСОК"};
  const models=t.items.concat(b.models.filter(x=>!t.items.some(y=>y.model===x.model)))
    .concat(e.models.filter(x=>!t.items.some(y=>y.model===x.model)&&
      !b.models.some(y=>y.model===x.model)));
  const modelLabels=models.length?models.map(x=>(x.tier==="green"?"ЗЕЛЁНЫЙ ":"БЕЛЫЙ ")+x.model+
    (x.source==="C"?" ("+x.count+" шт.)":
     x.source==="D"?" (по D, 1 упом.)":" (по источнику, 1 упом.)")).join("; "):
    "нет точного совпадения";
  const warnings=[];
  if(!blank(revenue)&&rv===null)warnings.push("выручка не распознана");
  if(!blank(staff)&&pe===null)warnings.push("численность не распознана");
  if(t.unknown)warnings.push("TORGBOX: "+t.unknown+" записей без классифицированного типа"+
    (t.unknownExamples.length?" ("+t.unknownExamples.join(" | ")+")":""));
  if(generic&&e.tier==="none"&&t.tier==="none"&&!ai.length)
    warnings.push("D содержит только обобщённую оценку A; точное подтверждение полуприцепа из источника не извлечено");
  if(b.uncertain)warnings.push("основание D содержит сведения о полуприцепах с отрицанием/истёкшим договором");
  if(tier!=="none"&&b.negative&&t.tier!=="none")
    warnings.push("D не подтверждает технику, хотя C содержит модель: проверить актуальность");
  if(tier!=="none"&&/лизинг|аренда/i.test(str(d))&&
    /заверш[а-яё]*|ист[её]к[а-яё]*|до\s+\d{2}\.\d{2}\.\d{4}/i.test(str(d)))
    warnings.push("в D упоминаются сроки лизинга/аренды: проверить актуальность");
  const fmt=v=>new Intl.NumberFormat("ru-RU").format(v);
  const explanation=[
    "ИТОГО: "+score+"/100",
    "КАТЕГОРИЯ: "+names[tier]+" ("+band[0]+"–"+band[1]+")",
    "Модели из списка: "+modelLabels,
    "Подтверждённый минимум полуприцепов без двойного учёта C/D/источников: "+count,
    "Внутригрупповые показатели (до нормировки, сумма "+raw+"/60):",
    "— седельный тягач из C: "+(t.tractor?"да":"нет")+" = "+tp+"/20",
    "— выручка Q: "+(rv===null?"нет распознанных данных":fmt(rv)+" ₽")+" = "+rp+"/20",
    "— сотрудники V: "+(pe===null?"нет распознанных данных":pe+" чел.")+" = "+sp+"/10",
    "— количество полуприцепов: "+count+" = "+qp+"/10",
    "Формула: нижняя граница "+band[0]+" + "+extra+" балл(ов) за показатели внутри категории = "+score
  ];
  if(ai.length)for(const item of ai){
    const evidenceSource=item.source_url?
      item.source_status==="company_website_correlated_not_live_verified"?
        "сайт организации сопоставлен с сохранённой заметкой по домену: "+
          item.source_url+"; новая веб-проверка не выполнялась":
        "сохранённая заметка с источником "+item.source_url:
      "сохранённая заметка (ссылка на источник не установлена)";
    explanation.push("КЛАССИФИКАЦИЯ МОДЕЛИ OPENAI: "+item.model_quote+
      " = полуприцеп (высокая уверенность, без веб-проверки спецификации; "+
      (item.source==="evidence"?evidenceSource:
        item.source_url?"сохранённый источник "+item.source_url:
          "сохранённый источник без URL")+
      "). Не является новым доказательством владения.");
  }
  if(warnings.length)explanation.push("ПРОВЕРИТЬ: "+warnings.join("; "));
  return {score,tier,models:modelLabels,explanation:explanation.join("\n"),warnings};
}

/** Modify only E + virtual AK. All other commercial source columns are untouched. */
export function applyPriorityStage13(result,{aiStats=null}={}){
  if(!Array.isArray(result?.direct_buyers))
    throw new TypeError("Stage 13 requires final_result.direct_buyers");
  const report={version:5,processed:0,changed:0,warnings:0,
    tiers:{none:0,ordinary:0,white:0,green:0},openai_calls:0,saby_calls:0,network_calls:0};
  for(const row of result.direct_buyers){
    if(!str(row?.["Организация"]).trim())continue;
    const r=calculatePriority13({c:row["Наличие транспорта"]||"",
      d:row["Основание"],revenue:row["Выручка последнего подтвержденного года"],
      staff:row["Численность"],notes:row.__evidence?.notes||[],
      ai:matchedAIInterpretations(row)});
    if(row["Итоговый коэффициент"]!==r.score ||
       row[EXPLANATION_FIELD]!==r.explanation)report.changed++;
    row["Итоговый коэффициент"]=r.score;
    row[EXPLANATION_FIELD]=r.explanation;
    report.tiers[r.tier]++;report.processed++;
    if(r.warnings.length)report.warnings++;
  }
  if(aiStats){
    report.ai={...aiStats};
    report.openai_calls=Number(aiStats.calls||0);
    report.network_calls=report.openai_calls;
  }
  return report;
}
