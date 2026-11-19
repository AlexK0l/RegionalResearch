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
  const scale=match[2]||compact(defaultScale).match(/(?:млрд|млн|тыс)(?=\s|₽|$)/iu)?.[0]||"";
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
  const yearSet=years.filter(Boolean);
  let revenueRub=null,revenueYear=null;
  // Year columns MUST align one-for-one with amounts. Do not infer years
  // from unrelated chart axis ticks or general "2016-2025" body text.
  if(years.length>0&&yearSet.length===years.length &&
     yearSet.length===new Set(yearSet).size && lines.length===1){
    const cells=lines[0];
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
    if(!validRevenue(bannerRub) ||
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
export async function readSabyFinancials(page){
  const snapshot=await page.evaluate(() => {
    const text=el=>(el?.textContent||"").replace(/\s+/gu," ").trim();
    const visible=el=>Boolean(el&&el.isConnected&&el.getClientRects().length);
    const employees=[...document.querySelectorAll('[data-qa="ContractorCard_Employees"]')]
      .filter(el=>visible(el)&&/сотрудник/iu.test(
        text(el.closest(".contractor-Employees__hovered")||el.parentElement)))
      .map(text);
    const revenueWidgets=[...document.querySelectorAll(
      '[data-qa="contractorCard-CardRatingBanner__Revenue"]')]
      .filter(visible).map(text);
    // Conflicting duplicate banners are not evidence.
    const banner=revenueWidgets.length===1?revenueWidgets[0]:"";
    const headings=[...document.querySelectorAll('[data-qa="analytics-finanalysis"]')]
      .filter(el=>visible(el)&&/^Выручка\s*\/\s*Финансы$/iu.test(text(el)));
    const report=headings.length===1?
      headings[0].closest(".analytics-FinAnalysis__margin"):null;
    const years=report?[...report.querySelectorAll(
      ".analytics-FinAnalysis__stickerHeader_right")]
      .map(text).filter(value=>/^(?:19|20)\d\d$/.test(value)):[];
    const reportScale=report?text(report.querySelector(
      ".analytics-FinAnalysis__stickerHeader_left")):"";
    const revenueRows=[];
    if(report){
      for(const row of report.querySelectorAll('[data-qa="row"]')){
        if(!visible(row))continue;
        const cells=[...row.querySelectorAll(':scope > [data-qa="cell"]')]
          .map(text);
        const label=cells.slice(0,2).join(" ");
        // "Доходы" = 2110 + 2320 etc and MUST NOT be treated
        // as revenue; expenses, assets and owner value are excluded.
        if(/^От основной деятельности(?:\s|$)/iu.test(label)||
           (/^Выручка(?:\s|$)/iu.test(cells[0]||"")&&
             /^2110(?:\s|$)/u.test(cells[1]||""))){
          revenueRows.push(cells.slice(2));
        }
      }
    }
    return {employeeTexts:employees,banner,years,reportScale,revenueRows};
  });
  return parseSabyFinancialSnapshot(snapshot);
}
