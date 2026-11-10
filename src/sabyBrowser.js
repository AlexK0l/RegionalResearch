// Saby browser adapter. Ported from the supplied saby_agent.py, but with a
// single persistent Playwright session, bounded DOM polling, independent
// contacts/truck recovery, and no Google Sheets or paid OpenAI dependencies.
import path from "node:path";
import { chromium } from "playwright";
import { extractSabyPhoneDetails } from "./phoneExport.js";
import { findSabyCompanySearch } from "./sabySearch.js";
import { verifySabyCard, sabyCardRoute, safeCardDiagnostic } from "./sabyCard.js";
import { authenticateSaby, sabyCredentials } from "./sabyAuth.js";
import { recoverSabyMissingSections } from "./sabyRecovery.js";
import { sabyInn, sabyNameMatches, sabySearchResultMatches,
  isSabyProfileUrl } from "./sabyEnrichment.js";

export class SabyReview extends Error {
  constructor(message) { super(message); this.name = "SabyReview"; }
}

const BASE = "https://profile.saby.ru/page/company-list-prof";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bound = (v, min, max, fallback) => Number.isFinite(Number(v)) ?
  Math.max(min, Math.min(max, Math.floor(Number(v)))) : fallback;

export function sabyBrowserSettings(env = process.env) {
  const {login, password} = sabyCredentials(env);
  return {
    login, password,
    profileDir: path.resolve(String(env.SABY_PROFILE_DIR || "data/saby-profile")),
    headless: String(env.SABY_HEADLESS || "false").toLowerCase() === "true",
    channel: String(env.SABY_BROWSER_CHANNEL || "").trim(),
    timeoutMs: bound(env.SABY_COMPANY_TIMEOUT_MS, 15000, 90000, 45000),
    delayMs: bound(env.SABY_DELAY_MS, 250, 30000, 1500)
  };
}

let sessionQueue = Promise.resolve();
// A persistent Chrome/Chromium user data directory cannot be opened by two
// processes at once. This serializes overlapping regional studies in Node.
export async function withSabyBrowser(task, {env = process.env, autoLogin = true} = {}) {
  let release;
  const predecessor = sessionQueue;
  sessionQueue = new Promise(resolve => { release = resolve; });
  await predecessor;
  let context;
  try {
    const settings = sabyBrowserSettings(env);
    context = await chromium.launchPersistentContext(settings.profileDir, {
      ...(settings.channel ? {channel:settings.channel} : {}),
      headless:settings.headless, viewport:{width:1440,height:920},
      acceptDownloads:false,
      timeout:30000
    });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(6000);
    if (autoLogin && settings.login && settings.password) {
      await authenticateSaby(page, settings);
    }
    return await task({page, context, settings});
  } finally {
    if (context) await context.close().catch(() => {});
    release();
  }
}

async function visibleLocator(locator) {
  const count = Math.min(20, await locator.count());
  for (let i = 0; i < count; i++) {
    if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  }
  return null;
}


/**
 * Identity can render before Saby asynchronously mounts contact and fleet
 * widgets. Wait only when neither requested widget is visible, so ordinary
 * cards are not slowed down and missing widgets never look like confirmed
 * absence of company data.
 */
async function detailSections(page) {
  return {
    contacts:Boolean(await visibleLocator(page.getByText("Контакты",{exact:true}))),
    trucks:Boolean(await visibleLocator(page.getByText("Автопарк компании",{exact:true})))
  };
}

async function waitForDetailSections(page, timeoutMs=7000) {
  const until=Date.now()+Math.max(0,Math.min(timeoutMs,10000));
  let found=await detailSections(page);
  while(!found.contacts&&!found.trucks&&Date.now()<until) {
    await delay(450);
    found=await detailSections(page);
  }
  return found;
}

/**
 * First-party-only, allowlisted booleans. No page text or URLs leave the
 * browser; never print cookies, contact numbers, emails or company details.
 */
export async function safeSabySectionDiagnostic(page) {
  const route=sabyCardRoute(page.url());
  if(route!=="detail") return {route};
  const out={route};
  try {
    const sections=await detailSections(page);
    out.exact_contacts_heading=sections.contacts;
    out.exact_fleet_heading=sections.trucks;
  } catch {
    out.heading_check_failed=true;
  }
  if(typeof page.evaluate!=="function") return out;
  try {
    const flags=await page.evaluate(()=>{
      const text=String(document.body?.innerText||"").slice(0,100000);
      return {
        mentions_contacts:/контакт/i.test(text),
        mentions_phones:/телефон/i.test(text),
        mentions_fleet:/автопарк/i.test(text),
        mentions_trucks:/грузовые/i.test(text),
        has_tel_link:Boolean(document.querySelector('a[href^="tel:"]')),
        has_mail_link:Boolean(document.querySelector('a[href^="mailto:"]')),
        substantive_page:text.trim().length>150
      };
    });
    for(const key of [
      "mentions_contacts","mentions_phones","mentions_fleet",
      "mentions_trucks","has_tel_link","has_mail_link","substantive_page"
    ]) out[key]=flags?.[key]===true;
  } catch {
    out.dom_check_failed=true;
  }
  return out;
}

