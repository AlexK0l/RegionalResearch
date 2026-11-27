// Saby browser adapter. Ported from the supplied saby_agent.py, but with a
// single persistent Playwright session, bounded DOM polling, independent
// contacts/truck recovery, and no Google Sheets or paid OpenAI dependencies.
import path from "node:path";
import { chromium } from "playwright";
import { extractSabyPhoneDetails } from "./phoneExport.js";
import { readSabyFinancials } from "./sabyFinancials.js";
import {storedSabyNavigationHint,safeSabyNavigationUrl} from "./sabyVisitPolicy.js";
import {submitSabyCompanySearch,waitForSabySearchHydration}
  from "./sabySearch.js";
import {observeSabySearchTransport,shouldRecoverSilentSabySearch,
  trackSabySessionSockets,hasSabySessionSocketTracker}
  from "./sabySearchTransport.js";
import {SABY_CATALOG_URL,openSabyCatalog,rememberSabyCatalogOrigin,
  forgetSabyCatalogOrigin} from "./sabyCatalogNavigation.js";
import {readSabySearchState,classifySabySearchZeroState,
  isUnconfirmedSabyZeroResult} from "./sabySearchState.js";
import {verifySabyCard,sabyCardRoute,safeCardDiagnostic,
  classifySabyCardReviewCode} from "./sabyCard.js";
import { authenticateSaby, sabyCredentials } from "./sabyAuth.js";
import { recoverSabyMissingSections } from "./sabyRecovery.js";
import { sabyInn, sabyNameMatches, sabySearchResultMatches,
  isSabyProfileUrl,verifiedTrucks,sabyFinancialGaps } from "./sabyEnrichment.js";
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
import {collectSabyFleetTree,readSabyFleetTree,recoverSabyFleetFromOpenDrawer}
  from "./sabyFleetTree.js";
import {openSabyVerifiedFleetTreePanel}
  from "./sabyFleetTreeOpening.js";
import {SABY_NON_VEHICLE_LABEL_PATTERN}
  from "./sabyVehicleLabels.js";
import {captureSabyFleetPanelScreenshot}
  from "./sabyFleetPanelSnapshot.js";
import {
  verifySabyPostRouteOwnerIdentity,safeSabyPostRouteDiagnostic,
  tryEarlySabyPostRouteProof
} from "./sabyPostRouteIdentity.js";
import {recoverSabyFleetHeading} from "./sabyFleetReadiness.js";
import {createSabyCardReadiness} from "./sabyCardReadiness.js";
import {collectSabyVehicleInventory} from "./sabyVehicleSummary.js";

// Typed review classification prevents a missing or ambiguous individual
// contractor from tripping the circuit breaker for a site-wide failure.
// Default is 'systemic' until the precise call site proves company-specific.
export class SabyReview extends Error {
  constructor(message,{scope="systemic",code="review"}={}) {
    super(message);
    this.name="SabyReview";
    this.scope=scope==="company"?"company":"systemic";
    // Machine-readable, privacy-safe reason for bounded Stage12 recovery.
    this.code=new Set(["review","search_scan_error","search_no_unique_result",
      "search_ambiguous","card_render_timeout","card_changed",
      "search_input_failed","search_confirmed_empty",
      "search_service_unavailable","search_loading_stalled",
      "search_zero_unconfirmed","card_legal_name_unverified"]).has(code)?code:"review";
  }
}

const BASE = SABY_CATALOG_URL;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bound = (v, min, max, fallback) => Number.isFinite(Number(v)) ?
  Math.max(min, Math.min(max, Math.floor(Number(v)))) : fallback;

// Live v27 proved the structured Wasaby tree on one company. Ordinary Stage12
// may process a bounded batch or all eligible companies only when its separate
// production opt-in, headed browser and strict registered identity are set.
// The smoke-only click remains isolated, and defaults never enable Stage12.
export function sabyFleetTreeProductionEnabled(env = process.env) {
  const enabled=value=>String(value||"false").toLowerCase()==="true";
  // 0 means all eligible companies within the Stage12 deadline; all nonzero
  // limits are explicit safe integers, matching sabyStage12Settings().
  // Reject missing, malformed and out-of-range limits instead of silently
  // switching mass runs to the old, incomplete truck collector.
  const rawLimit=String(env.SABY_MAX_COMPANIES??"");
  const allowedLimit=/^(?:0|[1-9][0-9]*)$/.test(rawLimit) &&
    Number(rawLimit)<=20000;
  return env.SABY_SMOKE_ONLY!=="true" &&
    enabled(env.SABY_STAGE12_ENABLED) &&
    enabled(env.SABY_FLEET_TREE_PRODUCTION_ENABLED) &&
    enabled(env.SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED) &&
    !enabled(env.SABY_HEADLESS) &&
    allowedLimit;
}

export function shouldUseSabyFleetTree(settings) {
  return settings?.publicIdentityFallback===true &&
    (settings.fleetTailClickOptIn===true ||
      settings.fleetTreeProductionOptIn===true);
}

