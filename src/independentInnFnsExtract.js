// Official EGRUL PDF, downloaded by the visible public FNS UI.
// No third-party identity source, signature bypass, private endpoint or
// persistent copy of the document (which can include natural-person data).
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {verifiedInnChecksum} from "./sabyMissingInnRecovery.js";
import {normalizedOgrn} from "./legalIdentity.js";
import {normalizeEmail} from "./emailContact.js";
import {isFnsFormRoute,fnsSourceUrl} from "./independentInnFns.js";

const clean=v=>String(v??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const MAX_BYTES=20*1024*1024, MAX_TEXT=8*1024*1024, MAX_PAGES=200;
const fail=code=>Object.assign(Error(code),{code});
const sectionNames=new Map([
  ["Наименование","names"],
  ["Место нахождения и адрес юридического лица","address"],
  ["Сведения о регистрации","registration"],
  ["Сведения об учете в налоговом органе","tax"],
  ["Сведения об адресе электронной почты","email"],
  ["Адрес электронной почты","email"],
  ["Сведения о лице, имеющем право без доверенности действовать от имени юридического лица","leader"]
].map(([a,b])=>[clean(a).toLowerCase(),b]));
const adverseHeading=/^Сведения\s+(?:о|об)\s+(?:состоянии(?:\s+\(статусе\))?\s+юридического лица|статусе\s+юридического лица|прекращении(?:\s+деятельности)?\s+юридического лица|нахождении юридического лица в процессе|принятии решения о предстоящем исключении|принятом решении о предстоящем исключении|процессе реорганизации|ликвидации юридического лица|банкротстве юридического лица|недостоверности сведений|ограничении доступа к сведениям)/iu;
const cessationHeading=/^Сведения о прекращении(?: деятельности)? юридического лица$/iu;
const adverseRow=/^(?:Статус(?: юридического лица)?|Состояние юридического лица|Способ прекращения(?: деятельности)?|Дата прекращения(?: деятельности)?|Сведения о недостоверности|Признак недостоверности)/iu;

function calendarDate(s){
  const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s||"");
  if(!m)return null;
  const ms=Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]));
  const date=new Date(ms);
  return date.getUTCDate()===Number(m[1])&&date.getUTCMonth()===Number(m[2])-1&&
    date.getUTCFullYear()===Number(m[3])?ms:null;
}
function freshDate(s,now){
  const ms=calendarDate(s);
  if(ms===null||!Number.isFinite(now))return false;
  // The service date is Moscow local time; tolerate the date boundary.
  const day=Math.floor((now+3*3600000)/86400000)*86400000;
  return ms>=day-86400000&&ms<=day;
}
function extractHeader(text,now){
  const end=text.search(/^\s*№\s*п\/п\s+Наименование показателя\s+Значение показателя\s*$/mu);
  if(end<0)return {issue:"table_header"};
  const head=text.slice(0,end);
  if(!/^\s*ВЫПИСКА\s*$/mu.test(head)||
    !/^\s*из Единого государственного реестра юридических лиц\s*$/mu.test(head)||
    !/Настоящая выписка содержит сведения о юридическом лице/iu.test(head))return {issue:"document_title"};
  const dateNumber=/^[ \t]*(\d{2}\.\d{2}\.\d{4})[ \t]+№[ \t]+([А-ЯA-Z0-9-]+)[ \t]*(?:\n[ \t]+(\d{3,20})[ \t]*$)?/imu.exec(head);
  if(!dateNumber)return {issue:"date_number_layout"};
  if(!freshDate(dateNumber[1],now))return {issue:"document_date"};
  const number=dateNumber[2]+(dateNumber[3]||"");
  if(!/^[А-ЯA-Z0-9-]{5,60}$/u.test(number)||number.endsWith("-"))return {issue:"document_number"};
  const id=(label,size)=>{
    const pattern=new RegExp("^[ \\t]*"+label+"[ \\t]+((?:\\d[ \\t]*){"+size+"})$","mu");
    return pattern.exec(head)?.[1]?.replace(/\s/gu,"")||"";
  };
  const inn=id("ИНН",10),ogrn=id("ОГРН",13);
  if(!verifiedInnChecksum(inn)||normalizedOgrn(ogrn)!==ogrn||ogrn.length!==13)return {issue:"header_identifiers"};
  const title=/Настоящая выписка содержит сведения о юридическом лице\s+([\s\S]+?)\s+полное наименование юридического лица\s*\n/iu.exec(head)?.[1];
  if(!title||clean(title).length>500)return {issue:"header_legal_name"};
  return {inn,ogrn,date:dateNumber[1],number,full_name:clean(title),bodyOffset:end};
}