async function findResultRows(page, inn) {
  return page.evaluate(inn => {
    const norm = s => String(s || "").replace(/\s+/g," ").trim();
    const matchesInn = s => new RegExp("(^|\\D)" + inn + "(?!\\d)").test(s);
    const visible = e => {
      const r=e.getBoundingClientRect(), s=getComputedStyle(e);
      return r.width>0 && r.height>0 && s.visibility!=="hidden" && s.display!=="none";
    };
    const legal = /(?:^|\W)(?:ООО|ПАО|АО|ОАО|ЗАО|ИП)(?:\W|$)/i;
    const relevant=[];
    // Highlighted INNs may span multiple child nodes; inspect only innermost
    // matching DOM nodes instead of collecting whole-page text.
    for (const element of document.querySelectorAll("body *")) {
      if (!visible(element) || !matchesInn(norm(element.textContent))) continue;
      if ([...element.children].some(ch => matchesInn(norm(ch.textContent)))) continue;
      let node=element;
      for (let depth=0;node && depth<9;depth++,node=node.parentElement) {
        if (!visible(node)) continue;
        const r=node.getBoundingClientRect();
        const rawText=String(node.innerText||node.textContent||"");
        const text=norm(rawText);
        if (r.height>190 || text.length>700) break;
        if (r.width<190 || r.height<24 || !matchesInn(text)) continue;
        if (legal.test(text) && text.replace(inn,"").trim().length>=5) {
          if (/\b(?:филиал|подразделение|представительство)\b/i.test(
            text.split(inn,1)[0])) break;
          relevant.push({text:rawText,rect:{x:r.x,y:r.y,w:r.width,h:r.height}});
          break;
        }
      }
    }
    return relevant.filter((x,i) => !relevant.some((y,j) =>
      j<i && Math.abs(x.rect.x-y.rect.x)<15 &&
      Math.abs(x.rect.y-y.rect.y)<5)).slice(0,20);
  }, inn);
}

async function openCompany(page, row, settings) {
  const inn=sabyInn(row?.["ИНН"]);
  const name=String(row?.["Организация"]||"").trim();
  if (!inn || !name) throw new SabyReview("Компания без пригодного ИНН/названия");
  await page.goto(BASE, {waitUntil:"domcontentloaded",timeout:settings.timeoutMs});
  if (!isSabyProfileUrl(page.url())) throw new SabyReview("Переадресация вне Saby");
  const found=await findSabyCompanySearch(page,{
    timeoutMs:Math.min(15000,settings.timeoutMs)
  });
  if(!found.field) {
    // No screenshots, DOM text, form values or credentials in diagnostics.
    console.warn("[SABY_SEARCH_DIAG] "+JSON.stringify(found.diagnostic));
    throw new SabyReview("Поле поиска компаний Saby не распознано ("+
      found.reason+"); статус входа проверен отдельно");
  }
  console.info("[SABY_SEARCH] "+found.method);
  await found.field.fill(inn);
  await found.field.press("Enter");
  const until=Date.now()+Math.min(18000,settings.timeoutMs);
  let rows=[];
  while(Date.now()<until) {
    rows=(await findResultRows(page,inn)).filter(item=>
      sabySearchResultMatches(name,item.text,inn));
    if(rows.length===1) break;
    if(rows.length>1) {
      // Search results sometimes duplicate DOM wrappers at the same position;
      // physical row de-duplication is done in findResultRows.
      throw new SabyReview("Saby: неоднозначный результат по ИНН");
    }
    await delay(450);
  }
  if(rows.length!==1) throw new SabyReview("Saby: однозначная организация по ИНН не найдена");
  const r=rows[0].rect;
  const listingUrl=page.url();
  await page.mouse.click(r.x+Math.min(120,r.w*.25),r.y+Math.min(20,r.h*.25));
  const startCard=Date.now();
  const cardUntil=startCard+Math.min(18000,settings.timeoutMs);
  let last={ok:false,reason:"not_detail_page",detail:{route:"list"}};
  let reClicked=false;
  while(Date.now()<cardUntil) {
    try {
      const outcome=await verifySabyCard(page,inn,name);
      last=outcome;
      if(outcome.ok) {
        console.info("[SABY_CARD] identity_verified");
        return {inn,name:outcome.verifiedName,verified:true};
      }
    } catch {
      // Rendering may be in progress during the route transition.
      last={ok:false,reason:"detail_loading",
        detail:{route:sabyCardRoute(page.url())}};
    }

    // Some Saby layouts do not handle clicks near the row's top edge.
    // One bounded second click is permitted only if the SAME unique
    // company still appears in the search results on the original route.
    if(!reClicked && Date.now()-startCard>4500 &&
       page.url()===listingUrl && sabyCardRoute(page.url())==="list") {
      reClicked=true;
      const again=(await findResultRows(page,inn)).filter(item=>
        sabySearchResultMatches(name,item.text,inn));
      if(again.length===1) {
        const box=again[0].rect;
        console.info("[SABY_CARD] retry_result_click");
        await page.mouse.click(
          box.x+Math.min(95,box.w*.20),
          box.y+Math.min(38,box.h*.5)
        );
      }
    }
    await delay(450);
  }
  console.warn("[SABY_CARD_DIAG] "+JSON.stringify(safeCardDiagnostic(last,{
    clicked:true,
    navigationObserved:page.url()!==listingUrl
  })));
  throw new SabyReview("Saby: карточка не подтверждена: "+last.reason);
}

