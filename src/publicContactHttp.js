// A small, read-only, bounded HTTP client for PUBLIC corporate pages.
// Treat model-generated/source URLs as untrusted. No auth, proxy, cookies,
// browser, challenge bypass, private network, or unbounded decompression.
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import {setTimeout as sleep} from "node:timers/promises";
const AGENT="RegionalResearchContact";
const USER_AGENT=AGENT+"/1.0";
const MAX_BYTES=1024*1024;
const fail=code=>Object.assign(Error(code),{code});
const transientCodes=new Set(["CONTACT_HTTP_UNAVAILABLE","CONTACT_REQUEST_TIMEOUT","CONTACT_DNS_UNAVAILABLE","CONTACT_TLS_UNAVAILABLE","CONTACT_CONNECTION_UNAVAILABLE"]);
export function contactPublicUrl(value){
  try{
    if(typeof value!=="string"||value.length>1800)return "";
    const u=new URL(value);
    if(!["https:","http:"].includes(u.protocol)||u.username||u.password||u.port||
      net.isIP(u.hostname)||!u.hostname.includes(".")||u.hostname.endsWith(".")||
      /(?:^|\.)(?:localhost|local|internal|home|lan|onion|test|invalid)$/i.test(u.hostname)||
      !/^[a-z0-9.-]+$/i.test(u.hostname))return "";
    // Never submit source-supplied tokens, search terms or arbitrary query
    // parameters. These may be private, or cause unintended actions.
    const decoded=decodeURIComponent(u.pathname);
    if(u.search||/[\\\x00-\x1f\x7f]/.test(decoded)||/%(?:2f|5c)/i.test(u.pathname)||
       /(?:^|\/)(?:login|logout|auth|admin|account|cart|checkout|api|wp-admin|cgi-bin)(?:\/|$)/i.test(decoded)||
       /\.(?:zip|rar|7z|exe|docx?|xlsx?|pptx?|pdf|jpg|png|svg|mp[34]|webp|xml|json)$/i.test(u.pathname))return "";
    u.hash="";
    return u.href;
  }catch{return "";}
}
export const contactHost=value=>{
  try{return new URL(value).hostname.toLowerCase().replace(/^www\./,"");}
  catch{return "";}
};
export function isPublicContactIPv4(ip){
  if(net.isIP(ip)!==4)return false;
  const [a,b,c]=ip.split(".").map(Number);
  return !(a===0||a===10||a===127||a>=224||
    a===100&&b>=64&&b<=127||a===169&&b===254||
    a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||
    a===192&&b===88&&c===99||a===198&&[18,19].includes(b)||
    a===198&&b===51&&c===100||a===203&&b===0&&c===113);
}
export async function resolvePublicContactAddress(host,{lookup=dns.lookup,signal}={}){
  if(signal?.aborted)throw fail("CONTACT_REQUEST_TIMEOUT");
  let timer,abortListener;
  try{
    const addresses=await Promise.race([
      lookup(host,{all:true,family:4,verbatim:true}),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(fail("CONTACT_DNS_UNAVAILABLE")),3000);
        abortListener=()=>reject(fail("CONTACT_REQUEST_TIMEOUT"));
        signal?.addEventListener("abort",abortListener,{once:true});
      })
    ]);
    if(!addresses?.length||addresses.some(a=>!isPublicContactIPv4(a.address)))
      throw fail("CONTACT_PRIVATE_ADDRESS");
    return addresses[0].address;
  }catch(error){
    throw error?.code?.startsWith("CONTACT_")?error:fail("CONTACT_DNS_UNAVAILABLE");
  }finally{clearTimeout(timer);signal?.removeEventListener("abort",abortListener);}
}
export function robotsAllows(text,path,userAgent=AGENT){
  const groups=[];let current=null;
  for(const raw of String(text||"").split(/\r?\n/)){
    const line=raw.split("#")[0].trim();
    const m=/^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if(!m)continue;
    const key=m[1].toLowerCase(),value=m[2].trim();
    if(key==="user-agent"){
      if(!current||current.hasRules||current.hasDelay){
        current={agents:[],rules:[],hasRules:false,hasDelay:false};groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    }else if(current&&(key==="allow"||key==="disallow")){
      current.hasRules=true;
      if(value)current.rules.push({allow:key==="allow",value});
    }else if(current&&key==="crawl-delay"){
      // Conservatively do not crawl sites asking for a custom delay.
      current.hasDelay=true;
    }
  }
  const agent=userAgent.toLowerCase();
  const specific=groups.filter(g=>g.agents.some(a=>a!=="*"&&a&&agent.startsWith(a)));
  const active=specific.length?specific:groups.filter(g=>g.agents.includes("*"));
  if(active.some(g=>g.hasDelay))return false;
  let best=null;
  for(const rule of active.flatMap(g=>g.rules)){
    const v=rule.value;
    if(!v.startsWith("/")||v.length>1000||/[^\x20-\x7e]/.test(v))return false;
    const last=v.endsWith("$");
    const body=(last?v.slice(0,-1):v).split("*")
      .map(x=>x.replace(/[.*+?^$(){}|[\]\\]/g,"\\$&")).join(".*");
    if(new RegExp("^"+body+(last?"$":"")).test(path)){
      const length=v.replace(/[*$]/g,"").length;
      if(!best||length>best.length||length===best.length&&rule.allow)
        best={length,allow:rule.allow};
    }
  }
  return !best||best.allow;
}
function readResponse(url,ip,{signal,maxBytes=MAX_BYTES,timeoutMs=8000}={}){
  return new Promise((resolve,reject)=>{
    const u=new URL(url),transport=u.protocol==="https:"?https:http;
    let done=false,timer;
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);
      if(error)reject(error);else resolve(value);
    };
    const request=transport.request(u,{
      method:"GET",agent:false,family:4,
      // Pin the exact validated address while preserving TLS SNI and
      // hostname verification. No second DNS lookup / rebinding.
      lookup:(_hostname,opts,callback)=>opts?.all?
        callback(null,[{address:ip,family:4}]):callback(null,ip,4),
      headers:{"User-Agent":USER_AGENT,Accept:"text/html,text/plain,application/xhtml+xml",
        "Accept-Encoding":"identity"},signal
    },response=>{
      const status=response.statusCode||0,headers=response.headers;
      if(status!==200){response.destroy();finish(null,{status,headers,body:Buffer.alloc(0)});return;}
      if(headers["content-encoding"]&&headers["content-encoding"]!=="identity"||
        Number(headers["content-length"]||0)>maxBytes){
        response.destroy();finish(fail("CONTACT_RESPONSE_SIZE"));return;
      }
      const chunks=[];let size=0;
      response.on("data",chunk=>{
        size+=chunk.length;
        if(size>maxBytes){response.destroy();finish(fail("CONTACT_RESPONSE_SIZE"));}
        else chunks.push(chunk);
      });
      response.on("end",()=>finish(null,{status,headers,body:Buffer.concat(chunks,size)}));
      response.on("error",()=>finish(fail("CONTACT_HTTP_UNAVAILABLE")));
      response.on("aborted",()=>finish(fail("CONTACT_HTTP_UNAVAILABLE")));
    });
    timer=setTimeout(()=>{finish(fail("CONTACT_REQUEST_TIMEOUT"));request.destroy();},timeoutMs);
    request.on("error",error=>{
      const code=String(error?.code||"");
      finish(fail(signal?.aborted||code==="ETIMEDOUT"||code==="ABORT_ERR"?
        "CONTACT_REQUEST_TIMEOUT":/^(?:ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER)/.test(code)?
        "CONTACT_TLS_UNAVAILABLE":/^(?:ECONN|EHOST|ENET|EPIPE)/.test(code)?
        "CONTACT_CONNECTION_UNAVAILABLE":"CONTACT_HTTP_UNAVAILABLE"));
    });
    request.end();
  });
}
export function decodeContactHtml(body,contentType=""){
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(body||"");
  const prefix=bytes.subarray(0,4096).toString("ascii");
  const charset=(String(contentType).match(/charset\s*=\s*["']?([a-z0-9_-]+)/i)||
    prefix.match(/charset\s*=\s*["']?([a-z0-9_-]+)/i))?.[1]?.toLowerCase();
  if(charset&&!["utf-8","utf8","windows-1251","cp1251","us-ascii","ascii"].includes(charset))
    throw fail("CONTACT_CHARSET_UNSUPPORTED");
  return new TextDecoder(["windows-1251","cp1251"].includes(charset)?"windows-1251":"utf-8",
    {fatal:!["windows-1251","cp1251"].includes(charset)}).decode(bytes);
}
// Serial across concurrent research jobs. We retain only a bounded origin
// cooldown map and one in-flight network operation, not HTML or row payloads.
let tail=Promise.resolve(),nextRequestAt=0;
const blockedOrigins=new Map();
async function serial(task,signal){
  const run=tail.then(async()=>{
    if(signal?.aborted)throw fail("CONTACT_REQUEST_TIMEOUT");
    const wait=Math.max(0,nextRequestAt-Date.now());
    if(wait)await sleep(wait,undefined,{signal});
    try{return await task();}
    finally{nextRequestAt=Date.now()+750;}
  });
  tail=run.then(()=>undefined,()=>undefined);
  return run;
}
function blockHost(host,ms){
  if(blockedOrigins.size>=2048&&!blockedOrigins.has(host))
    blockedOrigins.delete(blockedOrigins.keys().next().value);
  blockedOrigins.set(host,Date.now()+ms);
}
export function createPublicContactHttp({
  maxRequests=1000,previousRequests=0,deadlineAt=Date.now()+900000,
  signal=null,resolve=resolvePublicContactAddress,request=readResponse,
  schedule=serial
}={}){
  let requests=Math.max(0,Number(previousRequests)||0);
  const robots=new Map(),failures=new Map();
  const stop=()=>signal?.aborted||Date.now()>=deadlineAt||requests>=maxRequests;
  const one=async(url,limit)=>schedule(async()=>{
    if(stop())throw fail("CONTACT_REQUEST_BUDGET");
    const host=contactHost(url);
    if((blockedOrigins.get(host)||0)>Date.now())throw fail("CONTACT_HOST_COOLDOWN");
    const remaining=Math.max(1,Math.min(8000,deadlineAt-Date.now()));
    const timeout=AbortSignal.timeout(remaining);
    const active=signal?AbortSignal.any([signal,timeout]):timeout;
    requests++;
    try{
      const ip=await resolve(new URL(url).hostname,{signal:active});
      if(!isPublicContactIPv4(ip))throw fail("CONTACT_PRIVATE_ADDRESS");
      const r=await request(url,ip,{signal:active,maxBytes:limit,timeoutMs:remaining});
      if([401,403,429,451].includes(r.status)){
        const header=String(r.headers?.["retry-after"]||"");
        const retry=/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-Date.now();
        blockHost(host,Math.max(r.status===429?900000:1800000,
          Number.isFinite(retry)?retry:0));throw fail("CONTACT_ACCESS_DENIED");
      }
      if(r.status>=500)throw fail("CONTACT_HTTP_UNAVAILABLE");
      failures.delete(host);
      return r;
    }catch(error){
      if(transientCodes.has(error?.code)){
        const n=(failures.get(host)||0)+1;failures.set(host,n);
        if(n>=2)blockHost(host,300000);
      }
      throw error;
    }
  },signal);
  async function checkRobots(url){
    const u=new URL(url);
    if(!robots.has(u.origin)){
      // Cache only policy text, bounded per origin. No robots redirects:
      // a missing or unproven policy is not permission to crawl.
      let r=await one(u.origin+"/robots.txt",64*1024);
      if([301,302,303,307,308].includes(r.status)){
        let target="";
        try{target=contactPublicUrl(new URL(String(r.headers?.location||""),u.origin+"/robots.txt").href);}
        catch{/* malformed redirect */}
        if(!target||contactHost(target)!==contactHost(url)||
          new URL(target).pathname!=="/robots.txt"||new URL(target).protocol!=="https:")
          throw fail("CONTACT_ROBOTS_UNPROVEN");
        r=await one(target,64*1024);
      }
      if([404,410].includes(r.status))robots.set(u.origin,"");
      else if(r.status===200&&/^text\/plain\b/i.test(String(r.headers?.["content-type"]||"")))
        robots.set(u.origin,decodeContactHtml(r.body,r.headers["content-type"]));
      else throw fail("CONTACT_ROBOTS_UNPROVEN");
      if(robots.size>256)robots.delete(robots.keys().next().value);
    }
    if(!robotsAllows(robots.get(u.origin),u.pathname))throw fail("CONTACT_ROBOTS_DENIED");
  }
  return {get requests(){return requests;},get exhausted(){return stop();},
    async fetch(raw){
      let url=contactPublicUrl(raw);
      if(!url)throw fail("CONTACT_URL_UNSAFE");
      const host=contactHost(url);
      for(let redirect=0;redirect<=3;redirect++){
        await checkRobots(url);
        const r=await one(url,MAX_BYTES);
        if([301,302,303,307,308].includes(r.status)){
          const target=contactPublicUrl(new URL(String(r.headers?.location||""),url).href);
          if(!target||contactHost(target)!==host||
            new URL(url).protocol==="https:"&&new URL(target).protocol!=="https:")
            throw fail("CONTACT_REDIRECT_UNSAFE");
          url=target;continue;
        }
        if(r.status===404||r.status===410)return {status:r.status,url,html:""};
        if(r.status!==200||!/^text\/html\b|^application\/xhtml\+xml\b/i.test(String(r.headers?.["content-type"]||"")))
          throw fail("CONTACT_CONTENT_UNSUPPORTED");
        return {status:200,url,html:decodeContactHtml(r.body,r.headers["content-type"])};
      }
      throw fail("CONTACT_REDIRECT_LIMIT");
    }};
}
