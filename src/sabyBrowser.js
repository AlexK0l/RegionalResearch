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
import {selectSabyInnCandidate,verifySabyPublicNameFallback,
  safeSabyAliasDiagnostic,SABY_BRANCH_MARKER_SOURCE} from "./sabyPublicIdentityFallback.js";
import {scanSabyResultDOM,scanSabyLegacyDOM,
  consolidateSabyResultRows} from "./sabySearchRows.js";
import {auditSearchName} from "./sabyIdentityAudit.js";
import {diagnoseSabyPrivateOwnerStructure} from "./sabyPrivateOwnerDiagnostic.js";
import {safeSabyFleetFailure,observeSabyFleetDOM}
  from "./sabyFleetDiagnostic.js";
import {collectSabyTruckWindows,appendSabyTruckWindow}
  from "./sabyFleetWindows.js";
import {openSabyFleetPanelWithHydration} from "./sabyFleetPanelOpening.js";
import {compareSabyVerifiedFleetDetail}
  from "./sabyFleetRouteContinuity.js";
import {observeSabyFleetPagination}
  from "./sabyFleetPaginationDiagnostic.js";
import {observeSabyFleetTail} from "./sabyFleetTailDiagnostic.js";
import {probeSabyFleetTailClick}
  from "./sabyFleetTailInteraction.js";
import {collectSabyFleetTailBatches}
  from "./sabyFleetTailBatches.js";
import {SABY_NON_VEHICLE_LABEL_PATTERN}
  from "./sabyVehicleLabels.js";
import {captureSabyFleetPanelScreenshot}
  from "./sabyFleetPanelSnapshot.js";
import {
  verifySabyPostRouteOwnerIdentity,safeSabyPostRouteDiagnostic
} from "./sabyPostRouteIdentity.js";

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
    delayMs: bound(env.SABY_DELAY_MS, 250, 30000, 1500),
    // First enabled in explicitly selected smoke tests. Production still
    // rejects abbreviated aliases unless this opt-in is set.
    publicIdentityFallback: String(env.SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED||"false").toLowerCase()==="true",
    // A new first-party UI click is permitted ONLY in a one-company
    // Saby smoke with a dedicated EXPLICIT opt-in. Never production.
    fleetTailClickOptIn:
      env.SABY_SMOKE_ONLY==="true" &&
      env.SABY_MAX_COMPANIES==="1" &&
      String(env.SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED||"false").toLowerCase()==="true" &&
      env.SABY_FLEET_TAIL_CLICK_OPT_IN==="true",
    // Never save browser images unless explicitly requested by the
    // dedicated Saby-only smoke option. Not enabled in production.
    fleetScreenshotPath:
      String(env.SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED||"false").toLowerCase()==="true" &&
      String(env.SABY_FLEET_SNAPSHOT_OPT_IN||"false").toLowerCase()==="true"?
        String(env.SABY_FLEET_SCREENSHOT_PATH||""):""
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

