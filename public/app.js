const SAME_ORIGIN_API_HOSTS=new Set(["localhost","127.0.0.1","::1","regionalresearch.onrender.com"]);
const API_BASE_URL=SAME_ORIGIN_API_HOSTS.has(window.location.hostname)
  ?""
  :"https://regionalresearch.onrender.com";
const REGIONS=["Республика Адыгея","Республика Алтай","Республика Башкортостан","Республика Бурятия","Республика Дагестан","Республика Ингушетия","Кабардино-Балкарская Республика","Республика Калмыкия","Карачаево-Черкесская Республика","Республика Карелия","Республика Коми","Республика Марий Эл","Республика Мордовия","Республика Саха (Якутия)","Республика Северная Осетия — Алания","Республика Татарстан","Республика Тыва","Удмуртская Республика","Республика Хакасия","Чеченская Республика","Чувашская Республика","Алтайский край","Забайкальский край","Камчатский край","Краснодарский край","Красноярский край","Пермский край","Приморский край","Ставропольский край","Хабаровский край","Амурская область","Архангельская область","Астраханская область","Белгородская область","Брянская область","Владимирская область","Волгоградская область","Вологодская область","Воронежская область","Ивановская область","Иркутская область","Калининградская область","Калужская область","Кемеровская область — Кузбасс","Кировская область","Костромская область","Курганская область","Курская область","Ленинградская область","Липецкая область","Магаданская область","Московская область","Мурманская область","Нижегородская область","Новгородская область","Новосибирская область","Омская область","Оренбургская область","Орловская область","Пензенская область","Псковская область","Ростовская область","Рязанская область","Самарская область","Саратовская область","Сахалинская область","Свердловская область","Смоленская область","Тамбовская область","Тверская область","Томская область","Тульская область","Тюменская область","Ульяновская область","Челябинская область","Ярославская область","Москва","Санкт-Петербург","Еврейская автономная область","Ненецкий автономный округ","Ханты-Мансийский автономный округ — Югра","Чукотский автономный округ","Ямало-Ненецкий автономный округ"];

const e={
  region:document.querySelector("#region"),
  regions:document.querySelector("#regions"),
  regionCheckpointBox:document.querySelector("#regionCheckpointBox"),
  regionCheckpointText:document.querySelector("#regionCheckpointText"),
  regionResume:document.querySelector("#regionResumeBtn"),
  start:document.querySelector("#startBtn"),
  resume:document.querySelector("#resumeBtn"),
  checkpoint:document.querySelector("#checkpointBtn"),
  serviceStatus:document.querySelector("#serviceStatus"),
  cancel:document.querySelector("#cancelBtn"),
  progressCard:document.querySelector("#progressCard"),
  statusTitle:document.querySelector("#statusTitle"),
  statusText:document.querySelector("#statusText"),
  percent:document.querySelector("#percent"),
  bar:document.querySelector("#progressBar"),
  steps:document.querySelector("#steps"),
  contactBox:document.querySelector("#contactBox"),
  error:document.querySelector("#errorBox"),
  resultCard:document.querySelector("#resultCard"),
  resultSummary:document.querySelector("#resultSummary"),
  download:document.querySelector("#downloadBtn")
};

REGIONS.forEach(r=>{const o=document.createElement("option");o.value=r;e.regions.append(o)});

let config=null;
let backendReady=false;
let currentJobId=localStorage.getItem("sat_current_job")||"";
let pollTimer=null;
let timerTick=null;
let lastProgress=null;
let regionCheckpoint=null;
let regionCheckpointTimer=null;

const LAST_REGION_KEY="sat_last_region";
const BROWSER_CHECKPOINT_STORAGE_KEY="sat_browser_checkpoint_v1";
let browserCheckpointSyncInFlight=null;
let lastBrowserCheckpointSignature="";

e.region.value=localStorage.getItem(LAST_REGION_KEY)||"";

