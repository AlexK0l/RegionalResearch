// Read-only diagnostic: an authenticated one-INN search in the SAME
// persistent browser profile as financial backfill. Emits only categories,
// counts and booleans: never URLs, response bodies, request payloads,
// company names, cookies, screenshots or credentials. No checkpoint writes.
import {withSabyBrowser,findResultRows} from "../src/sabyBrowser.js";
import {submitSabyCompanySearch} from "../src/sabySearch.js";
import {readSabySearchState} from "../src/sabySearchState.js";
import {sabyCardRoute} from "../src/sabyCard.js";
import {sabyInn} from "../src/sabyEnrichment.js";

const log=value=>console.log("[SABY_NETWORK_PROBE] "+JSON.stringify(value));
export function firstPartySabyUrl(value){
  try{
    const url=new URL(String(value||""));
    return ["https:","wss:"].includes(url.protocol)&&
      ["saby.ru","sbis.ru"].some(root=>
        url.hostname===root||url.hostname.endsWith("."+root));
  }catch{return false;}
}
export function safeSabyTransportClass(url,method,resourceType,body,inn){
  const firstParty=firstPartySabyUrl(url);
  const type=String(resourceType||"").toLowerCase();
  const asyncRequest=type==="xhr"||type==="fetch";
  const kind=String(method||"").toUpperCase()==="POST"?"post":
    String(method||"").toUpperCase()==="GET"?"get":"other";
  // Raw URL/payload are only inspected IN MEMORY for the exact test token.
  // They are never returned, logged, serialized or written to disk.
  const expression=new RegExp("(?<!\\d)"+String(inn||"")+"(?!\\d)");
  const hasInn=firstParty&&asyncRequest&&
    (expression.test(String(url||""))||expression.test(String(body||"")));
  return {firstParty,asyncRequest,kind,hasInn};
}
export function blankSabyNetworkCounts(){
  return {
    requests:0,async_requests:0,async_post:0,async_get:0,
    async_requests_with_inn:0,responses:0,async_responses:0,
    http_2xx:0,http_3xx:0,http_4xx_other:0,
    http_401:0,http_403:0,http_429:0,http_5xx:0,
    failed_requests:0,ws_sent:0,ws_received:0,
    ws_sent_with_inn:0
  };
}
export function updateSabyNetworkCounts(counts,event,detail={}){
  if(event==="request"){
    counts.requests++;
    if(detail.asyncRequest){
      counts.async_requests++;
      if(detail.kind==="post")counts.async_post++;
      if(detail.kind==="get")counts.async_get++;
      if(detail.hasInn)counts.async_requests_with_inn++;
    }
  }else if(event==="response"){
    counts.responses++;
    if(detail.asyncRequest)counts.async_responses++;
    const status=Number(detail.status);
    if(status>=200&&status<300)counts.http_2xx++;
    if(status>=300&&status<400)counts.http_3xx++;
    if(status>=400&&status<500&&
       ![401,403,429].includes(status))counts.http_4xx_other++;
    if(status===401)counts.http_401++;
    if(status===403)counts.http_403++;
    if(status===429)counts.http_429++;
    if(status>=500&&status<600)counts.http_5xx++;
  }else if(event==="failed")counts.failed_requests++;
  else if(event==="ws_sent"){
    counts.ws_sent++;
    if(detail.hasInn)counts.ws_sent_with_inn++;
  }else if(event==="ws_received")counts.ws_received++;
  return counts;
}
export function safeSabyRequestDiagnostic(page,inn){
  const byPhase={
    page_load:blankSabyNetworkCounts(),
    submit:blankSabyNetworkCounts(),
    results:blankSabyNetworkCounts()
  };
  const requests=new Map();
  let phase="page_load",pageErrors=0,externalRequests=0;
  const inScope=url=>firstPartySabyUrl(url);
  const onRequest=request=>{
    try{
      if(!inScope(request.url())){externalRequests++;return;}
      const type=request.resourceType();
      const method=request.method();
      const body=type==="fetch"||type==="xhr"?
        request.postData():"";
      const meta=safeSabyTransportClass(
        request.url(),method,type,body,inn
      );
      requests.set(request,{phase,asyncRequest:meta.asyncRequest});
      updateSabyNetworkCounts(byPhase[phase],"request",meta);
    }catch{
      // Browser-network diagnostics never interfere with search itself.
    }
  };
  page.on("request",onRequest);
  page.on("response",response=>{
    try{
      const meta=requests.get(response.request());
      if(!meta)return;
      updateSabyNetworkCounts(byPhase[meta.phase],"response",{
        asyncRequest:meta.asyncRequest,status:response.status()
      });
    }catch{}
  });
  page.on("requestfailed",request=>{
    const meta=requests.get(request);
    if(meta)updateSabyNetworkCounts(byPhase[meta.phase],"failed");
    requests.delete(request);
  });
  page.on("requestfinished",request=>requests.delete(request));
  page.on("pageerror",()=>{pageErrors++;});
  page.on("websocket",socket=>{
    try{
      if(!inScope(socket.url()))return;
      socket.on("framesent",frame=>{
        const value=frame?.payload;
        const hasInn=typeof value==="string"&&
          new RegExp("(?<!\\d)"+inn+"(?!\\d)").test(value);
        updateSabyNetworkCounts(byPhase[phase],"ws_sent",{hasInn});
      });
      socket.on("framereceived",()=>{
        updateSabyNetworkCounts(byPhase[phase],"ws_received");
      });
    }catch{}
  });
  return {
    setPhase(next){
      if(!Object.hasOwn(byPhase,next))throw Error("Invalid diagnostic phase");
      phase=next;
    },
    summary:()=>({
      ...byPhase,page_errors:pageErrors,
      external_requests:externalRequests,
      in_flight:firstPartyInFlight(requests)
    })
  };
}
function firstPartyInFlight(requests){
  return Math.min(5000,requests.size);
}
export async function sabySearchUiStructure(page,inn){
  return page.evaluate(expected=>{
    const visible=el=>{
      if(!el?.isConnected||!el.getClientRects?.().length)return false;
      try{
        const style=getComputedStyle(el);
        return style.display!=="none"&&style.visibility!=="hidden";
      }catch{return false;}
    };
    const count=selector=>[...document.querySelectorAll(selector)]
      .filter(visible).length;
    const el=document.activeElement;
    return {
      spinner_aria_busy:count('[aria-busy="true"]'),
      spinner_progressbar:count('[role="progressbar"]'),
      spinner_controls:count(".controls-LoadingIndicator"),
      spinner_data_qa:count('[data-qa*="spinner" i]'),
      active_input_exact:Boolean(el&&el.value===expected),
      visible_options:count('[role="option"]'),
      visible_rows:count('[role="row"]'),
      body_dom_nodes:Math.min(document.querySelectorAll("body *").length,500000)
    };
  },inn);
}

