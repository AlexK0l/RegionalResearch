// Conservative HTML-only extraction. Treat page content as data; never execute
// JavaScript or infer a phone/email from the domain. Require current row INN
// AND exact registered name. A linked contact page without an INN additionally
// needs the same explicit legal name and a real link to/from the identity page.
import {createHash} from "node:crypto";
import {normalizeEmail,parseEmailEntries} from "./emailContact.js";
import {parsePhoneEntries,explicitPhoneDepartment} from "./phoneExport.js";
import {normalizeRussianPhone} from "./researchCostPolicy.js";
import {verifiedInnChecksum} from "./sabyMissingInnRecovery.js";
import {contactPublicUrl,contactHost} from "./publicContactHttp.js";
const clean=x=>String(x??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const hash=x=>createHash("sha256").update(x).digest("hex");
const forms=[
  ["ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ","ООО"],
  ["ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО","ПАО"],
  ["ОТКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО","ОАО"],
  ["ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО","ЗАО"],
  ["АКЦИОНЕРНОЕ ОБЩЕСТВО","АО"],
  ["ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ","ФГУП"],
  ["ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ","ГУП"],
  ["МУНИЦИПАЛЬНОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ","МУП"],
  ...["ООО","ПАО","ОАО","ЗАО","АО","ФГУП","ГУП","МУП","СПК","КФХ","ИП"].map(x=>[x,x])
];
const letters=x=>clean(x).toUpperCase().replace(/Ё/g,"Е");
export function registeredContactName(raw){
  let s=letters(raw);
  if(!s||s.length>500||/\/|\\|\bhttps?:/u.test(s))return "";
  for(const [long,short] of forms){
    if(!s.startsWith(long)||!/^[$\s«"“„]/u.test(s.slice(long.length,long.length+1)||"$"))continue;
    const core=s.slice(long.length).replace(/[^А-ЯA-Z0-9]+/gu," ").trim();
    if(!core||core.length<2)return "";
    return short+" "+core;
  }
  return "";
}
const quotedForm=new RegExp("(?<![\\p{L}\\p{N}])("+forms.map(f=>f[0]).join("|")+")\\s*[«\"“„]([^»\"”\\n]{1,300})[»\"”]","giu");
const explicitNamePrefix=/^(?:полное |сокращ[её]нное )?(?:наименование(?: юридического лица)?(?: на русском языке)?|организация|юридическое лицо)\s*[:—-]\s*/iu;
function observedNames(blocks){
  const names=new Set();
  for(const b of blocks){
    if(b.text.length>500)continue;
    for(const m of b.text.matchAll(quotedForm)){
      const key=registeredContactName(m[1]+" "+m[2]);
      if(key)names.add(key);
    }
    let value=b.text.replace(explicitNamePrefix,"")
      .replace(/^(?:контакты|реквизиты|о компании)\s*[:—–-]?\s*/iu,"")
      .replace(/^©\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?\s*)?/u,"");
    // An unquoted legal name is accepted only as a short entire label or
    // heading, never as a fuzzy match within an article or partner list.
    if(value.length<=180&&!/[:;|]/u.test(value)){
      const key=registeredContactName(value);
      if(key)names.add(key);
    }
  }
  return names;
}
const innPattern=/(?<![\p{L}\p{N}])(?:ИНН|INN)(?:\s*(?:организации|юридического лица|юрлица|[/\\]\s*КПП))?\s*[:№#—-]?\s*(\d{12}|\d{10})(?!\d)/giu;
const entities={nbsp:" ",amp:"&",quot:'"',apos:"'",lt:"<",gt:">",laquo:"«",raquo:"»",ndash:"–",mdash:"—",copy:"©",ensp:" ",emsp:" "};
export function decodeContactEntities(s){
  return String(s??"").replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,12});/gi,(raw,key)=>{
    if(key[0]!=="#")return entities[key.toLowerCase()]??raw;
    const cp=key[1].toLowerCase()==="x"?parseInt(key.slice(2),16):Number(key.slice(1));
    return Number.isInteger(cp)&&cp>0&&cp<=0x10ffff&&!(cp>=0xd800&&cp<=0xdfff)?String.fromCodePoint(cp):" ";
  });
}
function attrs(token){
  const out={};
  const rest=token.replace(/^<\s*[\w:-]+/u,"").replace(/\/?>$/u,"");
  for(const m of rest.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/gu)){
    const key=m[1].toLowerCase();
    if(!Object.hasOwn(out,key))out[key]=decodeContactEntities(m[2]??m[3]??m[4]??"");
  }
  return out;
}
const blockTags=new Set(["title","h1","h2","h3","h4","h5","h6","p","div","li","ul","ol","table","tr","td","th","section","article","address","header","footer","main","nav","aside","br","hr","dt","dd"]);
const rawTags=new Set(["script","style","textarea","title"]);
const hiddenTags=new Set(["script","style","noscript","template","iframe","svg","canvas","object","embed","textarea","form","select","button"]);
const voidTags=new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
export function parsePublicContactPage(html,url){
  if(typeof html!=="string"||html.length>1024*1024||!contactPublicUrl(url))return null;
  const stack=[],blocks=[],links=[];
  let text="",anchors=[],bad=false;
  const visible=()=>!stack.some(x=>x.hidden);
  const flush=()=>{
    const value=clean(text);
    if(value){
      if(value.length>1600||blocks.length>=5000)bad=true;
      else blocks.push({text:value,anchors:anchors.slice(0,20)});
    }
    text="";anchors=[];
  };
  const closeNode=node=>{
    if(node.anchor&&!node.hidden){
      const a={href:node.anchor.href,text:clean(node.anchor.text)};
      if(a.text&&a.href){
        if(/^(?:tel|mailto):/i.test(a.href))anchors.push(a);
        else{
          try{
            const href=contactPublicUrl(new URL(a.href,url).href);
            if(href&&contactHost(href)===contactHost(url)&&links.length<300)
              links.push({url:href,text:a.text.slice(0,150)});
          }catch{/* invalid link */}
        }
      }
    }
  };
  for(const m of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</gi)){
    const token=m[0],tag=/^<(\/?)\s*([a-z][\w:-]*)/i.exec(token);
    const raw=stack.at(-1);
    if(raw&&rawTags.has(raw.tag)&&raw.tag!=="title"&&
      !(tag&&tag[1]&&tag[2].toLowerCase()===raw.tag))continue;
    if(token.startsWith("<!"))continue;
    if(!tag){
      if(visible()){
        const value=decodeContactEntities(token);
        text+=value;
        for(const node of stack)if(node.anchor)node.anchor.text+=value;
        if(text.length>3200){bad=true;break;}
      }
      continue;
    }
    const name=tag[2].toLowerCase();
    if(tag[1]){
      const at=stack.findLastIndex(x=>x.tag===name);
      if(at<0)continue;
      const wasVisible=visible();
      while(stack.length>at)closeNode(stack.pop());
      if(wasVisible&&blockTags.has(name))flush();
      continue;
    }
    const wasVisible=visible(),a=attrs(token);
    if(wasVisible&&blockTags.has(name))flush();
    const hidden=!wasVisible||hiddenTags.has(name)||Object.hasOwn(a,"hidden")||
      a["aria-hidden"]==="true"||/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(a.style||"");
    if(!voidTags.has(name)&&!token.endsWith("/>")){
      stack.push({tag:name,hidden,anchor:name==="a"&&!hidden?{href:a.href||"",text:""}:null});
      if(stack.length>96){bad=true;break;}
    }
  }
  while(stack.length)closeNode(stack.pop());
  flush();
  if(bad||!blocks.length)return null;
  const full=blocks.map(b=>b.text).join("\n");
  if(/^(?:access denied|just a moment|captcha|подтвердите,? что вы не робот|доступ запрещ[её]н|проверка безопасности)\s*[.!:]*$/imu.test(full))return null;
  // Tax ID label and its value may be adjacent table cells. Combine only
  // the two bounded blocks, never arbitrary digits in prose.
  const ids=new Set([...full.matchAll(innPattern)].map(x=>x[1]));
  return {url,hash:hash(html),blocks,links,
    inns:[...ids],names:[...observedNames(blocks)]};
}
const contactPath=/(?:^|[/_.-])(?:contacts?|kontakty?|kontakti|contact-us|requisites?|rekvizity?|rekviziti|about|o-kompanii|company|management|rukovodstvo|zakupki|procurement|snabzhenie|transport|logistics)(?:$|[/_.-])/i;
const contactTitle=/^(?:контакт[ыа]?|наши контакты|контактная информация|реквизиты|о компании|о нас|руководство|закупки|снабжение|отдел закупок|транспортный отдел|служба логистики|contacts?|contact us|about us)(?:\s*[:—–-].*)?$/iu;
export function contactPageLink(link){
  try{return contactPath.test(new URL(link.url).pathname)||contactTitle.test(clean(link.text));}
  catch{return false;}
}
// Explicit company-card routes already cited by discovery. A catalogue
// homepage, search result, related-company list or maps card is not proof.
export function contactDirectoryCard(url){
  try{
    const u=new URL(url),h=contactHost(url),p=u.pathname;
    return (h==="rusprofile.ru"&&/^\/(?:id|inn)\/\d+\/?$/i.test(p))||
      (h==="list-org.com"&&/^\/company\/\d+\/?$/i.test(p))||
      (h==="checko.ru"&&/^\/company\/[^/]+-\d{13}\/?$/i.test(p))||
      (h==="tbank.ru"&&/^\/business\/contractor\/legal\/\d{13}\/?$/i.test(p));
  }catch{return false;}
}
const excludedHost=/^(?:.*\.)?(?:saby\.ru|sbis\.ru|nalog\.gov\.ru|nalog\.ru|yandex\.(?:ru|com)|ya\.ru|2gis\.ru|google\.(?:ru|com)|vk\.com|ok\.ru|t\.me|telegram\.me|youtube\.com|avito\.ru|zakupki\.gov\.ru|kad\.arbitr\.ru|fedresurs\.ru|wikipedia\.org|hh\.ru|rusprofile\.ru|list-org\.com|checko\.ru|tbank\.ru)$/i;
export function contactSourceCandidates(row){
  const e=row?.__evidence||{},raw=[];
  const push=(value,explicit=false)=>{
    const url=contactPublicUrl(value);
    if(!url)return;
    const host=contactHost(url),directory=contactDirectoryCard(url);
    if(excludedHost.test(host)&&!directory)return;
    const u=new URL(url);
    const root=u.pathname==="/";
    const contact=contactPageLink({url,text:""});
    // Do not start crawling an arbitrary article, tender or media site.
    if(!explicit&&!root&&!contact&&!directory)return;
    raw.push({url,host,directory,explicit,score:directory?3:explicit?6:contact?5:4});
  };
  push(e.official_site,true);
  push(e.contact_verification?.source_url,true);
  for(const url of Array.isArray(e.public_contact_site_hints)?e.public_contact_site_hints.slice(0,5):[])push(url,true);
  const comment=String(row?.__comment||"").match(/^Сайт\/источник:\s*(https?:\/\/[^\s]+)\s*$/im);
  if(comment)push(comment[1],false);
  for(const url of Array.isArray(e.source_urls)?e.source_urls.slice(0,60):[])push(url);
  raw.sort((a,b)=>b.score-a.score);
  const seen=new Set(),out=[];
  for(const item of raw){
    // One entry per company host, but exact directory cards stay separate
    // from own-site crawls. The address is never derived from the INN.
    if(seen.has(item.host))continue;
    seen.add(item.host);out.push(item);
    if(out.length===3)break;
  }
  return out;
}
export function publicContactTarget(row){
  const inn=String(row?.["ИНН"]||"").trim(),name=registeredContactName(row?.["Организация"]);
  return /^\d{10}$/.test(inn)&&verifiedInnChecksum(inn)&&name?{inn,name}:null;
}
function pageIdentity(page,target){
  return page&&page.names.length===1&&page.names[0]===target.name&&
    page.inns.length===1&&page.inns[0]===target.inn;
}
function isLinked(a,b){
  return a.links.some(x=>x.url===b.url)||b.links.some(x=>x.url===a.url);
}
const unsafeContext=/разработ(?:ка|чик)\s+сайта|создание\s+сайта|веб[- ]?студи|webmaster|сайт\s+(?:создан|разработан)|политик[аи]\s+конфиденциальности|партн[её]р|контрагент|поставщик\s*[:—-]|заказчик\s*[:—-]|субподрядчик|сторонн|филиал|представительств|факс|fax|ИНН|ОГРН|КПП|пример\s+заполнения|тестов[а-я]+\s+(?:номер|адрес)/iu;
const phoneLabel=/тел(?:ефон)?(?:ы)?\s*[:.]|телефон|горячая линия|при[её]мная|(?:отдел|служба|диспетчерская)\s*[:—-]|phone\s*:/iu;
const emailLabel=/e[\s-]?mail|электронн[а-я]*\s+почт|почта\s*:/iu;
const leaderLabel=/^(генеральный директор|исполнительный директор|директор|главный механик|руководитель отдела закупок|начальник отдела снабжения|начальник транспортного отдела)\s*[:—–-]\s*(.+)$/iu;
const fullName=/^[А-ЯЁ][а-яё-]{1,40}(?:\s+[А-ЯЁ][а-яё-]{1,40}){1,2}$/u;
const upperName=/^[А-ЯЁ][А-ЯЁ-]{1,40}(?:\s+[А-ЯЁ][А-ЯЁ-]{1,40}){1,2}$/u;
export function publicPersonName(value){
  const s=clean(value);
  if(!fullName.test(s)&&!upperName.test(s))return "";
  if(/директор|компани|отдел|организац|неизвест|вакант|должност|обществ|руководител/i.test(s))return "";
  return s;
}
function usableEmail(email){
  const value=normalizeEmail(email);
  if(!value)return "";
  if(/^(?:example|test|noreply|no-reply|donotreply)@/i.test(value)||
     /@(?:example\.(?:com|org|net)|example|test\.ru|email\.com)$/i.test(value))return "";
  return value;
}
function contactFacts(page,target,identity){
  const found=new Map();
  const add=(field,value,excerpt,department="")=>{
    if(!value||found.size>=30)return;
    const key=field+"|"+value;
    const prev=found.get(key);
    if(prev){
      if(prev.department&&department&&prev.department!==department)prev.department="";
      else if(!prev.department&&department)prev.department=department;
      return;
    }
    found.set(key,{field,value,department,excerpt:excerpt.slice(0,240),
      method:contactDirectoryCard(page.url)?"public_directory_exact_inn":"public_html_exact_entity",
      inn:target.inn,name:target.name,source_url:page.url,identity_url:identity.url,
      source_sha256:page.hash,identity_sha256:identity.hash});
  };
  for(let i=0;i<page.blocks.length;i++){
    const b=page.blocks[i],v=b.text;
    if(v.length>450||unsafeContext.test(v))continue;
    const previous=i>0?page.blocks[i-1].text:"";
    const preceding=previous.length<=65&&!unsafeContext.test(previous)&&
      !parsePhoneEntries(previous).length?explicitPhoneDepartment(previous):"";
    const department=explicitPhoneDepartment(v)||preceding;
    for(const a of b.anchors){
      if(/^tel:/i.test(a.href)){
        const raw=a.href.slice(4);
        if(!/^[+()\d .-]{10,28}$/.test(raw))continue;
        const phone=normalizeRussianPhone(raw);
        // A hidden/different href is not evidence. The same number must be
        // rendered visibly to ordinary visitors in this actual contact block.
        if(phone&&parsePhoneEntries(a.text).some(x=>x.phone===phone))
          add("Телефон",phone,v,department);
      }else if(/^mailto:/i.test(a.href)){
        const address=usableEmail(a.href.slice(7));
        if(address&&parseEmailEntries(a.text).includes(address))
          add("Электронная почта",address,v);
      }
    }
    if(phoneLabel.test(v)||department){
      for(const p of parsePhoneEntries(v))add("Телефон",p.phone,v,p.department||department);
    }
    if(emailLabel.test(v)){
      for(const e of parseEmailEntries(v))add("Электронная почта",usableEmail(e),v);
    }
    let role=leaderLabel.exec(v);
    if(!role&&v.length<=60&&i+1<page.blocks.length)
      role=leaderLabel.exec(v+": "+page.blocks[i+1].text);
    if(role){
      const person=publicPersonName(role[2]);
      if(person)add("Руководитель / ЛПР",person+" ("+role[1].toLowerCase()+")",
        role[0]);
    }
  }
  return [...found.values()];
}
export function extractVerifiedPublicContacts(pages,row,{directory=false}={}){
  const target=publicContactTarget(row);
  if(!target)return {reason:"identity_invalid",facts:[]};
  const list=pages.filter(Boolean),anchors=list.filter(p=>pageIdentity(p,target));
  if(!anchors.length)return {reason:"identity_unproven",facts:[]};
  const facts=[];
  for(const page of list){
    const own=anchors.find(x=>x===page);
    const linked=!directory&&!page.inns.length&&page.names.length===1&&page.names[0]===target.name?
      anchors.find(x=>contactHost(x.url)===contactHost(page.url)&&isLinked(x,page)):null;
    // A site with another explicit INN or named legal entity anywhere in
    // its inspected contact pages cannot confer cross-page ownership.
    const conflict=list.some(p=>p.inns.some(x=>x!==target.inn)||
      p.names.some(x=>x!==target.name));
    const identity=own||(!conflict?linked:null);
    if(!identity||directory&&!own)continue;
    facts.push(...contactFacts(page,target,identity));
  }
  return {reason:facts.length?"verified_contacts":"verified_no_contacts",facts:facts.slice(0,60)};
}
export async function lookupPublicCompanyContacts(row,client){
  const candidates=contactSourceCandidates(row);
  if(!candidates.length)return {reason:"no_safe_source",facts:[]};
  const facts=[];let read=0,errors=0,verifiedPages=0,proven=false;
  const seenHosts=new Set();
  for(const source of candidates){
    if(client.exhausted)break;
    const pages=[],seen=new Set();
    const readPage=async(url)=>{
      if(seen.has(url)||client.exhausted||pages.length>=5)return;
      seen.add(url);
      try{
        const response=await client.fetch(url);
        if(response.status!==200)return;
        read++;
        const page=parsePublicContactPage(response.html,response.url);
        if(page)pages.push(page);else errors++;
      }catch(error){errors++;}
    };
    if(seenHosts.has(source.host))continue;seenHosts.add(source.host);
    await readPage(source.url);
    if(!source.directory&&pages.length&&!client.exhausted){
      // Prefer actual contact and requisites hyperlinks. Do not guess
      // paths or fan out across the web; bound all reads to five pages.
      const links=pages[0].links.filter(contactPageLink).sort((a,b)=>{
        const rank=x=>/контакт|contact|реквизит|rekvizit/i.test(x.text+" "+x.url)?1:0;
        return rank(b)-rank(a);
      });
      for(const link of links.slice(0,8)){
        if(seen.size>=5||client.exhausted)break;
        await readPage(link.url);
      }
      // Requisites linked from the contact page rather than the landing page.
      for(const p of pages.slice(1)){
        for(const link of p.links.filter(contactPageLink)){
          if(seen.size>=5||client.exhausted)break;
          await readPage(link.url);
        }
        if(seen.size>=5||client.exhausted)break;
      }
    }
    const result=extractVerifiedPublicContacts(pages,row,{directory:source.directory});
    if(result.reason!=="identity_unproven"&&result.reason!=="identity_invalid"){proven=true;verifiedPages++;}
    facts.push(...result.facts);
    if(facts.length>=30)break;
  }
  return {facts:facts.slice(0,60),reason:facts.length?"verified_contacts":proven?
    "verified_no_contacts":errors?"source_unavailable":read?"identity_unproven":"no_readable_source",
    pages_read:read,source_errors:errors,verified_sources:verifiedPages};
}
