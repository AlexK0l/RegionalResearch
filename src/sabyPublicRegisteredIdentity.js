// Public first-party Saby company-profile verification using an ALREADY
// OBSERVED INN/KPP. A Saby display title alone is not legal identity proof.
//
// This read-only module never writes data back to Stage 12, the final XLSX,
// the checkpoint or the Saby authenticated account.
import {sabyInn,sabyNameMatches} from "./sabyEnrichment.js";
import {auditLegalForm} from "./sabyIdentityAudit.js";

const compact=s=>String(s??"").normalize("NFKC")
  .replace(/\s+/g," ").trim();
const linesOf=text=>String(text??"").slice(0,200000)
  .split(/[\r\n]+/).map(compact).filter(Boolean);
const isKpp=s=>/^\d{9}$/.test(String(s||""));
const legalName=s=>{
  const value=compact(s);
  return value.length>=4 && value.length<=260 &&
    /[а-яa-z]/iu.test(value) &&
    !/@|(?:\+7|8)\s*[\s(.-]?\d{3}|(?:^|\s)(?:контакты|телефон|электронная почта)(?:\s|$)/iu.test(value);
};
export function sabyPublicProfileRoute(rawInn,rawKpp) {
  const inn=sabyInn(rawInn),kpp=String(rawKpp||"").trim();
  return inn&&isKpp(kpp) ? "https://saby.ru/profile/"+inn+"-"+kpp : "";
}
export function canonicalSabyPublicRoute(url,expectedInn,expectedKpp) {
  const canonical=sabyPublicProfileRoute(expectedInn,expectedKpp);
  if(!canonical)return false;
  try {
    const u=new URL(String(url));
    return u.protocol==="https:" && u.hostname==="saby.ru" &&
      u.port==="" && !u.username && !u.password &&
      u.pathname===new URL(canonical).pathname;
  } catch {return false;}
}
// Saby has several "Реквизиты" labels: menu, About summary, registered
// details. A labelled INN + KPP in About is NEVER full legal-name proof.
const requisiteHeading=/^(?:Реквизиты|Регистрационные реквизиты)\s*:?\s*$/iu;
const sectionBoundary=/^(?:О компании|Контакты|Владельцы|Связанные лица|Связанные компании|Филиалы|Адрес|Регистрация компании|Регистрация в государственных органах|Автопарк компании|Лицензии|Проверки|Суды|Торги|Кредитоспособность|События|Реквизиты)\s*$/iu;
const nameLabels=[
  "Юридическое наименование","Наименование организации",
  "Полное наименование","Полное название","Название организации",
  "Название"
];
const registeredFields=[
  ["name",nameLabels],["inn",["ИНН"]],["kpp",["КПП"]],["ogrn",["ОГРН"]]
];
function labelledValue(line,aliases) {
  const value=compact(line).replace(/^[\-–—•]\s*/u,"");
  for(const label of aliases) {
    if(value.toLowerCase()===label.toLowerCase())
      return {inline:false,value:""};
    if(value.toLowerCase().startsWith(label.toLowerCase())){
      const suffix=value.slice(label.length);
      // Colon, dash, or explicitly separated column. Prevent matching
      // longer labels as prefix of unrelated names.
      if(/^\s*[:：–—-]\s*\S/u.test(suffix))
        return {inline:true,value:compact(suffix.replace(/^\s*[:：–—-]\s*/u,""))};
      if(/^\s+\S/u.test(suffix))
        return {inline:true,value:compact(suffix)};
    }
  }
  return null;
}
function normalizedRegistryNumber(value,lengths) {
  const normalized=compact(value)
    .replace(/[.;,]\s*$/u,"")
    .replace(/[\s\u00a0\u202f]/gu,"");
  return lengths.includes(normalized.length) && /^\d+$/u.test(normalized) ?
    normalized : "";
}
function readRegisteredBlock(lines,from,to) {
  const observed={name:[],inn:[],kpp:[],ogrn:[]};
  const offsets={name:-1,inn:-1,kpp:-1,ogrn:-1};
  for(let i=from;i<to;i++) {
    for(const [key,aliases] of registeredFields) {
      const matched=labelledValue(lines[i],aliases);
      if(!matched)continue;
      if(offsets[key]===-1)offsets[key]=i-from;
      let raw=matched.inline?matched.value:compact(lines[i+1]||"");
      if(!matched.inline) {
        // Never take the next field or a new section as the value.
        if(i+1>=to || sectionBoundary.test(raw) ||
           registeredFields.some(([,other])=>labelledValue(raw,other)))continue;
      }
      raw=compact(raw);
      if(key==="name"){
        if(!legalName(raw))continue;
      } else {
        raw=normalizedRegistryNumber(raw,
          key==="inn"?[10,12]:key==="kpp"?[9]:[13,15]);
        if(!raw)continue;
      }
      if(!observed[key].includes(raw))observed[key].push(raw);
    }
  }
  return {observed,offsets};
}
function candidateBlocks(text) {
  const lines=linesOf(text),blocks=[];
  for(let i=0;i<lines.length && blocks.length<24;i++){
    if(!requisiteHeading.test(lines[i]))continue;
    const from=i+1;
    let to=Math.min(lines.length,from+70);
    for(let j=from;j<to;j++){
      if(sectionBoundary.test(lines[j])){to=j;break;}
    }
    const {observed,offsets}=readRegisteredBlock(lines,from,to);
    blocks.push({observed,offsets,window:to-from});
  }
  return blocks;
}
export function diagnoseSabyPublicRequisiteLayout(text) {
  // Only structural counters and offsets: never leak company text or PII.
  const blocks=candidateBlocks(text);
  return {
    anchors:blocks.length,
    field_layouts:blocks.slice(0,8).map(({observed,offsets,window})=>({
      lines_scanned:window,
      name_offset:offsets.name,inn_offset:offsets.inn,
      kpp_offset:offsets.kpp,
      name_values:observed.name.length,
      inn_values:observed.inn.length,
      kpp_values:observed.kpp.length,
      ambiguous:observed.name.length>1||
        observed.inn.length>1||observed.kpp.length>1
    }))
  };
}
export function extractSabyPublicRequisites(text) {
  const found=new Map();
  for(const {observed} of candidateBlocks(text)) {
    // Never stitch values from different sections or different companies.
    // Conflicting duplicate names, INNs or KPPs in a block fail closed.
    if(observed.name.length!==1||observed.inn.length!==1||
       observed.kpp.length!==1||observed.ogrn.length>1)continue;
    const candidate={
      name:observed.name[0],inn:sabyInn(observed.inn[0]),
      kpp:observed.kpp[0],ogrn:observed.ogrn[0]||""
    };
    if(!candidate.inn)continue;
    found.set(JSON.stringify(candidate),candidate);
  }
  return [...found.values()].slice(0,12);
}
export function compareSabyPublicRequisites({
  expectedInn,expectedKpp,expectedName,publicTitle,records,url
}) {
  const result={
    status:"review",reason:"requisites_unavailable",
    official_name:"",public_short_name:compact(publicTitle).slice(0,220),
    official_inn:"",official_kpp:"",official_ogrn:"",
    match_type:"",source_inn:sabyInn(expectedInn)
  };
  if(!canonicalSabyPublicRoute(url,expectedInn,expectedKpp)){
    result.reason="public_route_untrusted";return result;
  }
  const all=Array.isArray(records)?records:[];
  if(!all.length)return result;
  const exact=all.filter(x=>x.inn===sabyInn(expectedInn) &&
    x.kpp===String(expectedKpp));
  if(exact.length!==1 || all.some(x=>x.inn!==sabyInn(expectedInn) ||
      x.kpp!==String(expectedKpp))) {
    result.reason=exact.length>1?"ambiguous_requisites":"inn_kpp_conflict";
    return result;
  }
  const req=exact[0];
  result.official_name=req.name;
  result.official_inn=req.inn;
  result.official_kpp=req.kpp;
  result.official_ogrn=req.ogrn||"";
  const formA=auditLegalForm(expectedName);
  const formB=auditLegalForm(req.name);
  if(formA&&formB&&formA!==formB){
    result.reason="legal_form_conflict";return result;
  }
  if(sabyNameMatches(expectedName,req.name)){
    result.status="verified";
    result.reason="exact_registered_name_and_inn_kpp";
    result.match_type="registered_full_name";
  } else if(sabyNameMatches(expectedName,publicTitle)){
    // The short header and full legal title are linked by one exact
    // Saby INN+KPP requisites record, not by guessed abbreviation.
    result.status="verified";
    result.reason="same_public_profile_short_and_registered_name";
    result.match_type="short_title_registered_alias";
  } else {
    result.reason="name_not_matched_to_registered_entity";
  }
  return result;
}

// Diagnostic is a small allowlist of counts/flags. Never return arbitrary
// page content, contacts, cookies, user account details or raw HTML.
export function safeSabyPublicLoadDiagnostic(snapshot,httpStatus=0) {
  const body=String(snapshot?.body||"");
  const lines=body.split(/[\r\n]+/).map(compact).filter(Boolean);
  const has=reg=>lines.some(x=>reg.test(x));
  return {
    http_status:Number.isSafeInteger(httpStatus)?httpStatus:0,
    visible_text_chars:Math.max(0,Number(snapshot?.bodyChars)||body.length),
    dom_text_chars:Math.max(0,Number(snapshot?.domTextChars)||0),
    h1_count:Math.max(0,Number(snapshot?.h1Count)||0),
    h1_has_text:Boolean(compact(snapshot?.title)),
    requisites_heading_visible:has(/^Реквизиты$/iu),
    registered_name_label_visible:has(/^(?:Название|Полное название|Полное наименование|Наименование организации|Юридическое наименование)(?:\s*[:：].*)?$/iu),
    inn_label_visible:has(/^ИНН(?:\s*[:：].*)?$/iu),
    kpp_label_visible:has(/^КПП(?:\s*[:：].*)?$/iu),
    challenge_observed:/(?:captcha|капча|подтвердите.{0,35}(?:человек|робот)|проверка.{0,25}робот|access denied)/iu.test(body)
  };
}

// Requisites can be physically near the END of a long page; preserve
// multiple distinct headings when the public profile contains huge charts.
export function safeSabyVisibleRequisitesText(text) {
  const value=String(text||"");
  if(value.length<=190000)return value;
  const matches=[...value.matchAll(/(?:^|[\r\n])\s*Реквизиты\s*(?=[\r\n]|$)/gu)];
  if(!matches.length)return value.slice(-190000);
  return matches.slice(-12).map(m=>value.slice(m.index,m.index+6500)).join("\n");
}

/** Read a canonical public profile in a separate tab, preserve original tab.
 * Return only allowlisted fields; never persist HTML, page text, cookies,
 * contact details, or remote addresses.
 */
export async function verifyPublicSabyIdentity(page,inn,kpp,sourceName,{
  timeoutMs=14000
}={}) {
  const url=sabyPublicProfileRoute(inn,kpp);
  if(!url||!sourceName)return {status:"review",reason:"invalid_request"};
  if(typeof page?.context!=="function")
    return {status:"review",reason:"browser_context_unavailable"};
  let tab;
  let diagnostic=null;
  try {
    tab=await page.context().newPage();
    const response=await tab.goto(url,{
      waitUntil:"domcontentloaded",timeout:Math.min(20000,timeoutMs)
    });
    const status=Number(response?.status?.()||0);
    if(!canonicalSabyPublicRoute(tab.url(),inn,kpp))
      return {status:"review",reason:"public_route_untrusted"};
    let observation;
    const maxAttempts=Math.max(2,Math.min(12,Math.ceil(timeoutMs/1000)));
    for(let attempt=0;attempt<maxAttempts;attempt++){
      if(!canonicalSabyPublicRoute(tab.url(),inn,kpp))
        return {status:"review",reason:"public_route_untrusted",diagnostic};
      observation=await tab.evaluate(()=>{
        const headings=[...document.querySelectorAll("h1")];
        const short=headings.map(e=>String(e.innerText||e.textContent||"").trim())
          .find(Boolean)||"";
        // Only public visible text is used for proof. Other DOM text is
        // reduced to a length number; no raw response is returned/logged.
        const body=String(document.body?.innerText||"");
        const candidate=body.length>250000 ?
          body.slice(0,40000)+"\n"+body.slice(-200000) : body;
        return {
          title:short.slice(0,220),
          body:candidate,
          bodyChars:body.length,
          domTextChars:String(document.body?.textContent||"").length,
          h1Count:headings.length
        };
      });
      diagnostic=safeSabyPublicLoadDiagnostic(observation,status);
      diagnostic.requisite_layout=diagnoseSabyPublicRequisiteLayout(
        safeSabyVisibleRequisitesText(observation.body));
      if(status && status!==200)
        return {status:"review",reason:"http_status_not_ok",diagnostic};
      if(diagnostic.challenge_observed)
        return {status:"review",reason:"public_page_challenge",diagnostic};
      const records=extractSabyPublicRequisites(
        safeSabyVisibleRequisitesText(observation.body));
      if(records.length){
        return {
          ...compareSabyPublicRequisites({
            expectedInn:inn,expectedKpp:kpp,expectedName:sourceName,
            publicTitle:observation.title,records,url:tab.url()
          }),
          diagnostic
        };
      }
      // Saby public pages can mount sections much later than
      // DOMContentLoaded. A single navigation-tab scroll can trigger lazy
      // section mounting, without requesting a different company.
      if(attempt===3&&typeof tab.getByRole==="function") {
        try {
          const tabLink=tab.getByRole("link",{
            name:"Реквизиты",exact:true
          });
          if(await tabLink.count()===1 &&
             await tabLink.isVisible().catch(()=>false))
            await tabLink.click({timeout:2500}).catch(()=>{});
        } catch { /* Optional scroll only; never a verification input. */ }
      }
      if(attempt+1<maxAttempts)
        await tab.waitForTimeout(900);
    }
    // No proof: make the reason explain which stage was absent.
    const reason=diagnostic?.visible_text_chars<60?"public_body_empty":
      !diagnostic?.requisites_heading_visible?"requisites_section_not_rendered":
      !diagnostic?.registered_name_label_visible?"registered_name_not_rendered":
      "requisites_unavailable";
    return {status:"review",reason,diagnostic};
  } catch {
    return {status:"review",reason:"public_page_unavailable",
      ...(diagnostic?{diagnostic}:{})};
  } finally {
    if(tab)await tab.close().catch(()=>{});
  }
}
