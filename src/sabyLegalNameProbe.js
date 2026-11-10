// Read-only diagnostic of company name and requisite FIELD STRUCTURE on an
// authenticated Saby detail page. Never exports raw HTML, arbitrary page
// text, phones, email, credentials, cookies, URLs or response bodies.
//
// This is evidence collection only. Candidate values are NOT legal proof.
import {sabyCardRoute} from "./sabyCard.js";
import {sabyInn} from "./sabyEnrichment.js";

const compact=value=>String(value||"").replace(/\s+/g," ").trim();
export function safeSabyLegalNameCandidate(value) {
  const name=compact(value);
  if(name.length<3||name.length>220||
     /[@\r\n]|(?:^|\s)(?:телефон|email|почта|факс|контакты|реквизиты)(?:\s|$)/iu.test(name) ||
     /(?:\+7|8)\s*[\s(.-]?\d{3}[\s).-]?\s*\d{3}/u.test(name) ||
     /^\d{9,15}$/u.test(name))return "";
  return name;
}
export function summarizeSabyNameEvidence(snapshot,expectedInn) {
  const inn=sabyInn(expectedInn);
  if(!inn)return {reason:"invalid_inn",candidates:[],labels:[],sections:[]};
  const values=(Array.isArray(snapshot?.values)?snapshot.values:[]).slice(0,30);
  const candidates=[];
  for(const item of values) {
    const name=safeSabyLegalNameCandidate(item?.candidate);
    if(!name)continue;
    const label=compact(item?.label).slice(0,80);
    if(!/^(?:название|полное название|наименование|полное наименование|юридическое наименование|наименование организации|краткое наименование|сокращенное наименование)$/iu.test(label))continue;
    const context=["same_row","sibling","adjacent_line"].includes(item?.context) ?
      item.context : "unclassified";
    const sameInnBlock=item?.sameInnBlock===true;
    const key=JSON.stringify([label,name,context,sameInnBlock]);
    if(candidates.some(x=>x.key===key))continue;
    candidates.push({key,label,name,context,sameInnBlock});
  }
  const labels=(Array.isArray(snapshot?.labels)?snapshot.labels:[])
    .map(compact).filter(x=>x.length>0&&x.length<=80).slice(0,24);
  const sections=(Array.isArray(snapshot?.sections)?snapshot.sections:[])
    .map(compact).filter(x=>x.length>0&&x.length<=80).slice(0,16);
  return {
    reason:"observed_not_verified",
    candidates:candidates.slice(0,12).map(({key,...rest})=>rest),
    labels:[...new Set(labels)],sections:[...new Set(sections)],
    exactInnVisible:snapshot?.exactInnVisible===true,
    labelledInnVisible:snapshot?.labelledInnVisible===true,
    labelledKppVisible:snapshot?.labelledKppVisible===true,
    requisiteTabVisible:snapshot?.requisiteTabVisible===true,
    // Presence flags are for locating the correct DOM owner scope, not
    // evidence sufficient to merge data across organisations.
    sameOwnerScopeProven:false
  };
}

export async function probeSabyLegalNameFields(page,expectedInn) {
  const inn=sabyInn(expectedInn);
  if(!inn)return {reason:"invalid_inn",candidates:[],labels:[],sections:[]};
  if(sabyCardRoute(page?.url?.())!=="detail")
    return {reason:"not_detail_page",candidates:[],labels:[],sections:[]};
  let snapshot;
  try {
    snapshot=await page.evaluate(inn=>{
      const compact=s=>String(s||"").replace(/\s+/g," ").trim();
      const visible=el=>{
        if(!el)return false;
        const rect=el.getBoundingClientRect(),css=getComputedStyle(el);
        return rect.width>0&&rect.height>0 &&
          css.display!=="none"&&css.visibility!=="hidden";
      };
      const nameLabel=/^(?:Название|Полное название|Наименование|Полное наименование|Юридическое наименование|Наименование организации|Краткое наименование|Сокращенное наименование)$/iu;
      const inlineLabel=/^(Название|Полное название|Наименование|Полное наименование|Юридическое наименование|Наименование организации|Краткое наименование|Сокращенное наименование)\s*[:：]\s*(.+)$/iu;
      const knownLabel=/^(?:ИНН|КПП|ОГРН|ОКПО|Название|Полное название|Полное наименование|Юридическое наименование|Наименование организации|Краткое наименование|Сокращенное наименование|Реквизиты|Регистрационные данные|О компании)$/iu;
      const exactInn=new RegExp("(?:^|\\D)"+inn+"(?!\\d)");
      const innLabel=new RegExp("(?:ИНН|INN)\\s*[:№#-]?\\s*"+inn+"(?!\\d)","i");
      const body=String(document.body?.innerText||"").slice(0,135000);
      const leaves=[...document.querySelectorAll("body *")].filter(el=>
        visible(el)&&el.children.length===0 &&
        compact(el.textContent).length<=240).slice(0,4000);
      const values=[],labels=[],sections=[];
      function pushValue(label,candidate,context,el) {
        const parent=el.parentElement;
        const parentText=String(parent?.innerText||"").slice(0,1800);
        values.push({label,candidate:compact(candidate).slice(0,240),
          context,sameInnBlock:innLabel.test(parentText)});
      }
      for(const el of leaves) {
        const text=compact(el.textContent);
        if(knownLabel.test(text)){
          labels.push(text);
          if(/^(?:Реквизиты|Регистрационные данные|О компании)$/iu.test(text))
            sections.push(text);
        }
        const inline=inlineLabel.exec(text);
        if(inline) {
          labels.push(inline[1]);
          pushValue(inline[1],inline[2],"same_row",el);
        }
        if(!nameLabel.test(text))continue;
        const sibling=el.nextElementSibling;
        if(sibling&&visible(sibling))
          pushValue(text,String(sibling.innerText||"").slice(0,240),"sibling",el);
        const parent=el.parentElement;
        if(!parent || !visible(parent))continue;
        const raw=String(parent.innerText||"").slice(0,850);
        const lines=raw.split(/[\r\n]+/).map(compact).filter(Boolean);
        const index=lines.findIndex(x=>x===text);
        if(index>=0&&index+1<lines.length)
          pushValue(text,lines[index+1],"adjacent_line",el);
      }
      const tabs=[...document.querySelectorAll(
        '[role="tab"],button,a'
      )].filter(visible).slice(0,400);
      return {
        values:values.slice(0,30),
        labels:labels.slice(0,40),
        sections:sections.slice(0,20),
        exactInnVisible:exactInn.test(body),
        labelledInnVisible:innLabel.test(body.replace(/\s+/g," ")),
        labelledKppVisible:/(?:^|\s)КПП(?:\s*[:№#-]|\s+\d{9})/iu.test(body),
        requisiteTabVisible:tabs.some(x=>compact(x.innerText)==="Реквизиты")
      };
    },inn);
  } catch {
    return {reason:"dom_probe_unavailable",candidates:[],labels:[],sections:[]};
  }
  return summarizeSabyNameEvidence(snapshot,inn);
}
