// Two independent financial indicators from the SAME already-verified Saby
// company card. No additional searches, tabs, external APIs or OpenAI.
// The page DOM is inspected only after openCompany() verified legal identity.
// This intentionally ignores financial widgets of related legal entities.
const YEAR_MIN=1995;
const MAX_REVENUE_RUB=1e15;
const EMPLOYEES_LIMIT=10000000;
const MONEY_PATTERN=/^([+]?\d[\d \u00a0\u202f]*(?:[.,]\d+)?)\s*(млрд|млн|тыс)?\s*(?:₽|руб(?:лей|ля|\.?)?)?$/iu;
const REVENUE_LABEL=/^Выручка\s*:\s*/iu;

const compact=value=>String(value??"").replace(/\s+/gu," ").trim();

export function parseSabyMoneyRub(value,defaultScale=""){
  const raw=compact(value).replace(REVENUE_LABEL,"");
  const match=MONEY_PATTERN.exec(raw);
  if(!match)return null;
  const local=match[1].replace(/[\s\u00a0\u202f]/gu,"").replace(",",".");
  if(!/^\d+(?:\.\d+)?$/.test(local))return null;
  const amount=Number(local);
  if(!Number.isFinite(amount)||amount<0)return null;
  const scale=(match[2]||compact(defaultScale).match(/(?:млрд|млн|тыс)(?=\s|₽|$)/iu)?.[0]||"").toLowerCase();
  const multiplier=scale==="млрд"?1e9:scale==="млн"?1e6:scale==="тыс"?1e3:1;
  const rub=Math.round(amount*multiplier);
  return Number.isSafeInteger(rub)&&rub>=0&&rub<=MAX_REVENUE_RUB?rub:null;
}

function validRevenue(value){
  return Number.isSafeInteger(value)&&value>0&&value<=MAX_REVENUE_RUB;
}
function validStaff(value){
  return Number.isSafeInteger(value)&&value>=0&&value<=EMPLOYEES_LIMIT;
}
function fiscalYear(value,nowYear=new Date().getUTCFullYear()){
  const year=Number(value);
  return Number.isInteger(year)&&year>=YEAR_MIN&&year<=nowYear?year:null;
}
function extractStaff(snapshot){
  if(!Array.isArray(snapshot?.employeeTexts))return null;
  const values=snapshot.employeeTexts.map(text=>compact(text))
    .filter(text=>/^\d[\d \u00a0\u202f]*$/.test(text))
    .map(text=>Number(text.replace(/[\s\u00a0\u202f]/gu,"")))
    .filter(validStaff);
  if(!values.length||new Set(values).size!==1)return null;
  return values[0];
}

/**
 * Only two explicitly labelled widgets:
 * - annual revenue: financial "От основной деятельности" (or "Выручка")
 *   row, aligned with year header; "Выручка" banner cross-checks value;
 * - employee count: ContractorCard_Employees element inside the section
 *   explicitly labelled "сотрудников", never the salary widget.
 */
