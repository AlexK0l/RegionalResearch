// Company-specific qualification notes for the strict five-sheet XLSX.
// Final qualification uses deliberately generic A/B/C safety messages. Keep
// its grade and verification exactly as saved, but present actual company
// facts from the attached evidence instead of repeating those messages.
// This is a deterministic, read-only presentation pass: no OpenAI, no
// invented claims, and no changes to scores, role, or provenance.
import {formatEmailCell,EMAIL_COLUMN} from "./emailContact.js";
import {sabyStoredSectionCoverage,fleetSummary,sabyStoredVehicleFleet,sabyVehicleFleetSummary} from "./sabyEnrichment.js";
const SECTION_KEYS=["direct_buyers","intermediaries","leasing"];
const BASIS_NOTE_KEY="__basis_comment";
const URL_RE=/https?:\/\/[^\s<>"'()[\]]+/gi;
const GRADE_RE=/^\s*([ABC])\s*[—–-]\s*/i;
const GENERIC_BASIS=[
  /^конкретный evidence-note одновременно подтверждает/i,
  /^в evidence одновременно подтверждены/i,
  /^в evidence подтверждены/i,
  /^подтверждён действующий целевой производственный\/грузовой процесс/i,
  /^отдельные evidence-note связывают то же юридическое лицо/i,
  /^подтверждена закупка транспортных услуг для конкретного целевого груза/i
];
const ADMIN_NOTE=/^(?:identity:|final inn:|подтвержденн(?:ый|ого)\s+инн|сопоставление инн|email:|телефон:|сайт\/источник:|источник:|огрн:|кпп:|saby:|saby_only:)/i;
const ONLY_URLS=/^(?:источник|sources?|url|ссылка|публичный источник)\s*:/i;
const BUSINESS_WORDS=/производств|перераб|зерн|пшениц|рисовод|масличн|сельхоз|дорожн|строитель|цемент|бетон|жби|щеб[её]н|песок|грунт|неруд|лесо|древес|щеп|лом|металл|отход|сырь|перевоз|достав|вывоз|автологист|карьер|сервис|ремонт|продаж|аренд|лизинг|полуприцеп|прицеп|тягач|самосвал|автопарк|парк\s+грузов|договор|контракт|закупк|тендер|поставка|груз/iu;
const OPERATING_WORDS=/действующ|эксплуат|выполня|имеет|вед[её]т|работа|поставля|перевоз|отгружа|снабж|производ|перераб|обслужив|ремонтир|оказыва|договор|контракт|закуп|транспорт|автопарк|зарегистр|указан|суд|сельхоз|строител/iu;
const LOGISTICS_WORDS=/полуприцеп|прицеп|седельн|тягач|самосвал|автопарк|категори[яи]\s*(?:CE|Е)|водител|автомоб|транспорт|перевоз|грузопоток|лизинг|договор|контракт|ремонт|техника|закупк|эксплуат/iu;
const PROFILE_LABEL=/^деятельность\s*:\s*(.+)$/im;

function text(v){return String(v??"").replace(/\s+/g," ").trim();}
function unique(items){return [...new Set(items.filter(Boolean))];}
function urlsIn(value){
  const values=String(value??"").match(URL_RE)||[];
  return unique(values.map(url=>url.replace(/[.,;:]+$/,"")).filter(url=>url.length<1800));
}
function removeEmptyCitationLabels(value){
  return String(value??"").replace(/\s*\(\s*(?:(?:источник(?:и)?|ссылка|url)\s*:?\s*)?\)/giu,"");
}
function cleanFact(value){
  let s=String(value??"")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g,"$1")
    .replace(URL_RE,"")
    .replace(/(^|\n)\s*(?:источники?|url|ссылки|source(?:s)?)\s*:\s*(?:[,; ]*)/gim,"$1")
    .replace(/\s+(?:источники?|url|ссылки|source(?:s)?)\s*:\s*(?=\s|$)/gim,"")
    .replace(/^[\s"'\-—•:]+|[\s"'\-—•:]+$/g,"")
    .replace(/^\s*[ABC]\s*[—–-]\s*/i,"")
    .replace(/\s+/g," ").trim();
  s=removeEmptyCitationLabels(s);
  if(s && !/[.!?]$/.test(s))s+=".";
  return s;
}
function trimSentence(value,max=420){
  const s=text(value);
  if(s.length<=max)return s;
  const cut=s.slice(0,max);
  const end=Math.max(cut.lastIndexOf(". "),cut.lastIndexOf("; "),cut.lastIndexOf(", "));
  return (end>=120?cut.slice(0,end+1):cut.replace(/\s+\S*$/,""))+"…";
}
function meaningful(value){
  const s=cleanFact(value);
  return s.length>=32 && /[а-яa-z]/iu.test(s) && BUSINESS_WORDS.test(s) &&
    !/^https?:|^нет данных|^не найден|^для справки/i.test(s);
}
function gradeOf(row){
  const saved=text(row?.__final_grade).toUpperCase();
  if(["A","B","C"].includes(saved))return saved;
  return text(row?.["Основание"]).match(GRADE_RE)?.[1]?.toUpperCase()||"";
}
function isGenericBasis(value){
  const v=text(value).replace(GRADE_RE,"");
  return !v || /^https?:\/\//i.test(v) ||
    /^(?:источник|ссылка|url)\s*:/i.test(v) ||
    GENERIC_BASIS.some(p=>p.test(v));
}
function activity(row){
  const comment=String(row?.__comment||"");
  const activityLine=comment.match(PROFILE_LABEL)?.[1]||"";
  return trimSentence(cleanFact(activityLine||row?.["Техника/сегмент"]||""),260);
}
function noteCandidates(row,grade){
  const notes=Array.isArray(row?.__evidence?.notes)?row.__evidence.notes:[];
  const links=Array.isArray(row?.__evidence?.inline_note_provenance)?
    row.__evidence.inline_note_provenance:[];
  const candidates=[];
  const selectedA=grade==="A"?String(row?.__a_evidence||"").trim():"";
  if(meaningful(selectedA)){
    const selectedUrl=text(row?.__evidence?.selected_a_provenance?.source_url);
    candidates.push({
      value:cleanFact(selectedA),
      urls:unique([...urlsIn(selectedA),...urlsIn(selectedUrl)]),
      priority:10000,
      attributed:!!(urlsIn(selectedA).length||selectedUrl)
    });
  }
  for(let i=0;i<Math.min(200,notes.length);i++){
    const raw=text(notes[i]);
    if(ADMIN_NOTE.test(raw)||ONLY_URLS.test(raw)||!meaningful(raw))continue;
    const cleaned=cleanFact(raw);
    const linked=links.filter(link=>Number(link?.note_index)===i)
      .map(link=>text(link?.source_url)).filter(Boolean);
    const linksHere=unique([...urlsIn(raw),...linked]);
    let score=cleaned.length>55?2:0;
    if(linksHere.length)score+=5;
    if(OPERATING_WORDS.test(cleaned))score+=4;
    if(LOGISTICS_WORDS.test(cleaned))score+=grade==="C"?2:5;
    if(grade==="C"&&BUSINESS_WORDS.test(cleaned))score+=4;
    if(/^(?:данные из файла|сводная информация|сведения об организации)/i.test(cleaned))score-=10;
    if(/(?:предположительно|потенциально|вероятно|теоретически|может потребоваться)/i.test(cleaned))score-=5;
    candidates.push({
      value:cleaned,urls:linksHere,
      priority:score,
      attributed:linksHere.length>0
    });
  }
  return candidates.sort((a,b)=>b.priority-a.priority);
}
function sourceList(row,chosen){
  const inline=chosen?.urls||[];
  const evidence=Array.isArray(row?.__evidence?.source_urls)?
    row.__evidence.source_urls.flatMap(urlsIn):[];
  const urlInComment=urlsIn(row?.__comment||"");
  const accurate=unique(inline).slice(0,6);
  if(accurate.length)return {urls:accurate,exact:true};
  const general=unique([...evidence,...urlInComment]).slice(0,5);
  return {urls:general,exact:false};
}
function basisAndNote(row){
  const grade=gradeOf(row);
  const original=removeEmptyCitationLabels(text(row?.["Основание"]));
  if(!grade)return null;
  const candidates=noteCandidates(row,grade);
  const chosen=candidates[0];
  const canDescribe=Boolean(chosen?.value&&chosen.value.length>=32);
  const originalSpecific=!isGenericBasis(original);
  const specificBasis=originalSpecific?original:
    canDescribe?grade+" — "+trimSentence(
      chosen.attributed?chosen.value:
        "По сохранённой записи (ссылка на конкретный факт не установлена): "+chosen.value,
      425):
    original;
  const profile=activity(row);
  const source=sourceList(row,chosen);
  const explanation=originalSpecific?
    text(original.replace(GRADE_RE,"")):
    canDescribe?chosen.value:"";
  const lines=[
    "ОСНОВАНИЕ КАТЕГОРИИ "+grade,
    explanation?"Факт из сохранённых сведений: "+trimSentence(explanation,1200):
      "Индивидуальное подтверждающее утверждение не сохранено; "+
      "для оценки нужно проверить исходные материалы.",
    profile?"Профиль компании: "+profile:"",
    source.urls.length?(
      source.exact?"Источник утверждения: ":"Источники карточки (точная привязка факта не подтверждена): "
    )+source.urls.join("\n"):"Источник не указан"
  ].filter(Boolean);
  return {basis:specificBasis,note:lines.join("\n")};
}

// Legacy checkpoints start the company comment with a long URL. Excel's
// default note popup is small, so the actual explanation used to be invisible.
// Put the customer-useful facts FIRST, preserve all existing lines and source
// URLs AFTER the description. The transformation is idempotent for saved JSON.
function readableCompanyComment(row,info){
  const previous=String(row?.__comment||"").replace(/\r\n/g,"\n");
  const lines=previous.split("\n").map(x=>x.trim()).filter(Boolean);
  const summary=trimSentence(text(info?.basis||"").replace(GRADE_RE,""),340);
  const isTitle=line=>/^СВЕДЕНИЯ О КОМПАНИИ(?:\s*[—-].*)?$/i.test(line);
  const isSummary=line=>/^Краткое основание\s*:/i.test(line);
  const isActivity=line=>/^Деятельность\s*:/i.test(line);
  const isSource=line=>/^Сайт\/источник\s*:/i.test(line);
  const activityLines=lines.filter(isActivity);
  const sourceLines=lines.filter(isSource);
  // Current cell is authoritative for presentation. Do not leave a stale
  // "Email: не найден" from a pre-contact checkpoint next to a saved address.
  // Preserve all non-email evidence and retain legacy lines when the cell
  // is empty; no new address is inferred here.
  const emails=formatEmailCell(row?.[EMAIL_COLUMN]);
  const others=lines.filter(line=>!isTitle(line)&&!isSummary(line)&&
    !isActivity(line)&&!isSource(line)&&!(emails&&/^Email\s*:/i.test(line)));
  const activityLine=activityLines[0]||
    (activity(row)?"Деятельность: "+activity(row):"");
  const existingHeading=lines.find(isTitle);
  const top=[
    existingHeading||"СВЕДЕНИЯ О КОМПАНИИ",
    summary?"Краткое основание: "+summary:"",
    activityLine,
    emails?"Email: "+emails:""
  ].filter(Boolean);
  // Contacts have their own evidence; never use them as an A/B/C claim.
  const contactFacts=Array.isArray(row?.__evidence?.public_contact_facts)?
    row.__evidence.public_contact_facts:[];
  const contactLines=unique(contactFacts.slice(0,15).filter(f=>
    f?.inn===String(row?.["ИНН"]||"").trim()&&
    /^https?:\/\//i.test(String(f.source_url||""))&&
    ["Телефон","Электронная почта","Руководитель / ЛПР"].includes(f.field))
    .map(f=>f.field+": "+text(f.value)+(f.department?" ("+text(f.department)+")":"")+
      " · "+f.source_url));
  return unique([...top,...others,...contactLines,...sourceLines,...activityLines.slice(1)]).join("\n");
}

// The established intermediary/leasing sheets do not have a transport
// column. Attach the verified fleet to the existing organization note,
// including when Stage13 moved a direct buyer into either of these sheets.
// The raw JSON retains the complete validated list; cap only presentation
// for unusually large fleets, and say where the full inventory is stored.
function withFleetNote(row,comment,sheet){
  const all=sabyStoredVehicleFleet(row);
  if(all){
    const prefix="Saby: подтверждённый автопарк по категориям";
    const lines=String(comment||"").split(/\r?\n/).filter(line=>!line.startsWith(prefix));
    const summary=sabyVehicleFleetSummary(all);
    const display=summary.length>16000?summary.slice(0,16000).split("; ").slice(0,-1).join("; ")+"; полный перечень в JSON исследования":summary;
    return [...lines.filter(Boolean),prefix+" — "+all.count+" шт.: "+display].join("\n");
  }
  if(sheet==="direct_buyers"||!sabyStoredSectionCoverage(row,{transport:true}).trucks)
    return comment;
  const fleet=row.__evidence.saby.trucks;
  const prefix="Saby: подтверждённый грузовой автопарк";
  const lines=String(comment||"").split(/\r?\n/).filter(line=>!line.startsWith(prefix));
  const summary=fleetSummary(fleet);
  const display=summary.length>16000?
    summary.slice(0,16000).split("; ").slice(0,-1).join("; ")+
      "; полный перечень в JSON исследования":summary;
  const note=prefix+" — "+fleet.count+" шт."+(display?": "+display:"");
  return [...lines.filter(Boolean),note].join("\n");
}

export function decorateCompanyBasisForExport(result){
  if(!result || typeof result!=="object")return result;
  const output={...result};
  for(const key of SECTION_KEYS){
    if(!Array.isArray(result[key]))continue;
    output[key]=result[key].map(row=>{
      if(!row||typeof row!=="object")return row;
      const info=basisAndNote(row);
      if(!info){
        const comment=withFleetNote(row,row.__comment,key);
        return comment===row.__comment?{...row}:{...row,__comment:comment};
      }
      return {
        ...row,
        "Основание":info.basis,
        [BASIS_NOTE_KEY]:info.note,
        __comment:withFleetNote(row,readableCompanyComment(row,info),key)
      };
    });
  }
  return output;
}
