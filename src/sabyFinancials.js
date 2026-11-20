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

// Re-read only already-open, verified card DOM. No clicks or navigation.
// Some finance grids render after the employee badge or as nested cells.
export async function readSabyFinancials(page){
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
    const headings=[...document.querySelectorAll('[data-qa="analytics-finanalysis"]')]
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
        if(!visible(row))continue;
        // Real cards may nest data-qa cells under layout wrappers.
        const cells=[...row.querySelectorAll('[data-qa="cell"]')]
          .filter(el=>visible(el)&&
            (!el.closest?.('[data-qa="row"]')||
              el.closest('[data-qa="row"]')===row))
          .map(text);
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
      financeHeadings:headings.length,reportFound:Boolean(report)};
  });

  let snapshot=await inspect();
  let result=parseSabyFinancialSnapshot(snapshot);
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
  if(result.revenue_rub===null&&financeMissingDiagnostics<12){
    financeMissingDiagnostics++;
    const code=!snapshot.financeHeadings?"no_heading":
      !snapshot.reportFound?"no_report":
      !snapshot.years.length?"no_years":
      !snapshot.revenueRows.length?"no_2110_row":"year_value_or_banner_mismatch";
    // No company text, INN, URL, raw HTML, auth token or profile details.
    console.warn("[SABY_FINANCIAL_DIAG] "+JSON.stringify({
      code,years:snapshot.years.length,rows:snapshot.revenueRows.length
    }));
  }
  return result;
}
