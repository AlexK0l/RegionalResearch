// Shared official-GIR-BO transport, used by both the CLI and full pipeline.
// A process-wide gate serializes requests from concurrent regional jobs.
// No automatic retries or bypass of source denial/throttling.
import {spawnSync} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";
import {GIRBO_BASE,girboPdfHash} from "./girBoBackfill.js";
const defaultMetric=(n,x)=>console.log("["+n+"] "+JSON.stringify(x));

export function retryDelay(value,now=Date.now()){
  const raw=String(value||"").trim();
  if(/^\d{1,10}$/.test(raw))return Math.max(15*60000,Number(raw)*1000);
  const date=Date.parse(raw);
  return Number.isFinite(date)?Math.max(15*60000,date-now):15*60000;
}
function waitOrCancel(task,signal,reason){
  if(!signal)return task;
  if(signal.aborted){task.catch(()=>{});return Promise.reject(Error(reason()));}
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(Error(reason()));};
    const cleanup=()=>signal.removeEventListener("abort",abort);
    signal.addEventListener("abort",abort,{once:true});
    task.then(v=>{cleanup();resolve(v);},e=>{cleanup();reject(e);});
  });
}
export function createGirBoRequestGate({spacingMs=1500,now=Date.now,wait=sleep}={}){
  let tail=Promise.resolve(),lastStart=-Infinity,blockedUntil=0,blockedReason="";
  function cooldown(reason,ms){
    const until=now()+Math.max(0,ms);
    if(until>blockedUntil){blockedUntil=until;blockedReason=reason;}
  }
  return {cooldown,status:()=>({blocked_until:blockedUntil,reason:blockedReason}),
    run(fn,{signal=null,reason=()=>"JOB_CANCELLED"}={}){
      const check=()=>{if(signal?.aborted)throw Error(reason());};
      const task=tail.then(async()=>{
        check();
        if(now()<blockedUntil)throw Error("GIRBO_CIRCUIT_OPEN");
        const delay=Math.max(0,spacingMs-(now()-lastStart));
        if(delay){
          try{await wait(delay,undefined,{signal:signal||undefined});}
          catch(e){check();throw e;}
        }
        check();
        if(now()<blockedUntil)throw Error("GIRBO_CIRCUIT_OPEN");
        lastStart=now();
        return fn();
      });
      tail=task.catch(()=>{});
      return waitOrCancel(task,signal,reason);
    }};
}
export const sharedGirBoGate=createGirBoRequestGate();