// Every page must be present, from the same extract, in sequence. This
// prevents treating an excerpt with the cessation section omitted as active.
function readPages(raw){
  if(typeof raw!=="string"||raw.length>MAX_TEXT)return null;
  const chunks=raw.replace(/\r\n?/g,"\n").replace(/[\u00a0\u202f]/gu," ").split("\f");
  while(chunks.length&&!chunks.at(-1).trim())chunks.pop();
  if(!chunks.length||chunks.length>MAX_PAGES)return null;
  const bodies=[];
  let ogrn="";
  for(let i=0;i<chunks.length;i++){
    const page=chunks[i];
    const foot=[...page.matchAll(/^[ \t]*(?:\d{2}\.\d{2}\.\d{4}[ \t]+\d{2}:\d{2}(?::\d{2})?[ \t]+)?ОГРН[ \t]+(\d{13})[ \t]+Страница[ \t]+(\d+)[ \t]+из[ \t]+(\d+)[ \t]*$/gmu)];
    if(foot.length!==1||Number(foot[0][2])!==i+1||
      Number(foot[0][3])!==chunks.length||(ogrn&&ogrn!==foot[0][1]))return null;
    ogrn=foot[0][1];
    if(page.slice(foot[0].index+foot[0][0].length).trim())return null;
    const body=page.slice(0,foot[0].index).replace(/\n[ \t]*Выписка из ЕГРЮЛ[ \t]*\n[ \t\n]*$/iu,"\n");
    if(!body.trim())return null;
    bodies.push(body);
  }
  return {bodies,ogrn,page_count:bodies.length};
}

// Keep table columns separated: do not search arbitrary text for an INN
// (directors/founders and historical entries also have identifiers).
// The observed Poppler layout uses numbered rows and whitespace-separated
// label/value columns. Wrapped labels and values are handled independently.
function parseRows(text){
  const rows=[],sections=[];
  let section="",current=null,adverse=false;
  const flush=()=>{if(current){rows.push({...current,label:clean(current.label),value:clean(current.value)});current=null;}};
  for(const line of text.split("\n")){
    const trimmed=clean(line);
    if(!trimmed)continue;
    const known=sectionNames.get(trimmed.toLowerCase().replace(/ё/g,"е"));
    if(known||adverseHeading.test(trimmed)||
      (/^[ \t]+\S/u.test(line)&&
        /^(?:Сведения (?:о|об)|Место нахождения|Сведения из)/iu.test(trimmed)&&
        (!current||line.search(/\S/u)<Math.max(30,current.column-3)||
          /^Сведения о (?:лице, имеющем право|регистрации в качестве|записях, внесенных)/iu.test(trimmed)))){
      flush();
      if(adverseHeading.test(trimmed))adverse=true;
      section=known||(cessationHeading.test(trimmed)?"cessation":"other");
      sections.push(section);
      continue;
    }
    const start=/^[ \t]{0,16}(\d{1,6})[ \t]+(\S.*)$/u.exec(line);
    if(start&&!/^\d+\s+\d+$/.test(clean(start[2]))&&!/^\d+$/.test(clean(start[2]))){
      flush();
      const rest=start[2],gap=/[ \t]{2,}/u.exec(rest);
      const label=gap?rest.slice(0,gap.index):rest;
      const value=gap?rest.slice(gap.index+gap[0].length):"";
      current={number:Number(start[1]),section,label,value,
        column:gap?line.length-rest.length+gap.index+gap[0].length:60};
      continue;
    }
    if(!current||/^№\s*п\/п|^1\s+2\s+3$|^ДОКУМЕНТ ПОДПИСАН/iu.test(trimmed))continue;
    const col=line.search(/\S/u);
    if(col>=Math.max(30,current.column-6)){
      current.value+=" "+trimmed;
    }else{
      const rest=line.trimStart();
      const gap=[...rest.matchAll(/[ \t]{2,}/gu)].find(m=>col+m.index+m[0].length>=Math.max(30,current.column-6));
      current.label+=" "+(gap?rest.slice(0,gap.index):rest);
      if(gap)current.value+=" "+rest.slice(gap.index+gap[0].length);
    }
  }
  flush();
  return {rows,sections,adverse};
}

