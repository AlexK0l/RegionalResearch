// Privacy-safe first-party transport evidence for ONE exact Saby INN search.
// No response bodies, URL strings, request payloads, cookies or credentials
// leave this module. Exposes only numeric counters used to distinguish
// a search that was visibly entered from one observed on the wire.
const ACTIVE=new WeakMap();
const SESSION_SOCKETS=new WeakMap();
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

// Optional warm-catalog experiment: the list may survive a SPA history
// return, including sockets created BEFORE the next per-INN observer.
// Track socket handles, not frames/payloads, for the browser page lifetime.
export function trackSabySessionSockets(page){
  if(SESSION_SOCKETS.has(page))throw Error("SABY_SOCKET_TRACKER_ALREADY_ACTIVE");
  const sockets=new Set(),offBySocket=new Map();
  let stopped=false;
  const forget=socket=>{
    sockets.delete(socket);
    const off=offBySocket.get(socket);
    offBySocket.delete(socket);
    off?.();
  };
  const seen=socket=>{
    try{
      if(!firstPartySabySearchTransport(socket.url())||sockets.has(socket))return;
      sockets.add(socket);
      const onClose=()=>forget(socket);
      socket.on("close",onClose);
      offBySocket.set(socket,()=>socket.off?.("close",onClose));
    }catch{forget(socket);}
  };
  const stop=()=>{
    if(stopped)return;
    stopped=true;
    page.off?.("websocket",seen);
    page.off?.("close",stop);
    for(const socket of [...sockets])forget(socket);
    SESSION_SOCKETS.delete(page);
  };
  SESSION_SOCKETS.set(page,sockets);
  page.on("websocket",seen);
  page.on("close",stop);
  return stop;
}
export const hasSabySessionSocketTracker=page=>SESSION_SOCKETS.has(page);

export function observeSabySearchTransport(page,inn,{armed:initiallyArmed=true}={}){
  if(!VALID_INN.test(String(inn||"")))throw Error("SABY_TRANSPORT_INN_INVALID");
  ACTIVE.get(page)?.stop();
  const counts={
    first_party_async_requests:0,
    exact_inn_async_requests:0,
    exact_inn_ws_frames:0,
    async_responses:0,failed_requests:0,exact_inn_successful_responses:0,
    http_401:0,http_403:0,http_429:0,http_5xx:0
  };
  const pending=new Set(),exactPending=new Map(),socketOff=[],attachedSockets=new Set();
  let stopped=false,armed=initiallyArmed===true;
  const requestSeen=request=>{
    if(stopped||!armed)return;
    try{
      if(!firstPartySabySearchTransport(request.url()))return;
      const kind=String(request.resourceType()||"").toLowerCase();
      if(kind!=="fetch"&&kind!=="xhr")return;
      pending.add(request);
      counts.first_party_async_requests++;
      // URL / postData only used in memory to compare the caller's exact INN.
      // Do not retain their text or write anything to logs.
      if(exactSabyInnTransportToken(request.url(),inn)||
        exactSabyInnTransportToken(request.postData?.(),inn)){
        counts.exact_inn_async_requests++;
        exactPending.set(request,false);
      }
    }catch{
      // A diagnostic must never prevent a company search.
    }
  };
  const responseSeen=response=>{
    try{
      if(!pending.has(response.request()))return;
      counts.async_responses++;
      const status=Number(response.status());
      if(exactPending.has(response.request()))
        exactPending.set(response.request(),status>=200&&status<300);
      if(status===401)counts.http_401++;
      else if(status===403)counts.http_403++;
      else if(status===429)counts.http_429++;
      else if(status>=500&&status<600)counts.http_5xx++;
    }catch{}
  };
  const failed=request=>{
    if(pending.delete(request))counts.failed_requests++;
    exactPending.delete(request);
  };
  const finished=request=>{
    pending.delete(request);
    if(exactPending.get(request)===true)counts.exact_inn_successful_responses++;
    exactPending.delete(request);
  };
  const socketSeen=socket=>{
    try{
      if(!firstPartySabySearchTransport(socket.url())||attachedSockets.has(socket))return;
      attachedSockets.add(socket);
      const onFrame=frame=>{
        if(!stopped&&armed&&typeof frame?.payload==="string"&&
          exactSabyInnTransportToken(frame.payload,inn))
          counts.exact_inn_ws_frames++;
      };
      socket.on("framesent",onFrame);
      socketOff.push(()=>socket.off?.("framesent",onFrame));
    }catch{}
  };
  const self={
    // Subscribe BEFORE navigation/hydration so a long-lived Wasaby
    // WebSocket is not missed. Only count traffic AFTER the exact search
    // is about to be submitted; discard unrelated hydration requests.
    arm(){
      if(stopped)return;
      for(const key of Object.keys(counts))counts[key]=0;
      pending.clear();exactPending.clear();
      armed=true;
    },
    summary:()=>({...counts}),
    hasExactInnEvidence:()=>
      counts.exact_inn_async_requests>0||counts.exact_inn_ws_frames>0,
    // Transmission alone does not prove a completed search. Require
    // every observed exact-INN HTTP request to have finished
    // successfully, with no observed failure or blocking status.
    hasSettledExactInnResponse:()=>!stopped&&armed&&exactPending.size===0&&
      counts.exact_inn_async_requests>0&&
      counts.exact_inn_async_requests===counts.exact_inn_successful_responses&&
      !counts.failed_requests&&!counts.http_401&&!counts.http_403&&!counts.http_429&&!counts.http_5xx,
    // More conservative than scoped-empty classification: reusing the
    // mounted catalog requires ALL observed async work to be idle.
    // WebSocket dispatch has no matching completion proof here.
    hasIdleCompletedExactInnQuery:()=>self.hasSettledExactInnResponse()&&
      pending.size===0&&counts.exact_inn_ws_frames===0,
    stop(){
      if(stopped)return;
      stopped=true;
      page.off?.("request",requestSeen);
      page.off?.("response",responseSeen);
      page.off?.("requestfailed",failed);
      page.off?.("requestfinished",finished);
      page.off?.("websocket",socketSeen);
      for(const off of socketOff)try{off();}catch{}
      pending.clear();exactPending.clear();
      attachedSockets.clear();
      if(ACTIVE.get(page)===self)ACTIVE.delete(page);
    }
  };
  page.on("request",requestSeen);
  page.on("response",responseSeen);
  page.on("requestfailed",failed);
  page.on("requestfinished",finished);
  page.on("websocket",socketSeen);
  for(const socket of SESSION_SOCKETS.get(page)||[])socketSeen(socket);
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
  alreadyRecovered=false,exactTransportEvidence=null,serviceBlocked=false
}={}){
  return route==="list"&&reason==="not_found"&&observed===0&&
    elapsedMs>=6500&&alreadyRecovered===false&&
    serviceBlocked===false&&exactTransportEvidence===false;
}
