// Discover an observed INN+KPP pair from Saby's own XHR/JSON responses.
// Only a lookup hint: the official full legal name, INN and KPP must still
// be reverified against Saby's structured public requisites before a row
// can be enriched. Never persist or log response bodies, names or tokens.
import {sabyInn} from "./sabyEnrichment.js";

const MAX_JSON_BYTES=1_250_000;
const MAX_API_RESPONSES=140;
const MAX_NODES=8500;
const INN_KEYS=new Set(["inn","инн","innul","иннюл","taxpayerinn"]);
const KPP_KEYS=new Set(["kpp","кпп"]);
const normalizeKey=value=>String(value||"").toLowerCase().replace(/[\s_\-]/g,"");
const isKpp=value=>typeof value==="string" && /^\d{9}$/.test(value);

export function sabyNetworkKppCandidates(value,expectedInn) {
  const inn=sabyInn(expectedInn);
  const result=new Set();
  if(!inn)return [];
  const seen=new Set();
  const pending=[{value,depth:0}];
  let visited=0;
  while(pending.length && visited<MAX_NODES) {
    const {value:node,depth}=pending.pop();
    if(depth>14 || node==null)continue;
    if(typeof node==="string") {
      if(node.length<5 || node.length>MAX_JSON_BYTES ||
         !/^\s*[\[{]/.test(node))continue;
      try {pending.push({value:JSON.parse(node),depth:depth+1});}
      catch { /* RPC may contain non-JSON strings. */ }
      continue;
    }
    if(typeof node!=="object" || seen.has(node))continue;
    seen.add(node);
    visited++;
    if(Array.isArray(node)) {
      for(const child of node.slice(0,400))
        pending.push({value:child,depth:depth+1});
      continue;
    }
    const pairs=Object.entries(node).slice(0,150);
    const ownInn=pairs.filter(([key])=>INN_KEYS.has(normalizeKey(key)))
      .map(([,v])=>v).find(v=>String(v||"")===inn);
    if(ownInn!==undefined) {
      const kpps=pairs.filter(([key])=>KPP_KEYS.has(normalizeKey(key)))
        .map(([,v])=>v).filter(isKpp);
      for(const kpp of kpps)result.add(kpp);
    }
    for(const [,child] of pairs)
      if(child && (typeof child==="object" || typeof child==="string"))
        pending.push({value:child,depth:depth+1});
  }
  return [...result].sort();
}

/**
 * Listener is active only while this company is being opened.
 * Reports only numeric counters / KPP candidate hints to the caller; no
 * response payloads are retained beyond per-response parsing.
 */
export function watchSabyKppNetwork(page,expectedInn) {
  const inn=sabyInn(expectedInn);
  const candidates=new Set(),pending=new Set();
  let responses=0,parsed=0;
  function onResponse(response) {
    if(!inn || responses>=MAX_API_RESPONSES)return;
    try {
      const request=response.request();
      if(!["xhr","fetch"].includes(request.resourceType()))return;
      const url=new URL(response.url());
      if(url.protocol!=="https:" || !(
        url.hostname==="profile.saby.ru" ||
        url.hostname==="api.saby.ru" ||
        url.hostname==="profile.sbis.ru"))return;
      if(response.status()!==200)return;
      const contentType=String(response.headers()["content-type"]||"").toLowerCase();
      if(!/(json|javascript|text\/plain)/.test(contentType))return;
      const contentLength=Number(response.headers()["content-length"]||"0");
      if(contentLength>MAX_JSON_BYTES)return;
      responses++;
      const promise=(async()=>{
        try {
          const buffer=await response.body();
          if(buffer.length>MAX_JSON_BYTES)return;
          const parsedJson=JSON.parse(buffer.toString("utf8"));
          parsed++;
          for(const found of sabyNetworkKppCandidates(parsedJson,inn))
            candidates.add(found);
        } catch { /* Invalid/expired Saby response: no KPP evidence. */ }
      })();
      pending.add(promise);
      promise.finally(()=>pending.delete(promise)).catch(()=>{});
    } catch { /* No raw network errors in logs. */ }
  }
  page.on("response",onResponse);
  return {
    async snapshot() {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise(resolve=>setTimeout(resolve,1800))
      ]);
      return {kpps:[...candidates].sort(),responses,parsed};
    },
    stop() {page.off("response",onResponse);}
  };
}