function loadBrowserCheckpointRecord(){
  try{
    const raw=sessionStorage.getItem(BROWSER_CHECKPOINT_STORAGE_KEY);
    if(!raw)return null;
    const record=JSON.parse(raw);
    const checkpoint=record?.checkpoint;
    if(Number(checkpoint?.version)!==1||!String(checkpoint?.region||"").trim())return null;
    return record;
  }catch(err){
    console.warn("Не удалось прочитать checkpoint из sessionStorage:",err);
    return null;
  }
}

function saveBrowserCheckpoint(checkpoint,jobId=""){
  try{
    if(Number(checkpoint?.version)!==1||!String(checkpoint?.region||"").trim())return false;
    sessionStorage.setItem(BROWSER_CHECKPOINT_STORAGE_KEY,JSON.stringify({
      job_id:String(jobId||""),
      saved_at:new Date().toISOString(),
      checkpoint
    }));
    return true;
  }catch(err){
    console.warn("Не удалось сохранить checkpoint в sessionStorage:",err);
    return false;
  }
}

function clearBrowserCheckpoint(region=""){
  try{
    const record=loadBrowserCheckpointRecord();
    if(!region||!record||String(record.checkpoint?.region||"").trim()===String(region||"").trim()){
      sessionStorage.removeItem(BROWSER_CHECKPOINT_STORAGE_KEY);
      lastBrowserCheckpointSignature="";
    }
  }catch{}
}

function browserCheckpointForRegion(region){
  const record=loadBrowserCheckpointRecord();
  const checkpoint=record?.checkpoint;
  if(!checkpoint||String(checkpoint.region||"").trim()!==String(region||"").trim())return null;
  const pipelineVersion=Number(checkpoint.pipeline_version||0);
  return {
    id:String(record.job_id||""),
    region:String(checkpoint.region||""),
    mode:String(checkpoint.source_mode||checkpoint.mode||"full"),
    pipeline_version:pipelineVersion,
    status:String(checkpoint.phase||"")==="completed"?"completed":"resumable",
    phase:String(checkpoint.phase||""),
    completed_stage:Number(checkpoint.completed_stage||0),
    completed_final_batches:Number(checkpoint.completed_final_batches||0),
    created_at:checkpoint.created_at||null,
    updated_at:checkpoint.updated_at||record.saved_at||null,
    compatible:!config?.pipelineVersion||!pipelineVersion||pipelineVersion===Number(config.pipelineVersion),
    source:"browser",
    browser_checkpoint:checkpoint,
    contacts_deferred:Array.isArray(checkpoint.contact_unsearched_ids)?checkpoint.contact_unsearched_ids.length:0,
    continuation_available:Array.isArray(checkpoint.contact_unsearched_ids)&&checkpoint.contact_unsearched_ids.length>0
  };
}

function checkpointTimestamp(checkpoint){
  const parsed=Date.parse(checkpoint?.updated_at||checkpoint?.created_at||"");
  return Number.isFinite(parsed)?parsed:0;
}

function chooseLatestCheckpoint(backendCheckpoint,browserCheckpoint){
  if(!backendCheckpoint)return browserCheckpoint||null;
  if(!browserCheckpoint)return {...backendCheckpoint,source:"backend"};
  const backend={...backendCheckpoint,source:"backend"};
  return checkpointTimestamp(browserCheckpoint)>=checkpointTimestamp(backendCheckpoint)
    ?browserCheckpoint
    :backend;
}