export async function findResultRows(page, inn, {
  includeInnOnly=false,includeBranches=false
}={}) {
  // Keep the working production Stage12 search unchanged until opt-in
  // Saby-only smoke validates the new DOM scanner on real site pages.
  if(!includeInnOnly && !includeBranches)
    return page.evaluate(scanSabyLegacyDOM,{
      inn,branchSource:SABY_BRANCH_MARKER_SOURCE
    });
  // In experimental mode, DOM traversal happens inside the browser and
  // duplicate fragments are consolidated with pure offline-tested checks.
  const scanned=await page.evaluate(scanSabyResultDOM,{
    inn,includeInnOnly,includeBranches,
    branchSource:SABY_BRANCH_MARKER_SOURCE
  });
  return consolidateSabyResultRows(scanned,inn);
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
  const publicFallback=settings.publicIdentityFallback===true;
  let rows=[],selection="not_found",lastSelected=null;
  async function candidates() {
    // For optional fallback retain branch rows for Node-side
    // classification, then exclude them BEFORE opening any candidate.
    // Strict production search still excludes branches.
    const all=await findResultRows(page,inn,{
      includeInnOnly:publicFallback,includeBranches:publicFallback
    });
    if(!publicFallback) {
      const strict=all.filter(item=>
        sabySearchResultMatches(name,item.text,inn));
      return {row:strict.length===1?strict[0]:null,
        count:strict.length,reason:strict.length>1?"ambiguous":
          strict.length===1?"strict_name":"not_found"};
    }
    return selectSabyInnCandidate(all,inn,name);
  }
  while(Date.now()<until) {
    const selected=await candidates();
    lastSelected=selected;
    selection=selected.reason;
    if(["ambiguous","ambiguous_exact","result_window_full",
        "primary_window_full"].includes(selected.reason)) {
      if(publicFallback)console.warn("[SABY_SEARCH_AMBIGUITY_DIAG] "+
        JSON.stringify({reason:selected.reason,observed:selected.observed||0,
          primary:selected.count||0,branches:selected.branches||0,
          raw_candidates:selected.rawCandidates||0,
          geometry_duplicates:selected.geometryDuplicates||0,
          fragments_rejected:selected.rejectedFragments||0,
          unique_titles:selected.uniqueTitles||0,
          raw_capped:selected.rawCapped===true,
          foreign_inn_rows:selected.foreignInnRows||0,
          primary_candidates:selected.primaryCandidates||0}));
      throw new SabyReview("Saby: неоднозначный результат по ИНН");
    }
    rows=selected.row?[selected.row]:[];
    if(rows.length===1)break;
    await delay(450);
  }
  if(rows.length!==1)
    throw new SabyReview("Saby: однозначная организация по ИНН не найдена");
  if(publicFallback){
    const final=lastSelected||{};
    console.info("[SABY_SEARCH_FILTER_DIAG] "+JSON.stringify({
      observed:final.observed||0,branches:final.branches||0,
      foreign_inn_rows:final.foreignInnRows||0,
      primary_candidates:final.primaryCandidates||0,
      reason:selection
    }));
    console.info("[SABY_SEARCH_RESULT] "+selection+"_requires_card_verification");
  }
  const r=rows[0].rect;
  const listingUrl=page.url();
  await page.mouse.click(r.x+Math.min(120,r.w*.25),r.y+Math.min(20,r.h*.25));
  const startCard=Date.now();
  const cardUntil=startCard+Math.min(18000,settings.timeoutMs);
  let last={ok:false,reason:"not_detail_page",detail:{route:"list"}};
  let reClicked=false;
  let publicFallbackAttempted=false;
  let publicFallbackFailureReason="";
  let publicFallbackRejection=null;
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

    // Once per candidate, after the detail has hydrated enough to show
    // its own scoped INN. A mismatched title is allowed ONLY if registered
    // name, exact INN and KPP on the public profile are independently tied
    // to this authenticated private card. The fallback never accepts a
    // mere unique-INN search row, and is disabled by default.
    if(publicFallback && !publicFallbackAttempted &&
       Date.now()-startCard>2800 &&
       last.reason==="legal_name_not_verified" &&
       last.detail?.hasScopedInn===true) {
      publicFallbackAttempted=true;
      const checked=await verifySabyPublicNameFallback(
        page,inn,name,last,{
          selectedSearchTitle:auditSearchName(rows[0]?.text,inn)
        });
      publicFallbackFailureReason=String(checked?.reason||"");
      publicFallbackRejection=checked;
      console.info("[SABY_PUBLIC_ALIAS_DIAG] "+
        JSON.stringify(safeSabyAliasDiagnostic(checked)));
      if(checked.ok){
        console.info("[SABY_CARD] registered_alias_verified");
        return checked.identity;
      }
    }

    // Some Saby layouts do not handle clicks near the row's top edge.
    // One bounded second click is permitted only if the SAME unique
    // company still appears in the search results on the original route.
    if(!reClicked && Date.now()-startCard>4500 &&
       page.url()===listingUrl && sabyCardRoute(page.url())==="list") {
      reClicked=true;
      const again=await candidates();
      if(again.row && !["ambiguous","ambiguous_exact"].includes(again.reason)) {
        const box=again.row.rect;
        console.info("[SABY_CARD] retry_result_click");
        await page.mouse.click(
          box.x+Math.min(95,box.w*.20),
          box.y+Math.min(38,box.h*.5)
        );
      }
    }
    await delay(450);
  }
  // A genuinely missing private KPP must NOT trigger more speculative
  // parsing or guessed public URLs. Capture only structural counters to
  // distinguish an unhydrated/wrong owner panel from an unlicensed card.
  if(publicFallback && ["no_scoped_inn_kpp","private_route_changed"].includes(publicFallbackFailureReason)){
    const selectedName=auditSearchName(rows[0]?.text,inn);
    const detailStructure=await diagnoseSabyPrivateOwnerStructure(
      page,inn,selectedName);
    console.warn("[SABY_PRIVATE_OWNER_DIAG] "+
      JSON.stringify(detailStructure));
  }
  // The ORIGINAL alias verifier remains fail-closed on a changed unknown
  // query key. Only after that rejection and the card's bounded wait may
  // an independent opt-in proof bind the CURRENT selected Saby H1 to one
  // strictly scoped, stable private INN/KPP and canonical public identity.
  // Route continuity itself NEVER authorizes data transfer.
  if(publicFallback &&
     publicFallbackFailureReason==="private_route_changed" &&
     publicFallbackRejection) {
    const inspected=await verifySabyPostRouteOwnerIdentity(
      page,inn,name,last,{
        priorFailure:publicFallbackRejection,
        selectedSearchTitle:auditSearchName(rows[0]?.text,inn)
      });
    console.info("[SABY_POST_ROUTE_DIAG] "+
      JSON.stringify(safeSabyPostRouteDiagnostic(inspected)));
    if(inspected.ok) {
      console.info("[SABY_CARD] post_route_registered_identity_verified");
      return inspected.identity;
    }
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
  return page.evaluate(({nonVehiclePattern}) => {
    const excluded=new RegExp(nonVehiclePattern,"iu");
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
        // VIN/plate descriptions are attributes of a truck, never a
        // separate vehicle. A model with an unknown year is valid.
        if(/[a-zа-яё]/iu.test(model)&&model.length<=150 &&
           !excluded.test(model)) {
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
  },{nonVehiclePattern:SABY_NON_VEHICLE_LABEL_PATTERN});
}

async function sidePanelTrucks(page,expected,action="read") {
  return page.evaluate(({expected,action,nonVehiclePattern})=>{
    const clean=s=>String(s||"").replace(/\s+/g," ").trim();
    const excluded=new RegExp(nonVehiclePattern,"iu");
    // Identical model labels in different rows remain different trucks.
    // The same rule is used by tail geometry and the row assembler.
    const vehicleLabel=t=>t.length>=3&&t.length<=150&&
      /[a-zа-яё]/iu.test(t)&&!excluded.test(t)&&
      !/(?:\.\.\.|…)\s*$/.test(t);
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
      const rawNodes=leaf.filter(e=>e!==truck &&
        Boolean(truck.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING) &&
        (!next||Boolean(e.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING)));
      const raw=rawNodes.map(e=>clean(e.textContent)).filter(Boolean);
      const rows=[];
      for(let i=0;i<raw.length;i++){
        const t=raw[i];
        if(cats.test(t))break;
        if(!vehicleLabel(t))continue;
        let model=t,year=null;
        const m=t.match(/^(.+?)[,;]\s*((?:19|20)\d{2})(?:\s*г\.?)?$/);
        if(m){model=clean(m[1]);year=Number(m[2]);}
        else if(i+1<raw.length&&/^(?:19|20)\d{2}(?:\s*г\.?)?$/.test(raw[i+1])){
          year=Number(raw[++i].match(/\d{4}/)[0]);
        }
        if(vehicleLabel(model))rows.push({model,year});
      }
      const scrolls=[panel,...panel.querySelectorAll("*")].filter(e=>{
        const s=getComputedStyle(e);
        return vis(e)&&e.scrollHeight>e.clientHeight+15&&/(auto|scroll)/.test(s.overflowY);
      });
      // For the experimental window reader, prefer the innermost
      // scrollable container covering MOST of the actual vehicle rows.
      // The original selector below often chose an ancestor containing
      // the truck HEADING but not the scrollable rows themselves.
      // Keep that existing selector unchanged for ordinary Stage12.
      const oldScroller=scrolls.findLast(e=>e.contains(truck))||
        scrolls[scrolls.length-1];
      const windowMode=["window","reset","advance"].includes(action);
      const sufficient=Math.max(1,Math.ceil(rawNodes.length*.75));
      const vehicleScrolls=windowMode?scrolls.map(e=>{
        const r=e.getBoundingClientRect();
        return {element:e,contained:rawNodes.filter(n=>e.contains(n)).length,
          area:Math.max(1,r.width*r.height)};
      }).filter(x=>x.contained>=sufficient &&
        x.element.clientHeight>=90).sort((a,b)=>a.area-b.area):[];
      const scroller=vehicleScrolls[0]?.element||oldScroller;
      let scroll={available:false,moved:false,candidates:scrolls.length,
        selected_from_vehicle_rows:vehicleScrolls.length>0};
      if(scroller) {
        const before=scroller.scrollTop;
        const max=Math.max(0,scroller.scrollHeight-scroller.clientHeight);
        if(action==="reset")scroller.scrollTop=0;
        else if(action==="advance") {
          const step=Math.max(45,Math.floor(scroller.clientHeight*.60));
          scroller.scrollTop=Math.min(max,before+step);
        } else if(action==="read" && rows.length<expected) {
          // Preserve the original behavior for normal Stage12.
          scroller.scrollTop+=Math.max(200,scroller.clientHeight*.75);
        }
        scroll={available:true,moved:Math.abs(scroller.scrollTop-before)>1,
          candidates:scrolls.length,
          selected_from_vehicle_rows:vehicleScrolls.length>0,
          target_contains_truck:scroller.contains(truck),
          target_vehicle_leaves:rawNodes.filter(n=>scroller.contains(n)).length,
          target_is_panel:scroller===panel,
          at_end:max-scroller.scrollTop<=2,
          top:before,after:scroller.scrollTop,max,
          height:scroller.clientHeight};
      }
      return {opened:true,rows,scroll};
    }
    return {opened:false,rows:[]};
  },{expected,action,nonVehiclePattern:SABY_NON_VEHICLE_LABEL_PATTERN});
}