async function ownContacts(page) {
  const heading=await visibleLocator(page.getByText("Контакты",{exact:true}));
  if (!heading) return {phones:[],emails:[],status:"missing"};
  let node=heading;
  let text="";
  for(let i=0;i<6;i++){
    node=node.locator("xpath=..");
    const value=await node.innerText({timeout:4000}).catch(()=>"");
    if (value.length>1800) break;
    text=value;
    if (/\+7|(?:^|\s)8\s*\(|[\w.+-]+@[\w.-]+\.[a-zа-я]{2,}/i.test(text)) break;
  }
  text=text.split(/Контакты связанных компаний/i,1)[0];
  const phoneDetails=extractSabyPhoneDetails(text);
  const phones=phoneDetails.map(x=>x.phone);
  const emails=[...new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)||[])
    .map(x=>x.toLowerCase()))];
  return {phones,phone_details:phoneDetails,emails,status:"collected"};
}

async function closeContactOverlay(page) {
  await page.keyboard.press("Escape").catch(()=>{});
  const title=await visibleLocator(page.getByText("Контакты и телефоны",{exact:true}));
  if(!title) return;
  const pos=await page.evaluate(() => {
    const matches=[...document.querySelectorAll("body *")].filter(e=>
      e.children.length===0 &&
      (e.textContent||"").trim()==="Контакты и телефоны" &&
      e.getBoundingClientRect().width>0);
    const heading=matches.sort((a,b)=>b.getBoundingClientRect().x-a.getBoundingClientRect().x)[0];
    if(!heading) return null;
    const r=heading.getBoundingClientRect();
    for(const y of [innerHeight*.55,innerHeight*.67,innerHeight*.42]) {
      for(const x of [r.left-85,r.left-130,r.left-190]) {
        if(x<220||y<80||x>innerWidth-60) continue;
        const el=document.elementFromPoint(x,y);
        if(!el || el.closest("button,a,input,select,textarea,[role='button'],[onclick]")) continue;
        return {x:Math.round(x),y:Math.round(y)};
      }
    }
    return null;
  });
  if(!pos) throw new SabyReview("Нет безопасного способа закрыть панель контактов");
  await page.mouse.click(pos.x,pos.y);
  if(await visibleLocator(page.getByText("Контакты и телефоны",{exact:true}))) {
    throw new SabyReview("Панель контактов осталась открытой");
  }
}

