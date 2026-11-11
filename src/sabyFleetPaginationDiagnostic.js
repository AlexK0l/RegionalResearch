// Read-only first-party Saby fleet pagination inspection. Never return raw
// text, URLs, company identifiers, phone numbers, models, DOM or CSS selectors.
// A missing pagination control is NOT proof that the reported fleet is empty.
import {sabyCardRoute} from "./sabyCard.js";

const count=(v,cap=120)=>typeof v==="number"&&
  Number.isSafeInteger(v)&&v>=0?Math.min(v,cap):null;

export function safeSabyFleetPaginationSignals(raw={}) {
  const status=["observed","panel_not_found","unavailable","not_detail"]
    .includes(raw?.status)?raw.status:"unavailable";
  return {
    status,
    panel_matches:count(raw?.panel_matches,16),
    controls_total:count(raw?.controls_total),
    controls_in_truck_section:count(raw?.controls_in_truck_section),
    controls_in_panel_footer:count(raw?.controls_in_panel_footer),
    unlabeled_controls:count(raw?.unlabeled_controls),
    show_more_controls:count(raw?.show_more_controls),
    load_more_controls:count(raw?.load_more_controls),
    next_page_controls:count(raw?.next_page_controls),
    disabled_next_controls:count(raw?.disabled_next_controls),
    numbered_page_controls:count(raw?.numbered_page_controls),
    page_current_markers:count(raw?.page_current_markers),
    navigation_landmarks:count(raw?.navigation_landmarks),
    range_indicators:count(raw?.range_indicators),
    page_indicators:count(raw?.page_indicators),
    ellipsis_indicators:count(raw?.ellipsis_indicators),
    load_more_text_leaves:count(raw?.load_more_text_leaves),
    loading_indicators:count(raw?.loading_indicators),
    is_at_truck_scroller_end:raw?.is_at_truck_scroller_end===true
  };
}