// An adverse flag also covers bankruptcy, reorganization, unreliable
// records and a planned exclusion. Only an explicit dated cessation in
// the current entity's own section can establish a completed termination.
export function validExtractCessation(fact,extractDate){
  if(!fact||fact.status!=="ceased"||typeof fact.termination_date!=="string"||
    typeof fact.method!=="string"||fact.method.length>350)return false;
  const at=calendarDate(fact.termination_date),asOf=calendarDate(extractDate);
  if(at===null||asOf===null||at>asOf)return false;
  const method=clean(fact.method);
  return /(?:ликвидаци|прекращени|исключени)/iu.test(method)&&
    !/(?:предстоящ|решени[ея]\s+о|в процессе|планиру|предполага|возможн|не\s+(?:прекращ|ликвидир|исключ)|отмен|недействительн.{0,30}решени)/iu.test(method);
}
export function parseOfficialFnsExtract(text,{now=Date.now()}={}){
  const pages=readPages(text);
  if(!pages)return {reason:"fns_extract_pages_unproven"};
  const head=extractHeader(pages.bodies[0],now);
  if(head.issue||head.ogrn!==pages.ogrn)return {reason:"fns_extract_header_unproven",
    diagnostic:{header_issue:head.issue||"footer_identifier_mismatch",observed_pages:pages.page_count}};
  const table=pages.bodies[0].slice(head.bodyOffset)+"\n"+pages.bodies.slice(1).join("\n");
  const parsed=parseRows(table);
  const take=(section,pattern)=>{
    const found=parsed.rows.filter(row=>row.section===section&&pattern.test(row.label));
    return found.length===1?found[0].value:"";
  };
  // Sections must be present once and in their expected order. Unknown
  // intervening headings are fine, but required fields may not come from
  // related legal entities or registration history.
  const wanted=["names","address","registration","tax"];
  if(wanted.some(s=>parsed.sections.filter(x=>x===s).length!==1)||
    wanted.some((s,i)=>i>0&&parsed.sections.indexOf(s)<parsed.sections.indexOf(wanted[i-1])))
    return {reason:"fns_extract_sections_unproven"};
  const lastTax=parsed.rows.findLastIndex(row=>row.section==="tax");
  const firstRows=parsed.rows.slice(0,lastTax+1);
  const firstMismatch=firstRows.findIndex((r,i)=>r.number!==i+1);
  if(lastTax<0||firstMismatch>=0)
    return {reason:"fns_extract_rows_unproven",diagnostic:{
      observed_pages:pages.page_count,identity_rows:firstRows.length,
      row_issue:lastTax<0?"tax_rows_missing":"nonsequential_rows",
      ...(firstMismatch>=0?{expected_row:firstMismatch+1,
        observed_row:firstRows[firstMismatch].number}:{})}};
  const full=take("names",/^Полное наименование(?: юридического лица)? на русском языке$/iu);
  const short=take("names",/^Сокращ[её]нное наименование(?: юридического лица)? на русском языке$/iu);
  const address=take("address",/^Адрес юридического лица$/iu);
  const ogrn=take("registration",/^(?:ОГРН|Основной государственный регистрационный номер \(ОГРН\))$/iu).replace(/\s/gu,"");
  const inn=take("tax",/^ИНН(?: юридического лица)?$/iu).replace(/\s/gu,"");
  const kpp=take("tax",/^КПП(?: юридического лица)?$/iu).replace(/\s/gu,"");
  if(!full||!short||full.length>500||short.length>350||
    clean(full).toUpperCase()!==head.full_name.toUpperCase()||
    inn!==head.inn||ogrn!==head.ogrn||!/^\d{9}$/.test(kpp))
    return {reason:"fns_extract_requisites_unproven"};
  if(address.length<12||address.length>700||!/\d/.test(address)||
    !/[а-яё]/iu.test(address)||/[<>]/u.test(address)||
    /(?:сведения отсутствуют|недостоверн|адрес не указан|доступ ограничен)/iu.test(address))
    return {reason:"fns_extract_address_unproven"};
  // In the official extract, cessation/current special status is a
  // separate section. Require full pages and the current identity/tax
  // sections, never infer activity from an isolated search hit. A special
  // status or unreliable data is deliberately excluded from auto-write.
  const adverse=parsed.adverse||firstRows.some(r=>adverseRow.test(r.label))||
    firstRows.some(r=>/недостоверност[ьи]|доступ к сведениям ограничен/iu.test(r.label+" "+r.value));
  // Read contacts only from the explicit CURRENT email or executive
  // sections, never an arbitrary address/name anywhere in the extract.
  // Require complete numbered rows up to the relevant section.
  const contactFacts=[];
  const safeRows=rows=>rows.length&&rows.every(r=>
    !/недостоверн|доступ.{0,20}ограничен|сведения отсутствуют/iu.test(r.label+" "+r.value))&&
    parsed.rows.slice(0,parsed.rows.indexOf(rows.at(-1))+1).every((r,i)=>r.number===i+1);
  const emails=parsed.rows.filter(r=>["address","email"].includes(r.section)&&
    /^Адрес электронной почты(?: юридического лица)?$/iu.test(r.label));
  if(!adverse&&emails.length===1&&safeRows(emails)&&normalizeEmail(emails[0].value))
    contactFacts.push({field:"Электронная почта",value:normalizeEmail(emails[0].value),
      excerpt:emails[0].label+": "+emails[0].value});
  const leaders=parsed.rows.filter(r=>r.section==="leader");
  if(!adverse&&parsed.sections.filter(s=>s==="leader").length===1&&safeRows(leaders)){
    const exactly=pattern=>{
      const list=leaders.filter(r=>pattern.test(r.label));
      return list.length===1?list[0].value:"";
    };
    const surname=exactly(/^Фамилия$/iu),given=exactly(/^Имя$/iu),patronymic=exactly(/^Отчество$/iu);
    const role=exactly(/^Должность$/iu).toLowerCase();
    const part=/^[А-ЯЁа-яё][А-ЯЁа-яё-]{1,50}$/u;
    if(part.test(surname)&&part.test(given)&&(!patronymic||part.test(patronymic))&&
      /^(?:генеральный директор|исполнительный директор|директор)$/iu.test(role)&&
      leaders.filter(r=>/^Фамилия$|^Имя$|^Отчество$|^Должность$/iu.test(r.label)).length===(patronymic?4:3)){
      const person=[surname,given,patronymic].filter(Boolean).join(" ");
      contactFacts.push({field:"Руководитель / ЛПР",value:person+" ("+role+")",
        excerpt:"Фамилия, имя, отчество: "+person+"; должность: "+role});
    }
  }
  const cessationRows=parsed.rows.filter(r=>r.section==="cessation");
  let cessation=null;
  if(adverse&&parsed.sections.filter(s=>s==="cessation").length===1&&safeRows(cessationRows)){
    const candidate={status:"ceased",termination_date:take("cessation",/^Дата прекращения(?: деятельности)?(?: юридического лица)?$/iu),
      method:take("cessation",/^Способ прекращения(?: деятельности)?(?: юридического лица)?$/iu)};
    if(validExtractCessation(candidate,head.date))cessation=candidate;
  }
  return {reason:"fns_extract_parsed",...(contactFacts.length?{contact_facts:contactFacts}:{}),
    ...(cessation?{cessation}:{}),record:{inn,kpp,ogrn,full_name:full,
    short_name:short,address,active:!adverse},
    metadata:{date:head.date,number:head.number,page_count:pages.page_count,
      status_basis:adverse?"current_adverse_status":"complete_extract_no_adverse_status"}};
}