async function truckPreview(page) {
  return page.evaluate(() => {
    const clean=s=>String(s||"").replace(/\s+/g," ").trim();
    const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden";};
    const isTruck=t=>/^Грузовые(?:\s+\d+)?$/i.test(clean(t));
    const leaves=[...document.querySelectorAll("body *")]
      .filter(e=>vis(e)&&isTruck(e.textContent)&&
        ![...e.children].some(c=>isTruck(c.textContent)));
    const tiles=[];
    for(const head of leaves) {
      let node=head,tile=null,count=null;
      for(let depth=0;node&&depth<8;depth++,node=node.parentElement){
        const t=clean(node.innerText),r=node.getBoundingClientRect();
        if(t.length>650||r.height>470||r.width>420)break;
        const m=t.match(/(?:^|\s)Грузовые\s+(\d+)(?=\s|$)/i);
        if(m&&r.height>=85&&r.width>=110){tile=node;count=Number(m[1]);}
      }
      if(!tile||tile.getBoundingClientRect().left>innerWidth*.68)continue;
      const r=tile.getBoundingClientRect();
      const raw=[...tile.querySelectorAll("*")].filter(e=>vis(e)&&e.children.length===0)
        .map(e=>clean(e.textContent)).filter(Boolean);
      const rows=[];
      for(let i=0;i<raw.length;i++) {
        const item=raw[i];
        if(/^(Грузовые|Легковые|Коммерческие|Автобусы|Спецтехника|Автопарк)/i.test(item) ||
            /^\d+$/.test(item))continue;
        let model=item,year=null;
        const pair=item.match(/^(.+?)[,;]\s*((?:19|20)\d{2})(?:\s*г\.?)?$/);
        if(pair){model=clean(pair[1]);year=Number(pair[2]);}
        else if(i+1<raw.length && /^(?:19|20)\d{2}(?:\s*г\.?)?$/.test(raw[i+1])) {
          year=Number(raw[++i].match(/\d{4}/)[0]);
        }
        if(/[a-zа-яё]/iu.test(model)&&model.length<=150) {
          rows.push({model,year});
        }
      }
      if(rows.length>count)continue;
      tiles.push({count,rows,rect:{x:r.x,y:r.y,w:r.width,h:r.height}});
    }
    const unique=tiles.filter((x,i)=>!tiles.some((y,j)=>j<i &&
      x.count===y.count && Math.abs(x.rect.x-y.rect.x)<3 && Math.abs(x.rect.y-y.rect.y)<3));
    return unique.length===1?{status:"found",...unique[0]}:
      {status:unique.length?"ambiguous":"missing"};
  });
}

async function sidePanelTrucks(page,expected,action="read") {
  return page.evaluate(({expected,action})=>{
    const clean=s=>String(s||"").replace(/\s+/g," ").trim();
    const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none";};
    const cats=/^(Легковые|Коммерческие|Грузовые|Автобусы|Спецтехника|Прицепы|Мотоциклы)(?:\s+\d+)?$/i;
    const headings=[...document.querySelectorAll("body *")].filter(e=>
      vis(e)&&e.children.length===0&&clean(e.textContent)==="Автопарк");
    const panels=[];
    for(const heading of headings) {
      let node=heading;
      for(let depth=0;node&&depth<12;depth++,node=node.parentElement) {
        const r=node.getBoundingClientRect(),t=node.innerText||"";
        if(r.width<250||r.height<180||r.right<innerWidth*.60||t.length>26000)continue;
        if(!t.includes("Грузовые"))continue;
        panels.push(node);
      }
    }
    panels.sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-
      b.getBoundingClientRect().width*b.getBoundingClientRect().height);
    for(const panel of panels) {
      const leaf=[...panel.querySelectorAll("*")].filter(e=>vis(e)&&e.children.length===0);
      const heads=leaf.filter(e=>cats.test(clean(e.textContent)));
      const truck=heads.find(e=>/^Грузовые(?:\s+\d+)?$/i.test(clean(e.textContent)));
      if(!truck)continue;
      const match=(clean(truck.textContent)+" "+clean(truck.parentElement?.innerText))
        .match(/Грузовые\s*(\d+)/i);
      if(!match||Number(match[1])!==expected)continue;
      if(action==="expand") {
        // Like the original Saby UI: the category can be a collapsed
        // accordion within the open side panel. Click its short heading
        // row, not an arbitrary coordinate of the whole panel.
        let target=truck;
        for(let i=0;i<4 && target.parentElement;i++) {
          const parent=target.parentElement;
          const rect=parent.getBoundingClientRect();
          const label=clean(parent.innerText);
          if(label.length>140 || rect.height>100) break;
          target=parent;
        }
        target.click();
        return {opened:true,rows:[],expanded:true};
      }
      const next=heads.slice(heads.indexOf(truck)+1)[0]||null;
      const raw=leaf.filter(e=>e!==truck &&
        Boolean(truck.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING) &&
        (!next||Boolean(e.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING)))
        .map(e=>clean(e.textContent)).filter(Boolean);
      const rows=[];
      for(let i=0;i<raw.length;i++){
        const t=raw[i];
        if(cats.test(t))break;
        if(/^\d+$/.test(t)||/^(Грузовые|Показать|Еще|Ещё|Свернуть|Всего)/i.test(t) ||
           t.length<3 || t.length>150)continue;
        let model=t,year=null;
        const m=t.match(/^(.+?)[,;]\s*((?:19|20)\d{2})(?:\s*г\.?)?$/);
        if(m){model=clean(m[1]);year=Number(m[2]);}
        else if(i+1<raw.length&&/^(?:19|20)\d{2}(?:\s*г\.?)?$/.test(raw[i+1])){
          year=Number(raw[++i].match(/\d{4}/)[0]);
        }
        if(/[a-zа-яё]/iu.test(model))rows.push({model,year});
      }
      const scrolls=[panel,...panel.querySelectorAll("*")].filter(e=>{
        const s=getComputedStyle(e);
        return vis(e)&&e.scrollHeight>e.clientHeight+15&&/(auto|scroll)/.test(s.overflowY);
      });
      const scroller=scrolls.findLast(e=>e.contains(truck))||scrolls[scrolls.length-1];
      if(scroller&&rows.length<expected)scroller.scrollTop+=Math.max(200,scroller.clientHeight*.75);
      return {opened:true,rows};
    }
    return {opened:false,rows:[]};
  },{expected,action});
}

