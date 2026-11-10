// Read-only, best-effort evidence capture for the whole source research.
// Does NOT call collectSabyCompany, mutate company rows, or treat INN-only
// search matches as verified identities. All raw DOM text stays in memory.
import {findSabyCompanySearch} from "./sabySearch.js";
import {findResultRows} from "./sabyBrowser.js";
import {sabyCardRoute} from "./sabyCard.js";
import {sabyInn} from "./sabyEnrichment.js";
import {
  auditExtractRequisites,auditLabelledInns,auditSelectSearchResult
} from "./sabyIdentityAudit.js";

const BASE="https://profile.saby.ru/page/company-list-prof";
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const titleExcluded=/^(?:компании|карточка компании|реквизиты|контакты|сведения|автопарк компании|основное|о компании|компания|справка|поиск|общая информация|все о компании|участие в торгах|надежность|связи)$/i;
export function auditPickTitle(headings) {
  const safe=(Array.isArray(headings)?headings:[])
    .map(x=>String(x||"").replace(/\s+/g," ").trim())
    .filter(x=>x.length>=3 && x.length<=200 && !titleExcluded.test(x));
  // A legal-form-marked heading is less likely to be a navigation section.
  const legal=/(?:^|\W)(?:ООО|ПАО|АО|ОАО|ЗАО|ИП)(?:\W|$)|(?:АКЦИОНЕРНОЕ\s+ОБЩЕСТВО|ОБЩЕСТВО\s+С\s+ОГРАНИЧЕННОЙ)/i;
  return safe.find(s=>legal.test(s))||safe[0]||"";
}
async function captureDetail(page) {
  const snapshot=await page.evaluate(()=>{
    const visible=el=>{
      if(!el)return false;
      const rect=el.getBoundingClientRect();
      const style=getComputedStyle(el);
      return rect.width>0 && rect.height>0 &&
        style.visibility!=="hidden" && style.display!=="none";
    };
    const compact=text=>String(text||"").replace(/\s+/g," ").trim();
    const candidates=[...document.querySelectorAll(
      '[class*="companyName" i],[class*="company-name" i],' +
      'h1,[role="heading"],h2,h3'
    )].filter(visible).slice(0,110);
    const headings=[...new Set(candidates.map(node=>
      compact((node.innerText||"").slice(0,350)))
      .filter(text=>text.length>=3&&text.length<=200))].slice(0,15);
    return {
      headings,
      // Full text is used ONLY within this browser call and subsequent
      // pure parsing. Never print or save raw body text, emails or phones.
      text:String(document.body?.innerText||"").slice(0,135000)
    };
  });
  return {
    title:auditPickTitle(snapshot.headings),
    headings:snapshot.headings,
    detailInns:auditLabelledInns(snapshot.text),
    requisites:auditExtractRequisites(snapshot.text)
  };
}
async function attemptRequisitesTab(page) {
  // Avoid clicking generic "Реквизиты" mentions embedded in descriptions.
  // Only an explicit, visible first-party link/tab/button may be opened.
  const controls=[
    page.getByRole("tab",{name:"Реквизиты",exact:true}),
    page.getByRole("button",{name:"Реквизиты",exact:true}),
    page.getByRole("link",{name:"Реквизиты",exact:true})
  ];
  for(const locator of controls){
    const count=Math.min(5,await locator.count().catch(()=>0));
    for(let i=0;i<count;i++){
      const tab=locator.nth(i);
      if(!await tab.isVisible().catch(()=>false))continue;
      await tab.click({timeout:3000}).catch(()=>{});
      if(sabyCardRoute(page.url())!=="detail")return false;
      await pause(750);
      return true;
    }
  }
  return false;
}
export async function auditSabyCompany(page,source,{
  searchTimeoutMs=14000,resultTimeoutMs=12000,cardTimeoutMs=13000
}={}) {
  const inn=sabyInn(source?.["ИНН"]);
  const name=String(source?.["Организация"]||"").trim();
  const obs={
    searchCount:0,searchName:"",searchNames:[],searchSelection:"",
    opened:false,title:"",headings:[],detailInns:[],
    requisites:[],route:"",requisitesSurface:"not_available",failure:""
  };
  if(!inn||!name)return obs;
  try {
    await page.goto(BASE,{waitUntil:"domcontentloaded",timeout:30000});
    if(!page.url().startsWith(BASE)){
      obs.failure="profile_search_unavailable";
      return obs;
    }
    const found=await findSabyCompanySearch(page,{timeoutMs:searchTimeoutMs});
    if(!found.field){
      obs.failure="company_search_field_missing";
      return obs;
    }
    await found.field.fill(inn);
    await found.field.press("Enter");
    let match={row:null,kind:"not_found",count:0,names:[]};
    const until=Date.now()+resultTimeoutMs;
    do {
      match=auditSelectSearchResult(await findResultRows(page,inn,{includeInnOnly:true}),inn,name);
      if(match.row || match.kind.startsWith("ambiguous"))break;
      await pause(450);
    } while(Date.now()<until);
    obs.searchCount=match.count;
    obs.searchNames=match.names.slice(0,12);
    obs.searchSelection=match.kind;
    if(!match.row)return obs;
    obs.searchName=match.names[0]||"";
    const rect=match.row.rect;
    await page.mouse.click(
      rect.x+Math.min(110,rect.w*0.25),
      rect.y+Math.min(24,rect.h*0.30)
    );
    const cardUntil=Date.now()+cardTimeoutMs;
    do {
      const route=sabyCardRoute(page.url());
      obs.route=route;
      if(route==="detail"){
        const detail=await captureDetail(page);
        if(detail.title || detail.detailInns.length || detail.requisites.length){
          obs.opened=true;
          Object.assign(obs,detail);
          obs.requisitesSurface=detail.requisites.length?"detail":"not_available";
          break;
        }
      }
      await pause(450);
    } while(Date.now()<cardUntil);
    if(!obs.opened){
      obs.failure="detail_did_not_render";
      return obs;
    }
    if(!obs.requisites.length && await attemptRequisitesTab(page)){
      const next=await captureDetail(page);
      if(next.requisites.length){
        obs.requisites=next.requisites;
        obs.requisitesSurface="requisites_tab";
      }
      if(next.detailInns.length)
        obs.detailInns=[...new Set([...obs.detailInns,...next.detailInns])];
    }
    return obs;
  } catch {
    // Playwright messages can include browser and account URLs; redact them.
    obs.failure="browser_page_error";
    return obs;
  }
}