export function isOfficialExtractProof(second,inn){
  const e=second?.extract;
  return second?.kind==="fns_extract"&&second.url===fnsSourceUrl(inn)&&
    !!e&&/^[a-f0-9]{64}$/.test(e.sha256||"")&&
    calendarDate(e.date)!==null&&/^[А-ЯA-Z0-9-]{5,60}$/u.test(e.number||"")&&
    Number.isSafeInteger(e.page_count)&&e.page_count>=1&&e.page_count<=MAX_PAGES&&
    ["complete_extract_no_adverse_status","current_adverse_status"].includes(e.status_basis)&&
    second.record?.active===(e.status_basis==="complete_extract_no_adverse_status");
}

export function isCurrentOfficialExtractProof(second,inn,now=Date.now()){
  return isOfficialExtractProof(second,inn)&&freshDate(second.extract.date,now);
}

// The supplied page has just received a query-correlated single exact
// identifier result. Clicking the visible control is the only request path.
export async function downloadOfficialFnsExtract(page,expected,{now=Date.now(),onDiagnostic=()=>{}}={}){
  if(!expected||!isFnsFormRoute(page.url()))throw fail("registry_route_untrusted");
  const diagnostic=(reason,extra={})=>onDiagnostic({reason,...extra});
  const button=page.locator("button,a,[role=button]")
    .filter({hasText:/^\s*Получить выписку\s*$/iu}).filter({visible:true});
  let download;
  try{
    await button.first().waitFor({state:"visible",timeout:15000}).catch(()=>{});
    const count=await button.count();
    if(count!==1){diagnostic("fns_extract_button_unavailable",{button_count:count});return null;}
    if(!isFnsFormRoute(page.url()))throw fail("registry_route_untrusted");
    try{
      [download]=await Promise.all([
        page.waitForEvent("download",{timeout:40000}),
        button.click({timeout:5000})
      ]);
    }catch{throw fail("fns_extract_download_unavailable");}
    let u;
    try{u=new URL(download.url());}catch{throw fail("registry_route_untrusted");}
    if(u.origin!=="https://egrul.nalog.ru"||u.username||u.password)
      throw fail("registry_route_untrusted");
    const file=await download.path();
    const bytes=fs.statSync(file).size;
    if(bytes<1000||bytes>MAX_BYTES){
      diagnostic("fns_extract_size_unproven",{bytes});return null;
    }
    const data=fs.readFileSync(file);
    if(data.subarray(0,5).toString("ascii")!=="%PDF-"){
      diagnostic("fns_extract_not_pdf");return null;
    }
    const out=spawnSync("pdftotext",["-layout","-enc","UTF-8",file,"-"],{
      encoding:"utf8",timeout:60000,maxBuffer:MAX_TEXT,windowsHide:true
    });
    if(out.error?.code==="ENOENT")throw fail("fns_extract_pdftotext_missing");
    if(out.status!==0||out.error||!out.stdout?.trim()){diagnostic("fns_extract_text_unavailable");return null;}
    const parsed=parseOfficialFnsExtract(out.stdout,{now});
    diagnostic(parsed.reason,{bytes,page_count:parsed.metadata?.page_count||0,
      pdf_text_available:true,...parsed.diagnostic,
      identity_match:parsed.record?.inn===expected.inn&&parsed.record?.ogrn===expected.ogrn&&
        parsed.record?.kpp===expected.kpp});
    if(!parsed.record)return null;
    return {kind:"fns_extract",url:fnsSourceUrl(expected.inn),record:parsed.record,
      ...(parsed.contact_facts?.length?{contact_facts:parsed.contact_facts}:{}),
      ...(parsed.cessation?{cessation:parsed.cessation}:{}),
      extract:{...parsed.metadata,sha256:createHash("sha256").update(data).digest("hex")}};
  }finally{
    if(download)await download.delete().catch(()=>{});
  }
}