export function parseSabyFinancialSnapshot(snapshot,{nowYear=new Date().getUTCFullYear()}={}){
  const employees=extractStaff(snapshot);
  const years=Array.isArray(snapshot?.years)?
    snapshot.years.map(y=>fiscalYear(y,nowYear)):[];
  const lines=Array.isArray(snapshot?.revenueRows)?snapshot.revenueRows:[];
  // Sticky and scrolled finance tables can render the same 2110 row twice.
  // Identical copies are one fact; conflicting amounts remain ambiguous.
  const uniqueRows=[...new Map(lines.filter(Array.isArray)
    .map(row=>[JSON.stringify(row),row])).values()];
  const yearSet=years.filter(Boolean);
  let revenueRub=null,revenueYear=null;
  // Year columns MUST align one-for-one with amounts. Do not infer years
  // from unrelated chart axis ticks or general "2016-2025" body text.
  if(years.length>0&&yearSet.length===years.length &&
     yearSet.length===new Set(yearSet).size && uniqueRows.length===1){
    const cells=uniqueRows[0];
    if(Array.isArray(cells)&&cells.length===years.length){
      const options=years.map((year,i)=>({
        year,value:parseSabyMoneyRub(cells[i],snapshot?.reportScale)
      })).filter(x=>validRevenue(x.value))
        .sort((a,b)=>b.year-a.year);
      if(options.length){
        revenueRub=options[0].value;
        revenueYear=options[0].year;
      }
    }
  }
  // Saby can render a stale or wrong-company banner during SPA transition:
  // if it conflicts materially with the year-table source, drop revenue.
  const banner=compact(snapshot?.banner);
  if(revenueRub!==null&&banner){
    const bannerRub=parseSabyMoneyRub(banner);
    // A banner may contain growth or other text; only a parsable,
    // unequivocal monetary banner is eligible to contradict the year row.
    if(validRevenue(bannerRub) &&
       Math.abs(bannerRub-revenueRub)>
         Math.max(100000,Math.round(revenueRub*0.01))){
      revenueRub=null;
      revenueYear=null;
    }
  }
  const hasRevenue=validRevenue(revenueRub)&&fiscalYear(revenueYear,nowYear)!==null;
  const hasEmployees=validStaff(employees);
  return {
    status:hasRevenue||hasEmployees?"collected":"missing",
    revenue_rub:hasRevenue?revenueRub:null,
    revenue_year:hasRevenue?revenueYear:null,
    employees:hasEmployees?employees:null
  };
}

export function validSabyFinancialEvidence(data){
  if(!data || typeof data!=="object" || data.status!=="collected")return null;
  const year=fiscalYear(data.revenue_year);
  const revenue=validRevenue(data.revenue_rub)&&year!==null?
    {revenue_rub:data.revenue_rub,revenue_year:year}:null;
  const staff=validStaff(data.employees)?{employees:data.employees}:null;
  if(!revenue&&!staff)return null;
  return {status:"collected",...revenue,...staff};
}

/**
 * Bounded read of current, visible first-party profile DOM. No interaction
 * with Saby, no browser state changes. All selectors come from the attached
 * 2026-11-19 HTML card; financial year is paired with the table revenue row.
 */
let financeMissingDiagnostics=0;

