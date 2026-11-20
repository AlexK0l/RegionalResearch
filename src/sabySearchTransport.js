// Privacy-safe first-party transport evidence for ONE exact Saby INN search.
// No response bodies, URL strings, request payloads, cookies or credentials
// leave this module. Exposes only numeric counters used to distinguish
// a search that was visibly entered from one observed on the wire.
const ACTIVE=new WeakMap();
const VALID_INN=/^(?:\d{10}|\d{12})$/;

export function firstPartySabySearchTransport(url){
  try{
    const parsed=new URL(String(url||""));
    return ["https:","wss:"].includes(parsed.protocol)&&
      ["saby.ru","sbis.ru"].some(domain=>
        parsed.hostname===domain||
        parsed.hostname.endsWith("."+domain));
  }catch{return false;}
}

export function exactSabyInnTransportToken(text,inn){
  const expected=String(inn||"");
  if(!VALID_INN.test(expected))return false;
  // Saby requests are structured (often JSON), so match an exact digit
  // token without accepting the leading digits of a different entity.
  return new RegExp("(?:^|[^0-9])"+expected+"(?![0-9])")
    .test(String(text||""));
}

export function observeSabySearchTransport(page,inn){
  if(!VALID_INN.test(String(inn||"")))throw Error("SABY_TRANSPORT_INN_INVALID");
  ACTIVE.get(page)?.stop();
  const counts={
    first_party_async_requests:0,
    exact_inn_async_requests:0,
    exact_inn_ws_frames:0,
    async_responses:0,failed_requests:0,
    http_401:0,http_403:0,http_429:0,http_5xx:0
  };
  const pending=new Set(),socketOff=[];
  let stopped=false;
  const requestSeen=request=>{
    if(stopped)return;
    try{
      if(!firstPartySabySearchTransport(request.url()))return;
      const kind=String(request.resourceType()||"").toLowerCase();
      if(kind!=="fetch"&&kind!=="xhr")return;
      pending.add(request);
      counts.first_party_async_requests++;
      // URL / postData only used in memory to compare the caller's exact INN.
      // Do not retain their text or write anything to logs.
      if(exactSabyInnTransportToken(request.url(),inn)||
        exactSabyInnTransportToken(request.postData?.(),inn))
        counts.exact_inn_async_requests++;
    }catch{
      // A diagnostic must never prevent a company search.
    }
  };
  const responseSeen=response=>{
    try{
      if(!pending.has(response.request()))return;
      counts.async_responses++;
      const status=Number(response.status());
      if(status===401)counts.http_401++;
      else if(status===403)counts.http_403++;
      else if(status===429)counts.http_429++;
      else if(status>=500&&status<600)counts.http_5xx++;
    }catch{}
  };
  const failed=request=>{
    if(pending.delete(request))counts.failed_requests++;
  };
  const finished=request=>{pending.delete(request);};
  const socketSeen=socket=>{
    try{
      if(!firstPartySabySearchTransport(socket.url()))return;
      const onFrame=frame=>{
        if(typeof frame?.payload==="string"&&
          exactSabyInnTransportToken(frame.payload,inn))
          counts.exact_inn_ws_frames++;
      };
      socket.on("framesent",onFrame);
      socketOff.push(()=>socket.off?.("framesent",onFrame));
    }catch{}
  };
  const self={
    summary:()=>({...counts}),
    hasExactInnEvidence:()=>
      counts.exact_inn_async_requests>0||counts.exact_inn_ws_frames>0,
    stop(){
      if(stopped)return;
      stopped=true;
      page.off?.("request",requestSeen);
      page.off?.("response",responseSeen);
      page.off?.("requestfailed",failed);
      page.off?.("requestfinished",finished);
      page.off?.("websocket",socketSeen);
      for(const off of socketOff)try{off();}catch{}
      pending.clear();
      if(ACTIVE.get(page)===self)ACTIVE.delete(page);
    }
  };
  page.on("request",requestSeen);
  page.on("response",responseSeen);
  page.on("requestfailed",failed);
  page.on("requestfinished",finished);
  page.on("websocket",socketSeen);
  ACTIVE.set(page,self);
  return self;
}


// A silent Wasaby input occasionally accepts fill/Enter before the SPA
// dispatches any first-party query. Retry the read-only search only once,
// after a full observation window, and only when NO result rows exist.
// An observed query, ambiguous candidate, changed route or prior recovery
// must never trigger a speculative resubmission.
export function shouldRecoverSilentSabySearch({
  route="",reason="",observed=0,elapsedMs=0,
  alreadyRecovered=false,exactTransportEvidence=null
}={}){
  return route==="list"&&reason==="not_found"&&observed===0&&
    elapsedMs>=6500&&alreadyRecovered===false&&
    exactTransportEvidence===false;
}