export function createGirBoLookup({maxRequests=1500,maxDurationMs=0,signal=null,gate=sharedGirBoGate,fetchImpl=globalThis.fetch,metric=defaultMetric}={}){
  if(!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>3000||!Number.isSafeInteger(maxDurationMs)||maxDurationMs<0||maxDurationMs>1800000)throw Error("GIRBO_BAD_ARGS");
  let requests=0;
  const deadline=maxDurationMs?AbortSignal.timeout(maxDurationMs):null;
  const cancelSignals=[signal,deadline].filter(Boolean);
  const cancellation=cancelSignals.length?AbortSignal.any(cancelSignals):null;
  const cancellationReason=()=>signal?.aborted?"JOB_CANCELLED":"GIRBO_DEADLINE";
  const check=()=>{if(cancellation?.aborted)throw Error(cancellationReason());};
  async function request(url,{pdf=false,stage="unknown"}={}){
    const u=new URL(url);
    if(u.origin!==GIRBO_BASE||u.username||u.password||u.hash)
      throw Error("GIRBO_RESPONSE_UNPROVEN");
    check();
    return gate.run(async()=>{
    check();
    if(requests>=maxRequests)throw Error("GIRBO_REQUEST_BUDGET");
    requests++;
    let response;
    try{response=await fetchImpl(u,{redirect:"manual",signal:AbortSignal.any([AbortSignal.timeout(45000),...cancelSignals]),
      headers:{"Accept":pdf?"application/pdf":"application/json","User-Agent":"RegionalResearch/2.1"}});}
    catch(e){
      check();
      gate.cooldown("GIRBO_HTTP_UNAVAILABLE",60000);
      const raw=String(e?.cause?.code||e?.code||e?.name||"");
      metric("GIRBO_HTTP_DIAG",{stage,reason:"GIRBO_HTTP_UNAVAILABLE",
        transport_code:/^[A-Za-z0-9_]{1,60}$/.test(raw)?raw:"unknown"});
      throw Error("GIRBO_HTTP_UNAVAILABLE");
    }
    const reject=async code=>{
      if(code==="GIRBO_RATE_LIMITED")gate.cooldown(code,retryDelay(response.headers.get("retry-after")));
      else if(code==="GIRBO_HTTP_DENIED")gate.cooldown(code,30*60000);
      else if(code==="GIRBO_HTTP_UNAVAILABLE")gate.cooldown(code,60000);
      else if(code==="GIRBO_RESPONSE_UNPROVEN")gate.cooldown(code,5*60000);
      const location=response.headers.get("location");
      let redirect_origin="none";
      if(location){try{redirect_origin=new URL(location,u).origin===GIRBO_BASE?"same_origin":"other_origin";}
        catch{redirect_origin="invalid";}}
      metric("GIRBO_HTTP_DIAG",{stage,http_status:response.status,reason:code,
        redirect_origin,media_type:(response.headers.get("content-type")||"").split(";")[0].slice(0,80)});
      await response.body?.cancel().catch(()=>{});
      throw Error(code);
    };
    if(response.status===429||response.headers.has("retry-after"))return reject("GIRBO_RATE_LIMITED");
    if(response.status===401||response.status===403)return reject("GIRBO_HTTP_DENIED");
    if(!response.ok)return reject("GIRBO_HTTP_UNAVAILABLE");
    if(response.url!==u.href||!response.body||
      !(response.headers.get("content-type")||"").toLowerCase().includes(pdf?"application/pdf":"application/json"))
      return reject("GIRBO_RESPONSE_UNPROVEN");
    const cap=pdf?24*1024*1024:12*1024*1024,reader=response.body.getReader(),chunks=[];
    let total=0;
    try{
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        total+=value.length;
        if(total>cap){await reader.cancel();throw Error(pdf?"GIRBO_PDF_SIZE_LIMIT":"GIRBO_RESPONSE_UNPROVEN");}
        chunks.push(Buffer.from(value));
      }
    }catch(e){
      check();
      const reason=["GIRBO_PDF_SIZE_LIMIT","GIRBO_RESPONSE_UNPROVEN"].includes(e.message)?e.message:"GIRBO_HTTP_UNAVAILABLE";
      if(reason==="GIRBO_HTTP_UNAVAILABLE")gate.cooldown(reason,60000);
      metric("GIRBO_HTTP_DIAG",{stage,http_status:response.status,reason,body_read_interrupted:true});
      throw Error(reason);
    }
    const buffer=Buffer.concat(chunks);
    if(pdf)return buffer;
    try{return JSON.parse(buffer.toString("utf8"));}catch{
      gate.cooldown("GIRBO_RESPONSE_UNPROVEN",5*60000);
      metric("GIRBO_HTTP_DIAG",{stage,http_status:response.status,reason:"GIRBO_RESPONSE_UNPROVEN",json_invalid:true});
      throw Error("GIRBO_RESPONSE_UNPROVEN");
    }
    },{signal:cancellation,reason:cancellationReason});
  }
  return {get requests(){return requests;},
    search:inn=>request(GIRBO_BASE+"/advanced-search/organizations/search?"+new URLSearchParams({query:inn,page:"0",size:"20"}),{stage:"search"}),
    reports:id=>request(GIRBO_BASE+"/nbo/organizations/"+id+"/bfo/",{stage:"reports"}),
    async pdf(candidate){
      const buffer=await request(candidate.report_url,{pdf:true,stage:"pdf"});
      if(buffer.subarray(0,5).toString()!=="%PDF-")return {text:"",sha256:""};
      const out=spawnSync("pdftotext",["-layout","-","-"],{input:buffer,encoding:"utf8",
        maxBuffer:8*1024*1024,timeout:45000,windowsHide:true});
      if(out.error?.code==="ENOENT")throw Error("GIRBO_PDFTOTEXT_MISSING");
      if(out.error||out.status!==0)return {text:"",sha256:""};
      return {text:out.stdout,sha256:girboPdfHash(buffer)};
    }};
}
