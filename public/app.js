const API_BASE_URL="https://regionalresearch.onrender.com";
const REGIONS=["Республика Адыгея","Республика Алтай","Республика Башкортостан","Республика Бурятия","Республика Дагестан","Республика Ингушетия","Кабардино-Балкарская Республика","Республика Калмыкия","Карачаево-Черкесская Республика","Республика Карелия","Республика Коми","Республика Марий Эл","Республика Мордовия","Республика Саха (Якутия)","Республика Северная Осетия — Алания","Республика Татарстан","Республика Тыва","Удмуртская Республика","Республика Хакасия","Чеченская Республика","Чувашская Республика","Алтайский край","Забайкальский край","Камчатский край","Краснодарский край","Красноярский край","Пермский край","Приморский край","Ставропольский край","Хабаровский край","Амурская область","Архангельская область","Астраханская область","Белгородская область","Брянская область","Владимирская область","Волгоградская область","Вологодская область","Воронежская область","Ивановская область","Иркутская область","Калининградская область","Калужская область","Кемеровская область — Кузбасс","Кировская область","Костромская область","Курганская область","Курская область","Ленинградская область","Липецкая область","Магаданская область","Московская область","Мурманская область","Нижегородская область","Новгородская область","Новосибирская область","Омская область","Оренбургская область","Орловская область","Пензенская область","Псковская область","Ростовская область","Рязанская область","Самарская область","Саратовская область","Сахалинская область","Свердловская область","Смоленская область","Тамбовская область","Тверская область","Томская область","Тульская область","Тюменская область","Ульяновская область","Челябинская область","Ярославская область","Москва","Санкт-Петербург","Еврейская автономная область","Ненецкий автономный округ","Ханты-Мансийский автономный округ — Югра","Чукотский автономный округ","Ямало-Ненецкий автономный округ"];

const e={
  region:document.querySelector("#region"),
  regions:document.querySelector("#regions"),
  start:document.querySelector("#startBtn"),
  smoke:document.querySelector("#smokeBtn"),
  quality:document.querySelector("#qualityBtn"),
  test:document.querySelector("#testBtn"),
  replay:document.querySelector("#replayBtn"),
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
  testCompanies:document.querySelector("#testCompanies"),
  download:document.querySelector("#downloadBtn")
};

REGIONS.forEach(r=>{const o=document.createElement("option");o.value=r;e.regions.append(o)});

let config=null;
let currentJobId=localStorage.getItem("sat_current_job")||"";
let pollTimer=null;
let timerTick=null;
let lastProgress=null;
const SNAPSHOT_STORAGE_KEY="sat_discovery_snapshot_v1";

function loadSavedSnapshot(){
  try{
    const raw=localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if(!raw)return null;
    const snapshot=JSON.parse(raw);
    return snapshot?.version===1&&Array.isArray(snapshot.parts)?snapshot:null;
  }catch{return null;}
}

function saveSnapshot(snapshot){
  try{
    if(snapshot?.version!==1||!Array.isArray(snapshot.parts))return false;
    localStorage.setItem(SNAPSHOT_STORAGE_KEY,JSON.stringify(snapshot));
    return true;
  }catch(err){
    console.warn("Не удалось сохранить discovery snapshot в браузере:",err);
    return false;
  }
}

async function cacheSnapshot(jobId){
  try{
    const snapshot=await api("/api/jobs/"+encodeURIComponent(jobId)+"/snapshot");
    return saveSnapshot(snapshot);
  }catch(err){
    console.warn("Discovery snapshot не сохранён:",err);
    return false;
  }
}


function headers(json=false){
  const h={};
  if(json) h["Content-Type"]="application/json";
  return h;
}

function apiUrl(url){
  return API_BASE_URL+(url.startsWith("/")?url:"/"+url);
}