async function ownTrucks(page, settings) {
  const heading=await visibleLocator(page.getByText("Автопарк компании",{exact:true}));
  if(!heading) return {status:"missing"};
  let preview=await truckPreview(page);
  if(preview.status==="missing") {
    await heading.click({timeout:4000}).catch(()=>{});
    const until=Date.now()+9000;
    while(Date.now()<until) {
      preview=await truckPreview(page);
      if(preview.status!=="missing") break;
      await delay(350);
    }
  }
  if(preview.status!=="found") throw new SabyReview("Грузовой автопарк не определён однозначно");
  if(preview.count===0) return {status:"verified",count:0,vehicles:[]};
  if(preview.count<0 || preview.count>5000) throw new SabyReview("Некорректное число грузовых");
  let rows=preview.rows;
  if(rows.length!==preview.count) {
    const r=preview.rect;
    let categoryExpanded=false;
    for(let attempt=0;attempt<2;attempt++){
      await page.mouse.click(r.x+r.w*.5,r.y+r.h*.45);
      const until=Date.now()+Math.min(12000,settings.timeoutMs);
      while(Date.now()<until) {
        const panel=await sidePanelTrucks(page,preview.count);
        if(panel.opened&&panel.rows.length>rows.length)rows=panel.rows;
        if(rows.length===preview.count)break;
        if(panel.opened && panel.rows.length===0 && !categoryExpanded) {
          const opened=await sidePanelTrucks(page,preview.count,"expand");
          categoryExpanded=Boolean(opened.expanded);
        }
        await delay(400);
      }
      if(rows.length===preview.count)break;
    }
  }
  if(rows.length!==preview.count ||
     rows.some(x=>!x.model||/(?:\.\.\.|…)\s*$/.test(x.model))) {
    throw new SabyReview("Неполный автопарк: заявлено "+preview.count+
      ", подтверждено "+rows.length);
  }
  return {status:"verified",count:preview.count,vehicles:rows};
}

async function collectSabyCompanyAttempt(page, row, settings) {
  const identity=await openCompany(page,row,settings);
  // A verified legal name and INN does not imply detail widgets are hydrated.
  await waitForDetailSections(page, Math.min(7000,settings.timeoutMs||45000));
  const result={identity,source:"SABY",source_url:page.url(),
    collected_at:new Date().toISOString(),
    contacts:{phones:[],emails:[],status:"missing"},trucks:{status:"missing"},
    errors:[]};
  try { result.contacts=await ownContacts(page); }
  catch(error) { result.errors.push("contacts: "+error.message); }
  try {
    await closeContactOverlay(page);
    result.trucks=await ownTrucks(page,settings);
  } catch(error) {
    result.errors.push("trucks: "+error.message);
    result.trucks={status:"review"};
  }
  if(result.contacts.status==="missing" && result.trucks.status==="missing") {
    console.warn("[SABY_SECTION_DIAG] "+JSON.stringify(
      await safeSabySectionDiagnostic(page)));
  }
  return result;
}

export async function collectSabyCompany(page, row, settings = sabyBrowserSettings()) {
  return recoverSabyMissingSections(
    ()=>collectSabyCompanyAttempt(page,row,settings), {
      wait:()=>delay(650),
      onRetry:()=>console.warn("[SABY_RETRY] both_detail_sections_missing_reopen_once"),
      onRetryError:()=>console.warn("[SABY_RETRY] reopen_failed_deferred")
    });
}

export async function collectSabyOnce(row,{env=process.env}={}) {
  return withSabyBrowser(({page,settings})=>
    collectSabyCompany(page,row,settings),{env});
}