// Saby's contractor card uses an internal scroll viewer and may not mount
// its bottom "finance" item until the user scrolls the verified detail card.
// A normal DOM/polling read then reports no_heading despite an available
// annual table. Scroll ONLY the existing contractor viewer, never the list,
// a linked counterparty, or an external page, and restore its position.
//
// This is a bounded attempt, not a claim that every firm has revenue. We
// never use the banner alone to invent a fiscal year or amount.
async function revealLazySabyFinance(page,inspect){
  const diag={scroller:"unavailable",scroll_steps:0,finance_item:false,
    selection:"none",lookup_attempts:0,scroll_retries:0,
    scroll_reacquired:false};
  if(typeof page?.locator!=="function")return {snapshot:null,diag};
  // The user's captured Saby detail HTML places its main scroll node at
  // [data-qa=contractorCard-dialog-Stack] >
  //   ... .controls-SlidingPanel__scrollWrapper >
  //   [data-qa=controls-Scroll__content].
  // Do not filter by .contractor-BaseInfoView: that nested widget may be
  // unmounted until this main scroll viewer is moved, which made the old
  // locator unavailable precisely when finance was lazy-loaded.
  const choices=[
    ['profile_scroll',
      '[data-qa="contractorCard-dialog-Stack"] '+
      '.controls-SlidingPanel__scrollWrapper > '+
      '[data-qa="controls-Scroll__content"]'],
    ['dialog_scroll',
      '[data-qa="contractorCard-dialog-Stack"] '+
      '[data-qa="controls-Scroll__content"]']
  ];
  const wait=ms=>typeof page.waitForTimeout==="function"?
    page.waitForTimeout(ms):new Promise(resolve=>setTimeout(resolve,ms));
  let scroller=null,original=null,item=null;
  // A mounted employee badge does not guarantee that the scroll wrapper has
  // hydrated yet. Two bounded attempts; never inspect the global body scroller.
  for(let attempt=0;attempt<2&&!scroller;attempt++){
    diag.lookup_attempts++;
    for(const [selection,selector] of choices){
      try{
        const candidate=page.locator(selector).first();
        const position=await candidate.evaluate(el=>({
          top:el.scrollTop,
          max:Math.max(0,el.scrollHeight-el.clientHeight)
        }),undefined,{timeout:2200});
        if(!Number.isFinite(position?.top)||!Number.isFinite(position?.max))
          continue;
        scroller=candidate;
        original=position;
        diag.scroller=position.max>20?"scrollable":"static";
        diag.selection=selection;
        break;
      }catch{
        // A missing/virtualized wrapper is not a reason to scroll a
        // different company's page or an unscoped document element.
      }
    }
    if(!scroller&&attempt===0)await wait(450);
  }
  if(!scroller)return {snapshot:null,diag};
  try{
    item=page.locator('[data-qa="item"][item-key="finance"]').first();
  }catch{
    return {snapshot:null,diag};
  }
  let snapshot=null;
  // Scrolling Wasaby can temporarily detach its own scroll wrapper, even
  // while the company card and strict ID remain unchanged. Re-select ONLY
  // the same scoped wrapper once. Do not open any card or use body.scrollTop.
  const moveWithinCard=async fraction=>{
    const targetSelector=choices.find(([name])=>name===diag.selection)?.[1];
    const move=locator=>locator.evaluate((el,part)=>{
      const max=Math.max(0,el.scrollHeight-el.clientHeight);
      el.scrollTop=Math.round(max*part);
    },fraction,{timeout:1800});
    try{
      await move(scroller);
      return true;
    }catch{
      if(!targetSelector)return false;
      diag.scroll_retries++;
      await wait(400);
      try{
        const replacement=page.locator(targetSelector).first();
        const geometry=await replacement.evaluate(el=>({
          max:Math.max(0,el.scrollHeight-el.clientHeight),
          mounted:el.isConnected!==false
        }),undefined,{timeout:1800});
        if(!geometry?.mounted||!Number.isFinite(geometry.max)||
           geometry.max<=20)return false;
        await move(replacement);
        scroller=replacement;
        diag.scroll_reacquired=true;
        return true;
      }catch{return false;}
    }
  };
  try {
    // A mounted item can be brought into view directly. When virtualization
    // has not yet mounted it, sweep a few positions through the card scroller.
    // No arbitrary document.body scroll and no clicks on unrelated panels.
    for(const fraction of [0.5,1,0.75,0.25]){
      let moved=false;
      if(diag.scroll_steps===0 && await item.count().catch(()=>0)>0){
        diag.finance_item=true;
        try{
          await item.scrollIntoViewIfNeeded({timeout:1800});
          moved=true;
        }catch{
          // A detached/hidden virtual item may need a scroll sweep instead.
        }
      }
      if(!moved){
        if(original.max<=20)break;
        if(!await moveWithinCard(fraction)){
          diag.scroller="scroll_failed";
          break;
        }
      }
      diag.scroll_steps++;
      await wait(550);
      try{snapshot=await inspect();}
      catch{break;}
      if(snapshot?.financeHeadings>0 && snapshot?.years?.length>0 &&
         snapshot?.revenueRows?.length>0)break;
    }
  }finally{
    // Wasaby may replace the scroll node while mounting the finance panel.
    // Restore on the original locator, then reacquire the SAME verified
    // dialog scroll node if it detached. Never touch document.body.
    try{
      await scroller.evaluate((el,top)=>{el.scrollTop=top;},original.top,
        {timeout:1500});
    }catch{
      try{
        const scoped=choices.find(([key])=>key===diag.selection)?.[1];
        if(!scoped)throw Error("scoped_scroller_missing");
        await page.locator(scoped).first().evaluate(
          (el,top)=>{el.scrollTop=top;},original.top,{timeout:1500});
        diag.scroll_restore="reacquired";
      }catch{
        diag.scroll_restore="not_restored";
      }
    }
  }
  return {snapshot,diag};
}