async function api(url,options={}){
  const r=await fetch(apiUrl(url),{...options,headers:{...headers(Boolean(options.body)),...(options.headers||{})}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){
    const err=new Error(data.error||("HTTP "+r.status));
    err.status=r.status;
    throw err;
  }
  return data;
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
  if(!Array.isArray(statuses)||!statuses.length) return;
  e.steps.innerHTML="";
  for(const item of statuses){
    const li=document.createElement("li");
    if(item.status==="running") li.classList.add("active");
    if(item.status==="done") li.classList.add("done");
    li.innerHTML='<span class="dot">'+item.step+'</span><span>'+item.name+'</span><span class="state">'+stepStateText(item)+'</span>';
    e.steps.append(li);
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
  e.download.hidden=false;
  e.testCompanies.hidden=true;
  e.testCompanies.innerHTML="";
  e.contactBox.hidden=true;
  e.progressCard.hidden=true;
  e.cancel.disabled=true;
  e.replay.hidden=!loadSavedSnapshot();
  e.replay.disabled=!loadSavedSnapshot();
  if(backendReady){
    e.start.disabled=false;
    e.smoke.disabled=false;
    e.quality.disabled=false;
    e.test.disabled=false;
  }
  if(config?.steps){
    renderSteps((config.steps||[]).map((name,i)=>({step:i+1,name,status:"waiting",detail:"ожидает"})));
  }
}

function setProgress(p){
  lastProgress=p||{};
  const value=Math.max(0,Math.min(100,Number(p.percent||0)));
  e.percent.textContent=value+"%";
  e.bar.style.width=value+"%";
  renderSteps(p.statuses);

  const labels={
    starting:"Подготовка",
    research:"Исследование",
    dedupe:"Объединение и дедупликация",
    google_ai:"Поиск контактов",
    qualification:"Identity, дедупликация и A/B/C",
    completed:"Готово",
    cancelled:"Остановлено"
  };
  e.statusTitle.textContent=labels[p.phase]||"Исследование";

  if(p.phase==="google_ai"){
    const cur=Number(p.contactCurrent||0),total=Number(p.contactTotal||0);
    e.statusText.textContent="Шаг 11 из 11 · поиск и проверка контактов";
    e.contactBox.hidden=false;
    const s=p.contactStats||{};
    e.contactBox.textContent=
      "Обработано компаний: "+cur+" / "+total+
      (p.contactCompany?" · "+p.contactCompany:"")+
      (s.ok!==undefined?" · найдено: "+(s.ok||0)+", недоступно: "+(s.unavailable||0)+", не найдено: "+(s.notFound||0):"");
  }else{
    e.contactBox.hidden=true;
    e.statusText.textContent=p.step?("Шаг "+p.step+" из 11"):"";
  }
}

function escapeHtml(value){
  return String(value??"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function renderQualifiedCompanies(companies){
  const rows=Array.isArray(companies)?companies:[];
  if(!rows.length){
    e.testCompanies.hidden=false;
    e.testCompanies.innerHTML='<p class="note">После проверки evidence ни одна компания не прошла финальный фильтр A/B/C.</p>';
    return;
  }

  const body=rows.map(item=>{
    const stages=(item.stages||[]).map(x=>"Этап "+x).join(", ");
    return '<tr>'+
      '<td><span class="grade grade-'+escapeHtml(item.grade)+'">'+escapeHtml(item.grade)+'</span></td>'+
      '<td><strong>'+escapeHtml(item.organization)+'</strong></td>'+
      '<td>'+escapeHtml(item.city||"—")+'</td>'+
      '<td>'+escapeHtml((item.segments||[]).join(" · ")||"—")+'</td>'+
      '<td>'+escapeHtml(item.reason||"")+'</td>'+
      '<td>'+escapeHtml(stages||"—")+'</td>'+
    '</tr>';
  }).join("");

  e.testCompanies.hidden=false;
  e.testCompanies.innerHTML=
    '<div class="test-companies-head"><strong>Компании, прошедшие строгую проверку релевантности</strong><span>'+rows.length+'</span></div>'+
    '<div class="table-wrap"><table class="qualified-table">'+
      '<thead><tr><th>Класс</th><th>Компания</th><th>Город/район</th><th>Сегмент</th><th>Почему подходит</th><th>Найдена</th></tr></thead>'+
      '<tbody>'+body+'</tbody>'+
    '</table></div>';
}

async function poll(restoring=false){
  if(!currentJobId)return;
  try{
    const d=await api("/api/jobs/"+encodeURIComponent(currentJobId));
    e.progressCard.hidden=false;
    setProgress(d.progress||{});

    if(d.state==="completed"){
      clearInterval(pollTimer);pollTimer=null;
      e.start.disabled=false;
      e.smoke.disabled=false;
      e.quality.disabled=false;
      e.test.disabled=false;
      e.cancel.disabled=true;
      e.resultCard.hidden=false;
      const r=d.result||{},c=r.counts||{},g=r.contacts||{};
      const isTestMode=["test12","smoke","quality","replay"].includes(r.mode);
      if(isTestMode){
        const modeLabel={
          smoke:"Smoke test",
          quality:"Quality sample",
          test12:"Тест этапов 1–2",
          replay:"Replay без web"
        }[r.mode]||"Тест";
        e.resultSummary.textContent=
          modeLabel+" завершён. Сырых находок: "+(c.total_rows||0)+
          ", условно уникальных discovery: "+(c.unique||0)+
          ", identity-кластеров: "+(c.identity_clusters||0)+
          ", identity без web: "+(c.identity_skipped_web||0)+
          ", identity с web: "+(c.identity_searched_web||0)+
          ", после global dedupe: "+(c.after_global_dedupe||0)+
          (c.web_budget?.used
            ? ", web budget: этап 1 "+(c.web_budget.used.stage1||0)+"/"+(c.web_budget.limits.stage1||"—")+
              ", этап 2 "+(c.web_budget.used.stage2||0)+"/"+(c.web_budget.limits.stage2||"—")+
              ", identity "+(c.web_budget.used.identity||0)+"/"+(c.web_budget.limits.identity||"—")+
              ", всего "+(c.web_budget.used.total||0)+"/"+(c.web_budget.limits.total||"—")
            : "")+
          ". Финально: A — "+(c.A||0)+
          ", B — "+(c.B||0)+
          ", C — "+(c.C||0)+
          ", исключено — "+(c.excluded_after_qualification||0)+".";
        renderQualifiedCompanies(r.qualified_companies||[]);
        e.download.hidden=true;
        if(r.replay_available) await cacheSnapshot(currentJobId);
        e.replay.hidden=!(r.replay_available||loadSavedSnapshot());
        e.replay.disabled=false;
      }else{
        e.testCompanies.hidden=true;
        e.testCompanies.innerHTML="";
        e.download.hidden=false;
        e.resultSummary.textContent=
          "Прямые покупатели: "+(c.direct_buyers||0)+
          ", посредники: "+(c.intermediaries||0)+
          ", лизинг: "+(c.leasing||0)+
          ". Проверено компаний: "+(g.total||0)+", контакты подтверждены для "+(g.ok||0)+".";
      }
      return;
    }

    if(d.state==="failed"){
      clearInterval(pollTimer);pollTimer=null;
      e.start.disabled=false;e.smoke.disabled=false;e.quality.disabled=false;e.test.disabled=false;e.cancel.disabled=true;
      e.error.hidden=false;e.error.textContent="Ошибка: "+(d.error||"задание завершилось с ошибкой");
      return;
    }

    if(d.state==="cancelled"){
      clearInterval(pollTimer);pollTimer=null;
      localStorage.removeItem("sat_current_job");
      if(restoring){
        resetIdleState();
        return;
      }
      currentJobId="";
      e.start.disabled=false;e.smoke.disabled=false;e.quality.disabled=false;e.test.disabled=false;e.cancel.disabled=true;
      e.statusTitle.textContent="Остановлено";
      e.statusText.textContent=d.error||"Исследование остановлено пользователем.";
      return;
    }

    if(d.state==="cancelling"){
      e.start.disabled=true;e.smoke.disabled=true;e.quality.disabled=true;e.test.disabled=true;e.replay.disabled=true;e.cancel.disabled=true;
      e.statusTitle.textContent="Останавливаем";
      e.statusText.textContent="Прерываем активные запросы…";
      return;
    }

    e.start.disabled=true;e.smoke.disabled=true;e.quality.disabled=true;e.test.disabled=true;e.replay.disabled=true;e.cancel.disabled=false;
  }catch(err){
    if(err?.status===404){
      resetIdleState();
      return;
    }
    e.error.hidden=false;e.error.textContent=err.message;
  }
}

async function startJob(mode="full"){
  const region=e.region.value.trim();
  if(!region){alert("Выберите или введите регион.");return;}
  e.error.hidden=true;e.resultCard.hidden=true;e.contactBox.hidden=true;
  e.progressCard.hidden=false;
  e.replay.hidden=true;
  e.start.disabled=true;e.smoke.disabled=true;e.quality.disabled=true;e.test.disabled=true;e.replay.disabled=true;e.cancel.disabled=false;
  try{
    const d=await api("/api/jobs",{method:"POST",body:JSON.stringify({region,mode})});
    currentJobId=d.id;
    localStorage.setItem("sat_current_job",currentJobId);
    if(pollTimer)clearInterval(pollTimer);
    await poll();
    pollTimer=setInterval(poll,2000);
  }catch(err){
    e.start.disabled=false;e.smoke.disabled=false;e.quality.disabled=false;e.test.disabled=false;e.cancel.disabled=true;
    e.error.hidden=false;e.error.textContent=err.message;
  }
}

async function start(){return startJob("full");}
async function startSmoke(){return startJob("smoke");}
async function startQuality(){return startJob("quality");}
async function startTest(){return startJob("test12");}

async function startReplay(){
  if(!currentJobId)return;
  const sourceJobId=currentJobId;
  e.error.hidden=true;e.resultCard.hidden=true;e.contactBox.hidden=true;
  e.progressCard.hidden=false;
  e.start.disabled=true;e.smoke.disabled=true;e.quality.disabled=true;e.test.disabled=true;e.replay.disabled=true;e.cancel.disabled=false;
  try{
    const snapshot=loadSavedSnapshot();
    const payload={mode:"replay",sourceJobId};
    if(snapshot)payload.snapshot=snapshot;
    const d=await api("/api/jobs",{method:"POST",body:JSON.stringify(payload)});
    currentJobId=d.id;
    localStorage.setItem("sat_current_job",currentJobId);
    if(pollTimer)clearInterval(pollTimer);
    await poll();
    pollTimer=setInterval(poll,2000);
  }catch(err){
    e.start.disabled=false;e.smoke.disabled=false;e.quality.disabled=false;e.test.disabled=false;e.replay.disabled=false;e.cancel.disabled=true;
    e.error.hidden=false;e.error.textContent=err.message;
  }
}

async function cancel(){
  if(!currentJobId)return;
  e.cancel.disabled=true;
  try{await api("/api/jobs/"+encodeURIComponent(currentJobId)+"/cancel",{method:"POST"});}
  catch(err){e.error.hidden=false;e.error.textContent=err.message;}
}

async function download(){
  if(!currentJobId)return;
  try{
    const r=await fetch(apiUrl("/api/jobs/"+encodeURIComponent(currentJobId)+"/download"),{headers:headers(false)});
    if(!r.ok){
      const d=await r.json().catch(()=>({}));
      throw new Error(d.error||("HTTP "+r.status));
    }
    const b=await r.blob();
    const cd=r.headers.get("content-disposition")||"";
    const m=cd.match(/filename\*=UTF-8''([^;]+)/i);
    const filename=m?decodeURIComponent(m[1]):"SAT_result.xlsx";
    const u=URL.createObjectURL(b);
    const a=document.createElement("a");a.href=u;a.download=filename;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(u),1000);
  }catch(err){
    e.error.hidden=false;e.error.textContent=err.message;
  }
}

let backendReady=false;

function setServiceStatus(text,state=""){
  if(!e.serviceStatus)return;
  e.serviceStatus.textContent=text;
  e.serviceStatus.dataset.state=state;
}

async function waitForBackend(){
  e.start.disabled=true;
  e.smoke.disabled=true;
  e.quality.disabled=true;
  e.test.disabled=true;
  e.replay.disabled=true;
  setServiceStatus("Сервис запускается…","starting");
  while(!backendReady){
    try{
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),15000);
      const r=await fetch(apiUrl("/health"),{signal:controller.signal,cache:"no-store"});
      clearTimeout(timeout);
      if(r.ok){
        backendReady=true;
        setServiceStatus("Сервис готов к работе.","ready");
        if(!currentJobId){
          e.start.disabled=false;
          e.smoke.disabled=false;
          e.quality.disabled=false;
          e.test.disabled=false;
          e.replay.hidden=!loadSavedSnapshot();
          e.replay.disabled=!loadSavedSnapshot();
        }
        return true;
      }
    }catch{}
    setServiceStatus("Сервис запускается… это может занять до минуты.","starting");
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
}

e.start.onclick=start;
e.smoke.onclick=startSmoke;
e.quality.onclick=startQuality;
e.test.onclick=startTest;
e.replay.onclick=startReplay;
e.cancel.onclick=cancel;
e.download.onclick=download;

timerTick=setInterval(()=>{
  if(lastProgress?.statuses)renderSteps(lastProgress.statuses);
},1000);

(async()=>{
  await waitForBackend();
  try{
    config=await api("/api/config");
    renderSteps((config.steps||[]).map((name,i)=>({step:i+1,name,status:"waiting",detail:"ожидает"})));
    if(currentJobId){
      try{
        const d=await api("/api/jobs/"+encodeURIComponent(currentJobId));
        if(d.state==="cancelled"||d.state==="failed"){
          resetIdleState();
        }else{
          e.progressCard.hidden=false;
          setProgress(d.progress||{});
          if(d.state==="completed"){
            await poll(true);
          }else if(currentJobId&&!pollTimer){
            pollTimer=setInterval(poll,2000);
          }
        }
      }catch(err){
        if(err?.status===404) resetIdleState();
        else throw err;
      }
    }
  }catch(err){
    e.error.hidden=false;e.error.textContent="Не удалось загрузить конфигурацию: "+err.message;
  }
})();