async function syncBrowserCheckpointFromBackend(jobId,summary=null){
  if(!jobId)return false;
  const signature=JSON.stringify({
    jobId,
    phase:summary?.phase||"",
    completed_stage:Number(summary?.completed_stage||0),
    completed_final_batches:Number(summary?.completed_final_batches||0),
    enrichment_completed:Number(summary?.enrichment_completed||0),
    contacts_completed:Number(summary?.contacts_completed||0),
    updated_at:summary?.updated_at||""
  });
  if(signature===lastBrowserCheckpointSignature)return true;
  if(browserCheckpointSyncInFlight)return browserCheckpointSyncInFlight;

  browserCheckpointSyncInFlight=(async()=>{
    try{
      const checkpoint=await api("/api/jobs/"+encodeURIComponent(jobId)+"/checkpoint");
      const saved=saveBrowserCheckpoint(checkpoint,jobId);
      if(saved)lastBrowserCheckpointSignature=signature;
      return saved;
    }catch(err){
      console.warn("Не удалось синхронизировать checkpoint в браузер:",err);
      return false;
    }finally{
      browserCheckpointSyncInFlight=null;
    }
  })();
  return browserCheckpointSyncInFlight;
}

function headers(json=false){
  const h={};
  const token=sessionStorage.getItem("regionalresearch_api_token")||"";
  if(token)h["Authorization"]="Bearer "+token;
  if(json)h["Content-Type"]="application/json";
  return h;
}

function apiUrl(url){
  return API_BASE_URL+(url.startsWith("/")?url:"/"+url);
}