export async function observeSabyFleetPagination(page,{expected}={}) {
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000 ||
     sabyCardRoute(page?.url?.())!=="detail")
    return safeSabyFleetPaginationSignals({status:"not_detail"});
  try {
    const raw=await page.evaluate(({expected})=>{
      const clean=s=>String(s||"").replace(/\s+/g," ").trim();
      const visible=e=>{
        if(!e||typeof e.getBoundingClientRect!=="function")return false;
        const r=e.getBoundingClientRect(),s=getComputedStyle(e);
        return r.width>0&&r.height>0&&s.visibility!=="hidden"&&
          s.display!=="none";
      };
      const cats=/^(Легковые|Коммерческие|Грузовые|Автобусы|Спецтехника|Прицепы|Мотоциклы)(?:\s+\d+)?$/i;
      const all=[...document.querySelectorAll("body *")];
      const headingLeaves=all.filter(e=>visible(e)&&e.children.length===0&&
        clean(e.textContent)==="Автопарк");
      const candidates=[];
      for(const heading of headingLeaves){
        let node=heading;
        for(let depth=0;node&&depth<12;depth++,node=node.parentElement){
          const r=node.getBoundingClientRect(),t=node.innerText||"";
          if(r.width<250||r.height<180||r.right<innerWidth*.60||
             t.length>26000||!t.includes("Грузовые"))continue;
          const categoryLeaves=[...node.querySelectorAll("*")]
            .filter(e=>visible(e)&&e.children.length===0&&
              cats.test(clean(e.textContent)));
          const truck=categoryLeaves.find(e=>
            /^Грузовые(?:\s+\d+)?$/i.test(clean(e.textContent)));
          if(!truck)continue;
          const label=(clean(truck.textContent)+" "+
            clean(truck.parentElement?.innerText));
          if(!label.match(new RegExp("Грузовые\\s*"+expected+"(?:\\D|$)","i")))
            continue;
          candidates.push({panel:node,truck,categoryLeaves,
            area:r.width*r.height});
        }
      }
      candidates.sort((a,b)=>a.area-b.area);
      if(!candidates.length)
        return {status:"panel_not_found",panel_matches:0};
      const {panel,truck,categoryLeaves}=candidates[0];
      const next=categoryLeaves.slice(categoryLeaves.indexOf(truck)+1)[0];
      const panelRect=panel.getBoundingClientRect();
      const footerTop=panelRect.bottom-
        Math.max(70,Math.min(220,panelRect.height*.25));
      const inTruckSection=e=>{
        if(!(truck.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING))
          return false;
        return !next||Boolean(e.compareDocumentPosition(next)&
          Node.DOCUMENT_POSITION_FOLLOWING);
      };
      const controls=[...new Set(panel.querySelectorAll(
        'button,a,[role="button"],[role="link"],[role="tab"],'+
        '[rel="next"],[aria-label],[title],[aria-current],'+
        'input[type="button"]'))].filter(visible);
      const more=/^(?:Показать|Загрузить)(?:\s+(?:ещё|еще|все|остальные|больше))?(?:\s+\d+)?(?:\s+(?:записей|строк|автомобилей|машин))?$/iu;
      const load=/^(?:Загрузить(?:\s+(?:ещё|еще|все|больше))?|Показать\s+(?:ещё|еще|все|остальные)|(?:Ещё|Еще)\s+\d+)$/iu;
      const nextPage=/^(?:Следующая(?:\s+страница)?|Следующую\s+страницу|Далее|Вперёд|Вперед|Next(?:\s+page)?|›|»|→|>)$/iu;
      const pageNumber=/^\d{1,3}$/;
      const range=/^(?:(?:Показано|Записи|Показаны)\s*)?\d{1,5}\s*[-–—]\s*\d{1,5}\s*(?:из|of|\/)\s*\d{1,5}$/iu;
      const page=/^(?:Страница\s*)?\d{1,3}\s*(?:из|of|\/)\s*\d{1,3}(?:\s+страниц?)?$/iu;
      let unlabeled_controls=0,show_more_controls=0,load_more_controls=0;
      let next_page_controls=0,disabled_next_controls=0,numbered_page_controls=0;
      let page_current_markers=0;
      for(const c of controls){
        const texts=[c.getAttribute("aria-label"),c.getAttribute("title"),
          c.textContent].map(clean).filter(x=>x.length&&x.length<=90);
        if(!texts.length)unlabeled_controls++;
        const disabled=Boolean(c.disabled)||
          c.getAttribute("aria-disabled")==="true";
        if(texts.some(t=>more.test(t)))show_more_controls++;
        if(texts.some(t=>load.test(t)))load_more_controls++;
        if(texts.some(t=>nextPage.test(t))||
           c.getAttribute("rel")==="next"){
          next_page_controls++;
          if(disabled)disabled_next_controls++;
        }
        if(texts.some(t=>pageNumber.test(t))&&
           (c.getAttribute("aria-current")||
            /page/i.test(c.getAttribute("class")||"")))
          numbered_page_controls++;
        if(c.getAttribute("aria-current")==="page")page_current_markers++;
      }
      const visibleLeaves=[...panel.querySelectorAll("*")]
        .filter(e=>visible(e)&&e.children.length===0);
      const tail=visibleLeaves.filter(e=>inTruckSection(e)||
        e.getBoundingClientRect().top>=footerTop);
      const rangeIndicators=tail.filter(e=>range.test(clean(e.textContent)));
      const pageIndicators=tail.filter(e=>page.test(clean(e.textContent)));
      const ellipsis=tail.filter(e=>/^(?:…|\.{3})$/.test(clean(e.textContent)));
      const moreLeaves=tail.filter(e=>load.test(clean(e.textContent)));
      const busy=[...panel.querySelectorAll(
        '[role="progressbar"],[aria-busy="true"]')].filter(visible);
      const scrollers=[panel,...panel.querySelectorAll("*")].filter(e=>{
        const st=getComputedStyle(e);
        return visible(e)&&e.scrollHeight>e.clientHeight+15&&
          /(auto|scroll)/.test(st.overflowY);
      });
      const ownScroll=scrollers.filter(e=>e.contains(truck))
        .sort((a,b)=>a.getBoundingClientRect().height-
          b.getBoundingClientRect().height)[0];
      const atEnd=ownScroll?ownScroll.scrollHeight-ownScroll.clientHeight-
        ownScroll.scrollTop<=2:false;
      return {
        status:"observed",panel_matches:candidates.length,
        controls_total:controls.length,
        controls_in_truck_section:controls.filter(inTruckSection).length,
        controls_in_panel_footer:controls.filter(e=>
          e.getBoundingClientRect().top>=footerTop).length,
        unlabeled_controls,show_more_controls,load_more_controls,
        next_page_controls,disabled_next_controls,numbered_page_controls,
        page_current_markers,
        navigation_landmarks:[...panel.querySelectorAll(
          'nav,[role="navigation"],[aria-label*="страниц"],'+
          '[aria-label*="Страниц"]')].filter(visible).length,
        range_indicators:rangeIndicators.length,
        page_indicators:pageIndicators.length,
        ellipsis_indicators:ellipsis.length,
        load_more_text_leaves:moreLeaves.length,
        loading_indicators:busy.length,
        is_at_truck_scroller_end:atEnd
      };
    },{expected});
    return safeSabyFleetPaginationSignals(raw);
  }catch{
    return safeSabyFleetPaginationSignals({status:"unavailable"});
  }
}
