#!/usr/bin/env node
// Compare WHAT Saby returns in three Playwright Chromium execution modes:
// the default headless shell, the full Chromium new-headless channel, and
// the full Chromium headed under Xvfb. Does not call OpenAI or touch SQLite.
//
// Privacy: all URLs are reduced to first-party hostname + SHA256 route IDs;
// request/response bodies, page text, credentials, cookies, names and contact
// details are never logged or written. Optional screenshots are PRIVATE and
// may contain personal information; don't upload them without redaction.
import fs from "node:fs/promises";
import path from "node:path";
import {withSabyBrowser, collectSabyCompany} from "../src/sabyBrowser.js";
import {safeSabySectionDiagnostic} from "../src/sabyBrowser.js";
import {safeNetworkEndpoint, safeResponseBody, compareSabyNetwork} from "../src/sabyNetworkProbe.js";

process.umask(0o077);
const args=process.argv.slice(2);
const option=name=>{
  const item=args.find(x=>x.startsWith("--"+name+"="));
  return item ? item.slice(name.length+3) : "";
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const INN=option("inn"), name=option("name"), profile=option("profile");
const help=args.includes("--help")||args.includes("-h");
if(help) {
  console.log("Saby network probe. Requires --inn=10/12digits --name=... --profile=/absolute/path");
  console.log("Optional: --out=/private/report.json --screenshots (PRIVATE images; sensitive)");
  console.log("Uses existing authorized profile, sequentially: headless shell, chromium new-headless, headed.");
  process.exit(0);
}
if(!/^(?:\d{10}|\d{12})$/.test(INN)||!name||!profile)
  throw new Error("Expected --inn, --name and --profile; never pass credentials as arguments");
const profileDir=path.resolve(profile);
if(profileDir==="/opt/regionalresearch/data/saby-profile")
  throw new Error("Production profile is not allowed; use existing independent test profile");
const out=path.resolve(option("out")||path.join("data","saby-network-diag-"+Date.now()+".json"));
const screenshots=args.includes("--screenshots");
const MODES=[
  {id:"headless_shell",headless:true,channel:""},
  {id:"headless_chromium",headless:true,channel:"chromium"},
  {id:"headed_chromium",headless:false,channel:"chromium"}
];

function bump(map,name) {map[name]=(map[name]||0)+1;}
function safeErrorKind(error) {
  const raw=String(error?.message||error||"");
  if(/XServer|DISPLAY|headed browser/.test(raw))return "display_unavailable";
  if(/executable doesn't exist|Executable doesn't exist/.test(raw))return "browser_not_installed";
  if(/Target page, context or browser has been closed/.test(raw))return "browser_closed";
  if(/login|авторизац|вход/i.test(raw))return "auth_or_session";
  if(/Поиск|поле поиска/i.test(raw))return "search_unavailable";
  if(/карточка|ИНН/i.test(raw))return "identity_unavailable";
  return "browser_or_collection";
}
function safeCompany(record) {
  const contacts=record?.contacts||{},trucks=record?.trucks||{};
  return {
    identity_verified:record?.identity?.verified===true,
    contact_status:["collected","missing","review"].includes(contacts.status)?contacts.status:"unknown",
    phones_count:Array.isArray(contacts.phones)?contacts.phones.length:0,
    email_count:Array.isArray(contacts.emails)?contacts.emails.length:0,
    fleet_status:["verified","missing","review"].includes(trucks.status)?trucks.status:"unknown",
    truck_count:Number.isSafeInteger(trucks.count)?trucks.count:null,
    collection_error_sections:(record?.errors||[]).map(e=>
      /^(contacts|trucks):/.exec(String(e))?.[1]||"other").slice(0,4)
  };
}
function observeNetwork(context,page) {
  const endpoints=new Map(),statusCounts={},types={}, pending=[];
  let total=0,thirdPartyResponses=0,failedRequests=0,
    pageErrors=0,consoleErrors=0,probeResponses=0,serviceWorkerResponses=0;
  const webSockets={opened:0,incoming_frames:0,incoming_bytes:0,
    contact_markers:false,fleet_markers:false};

  page.on("pageerror",()=>{pageErrors++;});
  page.on("console",msg=>{if(msg.type()==="error")consoleErrors++;});
  page.on("websocket",ws=>{
    webSockets.opened++;
    ws.on("framereceived",frame=>{
      webSockets.incoming_frames++;
      const payload=typeof frame.payload==="string"?
        frame.payload:Buffer.isBuffer(frame.payload)?
          frame.payload.toString("utf8"):"";
      webSockets.incoming_bytes+=Buffer.byteLength(payload);
      // Inspect only, do not retain WebSocket frame contents.
      if(/контакт|contacts?|phone|телефон/i.test(payload))
        webSockets.contact_markers=true;
      if(/автопарк|грузовые|fleet|truck|vehicles?/i.test(payload))
        webSockets.fleet_markers=true;
    });
  });
  context.on("requestfailed",request=>{
    const key=safeNetworkEndpoint(request.url());
    if(key)failedRequests++;
  });
  context.on("response",response=>{
    total++;
    const request=response.request();
    const type=request.resourceType(),status=response.status();
    bump(statusCounts,String(status));bump(types,type);
    const key=safeNetworkEndpoint(response.url());
    if(!key){thirdPartyResponses++;return;}
    if(response.fromServiceWorker())serviceWorkerResponses++;
    const method=request.method();
    const identity=key.host+":"+key.route+":"+type+":"+method;
    let entry=endpoints.get(identity);
    if(!entry) {
      entry={host:key.host,route:key.route,type,method,count:0,
        status_counts:{},signals:{contact_marker:false,fleet_marker:false,
          phone_key:false,vehicle_key:false,error_key:false,access_marker:false},
        samples:[],body_probe_errors:0};
      endpoints.set(identity,entry);
    }
    entry.count++;
    bump(entry.status_counts,String(status));
    const ct=String(response.headers()["content-type"]||"").toLowerCase();
    if(!["xhr","fetch","document"].includes(type) || probeResponses>=180 ||
       (!/json|text|javascript|xml/.test(ct)) ||
       Number(response.headers()["content-length"]||0)>2000000) return;
    probeResponses++;
    // Capture only in RAM: write allowlisted booleans, response length and
    // content hashes. Browser body and the original URL never reach the file.
    const task=response.body().then(body=>{
      const safe=safeResponseBody(body,ct);
      for(const field of Object.keys(entry.signals))
        entry.signals[field] ||= safe[field]===true;
      if(entry.samples.length<5)entry.samples.push({
        status,bytes:safe.bytes,body_hash:safe.sha256_16,
        content_type:safe.type,json_root:safe.json_root,
        contact_marker:safe.contact_marker,fleet_marker:safe.fleet_marker,
        phone_key:safe.phone_key,vehicle_key:safe.vehicle_key,
        error_key:safe.error_key,access_marker:safe.access_marker
      });
    }).catch(()=>{entry.body_probe_errors++;});
    pending.push(task);
  });
  return {
    async finish() {
      await Promise.race([Promise.allSettled(pending),sleep(4000)]);
      const entries=[...endpoints.values()]
        .filter(x=>["xhr","fetch","document"].includes(x.type))
        .sort((a,b)=>(b.count-a.count)||a.route.localeCompare(b.route));
      return {total_responses:total,third_party_responses:thirdPartyResponses,
        response_status_counts:statusCounts,resource_type_counts:types,
        failed_first_party_requests:failedRequests,
        browser_page_errors:pageErrors,browser_console_errors:consoleErrors,
        web_sockets:webSockets,
        responses_from_service_worker:serviceWorkerResponses,
        probed_api_bodies:probeResponses,
        endpoints:entries.slice(0,250)
      };
    }
  };
}
async function pageState(page) {
  const section=await safeSabySectionDiagnostic(page).catch(()=>({route:"unknown"}));
  const dom=await page.evaluate(()=>{
    const text=String(document.body?.innerText||"");
    const all=String(document.body?.textContent||"");
    return {
      ready_state:document.readyState,
      visible_text_characters:text.length,
      dom_text_characters:all.length,
      frame_count:document.querySelectorAll("iframe").length,
      script_count:document.scripts.length,
      loading_marker:/\bзагрузка\b|загружаем|loading|please wait/i.test(text),
      auth_or_challenge_marker:/код подтверждения|подтвердите вход|captcha|капча/i.test(text),
      access_restriction_marker:/доступ ограничен|доступ запрещен|access denied|оформить подписку/i.test(text),
      contacts_in_any_dom_text:/контакт|телефон/i.test(all),
      fleet_in_any_dom_text:/автопарк|грузовые/i.test(all),
      navigator_headless:/HeadlessChrome/i.test(navigator.userAgent),
      navigator_webdriver:navigator.webdriver===true,
      visibility_state:document.visibilityState,
      viewport:{width:innerWidth,height:innerHeight,
        screen_width:screen.width,screen_height:screen.height,
        device_pixel_ratio:devicePixelRatio}
    };
  }).catch(()=>({dom_evaluate_failed:true}));
  return {...section,...dom};
}
async function runMode(mode) {
  const started=Date.now(),outMode={
    mode:mode.id,headless:mode.headless,
    channel:mode.channel||"default",status:"unknown",
    company:null,states:[],network:null
  };
  const env={...process.env,SABY_PROFILE_DIR:profileDir,
    SABY_HEADLESS:String(mode.headless),SABY_BROWSER_CHANNEL:mode.channel};
  try{
    await withSabyBrowser(async ({page,context,settings})=>{
      // Disable HTTP cache per mode without clearing cookies/localStorage.
      // Saby uses a persistent authenticated profile, but cached responses
      // would otherwise make two browser modes impossible to compare fairly.
      let cacheDisabled=false;
      try {
        const session=await context.newCDPSession(page);
        await session.send("Network.setCacheDisabled",{cacheDisabled:true});
        cacheDisabled=true;
      } catch { /* Diagnostics still proceed if CDP is unavailable. */ }
      outMode.http_cache_disabled=cacheDisabled;
      const recorder=observeNetwork(context,page);
      try{
        const record=await collectSabyCompany(page,{"ИНН":INN,"Организация":name},settings);
        outMode.company=safeCompany(record);
        outMode.status="complete";
      }catch(error){
        outMode.status="collection_error";
        outMode.error_category=safeErrorKind(error);
      }
      outMode.states.push({when:"after_collection",...await pageState(page)});
      await sleep(2400);
      outMode.states.push({when:"after_extra_wait",...await pageState(page)});
      if(screenshots) {
        const target=out.replace(/\.json$/i,"")+"-"+mode.id+".png";
        try {
          await page.screenshot({path:target,fullPage:false,timeout:8000});
          await fs.chmod(target,0o600);
          outMode.private_screenshot_path=target;
        }catch {outMode.screenshot_failed=true;}
      }
      outMode.network=await recorder.finish();
    },{env});
  }catch(error){
    outMode.status="browser_or_auth_error";
    outMode.error_category=safeErrorKind(error);
  }
  outMode.elapsed_ms=Date.now()-started;
  const c=outMode.company||{};
  console.log("[SABY_DIAG] "+mode.id+
    " status="+outMode.status+
    " contacts="+(c.contact_status||"unknown")+
    " phones="+(c.phones_count??0)+
    " fleet="+(c.fleet_status||"unknown")+
    " trucks="+(c.truck_count??"n/a")+
    " api="+(outMode.network?.endpoints?.length||0));
  return outMode;
}
async function main() {
  await fs.mkdir(path.dirname(out),{recursive:true,mode:0o700});
  const results=[];
  console.log("Running 3 isolated browser modes sequentially. No OpenAI/Google/SQLite.");
  for(const mode of MODES)results.push(await runMode(mode));
  const report={
    schema_version:1,
    disclaimer:"No raw response bodies, URLs, credentials, cookies or identifying company details; only aggregate counts, hashes and booleans",
    modes:results,
    comparisons:{
      shell_vs_new:compareSabyNetwork(results[0].network,results[1].network),
      shell_vs_headed:compareSabyNetwork(results[0].network,results[2].network),
      new_vs_headed:compareSabyNetwork(results[1].network,results[2].network)
    }
  };
  await fs.writeFile(out,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
  console.log("[SABY_DIAG] Report: "+out);
  if(screenshots)console.log(
    "[SABY_DIAG] Screenshots are PRIVATE and may contain company data. Redact before sharing.");
}
main().catch(error=>{
  console.error("[SABY_DIAG] setup_error: "+safeErrorKind(error));
  process.exitCode=1;
});