async function main(){
  const args=process.argv.slice(2);
  if(args.includes("--help")||args.includes("-h")){
    console.log("Read-only, one-company Saby search-network diagnostic (no OpenAI, SQLite writes, screenshots or raw traffic).");
    console.log("  node scripts/saby-search-network-probe.js --inn=4718000935");
    return;
  }
  const values=args.filter(x=>x.startsWith("--inn="));
  if(values.length!==1||args.length!==1)throw Error("INVALID_PROBE_ARGS");
  const inn=sabyInn(values[0].slice("--inn=".length));
  if(!inn)throw Error("INVALID_PROBE_INN");

  await withSabyBrowser(async ({page,settings})=>{
    const telemetry=safeSabyRequestDiagnostic(page,inn);
    await page.goto("https://profile.saby.ru/page/company-list-prof",{
      waitUntil:"commit",timeout:Math.min(settings.timeoutMs,45000)
    });
    const route=sabyCardRoute(page.url());
    log({step:"open",route});
    if(route!=="list")throw Error("SABY_LIST_NOT_READY");
    await page.waitForTimeout(1200);
    const before=await readSabySearchState(page,inn);
    const initialStructure=await sabySearchUiStructure(page,inn);
    log({step:"before_search",...before,...initialStructure});

    telemetry.setPhase("submit");
    const submitted=await submitSabyCompanySearch(page,inn,{
      isListRoute:()=>sabyCardRoute(page.url())==="list",
      timeoutMs:15000,actionTimeoutMs:8000
    });
    log({step:"submit",ok:submitted.ok,
      method:submitted.method||null,reason:submitted.reason||null});
    if(!submitted.ok){
      log({step:"network",...telemetry.summary()});
      return;
    }

    telemetry.setPhase("results");
    const started=Date.now();
    for(const waitForMs of [3000,10000,20000]){
      const remaining=waitForMs-(Date.now()-started);
      if(remaining>0)await page.waitForTimeout(remaining);
      const routeNow=sabyCardRoute(page.url());
      if(routeNow!=="list"){
        log({step:"poll",route:routeNow});
        break;
      }
      const state=await readSabySearchState(page,inn);
      const structure=await sabySearchUiStructure(page,inn);
      const rows=await findResultRows(page,inn,{
        includeInnOnly:true,includeBranches:true
      });
      log({step:"poll",seconds:Math.round((Date.now()-started)/1000),
        ...state,detected_rows:rows.length,
        raw_candidates:rows.meta?.rawCandidates||0,
        rejected_fragments:rows.meta?.rejectedFragments||0,
        ...structure});
      if(rows.length)break;
    }
    log({step:"network",...telemetry.summary()});
  },{autoLogin:false});
  log({step:"complete",sqlite_writes:0,openai_requests:0});
}

const invoked=process.argv[1]?.endsWith("saby-search-network-probe.js");
if(invoked)main().catch(error=>{
  const code=new Set(["INVALID_PROBE_ARGS","INVALID_PROBE_INN",
    "SABY_LIST_NOT_READY"]).has(error?.message)?
      error.message:"BROWSER_OR_SESSION_UNAVAILABLE";
  log({step:"error",code});
  process.exitCode=1;
});
