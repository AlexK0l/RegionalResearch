const REGIONS=["Республика Адыгея","Республика Алтай","Республика Башкортостан","Республика Бурятия","Республика Дагестан","Республика Ингушетия","Кабардино-Балкарская Республика","Республика Калмыкия","Карачаево-Черкесская Республика","Республика Карелия","Республика Коми","Республика Марий Эл","Республика Мордовия","Республика Саха (Якутия)","Республика Северная Осетия — Алания","Республика Татарстан","Республика Тыва","Удмуртская Республика","Республика Хакасия","Чеченская Республика","Чувашская Республика","Алтайский край","Забайкальский край","Камчатский край","Краснодарский край","Красноярский край","Пермский край","Приморский край","Ставропольский край","Хабаровский край","Амурская область","Архангельская область","Астраханская область","Белгородская область","Брянская область","Владимирская область","Волгоградская область","Вологодская область","Воронежская область","Ивановская область","Иркутская область","Калининградская область","Калужская область","Кемеровская область — Кузбасс","Кировская область","Костромская область","Курганская область","Курская область","Ленинградская область","Липецкая область","Магаданская область","Московская область","Мурманская область","Нижегородская область","Новгородская область","Новосибирская область","Омская область","Оренбургская область","Орловская область","Пензенская область","Псковская область","Ростовская область","Рязанская область","Самарская область","Саратовская область","Сахалинская область","Свердловская область","Смоленская область","Тамбовская область","Тверская область","Томская область","Тульская область","Тюменская область","Ульяновская область","Челябинская область","Ярославская область","Москва","Санкт-Петербург","Еврейская автономная область","Ненецкий автономный округ","Ханты-Мансийский автономный округ — Югра","Чукотский автономный округ","Ямало-Ненецкий автономный округ"];

const e={
  region:document.querySelector("#region"),
  regions:document.querySelector("#regions"),
  start:document.querySelector("#startBtn"),
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
let currentJobId=localStorage.getItem("sat_current_job")||"";
let pollTimer=null;

function headers(json=false){
  const h={};
  if(json) h["Content-Type"]="application/json";
  return h;
}

async function api(url,options={}){
  const r=await fetch(url,{...options,headers:{...headers(Boolean(options.body)),...(options.headers||{})}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||("HTTP "+r.status));
  return data;
}

function renderSteps(statuses){
  if(!Array.isArray(statuses)||!statuses.length) return;
  e.steps.innerHTML="";
  for(const item of statuses){
    const li=document.createElement("li");
    if(item.status==="running") li.classList.add("active");
    if(item.status==="done") li.classList.add("done");
    li.innerHTML='<span class="dot">'+item.step+'</span><span>'+item.name+'</span><span class="state">'+(item.detail||({waiting:"ожидает",running:"выполняется",done:"выполнен"}[item.status]||item.status))+'</span>';
    e.steps.append(li);
  }
}

function setProgress(p){
  const value=Math.max(0,Math.min(100,Number(p.percent||0)));
  e.percent.textContent=value+"%";
  e.bar.style.width=value+"%";
  renderSteps(p.statuses);

  const labels={
    starting:"Подготовка",
    research:"Исследование",
    dedupe:"Объединение и дедупликация",
    google_ai:"Google AI Mode",
    completed:"Готово",
    cancelled:"Остановлено"
  };
  e.statusTitle.textContent=labels[p.phase]||"Исследование";

  if(p.phase==="google_ai"){
    const cur=Number(p.contactCurrent||0),total=Number(p.contactTotal||0);
    e.statusText.textContent="Шаг 11 из 11 · поиск контактов в виртуальном браузере";
    e.contactBox.hidden=false;
    const s=p.contactStats||{};
    e.contactBox.textContent=
      "Google AI Mode: "+cur+" / "+total+
      (p.contactCompany?" · "+p.contactCompany:"")+
      (s.ok!==undefined?" · найдено: "+(s.ok||0)+", недоступно: "+(s.unavailable||0)+", не найдено: "+(s.notFound||0):"");
  }else{
    e.contactBox.hidden=true;
    e.statusText.textContent=p.step?("Шаг "+p.step+" из 11"):"";
  }
}

async function poll(){
  if(!currentJobId)return;
  try{
    const d=await api("/api/jobs/"+encodeURIComponent(currentJobId));
    e.progressCard.hidden=false;
    setProgress(d.progress||{});

    if(d.state==="completed"){
      clearInterval(pollTimer);pollTimer=null;
      e.start.disabled=false;e.cancel.disabled=true;
      e.resultCard.hidden=false;
      const r=d.result||{},c=r.counts||{},g=r.contacts||{};
      e.resultSummary.textContent=
        "Прямые покупатели: "+(c.direct_buyers||0)+
        ", посредники: "+(c.intermediaries||0)+
        ", лизинг: "+(c.leasing||0)+
        ". Google AI Mode обработал "+(g.total||0)+" компаний; контакты подтверждены для "+(g.ok||0)+".";
      return;
    }

    if(d.state==="failed"){
      clearInterval(pollTimer);pollTimer=null;
      e.start.disabled=false;e.cancel.disabled=true;
      e.error.hidden=false;e.error.textContent="Ошибка: "+(d.error||"задание завершилось с ошибкой");
      return;
    }

    e.start.disabled=true;e.cancel.disabled=false;
  }catch(err){
    e.error.hidden=false;e.error.textContent=err.message;
  }
}

async function start(){
  const region=e.region.value.trim();
  if(!region){alert("Выберите или введите регион.");return;}
  e.error.hidden=true;e.resultCard.hidden=true;e.contactBox.hidden=true;
  e.progressCard.hidden=false;
  e.start.disabled=true;e.cancel.disabled=false;
  try{
    const d=await api("/api/jobs",{method:"POST",body:JSON.stringify({region})});
    currentJobId=d.id;
    localStorage.setItem("sat_current_job",currentJobId);
    if(pollTimer)clearInterval(pollTimer);
    await poll();
    pollTimer=setInterval(poll,2000);
  }catch(err){
    e.start.disabled=false;e.cancel.disabled=true;
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
    const r=await fetch("/api/jobs/"+encodeURIComponent(currentJobId)+"/download",{headers:headers(false)});
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

e.start.onclick=start;
e.cancel.onclick=cancel;
e.download.onclick=download;

(async()=>{
  try{
    config=await api("/api/config");
    renderSteps((config.steps||[]).map((name,i)=>({step:i+1,name,status:"waiting",detail:"ожидает"})));
    if(currentJobId){
      e.progressCard.hidden=false;
      await poll();
      if(!pollTimer)pollTimer=setInterval(poll,2000);
    }
  }catch(err){
    e.error.hidden=false;e.error.textContent="Не удалось загрузить конфигурацию: "+err.message;
  }
})();