export function sabyBrowserSettings(env = process.env) {
  const {login, password} = sabyCredentials(env);
  return {
    login, password,
    profileDir: path.resolve(String(env.SABY_PROFILE_DIR || "data/saby-profile")),
    headless: String(env.SABY_HEADLESS || "false").toLowerCase() === "true",
    channel: String(env.SABY_BROWSER_CHANNEL || "").trim(),
    timeoutMs: bound(env.SABY_COMPANY_TIMEOUT_MS, 15000, 90000, 45000),
    delayMs: bound(env.SABY_DELAY_MS, 250, 30000, 1500),
    // Experimental: never assume a history return retains a usable list.
    // Off until measured on the real site with matching identity coverage.
    reuseCatalogHistory:String(env.SABY_REUSE_CATALOG_HISTORY_ENABLED||"false").toLowerCase()==="true",
    // Only the full-card strategy shares passive widget hydration time.
    // Explicit false restores independent legacy section waits.
    sharedCardReadiness:String(env.SABY_SHARED_CARD_READINESS_ENABLED??"true").toLowerCase()!=="false",
    // First enabled in explicitly selected smoke tests. Production still
    // rejects abbreviated aliases unless this opt-in is set.
    publicIdentityFallback: String(env.SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED||"false").toLowerCase()==="true",
    // The original smoke remains explicitly selected and cannot inherit
    // production rollouts. Both modes keep exact company/INN/KPP guards.
    fleetTailClickOptIn:
      env.SABY_SMOKE_ONLY==="true" &&
      env.SABY_MAX_COMPANIES==="1" &&
      String(env.SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED||"false").toLowerCase()==="true" &&
      env.SABY_FLEET_TAIL_CLICK_OPT_IN==="true",
    // Separately enabled production path: off by default, sequential across
    // eligible companies, headed Chromium, verified public/private identity.
    fleetTreeProductionOptIn:sabyFleetTreeProductionEnabled(env),
    // Never save browser images unless explicitly requested by the
    // dedicated Saby-only smoke option. Not enabled in production.
    fleetScreenshotPath:
      env.SABY_SMOKE_ONLY==="true" &&
      env.SABY_MAX_COMPANIES==="1" &&
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
  let context,stopSocketTracker;
  try {
    const settings = sabyBrowserSettings(env);
    if(process.env.REGIONALRESEARCH_SHUTDOWN_REQUESTED==="true")throw Error("SERVICE_SHUTDOWN_BROWSER_BLOCKED");
    context = await chromium.launchPersistentContext(settings.profileDir, {
      ...(process.env.REGIONALRESEARCH_MANAGED_SHUTDOWN==="true"?{handleSIGTERM:false,handleSIGINT:false}:{}),
      ...(settings.channel ? {channel:settings.channel} : {}),
      headless:settings.headless, viewport:{width:1440,height:920},
      acceptDownloads:false,
      timeout:30000
    });
    const page = context.pages()[0] || await context.newPage();
    if(settings.reuseCatalogHistory)stopSocketTracker=trackSabySessionSockets(page);
    page.setDefaultTimeout(6000);
    if (autoLogin && settings.login && settings.password) {
      await authenticateSaby(page, settings);
    }
    return await task({page, context, settings});
  } finally {
    try{stopSocketTracker?.();}catch{/* Diagnostics must not hold the browser lease. */}
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

// This is a readiness signal only, not a selector for data extraction.
// Playwright's own visible filter avoids count + nth + visibility RPCs for
// every hidden duplicate. Collection still performs all its original checks.
async function readFullCardWidgetVisible(page,kind){
  const locator=kind==="contacts"?page.getByText("Контакты",{exact:true}):
    kind==="fleet"?page.getByText("Автопарк компании",{exact:true}):
    page.locator('[data-qa="ContractorCard_Employees"],[data-qa="analytics-finanalysis"],[data-qa="contractorCard-CardRatingBanner__Revenue"]');
  if(typeof locator.filter==="function"){
    try{return await locator.filter({visible:true}).first().isVisible();}
    catch{/* Fall back to the existing bounded visibility lookup. */}
  }
  return Boolean(await visibleLocator(locator));
}
async function waitForDetailSections(page, timeoutMs=7000, requested=null) {
  const until=Date.now()+Math.max(0,Math.min(timeoutMs,10000));
  // The quick detail reads are opportunistic. They must not make the
  // contact pass wait for finance or open a slow fleet overlay.
  const read=async()=>{
    if(!requested)return detailSections(page);
    if(requested.contacts)
      return {contacts:Boolean(await visibleLocator(page.getByText("Контакты",{exact:true})))};
    if(requested.trucks)
      return {trucks:Boolean(await visibleLocator(page.getByText("Автопарк компании",{exact:true})))};
    // Finance-only task: do not wait for an unrelated contact/fleet widget.
    return {financials:Boolean(await visibleLocator(page.locator(
      '[data-qa="ContractorCard_Employees"],[data-qa="analytics-finanalysis"],[data-qa="contractorCard-CardRatingBanner__Revenue"]'
    )))};
  };
  let found=await read();
  while(!Object.values(found).some(Boolean)&&Date.now()<until) {
    await delay(450);
    found=await read();
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

async function openCompany(page, row, settings, timing=null) {
  const searchStarted=performance.now();
  // Component measurements are nested inside search_card_ms. Log only
  // elapsed times/counts; never include page text, routes or credentials.
  const components={catalog_ms:0,hydration_ms:0,baseline_ms:0,submit_ms:0,
    candidate_scan_ms:0,candidate_scans:0,search_poll_wait_ms:0,
    card_scan_ms:0,card_scans:0,alias_ms:0,post_route_ms:0,
    card_poll_wait_ms:0,initial_field_ms:0,field_settle_ms:0,
    field_find_ms:0,field_fill_ms:0,field_press_ms:0,field_retry_wait_ms:0,
    catalog_history_attempted:0,catalog_history_hit:0,catalog_history_fallback:0};
  const addTiming=(key,value)=>{
    if(Object.hasOwn(components,key)&&Number.isFinite(value)&&value>=0)
      components[key]+=value;
  };
  const measure=async(key,fn)=>{
    const started=performance.now();
    try{return await fn();}
    finally{components[key]+=Math.round(performance.now()-started);}
  };
  const inn=sabyInn(row?.["ИНН"]);
  const name=String(row?.["Организация"]||"").trim();
  if (!inn || !name) throw new SabyReview("Компания без пригодного ИНН/названия",{scope:"company"});
  // Install the observer before the navigation that may open a durable
  // WebSocket. Arm it only immediately before submitting this exact INN.
  const publicFallback=settings.publicIdentityFallback===true;
  let transport=publicFallback?observeSabySearchTransport(page,inn,{armed:false}):null;
  try{
  // Wait for navigation commit, NOT every subresource/SPA script. The
  // authenticated list's input is verified and polled below independently.
  // This avoids a 45s DOMContentLoaded timeout during slow Wasaby hydration.
  let catalog=await measure("catalog_ms",()=>openSabyCatalog(page,{
    reuse:publicFallback&&settings.reuseCatalogHistory===true&&hasSabySessionSocketTracker(page),
    timeoutMs:settings.timeoutMs
  }));
  components.catalog_history_attempted=Number(catalog.historyAttempted);
  components.catalog_history_hit=Number(catalog.historyHit);
  if(catalog.historyAttempted&&!catalog.historyHit)components.catalog_history_fallback=1;
  if (!isSabyProfileUrl(page.url()) || sabyCardRoute(page.url())!=="list")
    throw new SabyReview("Saby: список организаций не подтверждён");
  const isListRoute=()=>sabyCardRoute(page.url())==="list";
  const searchOptions={
    timeoutMs:Math.min(15000,settings.timeoutMs),
    actionTimeoutMs:Math.min(8000,settings.timeoutMs),
    isListRoute,onTiming:addTiming,
    onRetry:({stage,attempt})=>console.warn(
      "[SABY_SEARCH_RETRY] "+JSON.stringify({stage,attempt,reason:"action_timeout"})
    )
  };
  // In the successful VPS probe Wasaby had 1200 ms to mount search handlers
  // AFTER navigation commit. Finance previously entered INN immediately
  // when it saw the first generic input. Require bounded hydration first;
  // look up the safe field again after the settle delay.
  const settleSearch=async()=>{
    if(!publicFallback)return;
    const probe=()=>waitForSabySearchHydration(page,{
      isListRoute,timeoutMs:Math.min(8000,settings.timeoutMs),
      deferReacquireToSubmission:true,onTiming:addTiming
    });
    let state=await probe();
    if(!state.ok&&catalog.historyHit){
      // The warm route was not ready. No query was submitted, so it is
      // safe to fall back to the full cold navigation exactly once.
      transport?.stop();
      transport=observeSabySearchTransport(page,inn,{armed:false});
      components.catalog_history_fallback=1;
      catalog={historyAttempted:true,historyHit:false};
      await measure("catalog_ms",()=>page.goto(BASE,{waitUntil:"commit",timeout:settings.timeoutMs}));
      if(!isListRoute()||!isSabyProfileUrl(page.url()))
        throw new SabyReview("Saby: каталог изменился",{code:"search_input_failed"});
      state=await probe();
    }
    if(!state.ok){
      console.warn("[SABY_SEARCH_HYDRATION_DIAG] "+JSON.stringify({
        status:"not_ready",
        reason:new Set(["route_changed","no_safe_visible_input",
          "ambiguous_visible_inputs","multiple_search_fields",
          "not_rendered","search_not_rendered","search_not_stable"])
          .has(state.reason)?state.reason:"other"
      }));
      throw new SabyReview("Saby: поле поиска ещё не готово",
        {code:"search_input_failed"});
    }
    console.info("[SABY_SEARCH_HYDRATION_DIAG] initial_ready");
    return state;
  };
  let readiness=await measure("hydration_ms",settleSearch);
  const submitSearch=()=>submitSabyCompanySearch(page,inn,{
    ...searchOptions,
    ...(readiness?.reacquireTimeoutMs!==undefined?{firstFindTimeoutMs:readiness.reacquireTimeoutMs}:{})
  });
  // Some loading indicators persist even with a successful result list.
  // Sample AFTER hydration and BEFORE entering the exact INN.
  let beforeSearch=publicFallback?
    await measure("baseline_ms",()=>readSabySearchState(page,inn).catch(()=>null)):null;
  transport?.arm();
  const submitted=await measure("submit_ms",submitSearch);
  if(!submitted.ok){
    transport?.stop();
    // Strict, allowlisted statuses only. Never print INN, DOM, URL or
    // the raw Playwright exception, which can include private context.
    console.warn("[SABY_SEARCH_DIAG] "+JSON.stringify({
      code:submitted.reason,stage:submitted.stage||"find",
      attempts:submitted.attempts,
      ...(submitted.diagnostic||{})
    }));
    throw new SabyReview("Saby: безопасный ввод в поиск не завершён",
      {code:"search_input_failed"});
  }
  console.info("[SABY_SEARCH] "+submitted.method);
  let until=Date.now()+Math.min(18000,settings.timeoutMs);
  let submissionAt=Date.now(),transportRecoveryUsed=false;
  let rows=[],selection="not_found",lastSelected=null;
  async function candidates() {
    // For optional fallback retain branch rows for Node-side
    // classification, then exclude them BEFORE opening any candidate.
    // Strict production search still excludes branches.
    components.candidate_scans++;
    const all=await measure("candidate_scan_ms",()=>findResultRows(page,inn,{
      includeInnOnly:publicFallback,includeBranches:publicFallback
    }));
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
    let selected;
    try{
      selected=await candidates();
    }catch{
      // A transient Wasaby DOM rerender can invalidate a result-grid read.
      // Never print the raw Playwright exception, which may include a URL.
      console.warn("[SABY_SEARCH_CANDIDATE_DIAG] "+
        JSON.stringify({code:"scan_error"}));
      transport?.stop();
      throw new SabyReview("Saby: результаты поиска временно недоступны",
        {code:"search_scan_error"});
    }
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
      transport?.stop();
      throw new SabyReview("Saby: неоднозначный результат по ИНН",
        {scope:"company",code:"search_ambiguous"});
    }
    rows=selected.row?[selected.row]:[];
    if(rows.length===1)break;
    if(publicFallback&&shouldRecoverSilentSabySearch({
      route:sabyCardRoute(page.url()),reason:selected.reason,
      observed:Number(selected.observed||0),
      elapsedMs:Date.now()-submissionAt,
      alreadyRecovered:transportRecoveryUsed,
      exactTransportEvidence:transport?.hasExactInnEvidence(),
      serviceBlocked:Boolean(transport&&[401,403,429].some(code=>
        transport.summary()["http_"+code]>0))
    })){
      // No exact-INN request was observed after 6.5s despite safe
      // fill/Enter and zero result cards. This is consistent with a
      // still-hydrating input that had no event handler. A SINGLE reload
      // and re-submit is permitted; never repeat a dispatched query.
      transportRecoveryUsed=true;
      console.warn("[SABY_SEARCH_TRANSPORT_DIAG] "+JSON.stringify({
        state:"exact_inn_transport_not_observed",
        action:"reload_and_submit_once",
        ...(transport?.summary()||{})
      }));
      transport?.stop();
      transport=observeSabySearchTransport(page,inn,{armed:false});
      try{
        await measure("catalog_ms",()=>page.goto(BASE,{waitUntil:"commit",timeout:settings.timeoutMs}));
        if(!isListRoute()||!isSabyProfileUrl(page.url()))
          throw new SabyReview("Saby: каталог изменился при восстановлении поиска",
            {code:"search_input_failed"});
        catalog={historyAttempted:false,historyHit:false};
        readiness=await measure("hydration_ms",settleSearch);
        beforeSearch=await measure("baseline_ms",()=>readSabySearchState(page,inn).catch(()=>null));
        transport.arm();
        const second=await measure("submit_ms",submitSearch);
        if(!second.ok)
          throw new SabyReview("Saby: повторный безопасный ввод не завершён",
            {code:"search_input_failed"});
        console.info("[SABY_SEARCH] "+second.method+"_after_hydration_recovery");
        submissionAt=Date.now();
        until=submissionAt+Math.min(18000,settings.timeoutMs);
        lastSelected=null;
        selection="not_found";
        continue;
      }catch(error){
        transport?.stop();
        if(error instanceof SabyReview)throw error;
        throw new SabyReview("Saby: восстановление поиска не завершилось",
          {code:"search_loading_stalled"});
      }
    }
    await measure("search_poll_wait_ms",()=>delay(450));
  }
  // The two final zero-state reads already allow another 500ms of
  // hydration. Re-scan the original exact-INN candidates after that
  // wait, so a late valid result is not discarded as an uncertain zero.
  let finalZero=null;
  if(publicFallback&&rows.length!==1&&selection==="not_found"&&
     Number(lastSelected?.observed)===0&&isListRoute()){
    let sampleA=null,sampleB=null,classification="probe_error";
    try{
      sampleA=await readSabySearchState(page,inn);
      await delay(500);
      if(isListRoute()){
        sampleB=await readSabySearchState(page,inn);
        const lastRead=await candidates();
        if(isListRoute()){
          lastSelected=lastRead;selection=lastRead.reason;
          rows=lastRead.row&&!["ambiguous","ambiguous_exact","result_window_full",
            "primary_window_full"].includes(lastRead.reason)?[lastRead.row]:[];
          classification=classifySabySearchZeroState(sampleA,sampleB,{
            onListRoute:true,beforeSearch
          });
        }
      }
    }catch{/* Preserve the original fail-closed fallback. */}
    finalZero={sampleA,sampleB,classification};
    if(rows.length===1)
      console.info("[SABY_SEARCH_LATE_RESULT] "+JSON.stringify({status:"candidate_requires_card_verification"}));
  }
  if(rows.length!==1){
    if(publicFallback){
      const observed=transport?.summary()||{};
      console.warn("[SABY_SEARCH_TRANSPORT_DIAG] "+JSON.stringify({
        state:"no_verified_candidate",
        recovered:transportRecoveryUsed,
        ...observed
      }));
    }
    transport?.stop();
    // "observed:0" means our scanner saw no result rows; it cannot
    // independently tell an explicit Saby zero-results message from an
    // unhydrated/blocked list. Check two bounded, visible DOM samples.
    if(publicFallback&&selection==="not_found"&&
       Number(lastSelected?.observed)===0){
      const {classification="probe_error",sampleA=null,sampleB=null}=finalZero||{};
      console.warn("[SABY_SEARCH_ZERO_DIAG] "+JSON.stringify({
        state:classification,
        input_exact:sampleB?.inputExact===true,
        empty_message:sampleB?.explicitEmpty===true,
        busy:sampleB?.spinnerVisible===true,
        busy_before_search:beforeSearch?.spinnerVisible===true,
        baseline_available:beforeSearch!==null,
        service_error:sampleB?.serviceError===true,
        route_list:sabyCardRoute(page.url())==="list"
      }));
      if(classification==="service_unavailable")
        throw new SabyReview("Saby: сервис поиска временно недоступен",
          {code:"search_service_unavailable"});
      if(classification==="loading_stalled")
        throw new SabyReview("Saby: поиск не завершил загрузку результатов",
          {code:"search_loading_stalled"});
      if(classification==="confirmed_empty")
        throw new SabyReview("Saby: явное сообщение об отсутствии результатов",
          {scope:"company",code:"search_confirmed_empty"});
      if(isUnconfirmedSabyZeroResult(sampleA,sampleB,{
        classification,onListRoute:sabyCardRoute(page.url())==="list"
      })){
        // The exact search was dispatched but neither result rows nor an
        // explicit empty banner were observed. Global spinner flags cannot
        // prove a stall here. Never consume identity review budget or
        // re-submit the same ambiguous search immediately.
        throw new SabyReview("Saby: отсутствие результатов не подтверждено",
          {scope:"company",code:"search_zero_unconfirmed"});
      }
    }
    // The previous backfill log showed only [SABY_SEARCH] before a generic
    // review. Distinguish a blank/late result grid from identity rejection.
    // No INN, names, URLs or page text are emitted.
    const observed=lastSelected||{};
    const reason=String(selection||"");
    const code=new Set(["not_found","strict_name","no_primary",
      "filtered","ambiguous","ambiguous_exact","no_valid_title",
      "not_found_after_filter"]).has(reason)?reason:"other";
    console.warn("[SABY_SEARCH_CANDIDATE_DIAG] "+JSON.stringify({
      code:"no_unique_result",reason:code,
      observed:Number(observed.observed||0),
      primary:Number(observed.primaryCandidates||0),
      branches:Number(observed.branches||0)
    }));
    throw new SabyReview("Saby: однозначная организация по ИНН не найдена",
      {scope:"company",code:"search_no_unique_result"});
  }
  transport?.stop();
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
  const acceptIdentity=identity=>{
    if(settings.reuseCatalogHistory===true&&publicFallback)
      rememberSabyCatalogOrigin(page,listingUrl,page.url());
    return identity;
  };
  await page.mouse.click(r.x+Math.min(120,r.w*.25),r.y+Math.min(20,r.h*.25));
  if(timing)timing.search_ms=Math.round(performance.now()-searchStarted);
  const startCard=Date.now();
  const cardUntil=startCard+Math.min(18000,settings.timeoutMs);
  let last={ok:false,reason:"not_detail_page",detail:{route:"list"}};
  let reClicked=false;
  let publicFallbackAttempted=false;
  let publicFallbackFailureReason="";
  let publicFallbackRejection=null;
  while(Date.now()<cardUntil) {
    try {
      components.card_scans++;
      const outcome=await measure("card_scan_ms",()=>verifySabyCard(page,inn,name));
      last=outcome;
      if(outcome.ok) {
        console.info("[SABY_CARD] identity_verified");
        if(settings.reuseCatalogHistory===true&&publicFallback)
          rememberSabyCatalogOrigin(page,listingUrl,page.url());
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
      const checked=await measure("alias_ms",()=>verifySabyPublicNameFallback(
        page,inn,name,last,{
          selectedSearchTitle:auditSearchName(rows[0]?.text,inn)
        }));
      publicFallbackFailureReason=String(checked?.reason||"");
      publicFallbackRejection=checked;
      console.info("[SABY_PUBLIC_ALIAS_DIAG] "+
        JSON.stringify(safeSabyAliasDiagnostic(checked)));
      if(checked.ok){
        console.info("[SABY_CARD] registered_alias_verified");
        return acceptIdentity(checked.identity);
      }
      // The old path waited out the entire card deadline even if the
      // new private route already had its stable independently verified
      // owner. Only the EXISTING strict proof can finish early.
      const early=await measure("post_route_ms",()=>tryEarlySabyPostRouteProof(page,inn,name,{
        priorFailure:checked,selectedSearchTitle:auditSearchName(rows[0]?.text,inn)
      }));
      if(early){
        console.info("[SABY_POST_ROUTE_EARLY_DIAG] "+
          JSON.stringify(safeSabyPostRouteDiagnostic(early)));
        if(early.ok){
          console.info("[SABY_CARD] post_route_registered_identity_verified_early");
          return acceptIdentity(early.identity);
        }
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
    await measure("card_poll_wait_ms",()=>delay(450));
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
    const inspected=await measure("post_route_ms",()=>verifySabyPostRouteOwnerIdentity(
      page,inn,name,last,{
        priorFailure:publicFallbackRejection,
        selectedSearchTitle:auditSearchName(rows[0]?.text,inn)
      }));
    console.info("[SABY_POST_ROUTE_DIAG] "+
      JSON.stringify(safeSabyPostRouteDiagnostic(inspected)));
    if(inspected.ok) {
      console.info("[SABY_CARD] post_route_registered_identity_verified");
      return acceptIdentity(inspected.identity);
    }
  }
  console.warn("[SABY_CARD_DIAG] "+JSON.stringify(safeCardDiagnostic(last,{
    clicked:true,
    navigationObserved:page.url()!==listingUrl
  })));
  const reviewCode=classifySabyCardReviewCode(last,{
    publicIdentityAttempted:publicFallbackAttempted
  });
  throw new SabyReview("Saby: карточка не подтверждена: "+last.reason,
    {scope:"company",code:reviewCode});
  }finally{
    transport?.stop();
    console.info("[SABY_SEARCH_COMPONENT_TIMING] "+JSON.stringify({
      ...components,total_ms:Math.round(performance.now()-searchStarted)
    }));
  }
}

// Same bounded ancestor rule as the legacy locator loop, but one
// synchronous DOM read instead of up to six Playwright round trips.
export function readSabyContactAncestorText(heading){
  let node=heading,text="";
  for(let i=0;i<6;i++){
    node=node?.parentElement;
    if(!node)break;
    const value=String(node.innerText||"");
    if(value.length>1800)break;
    text=value;
    if(/\+7|(?:^|\s)8\s*\(|[\w.+-]+@[\w.-]+\.[a-zа-я]{2,}/i.test(text))break;
  }
  return text;
}
async function ownContacts(page) {
  const heading=await visibleLocator(page.getByText("Контакты",{exact:true}));
  if (!heading) return {phones:[],emails:[],status:"missing"};
  let text="";
  try{text=await heading.evaluate(readSabyContactAncestorText,undefined,{timeout:4000});}
  catch{
    // Wasaby can detach the heading between queries; preserve the
    // existing bounded locator fallback, never read the unscoped body.
    let node=heading;
    for(let i=0;i<6;i++){
      node=node.locator("xpath=..");
      const value=await node.innerText({timeout:4000}).catch(()=>"");
      if(value.length>1800)break;
      text=value;
      if(/\+7|(?:^|\s)8\s*\(|[\w.+-]+@[\w.-]+\.[a-zа-я]{2,}/i.test(text))break;
    }
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

export function scanSabyTruckPreview({nonVehiclePattern,allowCountOnly=false}) {
    const excluded=new RegExp(nonVehiclePattern,"iu");
    const clean=s=>String(s||"").replace(/\s+/g," ").trim();
    const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden";};
    const isTruck=t=>/^Грузовые(?:\s+\d+)?$/i.test(clean(t));
    const leaves=[...document.querySelectorAll("body *")]
      .filter(e=>isTruck(e.textContent)&&
        ![...e.children].some(c=>isTruck(c.textContent))&&vis(e));
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
      const raw=[...tile.querySelectorAll("*")].filter(e=>e.children.length===0&&vis(e))
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
      // A structurally unique positive truck-count tile can still open
      // the verified Wasaby tree even if its text leaves include extra
      // labels. Never treat those leaves as vehicles or assert zero.
      // The quick/legacy paths retain their previous rejection.
      if(rows.length>count&&(!allowCountOnly||count<=0))continue;
      tiles.push({count,rows:rows.length>count?[]:rows,
        rect:{x:r.x,y:r.y,w:r.width,h:r.height}});
    }
    const unique=tiles.filter((x,i)=>!tiles.some((y,j)=>j<i &&
      x.count===y.count && Math.abs(x.rect.x-y.rect.x)<3 && Math.abs(x.rect.y-y.rect.y)<3));
    return unique.length===1?{status:"found",...unique[0]}:
      {status:unique.length?"ambiguous":"missing"};
}

async function truckPreview(page,{allowCountOnly=false}={}) {
  return page.evaluate(scanSabyTruckPreview,{
    nonVehiclePattern:SABY_NON_VEHICLE_LABEL_PATTERN,allowCountOnly
  });
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

async function ownTrucks(page, settings,progress={},afterHeading=null) {
  progress.phase="heading";
  const verifiedRoute=settings.publicIdentityFallback===true?page.url():null;
  const sameCompany=()=>!verifiedRoute||
    compareSabyVerifiedFleetDetail(verifiedRoute,page.url()).ok;
  const assertCompany=()=>{
    if(!sameCompany())throw new SabyReview("Saby: карточка изменилась",
      {scope:"company",code:"card_changed"});
  };
  assertCompany();
  const readHeading=()=>visibleLocator(page.getByText("Автопарк компании",{exact:true}));
  let heading=await readHeading();
  if(!heading&&verifiedRoute){
    const recovery=await recoverSabyFleetHeading(page,{readHeading,sameCompany});
    console.info("[SABY_FLEET_HEADING_RECOVERY] "+JSON.stringify({
      status:recovery.status,scroll_steps:recovery.scrollSteps
    }));
    assertCompany();
    heading=recovery.heading;
  }
  if(!heading) {
    progress.reason="fleet_heading_missing";
    return {status:"missing"};
  }
  // All-category fallback gets a chance after the EXISTING single
  // bounded heading recovery, rather than scrolling the whole card twice.
  if(afterHeading){
    assertCompany();
    const collected=await afterHeading();
    assertCompany();
    if(collected)return collected;
  }
  progress.phase="preview";
  const readPreview=()=>truckPreview(page,{allowCountOnly:shouldUseSabyFleetTree(settings)});
  assertCompany();
  let preview=await readPreview();
  // Only an exact, already-open, same-company Wasaby drawer can
  // bypass the preview requirement. No new speculative heading/tile
  // click or absent-category-to-zero rule.
  const tryOpenDrawer=async()=>{
    if(!verifiedRoute||!shouldUseSabyFleetTree(settings))return null;
    assertCompany();
    const drawer=await recoverSabyFleetFromOpenDrawer(page,{
      originalUrl:verifiedRoute,wait:delay,maxClicks:20,maxMs:175000
    });
    assertCompany();
    if(drawer.reason!=="tree_missing"){
      const {vehicles,...safeTree}=drawer;
      progress.fleet_tree=safeTree;
      console.info("[SABY_FLEET_OPEN_DRAWER] "+JSON.stringify(safeTree));
      if(drawer.status==="complete"){
        const verified=verifiedTrucks({trucks:{
          status:"verified",count:drawer.expected,vehicles
        }});
        if(verified){
          progress.expected_trucks=verified.count;
          progress.parsed_vehicle_rows=verified.vehicles.length;
          progress.side_panel_observed=true;
          progress.stitch_reason="exact_count";
          return {status:"verified",...verified};
        }
      }
      // A positive-count tree was actually read but did not complete.
      // Do not expand it twice, reopen it, or substitute a subsequent
      // geometric preview for a contradictory/partial structural read.
      if(Number.isSafeInteger(drawer.expected)&&drawer.expected>0){
        progress.expected_trucks=drawer.expected;
        progress.parsed_vehicle_rows=drawer.rows??0;
        progress.side_panel_observed=true;
        progress.reason="vehicle_rows_incomplete";
        progress.phase="vehicles";
        throw new SabyReview("Неполный подтвержденный автопарк",
          {scope:"company"});
      }
    }
    return null;
  };
  if(preview.status==="missing") {
    // A newly mounted heading may precede the truck widget. Give it a
    // short passive chance before touching the existing heading control.
    if(verifiedRoute){
      for(let i=0;i<2&&preview.status==="missing";i++){
        await delay(350);assertCompany();preview=await readPreview();
      }
    }
    if(preview.status==="missing"){
      const existing=await tryOpenDrawer();
      if(existing)return existing;
      assertCompany();
      // A drawer that is visible but hydrating must not be toggled
      // shut by another heading click.
      const openTitle=verifiedRoute&&shouldUseSabyFleetTree(settings)?
        await visibleLocator(page.locator(
          '.controls-StackTemplate-content .controls-StackTemplate__caption [title="Автопарк"]'
        )):null;
      assertCompany();
      if(!openTitle&&!progress.category_navigation_attempted)
        await heading.click({timeout:4000}).catch(()=>{});
      const until=Date.now()+9000;
      // Poll within the ORIGINAL preview window. When the real drawer
      // mounts, try its structural count rather than wait exclusively
      // for the summary tile. An incomplete positive-count tree
      // terminates this visit as review; later normal retries remain.
      while(Date.now()<until) {
        assertCompany();
        preview=await readPreview();
        if(preview.status!=="missing") break;
        if(verifiedRoute&&shouldUseSabyFleetTree(settings)){
          const title=await visibleLocator(page.locator(
            '.controls-StackTemplate-content .controls-StackTemplate__caption [title="Автопарк"]'
          ));
          assertCompany();
          if(title){
            const recovered=await tryOpenDrawer();
            if(recovered)return recovered;
          }
        }
        await delay(350);
      }
    }
  }
  assertCompany();
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
  const fleetOriginalRoute=verifiedRoute;
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
    // Experimental Saby-only tree reads need their own opener. The
    // old opener reuses initial mouse coordinates and rejects a safe
    // same-company SPA UI route update before retrying: real v26 on VPS
    // stopped at preview_click_unavailable with fleet_tree=null.
    // Instead probe the actual Wasaby tree and re-read the unique
    // live preview tile before EACH bounded click, even after a
    // known UI-only route change. Keep legacy behavior untouched.
    const opening=shouldUseSabyFleetTree(settings)?
      await openSabyVerifiedFleetTreePanel({
        expected:preview.count,
        readTree:async()=>{
          if(!stillSameFleetCompany())
            return {status:"invalid",reason:"detail_changed"};
          return readSabyFleetTree(page,{expected:preview.count});
        },
        readPreview:async()=>{
          if(!stillSameFleetCompany())return {status:"missing"};
          return readPreview();
        },
        clickPreview:async live=>{
          if(!stillSameFleetCompany())return false;
          const r=live.rect;
          const viewport=page.viewportSize()||{width:1440,height:920};
          // The target was freshly read from the left-side preview;
          // never click behind an overlay, outside the viewport or
          // inside the unrelated right-side details panel.
          if(r.x<0||r.y<0||r.x+r.w>viewport.width*.68||
             r.y+r.h>viewport.height)return false;
          await page.mouse.click(r.x+r.w*.5,r.y+r.h*.45);
          return stillSameFleetCompany();
        },
        panelVisible:async()=>{
          if(!stillSameFleetCompany())return false;
          const title=await visibleLocator(page.locator(
            '.controls-StackTemplate-content '+
            '.controls-StackTemplate__caption [title="Автопарк"]'
          ));
          return Boolean(title);
        },
        sameCompany:stillSameFleetCompany,
        wait:delay,maxClicks:2,pollsPerClick:20,pollMs:400
      })
      :await openSabyFleetPanelWithHydration({
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
      if(shouldUseSabyFleetTree(settings)) {
        // Real user-provided Saby Wasaby DOM defines exact tree rows,
        // stable item keys and category-scoped node-footer controls.
        // Use semantic navigation, not geometrical 3-dot detection,
        // scroll heuristics or arbitrary model-text-leaf counts.
        const structured=await collectSabyFleetTree(page,{
          expected:preview.count,originalUrl:fleetOriginalRoute,
          wait:delay,maxClicks:20,maxMs:175000
        });
        const {vehicles:verifiedVehicles,...safeTree}=structured;
        progress.fleet_tree=safeTree;
        if(structured.status==="complete" &&
           Array.isArray(verifiedVehicles) &&
           verifiedVehicles.length===preview.count &&
           stillSameFleetCompany()){
          rows=verifiedVehicles;
          progress.parsed_vehicle_rows=rows.length;
          progress.stitch_reason="exact_count";
        } else {
          // Never promote old text-leaf estimates to a full fleet.
          rows=[];
          progress.parsed_vehicle_rows=safeTree.rows??0;
          progress.reason="vehicle_rows_incomplete";
          progress.stitch_reason="structured_incomplete";
        }
      } else {
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

// A quick fleet can be accepted only on the exact same verified card,
// and only under the full collector's exact count/model requirements.
// No click, scroll, wait for more rows, or estimate from a partial tile.
export function quickSabyFleetFromPreview(preview,originalUrl,currentUrl){
  if(!compareSabyVerifiedFleetDetail(originalUrl,currentUrl).ok||
    preview?.status!=="found"||!Number.isSafeInteger(preview.count)||preview.count<0||preview.count>5000||
    !Array.isArray(preview.rows)||preview.rows.length!==preview.count||
    preview.rows.some(x=>!x?.model||/(?:\.\.\.|…)\s*$/.test(x.model)))
    return {status:"missing"};
  const verified=verifiedTrucks({trucks:{status:"verified",count:preview.count,vehicles:preview.rows}});
  return verified?{status:"verified",...verified}:{status:"missing"};
}
async function collectSabyCompanyAttempt(page, row, settings, sections=null) {
  const optimized=sections?.optimized===true,quick=optimized&&sections.quickDetails===true;
  const combined=optimized&&!quick&&sections.combinedDetails===true;
  const fullCard=combined&&sections.fullCard===true;
  const sharedReadiness=fullCard&&settings.sharedCardReadiness!==false;
  const allVehicles=sections?.allVehicleCategories===true&&shouldUseSabyFleetTree(settings);
  const detailAttempts={financials:false,trucks:false};
  const timing={},timed=async(key,fn)=>{
    const start=performance.now();
    try{return await fn();}finally{timing[key]=(timing[key]||0)+Math.round(performance.now()-start);}
  };
  let identity;
  try{
    if(sections){
      const hint=savedSabyFinanceCardUrl(row);
      if(hint){
        identity=await timed("saved_card_ms",()=>openSavedSabyFinanceCard(page,row,settings));
        timing.saved_card=identity?"hit":"miss";
      }
    }
    if(!identity){
      timing.full_search=true;
      try{identity=await timed("search_card_ms",()=>openCompany(page,row,settings,timing));}
      finally{
        if(Number.isFinite(timing.search_ms))timing.identity_ms=Math.max(0,timing.search_card_ms-timing.search_ms);
        else timing.search_ms=timing.search_card_ms;
      }
    }
  }catch(error){
    // Expose only numeric allowlisted timing to the stage; a failed
    // search or identity verification must also contribute to diagnostics.
    if(error&&typeof error==="object")error.sabyTiming={...timing};
    throw error;
  }
  const verifiedRoute=page.url();
  const sameCard=()=>page.url()===verifiedRoute&&sabyCardRoute(verifiedRoute)==="detail"||
    compareSabyVerifiedFleetDetail(verifiedRoute,page.url()).ok;
  // One passive hydration window starts at the fresh ownership proof,
  // not again for each section. Contacts retain first priority. Full lazy
  // finance and fleet recovery below is NOT limited by this deadline.
  const readiness=sharedReadiness?createSabyCardReadiness({
    timeoutMs:Math.min(7000,settings.timeoutMs||45000),
    sameCard,readVisible:kind=>readFullCardWidgetVisible(page,kind)
  }):null;
  const ready=async(requested)=>{
    if(readiness){
      if(!sameCard())return;
      const kind=requested.contacts?"contacts":requested.trucks?"fleet":"financials";
      const begin=performance.now();
      let outcome;
      try{outcome=await timed("ready_ms",()=>readiness.waitFor(kind));}
      catch{/* Still enter the full section collector if ownership holds. */}
      timing["ready_"+kind+"_ms"]=(timing["ready_"+kind+"_ms"]||0)+
        Math.round(performance.now()-begin);
      console.info("[SABY_FULL_CARD_READY] "+JSON.stringify({
        section:kind,status:outcome?.status||"unavailable",
        polls:outcome?.polls||0,remaining_ms:Math.round(readiness.remaining())
      }));
      return;
    }
    const wait=()=>timed("ready_ms",()=>waitForDetailSections(page,
      Math.min(7000,settings.timeoutMs||45000),requested));
    if(fullCard){if(sameCard())await wait().catch(()=>{});}
    else await wait();
  };
  const firstReady=fullCard?(sections.contacts?{contacts:true}:
    sections.financials?{financials:true}:{trucks:true}):optimized?sections:null;
  // A fleet-only full visit waits after closing any contact overlay.
  if(!sharedReadiness||sections.contacts||sections.financials)await ready(firstReady);
  const result={identity,source:"SABY",source_url:optimized?verifiedRoute:page.url(),
    // Navigation-only hint captured immediately after identity proof,
    // before any section/widget changes the route. Its strict URL
    // allowlist and fresh ownership verification remain mandatory.
    verified_navigation_url:safeSabyNavigationUrl(verifiedRoute),
    collected_at:new Date().toISOString(),
    contacts:{phones:[],emails:[],status:"missing"},trucks:{status:"missing"},
    financials:{status:"missing"},errors:[],timing};
  const read=async(key,fn)=>{
    try{
      if(optimized&&!sameCard()){result.errors.push(key+": card_changed");return;}
      if(combined&&key==="financials")detailAttempts.financials=true;
      const value=await timed(key==="trucks"||key==="vehicle_fleet"?"fleet_ms":key+"_ms",fn);
      if(optimized&&!sameCard()){result.errors.push(key+": card_changed");return;}
      result[key]=value;
    }catch{result.errors.push(key+": unavailable");}
  };
  const contactRead=()=>read("contacts",()=>ownContacts(page));
  const financeRead=()=>read("financials",()=>readSabyFinancials(page,{
    visibleOnly:quick,
    needsRevenue:!optimized||sabyFinancialGaps(row).revenue
  }));
  // New production contact visits read contacts FIRST, then only visible
  // finance/fleet. The old collector still uses its original full order.
  const finish=()=>{
    if(combined&&sameCard()&&!result.errors.some(x=>/card_changed/.test(x)))
      result.full_detail_attempts={...detailAttempts};
    return result;
  };
  if(optimized&&sections.contacts)await contactRead();
  // The full collectors keep their own active recovery. The earlier
  // combined-retry and legacy strategies retain their independent waits.
  if(fullCard){
    if(sections.contacts&&sections.financials)await ready({financials:true});
  }else if(combined&&(sections.trucks||sections.financials)&&sameCard())
    await ready({contacts:false,trucks:sections.trucks,financials:sections.financials});
  if(!sections||sections.financials)await financeRead();
  if(!optimized&&(!sections||sections.contacts))await contactRead();
  if(sections&&!sections.trucks)return finish();
  if(fullCard&&!sharedReadiness&&(sections.contacts||sections.financials))await ready({trucks:true});
  if(quick){
    if(allVehicles){
      await read("vehicle_fleet",async()=>{
        const found=await collectSabyVehicleInventory(page,{originalUrl:verifiedRoute,quick:true});
        if(sameCard()){
          if(found.trucks)result.trucks=found.trucks;
          if(found.partial)result.vehicle_fleet_partial=found.partial;
        }
        return found.fleet||{status:"missing"};
      });
      if(result.vehicle_fleet?.status==="verified"||result.trucks.status==="verified"||
         result.vehicle_fleet_partial)return result;
    }
    await read("trucks",async()=>{
      const heading=await visibleLocator(page.getByText("Автопарк компании",{exact:true}));
      if(!heading)return {status:"missing"};
      const preview=await truckPreview(page);
      return quickSabyFleetFromPreview(preview,verifiedRoute,page.url());
    });
    return result;
  }
  if(optimized&&!sameCard()){result.errors.push("trucks: card_changed");return result;}
  const fleetProgress={phase:"overlay"};
  try {
    if(sharedReadiness){
      // Avoid waiting on an obstructed fleet widget while a contact
      // overlay is still open. Keep readiness time separate from fleet_ms.
      await timed("fleet_ms",()=>closeContactOverlay(page));
      if(!sameCard())throw new SabyReview("Saby card changed",{scope:"company",code:"card_changed"});
      fleetProgress.phase="heading";
      await ready({trucks:true});
    }
    await timed("fleet_ms",async()=>{
      if(!sharedReadiness)await closeContactOverlay(page);
      fleetProgress.phase="heading";
      // A full fleet read must remain tied to the card verified before
      // finance/contact scrolling, including old in-progress cursors.
      if((optimized||settings.publicIdentityFallback===true)&&!sameCard())
        throw new SabyReview("Saby card changed",{scope:"company",code:"card_changed"});
      if(combined)detailAttempts.trucks=true;
      const collectAll=async(pollAfterHeading=false)=>{
        const all=await collectSabyVehicleInventory(page,{originalUrl:verifiedRoute,wait:delay,pollAfterHeading,
          openNavigation:pollAfterHeading,
          onDiagnostic:diagnostic=>console.info("[SABY_VEHICLE_SUMMARY_DIAG] "+JSON.stringify({
            inn:identity.inn,phase:pollAfterHeading?"after_heading":"initial",...diagnostic
          }))
        });
        if(!sameCard())throw new SabyReview("Saby card changed",{scope:"company",code:"card_changed"});
        if(all.navigationAttempted)fleetProgress.category_navigation_attempted=true;
        if(all.fleet)result.vehicle_fleet=all.fleet;
        if(all.partial)result.vehicle_fleet_partial=all.partial;
        if(all.trucks)result.trucks=all.trucks;
        console.info("[SABY_ALL_VEHICLE_OUTCOME] "+JSON.stringify({
          status:all.status,count:all.fleet?.count??null,groups:all.fleet?.groups.length??0,
          announced_count:all.partial?.announced_count??null,
          partial_groups:all.partial?.groups.length??0,
          partial_vehicles:all.partial?.groups.reduce((n,g)=>n+g.count,0)??0
        }));
        return all;
      };
      // If all categories are accounted for, there is no truck-only
      // fallback to perform. A partial nontruck-only summary is still
      // useful but is not a verified complete fleet or a verified zero.
      const handled=all=>all.fleet||all.drawerOpened||all.trucks||
        all.partial&&!all.partial.categories.some(g=>g.category==="Грузовые");
      let afterHeading=null;
      if(allVehicles){
        const all=await collectAll();
        if(handled(all))return;
        if(all.status==="missing")afterHeading=async()=>{
          const recovered=await collectAll(true);
          return handled(recovered)?(recovered.trucks||{status:"missing"}):null;
        };
      }
      const trucks=afterHeading?
        await ownTrucks(page,settings,fleetProgress,afterHeading):
        await ownTrucks(page,settings,fleetProgress);
      if((optimized||settings.publicIdentityFallback===true)&&!sameCard())
        throw new SabyReview("Saby card changed",{scope:"company",code:"card_changed"});
      result.trucks=trucks;
      if(trucks.status==="missing"&&fleetProgress.reason==="fleet_heading_missing")
        result.errors.push("trucks: fleet_heading_missing");
    });
  } catch(error) {
    // Raw Playwright errors may contain URLs or private DOM; diagnostics
    // always use the fixed allowlisted code and never print the exception.
    if(error instanceof SabyReview&&error.code==="card_changed")
      fleetProgress.reason="card_changed";
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
  // The private DOM diagnostic is intentionally still smoke-only; the
  // production rollout records review/deferred statuses but no raw DOM.
  if(settings.publicIdentityFallback===true &&
     result.trucks.status!=="verified"&&result.vehicle_fleet?.status!=="verified") {
    const evidence=await observeSabyFleetDOM(page);
    console.warn("[SABY_FLEET_DIAG] "+JSON.stringify(
      safeSabyFleetFailure(fleetProgress,evidence)));
  }
  if(result.contacts.status==="missing" && result.trucks.status==="missing"&&result.vehicle_fleet?.status!=="verified") {
    console.warn("[SABY_SECTION_DIAG] "+JSON.stringify(
      await safeSabySectionDiagnostic(page)));
  }
  return finish();
}

// Finance scroll can remount DOM or move non-UI query parameters.
// The exact private card ID must remain the same throughout the read.
export function sameSabyDetailId(before,after){
  try{
    const a=new URL(String(before||""));
    const b=new URL(String(after||""));
    return a.protocol==="https:"&&b.protocol==="https:"&&
      a.hostname==="profile.saby.ru"&&b.hostname==="profile.saby.ru"&&
      a.pathname==="/page/contractor-info"&&
      b.pathname==="/page/contractor-info"&&
      Boolean(a.searchParams.get("id"))&&
      a.searchParams.get("id")===b.searchParams.get("id");
  }catch{return false;}
}

// The source checkpoint may already contain a first-party card URL that was
// verified by the earlier Stage12 run. It is a navigation hint only; never
// accept its ownership without fresh, on-page strict INN/name verification.
export function savedSabyFinanceCardUrl(row){
  const hinted=storedSabyNavigationHint(row);
  if(hinted)return hinted;
  const saved=row?.__evidence?.saby;
  const inn=sabyInn(row?.["ИНН"]);
  if(!inn||sabyInn(saved?.inn)!==inn||
     !String(row?.["Организация"]||"").trim()||
     !String(saved?.verified_at||"").trim())return null;
  try{
    const target=new URL(String(saved.source_url||""));
    const id=String(target.searchParams.get("id")||"");
    if(target.protocol!=="https:"||target.hostname!=="profile.saby.ru"||
       target.username||target.password||target.port||
       target.pathname!=="/page/contractor-info"||target.searchParams.getAll("id").length!==1||
       !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
      return null;
    return target.href;
  }catch{return null;}
}

async function openSavedSabyFinanceCard(page,row,settings){
  const url=savedSabyFinanceCardUrl(row);
  if(!url)return null;
  const inn=sabyInn(row?.["ИНН"]);
  const name=String(row?.["Организация"]||"").trim();
  let reason="not_verified";
  try{
    forgetSabyCatalogOrigin(page);
    await page.goto(url,{waitUntil:"commit",timeout:settings.timeoutMs});
    // Private details and their scoped requisites may mount slowly as
    // Wasaby replaces the card. Wait boundedly, without trusting a URL.
    const limit=Date.now()+Math.min(8500,settings.timeoutMs);
    do{
      if(!sameSabyDetailId(url,page.url())){
        reason="route_changed";
        break;
      }
      try{
        const assessment=await verifySabyCard(page,inn,name);
        if(assessment.ok&&assessment.detail?.hasScopedInn&&sameSabyDetailId(url,page.url())){
          console.info("[SABY_FINANCE_SAVED_CARD] verified");
          return {inn,name:assessment.verifiedName,verified:true};
        }
        // Only allowlisted classification; never emit raw names or page DOM.
        const candidate=String(assessment.reason||"");
        reason=new Set(["no_scoped_inn","no_scoped_inn_kpp",
          "legal_name_not_verified","not_detail_page",
          "detail_loading","inn_not_verified","title_missing"]).has(candidate)?
          candidate:"not_verified";
      }catch{
        reason="verify_unavailable";
      }
      await delay(400);
    }while(Date.now()<limit);
  }catch{
    reason="navigation_unavailable";
  }
  console.info("[SABY_FINANCE_SAVED_CARD] not_verified_fallback_search");
  console.info("[SABY_FINANCE_SAVED_CARD_DIAG] "+JSON.stringify({reason}));
  return null;
}

// Financial-only collector: accept only a freshly verified legal card,
// whether opened from its previously verified same-card URL or exact-INN
// search. It never opens fleet/contacts or calls paid language models.
export async function collectSabyFinancialsOnly(page, row, settings = sabyBrowserSettings()) {
  const identity=await openSavedSabyFinanceCard(page,row,settings)||
    await openCompany(page,row,settings);
  await waitForDetailSections(page,Math.min(7000,settings.timeoutMs||45000));
  const source_url=page.url();
  const financials=await readSabyFinancials(page);
  if(!sameSabyDetailId(source_url,page.url()))
    throw new SabyReview("Saby: карточка изменилась во время финансовой проверки",
      {scope:"company",code:"card_changed"});
  return {
    identity,source:"SABY",source_url,
    collected_at:new Date().toISOString(),
    contacts:{phones:[],emails:[],status:"missing"},
    trucks:{status:"missing"},financials,errors:[]
  };
}

// Section-scoped production collector. Re-verify the saved card or search
// by exact INN/name. A section omitted on purpose is not a missing widget
// warranting a second full visit. The stage owns bounded gap recovery.
export async function collectSabySections(page,row,settings,sections){
  return collectSabyCompanyAttempt(page,row,settings,sections);
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