async function ownTrucks(page, settings,progress={}) {
  progress.phase="heading";
  const heading=await visibleLocator(page.getByText("Автопарк компании",{exact:true}));
  if(!heading) {
    progress.reason="fleet_heading_missing";
    return {status:"missing"};
  }
  progress.phase="preview";
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
  progress.preview_status=preview.status;
  if(preview.status!=="found"){
    progress.reason=preview.status==="ambiguous"?
      "truck_preview_ambiguous":"truck_preview_missing";
    throw new SabyReview("Грузовой автопарк не определён однозначно");
  }
  progress.expected_trucks=preview.count;
  progress.parsed_vehicle_rows=preview.rows.length;
  if(preview.count===0) return {status:"verified",count:0,vehicles:[]};
  if(preview.count<0 || preview.count>5000) {
    progress.reason="truck_count_invalid";
    throw new SabyReview("Некорректное число грузовых");
  }
  progress.phase="vehicles";
  let rows=preview.rows;
  // Record the independently verified contractor's route, before any
  // fleet UI clicks. Even UI-only route changes must preserve the same
  // opaque company ID and every non-UI query value.
  const fleetOriginalRoute=settings.publicIdentityFallback===true?
    page.url():null;
  const stillSameFleetCompany=()=>{
    if(!fleetOriginalRoute)return true;
    const checked=compareSabyVerifiedFleetDetail(
      fleetOriginalRoute,page.url());
    if(!checked.ok){
      progress.route_guard_reason=checked.reason;
      progress.route_delta=checked.route_delta;
    } else if(checked.ui_navigation_only){
      progress.fleet_ui_route_updated=true;
      progress.route_guard_reason="ui_navigation_only";
    }
    return checked.ok;
  };
  if(rows.length!==preview.count && settings.publicIdentityFallback===true) {
    // Opt-in only: v14 observed a strict 220-truck count but only one
    // 40-row panel window. Keep duplicate models as separate records and
    // stitch ONLY uniquely overlapping windows. If continuity or scrolling
    // is uncertain, the whole fleet remains pending.
    const r=preview.rect;
    const panelUrl=page.url();
    let previewClicks=0;
    let categoryExpanded=false;
    const noteScroll=panel=>{
      const x=panel?.scroll;
      if(x?.available!==true)return;
      progress.scroll_candidates=x.candidates;
      progress.scroll_selected_from_vehicle_rows=
        x.selected_from_vehicle_rows===true;
      progress.scroll_target_contains_truck=x.target_contains_truck===true;
      progress.scroll_target_vehicle_leaves=x.target_vehicle_leaves;
      progress.scroll_target_is_panel=x.target_is_panel===true;
      progress.scroll_at_end=x.at_end===true;
      progress.scroll_top=x.after;
      progress.scroll_max=x.max;
    };
    const routeChanged=()=>({opened:false,routeChanged:true,rows:[]});
    const readWindow=async()=>{
      if(!stillSameFleetCompany())return routeChanged();
      let panel=await sidePanelTrucks(page,preview.count,"window");
      if(!stillSameFleetCompany())return routeChanged();
      if(panel.opened)progress.side_panel_observed=true;
      noteScroll(panel);
      if(panel.opened && panel.rows.length===0 && !categoryExpanded) {
        const attempt=await sidePanelTrucks(page,preview.count,"expand");
        if(!stillSameFleetCompany())return routeChanged();
        categoryExpanded=true;
        progress.expanded=attempt.expanded===true;
        await delay(350);
        if(!stillSameFleetCompany())return routeChanged();
        panel=await sidePanelTrucks(page,preview.count,"window");
        if(!stillSameFleetCompany())return routeChanged();
      }
      return panel;
    };
    // The v15 regression came from testing the DOM immediately after
    // one click. In v14 this panel required a bounded hydration wait and
    // sometimes a second click. Poll for genuine first-party panel
    // evidence; retry the preview click ONLY when no panel is visible,
    // otherwise a second click might close the correctly opened panel.
    const opening=await openSabyFleetPanelWithHydration({
      clickPreview:async()=>{
        if(!stillSameFleetCompany())return false;
        // Reusing old mouse coordinates after a UI route change could click
        // a different element. Accept the first same-card SPA update, but
        // never attempt another blind toggle on an updated layout.
        if(previewClicks>0&&page.url()!==panelUrl){
          progress.route_guard_reason="second_click_after_ui_change_blocked";
          return false;
        }
        previewClicks++;
        await page.mouse.click(r.x+r.w*.5,r.y+r.h*.45);
        return stillSameFleetCompany();
      },
      readPanel:readWindow,
      observePanel:()=>observeSabyFleetDOM(page),
      wait:delay,maxClicks:2,pollsPerClick:20,pollMs:400
    });
    progress.panel_open_attempts=opening.clicks;
    progress.panel_wait_polls=opening.polls;
    progress.panel_title_seen=opening.titleSeen;
    if(opening.opened) {
      // A new side panel can preserve an old scroll position from the
      // browser profile. Always begin at top, or refuse to infer a
      // complete ordered sequence from an unknown middle window.
      const reset=await sidePanelTrucks(page,preview.count,"reset");
      noteScroll(reset);
      if(reset.opened && reset.scroll?.available &&
         stillSameFleetCompany()) {
        await delay(400);
        const stitched=await collectSabyTruckWindows({
          expected:preview.count,readWindow,
          advanceScroll:async()=>{
            if(!stillSameFleetCompany())
              return {opened:false,scroll:{moved:false}};
            const panel=await sidePanelTrucks(page,preview.count,"advance");
            noteScroll(panel);
            return stillSameFleetCompany()?
              panel:{opened:false,routeChanged:true,scroll:{moved:false}};
          },
          wait:delay,maxWindows:Math.min(80,Math.ceil(preview.count/5)+10),
          maxStaleScrolls:6,maxScrollMoves:96,
          maxMs:Math.min(70000,settings.timeoutMs*2)
        });
        progress.window_count=stitched.windows;
        progress.scroll_moves=stitched.scrollMoves;
        progress.stale_scroll_moves=stitched.totalStaleScrollMoves;
        progress.consecutive_stale_scroll_moves=stitched.staleScrollMoves;
        progress.stitch_reason=stitched.reason;
        if(stitched.rows.length>rows.length)rows=stitched.rows;
        progress.parsed_vehicle_rows=rows.length;
        if(stitched.status!=="complete"){
          progress.reason="vehicle_rows_incomplete";
          // v18 reached the end of the ONLY vehicle-row scroller after
          // 40 of 220 advertised trucks. Stop blind scroll retries.
          // This is a scoped READ-ONLY observation of potential paging
          // or load-more controls; do not infer that any control works.
          if(progress.scroll_at_end===true &&
             ["scroll_not_advanced","window_not_updated"].includes(
               stitched.reason) && stillSameFleetCompany()) {
            const pagination=await observeSabyFleetPagination(
              page,{expected:preview.count});
            if(stillSameFleetCompany()){
              progress.fleet_pagination=pagination;
              // v20 displayed three blue dots between the last truck
              // row and the next vehicle category, although the standard
              // pagination probe saw no recognized control. Inspect the
              // dot widget ONLY READ-ONLY, then compare row counts after
              // a single bounded passive wait (no clicks, no scrolling).
              if(pagination.status==="observed" &&
                 pagination.next_page_controls===0 &&
                 pagination.show_more_controls===0 &&
                 pagination.load_more_controls===0 &&
                 pagination.numbered_page_controls===0){
                const tail=await observeSabyFleetTail(page,{
                  expected:preview.count,waitMs:11000,wait:delay
                });
                if(stillSameFleetCompany()){
                  progress.fleet_tail=tail;
                  if(settings.fleetTailClickOptIn){
                    // Exactly ONE click of the geometrically validated
                    // nonanimated pointer-cursor three-dot capsule in the
                    // gap after 40 rows; no generic pagination clicks.
                    const clicked=await probeSabyFleetTailClick(page,{
                      originalUrl:fleetOriginalRoute,
                      expected:preview.count,
                      baselineRows:stitched.rows,
                      tail,readPanel:readWindow,wait:delay
                    });
                    if(stillSameFleetCompany())
                      progress.fleet_tail_click=clicked;
                    if(clicked.status==="rows_extended" &&
                       stillSameFleetCompany()){
                      const now=await readWindow();
                      if(now.opened&&stillSameFleetCompany()){
                        const merge=appendSabyTruckWindow(
                          stitched.rows,now.rows,preview.count);
                        if(merge.status==="advanced"){
                          // Partial newly visible rows remain unverified;
                          // only exactly all expected rows may complete.
                          rows=merge.rows;
                          progress.parsed_vehicle_rows=rows.length;
                          if(rows.length===preview.count){
                            progress.stitch_reason="exact_count";
                          } else {
                            // v22 real VPS: one validated click grew the
                            // list from 40 to 102 and pushed the scroller
                            // back before the new end (523 / 1893).
                            // Repeated clicks require fresh full-prefix,
                            // company ID, tail geometry and passive stability
                            // proofs for EACH next batch. Hard cap: 3 MORE.
                            const extra=await collectSabyFleetTailBatches({
                              expected:preview.count,initialRows:rows,
                              sameCompany:stillSameFleetCompany,
                              readWindow,
                              advanceScroll:async()=>{
                                if(!stillSameFleetCompany())
                                  return {routeChanged:true,opened:false};
                                const panel=await sidePanelTrucks(
                                  page,preview.count,"advance");
                                noteScroll(panel);
                                return stillSameFleetCompany()?panel:
                                  {routeChanged:true,opened:false};
                              },
                              observeTail:async()=>{
                                if(!stillSameFleetCompany())return null;
                                const fresh=await observeSabyFleetTail(page,{
                                  expected:preview.count,
                                  waitMs:11000,wait:delay
                                });
                                return stillSameFleetCompany()?fresh:null;
                              },
                              clickTail:async(baselineRows,freshTail)=>{
                                if(!stillSameFleetCompany())
                                  return {status:"company_changed"};
                                const response=await probeSabyFleetTailClick(
                                  page,{
                                    originalUrl:fleetOriginalRoute,
                                    expected:preview.count,
                                    baselineRows,freshTail,
                                    tail:freshTail,readPanel:readWindow,
                                    wait:delay
                                  });
                                if(stillSameFleetCompany())
                                  progress.fleet_tail_click=response;
                                return response;
                              },
                              wait:delay,maxExtraClicks:3,maxScrollMoves:48,
                              maxMovesPerRound:20,maxMs:85000
                            });
                            // Safe counters only. Raw vehicle models never
                            // enter the diagnostic progress/log object.
                            const {rows:nextRows,...batchDiag}=extra;
                            progress.fleet_tail_batches=batchDiag;
                            rows=nextRows;
                            progress.parsed_vehicle_rows=rows.length;
                            if(extra.status==="complete")
                              progress.stitch_reason="exact_count";
                          }
                        } else {
                          progress.tail_merge_reason=merge.reason||
                            "no_verified_extension";
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } else {
        progress.stitch_reason="scroll_not_available";
      }
    } else {
      progress.stitch_reason=opening.reason;
    }
  } else if(rows.length!==preview.count) {
    // Unchanged Stage12 behavior for nonexperimental runs.
    const r=preview.rect;
    let categoryExpanded=false;
    for(let attempt=0;attempt<2;attempt++){
      await page.mouse.click(r.x+r.w*.5,r.y+r.h*.45);
      const until=Date.now()+Math.min(12000,settings.timeoutMs);
      while(Date.now()<until) {
        const panel=await sidePanelTrucks(page,preview.count);
        if(panel.opened) progress.side_panel_observed=true;
        if(panel.opened&&panel.rows.length>rows.length)rows=panel.rows;
        progress.parsed_vehicle_rows=rows.length;
        if(rows.length===preview.count)break;
        if(panel.opened && panel.rows.length===0 && !categoryExpanded) {
          const opened=await sidePanelTrucks(page,preview.count,"expand");
          categoryExpanded=Boolean(opened.expanded);
          if(categoryExpanded)progress.expanded=true;
        }
        await delay(400);
      }
      if(rows.length===preview.count)break;
    }
  }
  // Never commit an otherwise full fleet if the selected first-party
  // contractor changed while the side panel was open.
  if(!stillSameFleetCompany()){
    progress.stitch_reason="detail_changed";
    progress.reason="vehicle_rows_incomplete";
    throw new SabyReview("Карточка Saby изменилась во время сбора автопарка");
  }
  if(rows.length!==preview.count ||
     rows.some(x=>!x.model||/(?:\.\.\.|…)\s*$/.test(x.model))) {
    progress.reason="vehicle_rows_incomplete";
    progress.parsed_vehicle_rows=rows.length;
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
  const fleetProgress={phase:"overlay"};
  try {
    await closeContactOverlay(page);
    fleetProgress.phase="heading";
    result.trucks=await ownTrucks(page,settings,fleetProgress);
  } catch(error) {
    // Raw Playwright errors may contain URLs or private DOM; diagnostics
    // always use the fixed allowlisted code and never print the exception.
    fleetProgress.reason ||=fleetProgress.phase==="overlay"?
      "contact_overlay_not_closed":"fleet_interaction_failed";
    result.errors.push("trucks: "+fleetProgress.reason);
    result.trucks={status:"review"};
  }
  // Only an explicitly opted-in, authenticated one-company smoke may
  // take a cropped image after an incomplete, fully scrolled fleet.
  // The image never enters evidence, output JSON, logs, or GitHub.
  if(settings.publicIdentityFallback===true &&
     settings.fleetScreenshotPath &&
     result.contacts.status==="collected" &&
     result.trucks.status==="review" &&
     fleetProgress.side_panel_observed===true &&
     fleetProgress.scroll_at_end===true &&
     Number.isSafeInteger(fleetProgress.expected_trucks)) {
    const snapshot=await captureSabyFleetPanelScreenshot(page,{
      originalUrl:result.source_url,
      expected:fleetProgress.expected_trucks,
      targetPath:settings.fleetScreenshotPath
    });
    console.warn("[SABY_FLEET_SNAPSHOT] "+JSON.stringify(snapshot));
  }
  // Emit extra DOM structure only for explicitly opted-in Saby smokes.
  // Ordinary Stage12 remains quiet and unchanged.
  if(settings.publicIdentityFallback===true &&
     result.trucks.status!=="verified") {
    const evidence=await observeSabyFleetDOM(page);
    console.warn("[SABY_FLEET_DIAG] "+JSON.stringify(
      safeSabyFleetFailure(fleetProgress,evidence)));
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