async function api(url,options={}){
  const r=await fetch(apiUrl(url),{
    ...options,
    headers:{...headers(Boolean(options.body)),...(options.headers||{})}
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok){
    if(r.status===401){
      const token=window.prompt("Доступ к исследованию: введите API_ACCESS_TOKEN");
      if(token){sessionStorage.setItem("regionalresearch_api_token",token.trim()); return api(url,options);}
    }
    const err=new Error(data.error||("HTTP "+r.status));
    err.status=r.status;
    err.code=data.code||"";
    err.data=data;
    throw err;
  }
  return data;
}

function formatCheckpointPhase(phase){
  return ({
    starting:"подготовка",
    discovery:"этапы discovery",
    pre_identity:"pre-identity",
    identity:"identity / ИНН",
    final_batches:"финальная подготовка",
    dedupe:"глобальная дедупликация",
    qualification:"финальная qualification",
    final_inn:"финальная проверка ИНН",
    enrichment:"enrichment",
    statistics:"статистика",
    contacts:"контакты",
    completed:"завершено"
  })[phase]||phase||"неизвестный этап";
}

function renderRegionCheckpoint(checkpoint){
  regionCheckpoint=checkpoint||null;
  if(checkpoint&&checkpoint.status==="completed"&&!checkpoint.continuation_available)checkpoint=null;
  if(!checkpoint){
    e.regionCheckpointBox.hidden=true;
    e.regionResume.disabled=true;
    e.start.textContent="Запустить исследование";
    return;
  }

  const updated=checkpoint.updated_at
    ?new Date(checkpoint.updated_at).toLocaleString("ru-RU")
    :"неизвестно";
  const batch=Number(checkpoint.completed_final_batches||0);
  const sourceText=checkpoint.source==="browser"?"браузер":"backend / SQLite";
  e.regionCheckpointText.textContent=
    (checkpoint.status==="completed"
      ?"Исследование завершено, но "+Number(checkpoint.contacts_deferred||0)+" компаний осталось без проверки контактов · "
      :"Есть незавершённое исследование · ")+formatCheckpointPhase(checkpoint.phase)+
    " · завершено discovery-этапов: "+Number(checkpoint.completed_stage||0)+
    (batch?" · final batches: "+batch:"")+
    " · сохранено: "+updated+
    " · источник: "+sourceText+
    (checkpoint.compatible===false?" · версия pipeline несовместима":"");
  e.regionCheckpointBox.hidden=false;
  e.regionResume.disabled=checkpoint.compatible===false;
  e.start.textContent="Начать новое исследование";
  e.regionResume.textContent=checkpoint.status==="completed"?"Продолжить недоисследованные контакты":"Продолжить с checkpoint";
}

async function refreshRegionCheckpoint(){
  const region=e.region.value.trim();
  if(!region){
    renderRegionCheckpoint(null);
    return;
  }

  const browserCheckpoint=browserCheckpointForRegion(region);
  if(!backendReady){
    renderRegionCheckpoint(browserCheckpoint);
    return;
  }

  try{
    const data=await api("/api/checkpoints?region="+encodeURIComponent(region)+"&mode=full");
    renderRegionCheckpoint(chooseLatestCheckpoint(data.checkpoint||null,browserCheckpoint));
  }catch(err){
    console.warn("Не удалось проверить checkpoint региона на backend:",err);
    renderRegionCheckpoint(browserCheckpoint);
  }
}

function scheduleRegionCheckpointRefresh(){
  localStorage.setItem(LAST_REGION_KEY,e.region.value.trim());
  if(regionCheckpointTimer)clearTimeout(regionCheckpointTimer);
  regionCheckpointTimer=setTimeout(refreshRegionCheckpoint,350);
}

function formatDuration(ms){
  const total=Math.max(0,Math.floor(Number(ms||0)/1000));
  const h=Math.floor(total/3600);
  const m=Math.floor((total%3600)/60);
  const s=total%60;
  if(h>0)return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
  return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}

function stepStateText(item){
  const base=item.detail||({waiting:"ожидает",running:"выполняется",done:"выполнен"}[item.status]||item.status);
  if(item.status==="running"&&item.startedAt){
    return base+" · "+formatDuration(Date.now()-Number(item.startedAt));
  }
  if(item.status==="done"&&item.startedAt&&item.completedAt){
    return base+" · "+formatDuration(Number(item.completedAt)-Number(item.startedAt));
  }
  return base;
}

function renderSteps(statuses){
  if(!Array.isArray(statuses)||!statuses.length)return;
  e.steps.innerHTML="";
  for(const item of statuses){
    const li=document.createElement("li");
    if(item.status==="running")li.classList.add("active");
    if(item.status==="done")li.classList.add("done");
    li.innerHTML='<span class="dot">'+item.step+'</span><span>'+item.name+'</span><span class="state">'+stepStateText(item)+'</span>';
    e.steps.append(li);
  }
}

function setControlsRunning(running){
  e.start.disabled=running||!backendReady;
  e.cancel.disabled=!running;
  if(running){
    e.resume.disabled=true;
    e.checkpoint.disabled=true;
  }
}

function resetIdleState(){
  currentJobId="";
  localStorage.removeItem("sat_current_job");
  lastProgress=null;
  if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
  e.error.hidden=true;
  e.error.textContent="";
  e.resultCard.hidden=true;
  e.contactBox.hidden=true;
  e.progressCard.hidden=true;
  e.cancel.disabled=true;
  e.resume.hidden=true;
  e.resume.disabled=true;
  e.checkpoint.hidden=true;
  e.checkpoint.disabled=true;
  regionCheckpoint=null;
  e.regionCheckpointBox.hidden=true;
  e.regionResume.disabled=true;
  e.start.textContent="Запустить исследование";
  if(backendReady)e.start.disabled=false;
  if(config?.steps){
    renderSteps((config.steps||[]).map((name,i)=>({
      step:i+1,
      name,
      status:"waiting",
      detail:"ожидает"
    })));
  }
}

function setProgress(p){
  lastProgress=p||{};
  const value=Math.max(0,Math.min(100,Number(p.percent||0)));
  e.percent.textContent=value+"%";
  e.bar.style.width=value+"%";
  renderSteps(p.statuses);

  const labels={
    queued:"В очереди",
    starting:"Подготовка",
    research:"Исследование",
    dedupe:"Объединение и дедупликация",
    google_ai:"Поиск контактов",
    qualification:"Identity, дедупликация и A/B/C",
    completed:"Готово",
    cancelled:"Остановлено"
  };
  e.statusTitle.textContent=labels[p.phase]||"Исследование";

  if(p.phase==="queued"){
    e.statusText.textContent="Ожидание запуска · позиция "+Number(p.queuePosition||1);
    e.contactBox.hidden=true;
  }else if(p.phase==="google_ai"){
    const cur=Number(p.contactCurrent||0);
    const total=Number(p.contactTotal||0);
    const s=p.contactStats||{};
    e.statusText.textContent="Поиск и проверка контактов";
    e.contactBox.hidden=false;
    e.contactBox.textContent=
      "Обработано компаний: "+cur+" / "+total+
      (p.contactCompany?" · "+p.contactCompany:"")+
      (s.ok!==undefined
        ?" · найдено: "+(s.ok||0)+", недоступно: "+(s.unavailable||0)+", не найдено: "+(s.notFound||0)
        :"");
  }else{
    e.contactBox.hidden=true;
    e.statusText.textContent=p.step?("Этап "+p.step):"";
  }
}

async function poll(restoring=false){
  if(!currentJobId)return;

  try{
    const d=await api("/api/jobs/"+encodeURIComponent(currentJobId));
    e.progressCard.hidden=false;
    setProgress(d.progress||{});

    if(d.resume_available&&d.checkpoint){
      void syncBrowserCheckpointFromBackend(currentJobId,d.checkpoint);
    }

    if(d.state==="completed"){
      if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
      setControlsRunning(false);
      e.resume.hidden=!d.continuation_available;
      e.resume.disabled=!d.continuation_available;
      e.resume.textContent=d.continuation_available?"Продолжить недоисследованные контакты":"Продолжить с checkpoint";
      e.checkpoint.hidden=!d.resume_available;
      e.checkpoint.disabled=!d.resume_available;
      e.resultCard.hidden=false;
      const r=d.result||{};
      const c=r.counts||{};
      const g=r.contacts||{};
      e.resultSummary.textContent=
        "Прямые покупатели: "+(c.direct_buyers||0)+
        ", посредники: "+(c.intermediaries||0)+
        ", лизинг: "+(c.leasing||0)+
        ". Проверено компаний: "+(g.total||0)+
        ", контакты подтверждены для "+(g.ok||0)+"."+
        (d.continuation_available
          ?" Отложено без поиска: "+Number(d.checkpoint?.contacts_deferred||0)+
            ". Доступно продолжение с checkpoint в пределах оставшегося бюджета."
          :"");
      return;
    }

    if(d.state==="failed"||d.state==="cancelled"){
      if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
      setControlsRunning(false);
      e.resume.hidden=!d.resume_available;
      e.resume.disabled=!d.resume_available;
      e.checkpoint.hidden=!d.resume_available;
      e.checkpoint.disabled=!d.resume_available;
      e.statusTitle.textContent=d.state==="cancelled"?"Остановлено":"Ошибка";
      e.statusText.textContent=d.state==="cancelled"
        ?(d.error||"Исследование остановлено пользователем.")
        :"Исследование завершилось с ошибкой.";
      if(d.state==="failed"){
        e.error.hidden=false;
        e.error.textContent="Ошибка: "+(d.error||"задание завершилось с ошибкой")+
          (d.resume_available?" · Доступно продолжение с последнего checkpoint.":"");
      }
      if(restoring&&d.state==="cancelled"&&!d.resume_available){
        resetIdleState();
      }
      return;
    }

    if(d.state==="cancelling"){
      setControlsRunning(true);
      e.cancel.disabled=true;
      e.statusTitle.textContent="Останавливаем";
      e.statusText.textContent="Прерываем активные запросы…";
      return;
    }

    setControlsRunning(true);
    e.resume.hidden=true;
    e.checkpoint.hidden=!d.resume_available;
    e.checkpoint.disabled=!d.resume_available;
  }catch(err){
    if(err?.status===404){
      const region=e.region.value.trim();
      resetIdleState();
      if(region)await refreshRegionCheckpoint();
      return;
    }
    e.error.hidden=false;
    e.error.textContent=err.message;
  }
}

async function start(){
  const region=e.region.value.trim();
  if(!region){
    alert("Выберите или введите регион.");
    return;
  }

  localStorage.setItem(LAST_REGION_KEY,region);
  e.error.hidden=true;
  e.resultCard.hidden=true;
  e.contactBox.hidden=true;
  e.progressCard.hidden=false;
  setControlsRunning(true);

  try{
    const d=await api("/api/jobs",{
      method:"POST",
      body:JSON.stringify({region,mode:"full",startFresh:true})
    });
    clearBrowserCheckpoint(region);
    currentJobId=d.id;
    localStorage.setItem("sat_current_job",currentJobId);
    renderRegionCheckpoint(null);
    if(pollTimer)clearInterval(pollTimer);
    await poll();
    pollTimer=setInterval(poll,2000);
  }catch(err){
    setControlsRunning(false);
    e.error.hidden=false;
    e.error.textContent=err.message;
  }
}

async function startRegionResume(){
  const checkpoint=regionCheckpoint;
  if(!checkpoint)return;

  e.error.hidden=true;
  e.resultCard.hidden=true;
  e.contactBox.hidden=true;
  e.progressCard.hidden=false;
  e.regionResume.disabled=true;
  setControlsRunning(true);

  try{
    const payload={mode:"resume"};
    if(checkpoint.source==="browser"&&checkpoint.browser_checkpoint){
      payload.checkpoint=checkpoint.browser_checkpoint;
    }else if(checkpoint.id){
      payload.checkpointId=checkpoint.id;
    }else if(checkpoint.browser_checkpoint){
      payload.checkpoint=checkpoint.browser_checkpoint;
    }else{
      throw new Error("Checkpoint для продолжения недоступен");
    }

    const d=await api("/api/jobs",{
      method:"POST",
      body:JSON.stringify(payload)
    });
    currentJobId=d.id;
    localStorage.setItem("sat_current_job",currentJobId);
    if(checkpoint.source==="browser"&&checkpoint.browser_checkpoint){
      saveBrowserCheckpoint(checkpoint.browser_checkpoint,currentJobId);
    }
    renderRegionCheckpoint(null);
    if(pollTimer)clearInterval(pollTimer);
    await poll();
    pollTimer=setInterval(poll,2000);
  }catch(err){
    e.regionResume.disabled=false;
    setControlsRunning(false);
    e.error.hidden=false;
    e.error.textContent=err.message;
  }
}

async function resumeFromCheckpoint(){
  if(!currentJobId)return;
  e.error.hidden=true;
  e.resume.disabled=true;
  e.checkpoint.disabled=true;
  setControlsRunning(true);

  try{
    const d=await api("/api/jobs/"+encodeURIComponent(currentJobId)+"/resume",{method:"POST"});
    currentJobId=d.id;
    localStorage.setItem("sat_current_job",currentJobId);
    e.resume.hidden=true;
    e.checkpoint.hidden=true;
    if(pollTimer)clearInterval(pollTimer);
    await poll();
    pollTimer=setInterval(poll,2000);
  }catch(err){
    e.resume.disabled=false;
    e.checkpoint.disabled=false;
    setControlsRunning(false);
    e.error.hidden=false;
    e.error.textContent=err.message;
  }
}

async function downloadCheckpoint(){
  if(!currentJobId)return;
  try{
    const checkpoint=await api("/api/jobs/"+encodeURIComponent(currentJobId)+"/checkpoint");
    saveBrowserCheckpoint(checkpoint,currentJobId);
    const blob=new Blob([JSON.stringify(checkpoint,null,2)],{type:"application/json"});
    const u=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=u;
    a.download="regionalresearch-checkpoint-"+currentJobId+".json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(u),1000);
  }catch(err){
    e.error.hidden=false;
    e.error.textContent=err.message;
  }
}

async function cancel(){
  if(!currentJobId)return;
  e.cancel.disabled=true;
  try{
    await api("/api/jobs/"+encodeURIComponent(currentJobId)+"/cancel",{method:"POST"});
  }catch(err){
    e.error.hidden=false;
    e.error.textContent=err.message;
  }
}

async function download(){
  if(!currentJobId)return;
  try{
    const r=await fetch(apiUrl("/api/jobs/"+encodeURIComponent(currentJobId)+"/download"),{
      headers:headers(false)
    });
    if(!r.ok){
      const d=await r.json().catch(()=>({}));
      throw new Error(d.error||("HTTP "+r.status));
    }
    const b=await r.blob();
    const cd=r.headers.get("content-disposition")||"";
    const m=cd.match(/filename\*=UTF-8''([^;]+)/i);
    const filename=m?decodeURIComponent(m[1]):"SAT_result.xlsx";
    const u=URL.createObjectURL(b);
    const a=document.createElement("a");
    a.href=u;
    a.download=filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(u),1000);
  }catch(err){
    e.error.hidden=false;
    e.error.textContent=err.message;
  }
}

