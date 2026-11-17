// Stage 13: free, deterministic model-band priority for direct buyers.
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
const NEGATIVE=/не\s+(?:подтвержд[а-яё]*|найден[а-яё]*|установлен[а-яё]*|доказан[а-яё]*)|принадлежност[а-яё]*[^.\n]{0,100}не\s+подтвержд|полуприцеп[а-яё]*[^.\n]{0,60}(?:отсутств[а-яё]*|не\s+найден[а-яё]*)|нет\s+(?:собственн[а-яё]*\s+)?полуприцеп[а-яё]*/i;
const POSITIVE=/зафиксирован[а-яё]*|зарегистрирован[а-яё]*|в\s+реестр[а-яё]*|в\s+залоге|эксплуатир[а-яё]*|использу[а-яё]*|принадлежит|в\s+собственност[а-яё]*|собственн[а-яё]*\s+парк|подтвержден[а-яё]*\s+(?:наличие|эксплуатац)/i;
const EXPIRED=/договор[а-яё]*[^.;\n]{0,80}(?:заверш[а-яё]*|прекращ[а-яё]*|ист[её]к[а-яё]*)|(?:заверш[а-яё]*|ист[её]к[а-яё]*)[^.;\n]{0,80}договор/i;
function startModel(line,{brand,model}){
  const full=norm(brand+" "+model);
  return line.startsWith(full)&&(line.length===full.length||/^[\s(;,]/.test(line.slice(full.length)));
}
function basisModel(text,{brand,model}){
  const full=norm(brand+" "+model);
  return new RegExp("(^|[^A-ZА-Я0-9])"+escapeRE(full).replace(/ /g,"\\s+")+
    "(?=$|[^A-ZА-Я0-9.\\-])").test(text);
}
function quantity(line){
  const m=line.match(/[—–-]\s*(\d+)\s*(?:шт|ед)(?:\.|иниц(?:ы|а)?)?(?=\s|$|[;,])/i);
  return m?Number(m[1]):1;
}
function parseTransport(raw){
  const res={tier:"none",green:0,white:0,ordinary:0,tractor:false,unknown:0,
    unknownExamples:[],items:[]},found=new Map();
  // Existing column C contains both TORGBOX lines and Saby truck inventories.
  const parts=str(raw).split(/[\r\n;]+/).map(x=>
    x.replace(/^\s*(?:TORGBOX|Saby\s*\(грузовые\))\s*:\s*/i,"").trim()).filter(Boolean);
  for(const line of parts){
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

/** Pure calculation, including model, evidence and data warnings. */
export function calculatePriority13({c="",d="",revenue="",staff=""}={}){
  const t=parseTransport(c),b=parseBasis(d),ranking={none:0,ordinary:1,white:2,green:3};
  const tier=ranking[t.tier]>=ranking[b.tier]?t.tier:b.tier;
  const count=Math.max(t.green+t.white+t.ordinary,b.qty);
  const rv=parseRevenue(revenue),pe=parseStaff(staff);
  const rp=rv===null||rv===0?0:rv<100e6?4:rv<300e6?8:rv<700e6?12:rv<1.5e9?16:20;
  const sp=pe===null||pe===0?0:pe<25?2:pe<=50?4:pe<=100?6:pe<=200?8:10;
  const tp=t.tractor?20:0,qp=tier==="none"?0:qtyPoints(count),raw=tp+rp+sp+qp;
  const band=BANDS[tier],extra=Math.round((band[1]-band[0])*Math.min(60,raw)/60),score=band[0]+extra;
  const names={none:"НЕТ ПОДТВЕРЖДЕНИЯ ПОЛУПРИЦЕПА",
    ordinary:"ОБЫЧНЫЙ ПОЛУПРИЦЕП",white:"БЕЛЫЙ СПИСОК",green:"ЗЕЛЁНЫЙ СПИСОК"};
  const models=t.items.concat(b.models.filter(x=>!t.items.some(y=>y.model===x.model)));
  const modelLabels=models.length?models.map(x=>(x.tier==="green"?"ЗЕЛЁНЫЙ ":"БЕЛЫЙ ")+x.model+
    (x.source==="C"?" ("+x.count+" шт.)":" (по D, 1 упом.)")).join("; "):"нет точного совпадения";
  const warnings=[];
  if(!blank(revenue)&&rv===null)warnings.push("выручка не распознана");
  if(!blank(staff)&&pe===null)warnings.push("численность не распознана");
  if(t.unknown)warnings.push("Наличие транспорта: "+t.unknown+" записей без классифицированного типа"+
    (t.unknownExamples.length?" ("+t.unknownExamples.join(" | ")+")":""));
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
    "Подтверждённый минимум полуприцепов без двойного учёта C/D: "+count,
    "Внутригрупповые показатели (до нормировки, сумма "+raw+"/60):",
    "— седельный тягач из C: "+(t.tractor?"да":"нет")+" = "+tp+"/20",
    "— выручка Q: "+(rv===null?"нет распознанных данных":fmt(rv)+" ₽")+" = "+rp+"/20",
    "— сотрудники V: "+(pe===null?"нет распознанных данных":pe+" чел.")+" = "+sp+"/10",
    "— количество полуприцепов: "+count+" = "+qp+"/10",
    "Формула: нижняя граница "+band[0]+" + "+extra+" балл(ов) за показатели внутри категории = "+score
  ];
  if(warnings.length)explanation.push("ПРОВЕРИТЬ: "+warnings.join("; "));
  return {score,tier,models:modelLabels,explanation:explanation.join("\n"),warnings};
}

/** Modify only E + virtual AK. All other commercial source columns are untouched. */
export function applyPriorityStage13(result){
  if(!Array.isArray(result?.direct_buyers))
    throw new TypeError("Stage 13 requires final_result.direct_buyers");
  const report={version:1,processed:0,changed:0,warnings:0,
    tiers:{none:0,ordinary:0,white:0,green:0},openai_calls:0,saby_calls:0,network_calls:0};
  for(const row of result.direct_buyers){
    if(!str(row?.["Организация"]).trim())continue;
    const r=calculatePriority13({c:row["Наличие транспорта"]??row.TORGBOX??"",
      d:row["Основание"],revenue:row["Выручка последнего подтвержденного года"],
      staff:row["Численность"]});
    if(row["Итоговый коэффициент"]!==r.score ||
       row[EXPLANATION_FIELD]!==r.explanation)report.changed++;
    row["Итоговый коэффициент"]=r.score;
    row[EXPLANATION_FIELD]=r.explanation;
    report.tiers[r.tier]++;report.processed++;
    if(r.warnings.length)report.warnings++;
  }
  return report;
}