// Re-read only the already-verified card. A bounded in-card scroll is allowed
// when Saby has not yet mounted the bottom finance section; no new search.
export async function readSabyFinancials(page,{visibleOnly=false,needsRevenue=true}={}){
  const inspect=()=>page.evaluate(() => {
    const text=el=>(el?.textContent||"").replace(/\s+/gu," ").trim();
    const visible=el=>Boolean(el&&el.isConnected&&el.getClientRects().length);
    const employees=[...document.querySelectorAll('[data-qa="ContractorCard_Employees"]')]
      .filter(el=>visible(el)&&/сотрудник/iu.test(
        text(el.closest?.(".contractor-Employees__hovered")||el.parentElement)))
      .map(text);
    const revenueWidgets=[...document.querySelectorAll(
      '[data-qa="contractorCard-CardRatingBanner__Revenue"]')]
      .filter(visible).map(text);
    const banner=revenueWidgets.length===1?revenueWidgets[0]:"";

    // "analytics-finanalysis" can wrap an entire widget; its textContent
    // then contains labels, years and figures, not only the heading.
    const financeNodes=[...document.querySelectorAll('[data-qa="analytics-finanalysis"]')];
    const headings=financeNodes
      .filter(el=>visible(el)&&/Выручк\p{L}*\s*\/\s*Финанс/iu.test(text(el)));
    const containers=headings.map(heading=>
      heading.closest?.(".analytics-FinAnalysis__margin") ||
      heading.querySelector?.(".analytics-FinAnalysis__margin") ||
      heading.parentElement?.querySelector?.(".analytics-FinAnalysis__margin") ||
      (heading.querySelectorAll?.('[data-qa="row"]').length?heading:null)
    ).filter(Boolean);
    // The visible heading already anchors this exact financial container;
    // a container may not itself expose a layout rectangle in Saby.
    const distinct=[...new Set(containers)];
    const report=distinct.length===1?distinct[0]:null;

    // Year headers are the only valid year source. A year in a tooltip,
    // date of registration, footer or unrelated graph must never be used.
    const headers=report?[...report.querySelectorAll(
      ".analytics-FinAnalysis__stickerHeader_right")].filter(visible):[];
    const leaves=headers.filter(header=>
      !headers.some(other=>other!==header&&header.contains?.(other)));
    const years=leaves.flatMap(el=>
      [...text(el).matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/gu)].map(m=>m[0]));
    const reportScale=report?text(report.querySelector?.(
      ".analytics-FinAnalysis__stickerHeader_left")):"";

    const revenueRows=[];
    if(report&&years.length){
      const rows=[...report.querySelectorAll('[data-qa="row"]')];
      for(const row of rows){
        // Saby GridReact renders rows with CSS display: contents (tw-contents).
        // Such rows have zero client rects even when their cells are visible;
        // requiring visible(row) silently dropped ALL revenue rows.
        if(!row.isConnected)continue;
        const cells=[...row.querySelectorAll('[data-qa="cell"]')]
          .filter(el=>visible(el)&&
            (!el.closest?.('[data-qa="row"]')||
              el.closest('[data-qa="row"]')===row))
          .map(text);
        if(!cells.length)continue;
        // One to three descriptor cells precede exactly one value for
        // each year. Never shift amounts into a different accounting year.
        const labelCount=cells.length-years.length;
        if(labelCount<1||labelCount>3)continue;
        const descriptors=cells.slice(0,labelCount);
        const label=descriptors.join(" ");
        const primary=/^От\s+основной\s+деятельности(?:\s|$)/iu.test(label);
        const line2110=/(?:^|\D)2110(?!\d)/u.test(label);
        const revenue=/^Выручка(?:\s|$)/iu.test(label)&&
          !/\/|рост|динамик|процент|изменени/iu.test(label)&&
          (line2110||labelCount===1);
        if(primary||revenue)revenueRows.push(cells.slice(labelCount));
      }
    }
    return {employeeTexts:employees,banner,years,reportScale,revenueRows,
      financeHeadings:headings.length,financeNodes:financeNodes.length,
      financeItemMounted:document.querySelectorAll(
        '[data-qa="item"][item-key="finance"]').length>0,
      dialogRoots:document.querySelectorAll(
        '[data-qa="contractorCard-dialog-Stack"]').length,
      profileScrollNodes:document.querySelectorAll(
        '[data-qa="contractorCard-dialog-Stack"] '+
        '.controls-SlidingPanel__scrollWrapper > '+
        '[data-qa="controls-Scroll__content"]').length,
      dialogScrollNodes:document.querySelectorAll(
        '[data-qa="contractorCard-dialog-Stack"] '+
        '[data-qa="controls-Scroll__content"]').length,
      reportFound:Boolean(report)};
  });

  let snapshot=await inspect();
  let result=parseSabyFinancialSnapshot(snapshot);
  // The employee badge is often above the lazy finance section; preserve
  // this verified observation while Saby unmounts it during scroll.
  const initialEmployees=result.employees;
  // Opportunistic read on the contact card: one DOM snapshot, no passive
  // waits, clicks, lazy mounting or finance diagnostic. Any missing fact
  // remains a gap for the original full-details pass.
  if(visibleOnly||(!needsRevenue&&initialEmployees!==null))return result;
  // Saby is a SPA: the year grid can hydrate after the already visible
  // employees badge. Small bounded DOM retries do NOT revisit the company.
  for(let attempt=0;attempt<2&&!result.revenue_rub&&
      (snapshot.employeeTexts?.length>0||snapshot.financeHeadings>0||
       snapshot.reportFound||snapshot.banner);attempt++){
    if(typeof page.waitForTimeout==="function")await page.waitForTimeout(350);
    else await new Promise(resolve=>setTimeout(resolve,350));
    snapshot=await inspect();
    result=parseSabyFinancialSnapshot(snapshot);
  }
  // A visible employee badge does not mean the bottom finance card
  // is mounted. Try the verified company's own bounded scroll viewer.
  let lazyDiag={scroller:"not_needed",scroll_steps:0,finance_item:false};
  if(result.revenue_rub===null && !snapshot.financeHeadings){
    const attempted=await revealLazySabyFinance(page,inspect);
    lazyDiag=attempted.diag;
    if(attempted.snapshot){
      snapshot=attempted.snapshot;
      result=parseSabyFinancialSnapshot(snapshot);
    }
  }
  if(initialEmployees!==null&&result.employees===null){
    result={...result,status:"collected",employees:initialEmployees};
  }
  if(result.revenue_rub===null&&financeMissingDiagnostics<12){
    financeMissingDiagnostics++;
    const code=!snapshot.financeHeadings?
        (snapshot.financeNodes?"heading_hidden":"no_heading"):
      !snapshot.reportFound?"no_report":
      !snapshot.years.length?"no_years":
      !snapshot.revenueRows.length?"no_2110_row":"year_value_or_banner_mismatch";
    // Counts/flags only: no company name, INN, URL, DOM, session data.
    console.warn("[SABY_FINANCIAL_DIAG] "+JSON.stringify({
      code,years:snapshot.years.length,rows:snapshot.revenueRows.length,
      finance_nodes:snapshot.financeNodes||0,
      finance_item:!!snapshot.financeItemMounted,
      dialog_roots:snapshot.dialogRoots||0,
      profile_scroll_nodes:snapshot.profileScrollNodes||0,
      dialog_scroll_nodes:snapshot.dialogScrollNodes||0,
      scroll:lazyDiag.scroller,scroll_steps:lazyDiag.scroll_steps,
      scroll_selection:lazyDiag.selection||"none",
      scroll_lookup_attempts:lazyDiag.lookup_attempts||0,
      scroll_retries:lazyDiag.scroll_retries||0,
      scroll_reacquired:lazyDiag.scroll_reacquired===true,
      scroll_restore:lazyDiag.scroll_restore||"original"
    }));
  }
  return result;
}