function setServiceStatus(text,state=""){
  if(!e.serviceStatus)return;
  e.serviceStatus.textContent=text;
  e.serviceStatus.dataset.state=state;
}

async function waitForBackend(){
  e.start.disabled=true;
  e.resume.disabled=true;
  e.checkpoint.disabled=true;
  setServiceStatus("Сервис запускается…","starting");

  while(!backendReady){
    try{
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),90000);
      const r=await fetch(apiUrl("/health"),{
        signal:controller.signal,
        cache:"no-store"
      });
      clearTimeout(timeout);

      if(r.ok){
        const health=await r.json().catch(()=>({}));
        backendReady=true;
        const runtime=health.runtime==="local"?"локально":"на сервере";
        setServiceStatus(
          "Сервис готов к работе ("+runtime+"). Checkpoint: SQLite, логи: отдельные файлы.",
          "ready"
        );
        if(!currentJobId)e.start.disabled=false;
        if(e.region.value.trim())await refreshRegionCheckpoint();
        return true;
      }
    }catch{}

    setServiceStatus("Сервис запускается…","starting");
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
}

e.region.oninput=scheduleRegionCheckpointRefresh;
e.region.onchange=()=>{
  localStorage.setItem(LAST_REGION_KEY,e.region.value.trim());
  void refreshRegionCheckpoint();
};
e.regionResume.onclick=startRegionResume;
e.start.onclick=start;
e.resume.onclick=resumeFromCheckpoint;
e.checkpoint.onclick=downloadCheckpoint;
e.cancel.onclick=cancel;
e.download.onclick=download;

timerTick=setInterval(()=>{
  if(lastProgress?.statuses)renderSteps(lastProgress.statuses);
},1000);

(async()=>{
  await waitForBackend();
  try{
    config=await api("/api/config");
    renderSteps((config.steps||[]).map((name,i)=>({
      step:i+1,
      name,
      status:"waiting",
      detail:"ожидает"
    })));

    if(currentJobId){
      try{
        const d=await api("/api/jobs/"+encodeURIComponent(currentJobId));
        e.progressCard.hidden=false;
        setProgress(d.progress||{});
        await poll(true);
        if(!["completed","failed","cancelled"].includes(d.state)&&!pollTimer){
          pollTimer=setInterval(poll,2000);
        }
      }catch(err){
        if(err?.status===404){
          resetIdleState();
          if(e.region.value.trim())await refreshRegionCheckpoint();
        }else{
          throw err;
        }
      }
    }else if(e.region.value.trim()){
      await refreshRegionCheckpoint();
    }
  }catch(err){
    e.error.hidden=false;
    e.error.textContent="Не удалось загрузить конфигурацию: "+err.message;
  }
})();
