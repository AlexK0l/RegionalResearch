// Official EGRUL public search. Read the responses produced by the normal
// visible search form. Never call an invented private endpoint, generate a
// challenge token, bypass CAPTCHA, or persist transient session identifiers.
import {verifiedInnChecksum} from "./sabyMissingInnRecovery.js";
import {normalizedOgrn} from "./legalIdentity.js";

const clean=v=>String(v??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const origin="https://egrul.nalog.ru";
const tokenPattern=/^[a-z0-9_-]{8,512}$/i;
const digit=(v,n)=>typeof v==="string"&&v.length===n&&/^\d+$/.test(v);
const fail=code=>Object.assign(Error(code),{code});
const asCount=v=>/^\d{1,7}$/.test(String(v??""))?Number(v):null;
const hasChallenge=v=>v===true||v===1||v==="true"||v==="1";
// The verified durable source is the form itself. The company-specific
// identity is stored in the proof, not an invented ?inn= deep link.
export const fnsSourceUrl=()=>origin+"/index.html";
export const isFnsSourceUrl=(url,inn)=>digit(inn,10)&&url===fnsSourceUrl(inn);
export function isFnsFormRoute(raw){
  try{
    const u=new URL(raw);
    return u.origin===origin&&!u.username&&!u.password&&!u.hash&&
      (u.pathname==="/"||u.pathname==="/index.html")&&!u.search;
  }catch{return false;}
}
function plain(value,max){
  if(typeof value!=="string"||value.length>max||/[<>]/u.test(value))return "";
  return clean(value);
}
// EGRUL can present the abbreviated name as "NAME ООО" instead of
// "ООО NAME". Normalize that explicit suffix only; do not add a legal form
// to a brand or infer one from an unrelated company.
function shortName(raw){
  const value=plain(raw,350);
  if(/^(?:ООО|АО|ПАО|ОАО|ЗАО|ГУП|МУП|ФГУП)(?=$|[\s«"])/iu.test(value))
    return value;
  return value.replace(/\s+(ООО|АО|ПАО|ОАО|ЗАО|ГУП|МУП|ФГУП)$/iu,", $1");
}
export function parseFnsSearchResult(payload,{query,exactName=false,completeNameSearch=false}={}){
  if(hasChallenge(payload?.captchaRequired)||hasChallenge(payload?.captcha))
    throw fail("fns_captcha_required");
  if(!Array.isArray(payload?.rows))return null;
  const raw=payload.rows;
  // A partial page may still prove an anchored exact INN/OGRN. It can
  // never establish that there is only one matching name and locality.
  const limited=raw.slice(0,100);
  const rows=[];
  for(const r of limited){
    if(!r||r.k!=="ul"||!digit(r.i,10)||!verifiedInnChecksum(r.i)||
      !digit(r.o,13)||normalizedOgrn(r.o)!==r.o||
      !digit(r.p,9))continue;
    const full=plain(r.n,500),short=shortName(r.c),address=plain(r.a,700);
    // Observed FNS 1.9.2 search response: a is absent/null even
    // for a complete legal-entity record. The address is a later
    // source-link proof, not a prerequisite for parsing identifiers.
    if(!full||!short)continue;
    if(/^\d{10}$/.test(query)&&r.i!==query)continue;
    if(/^\d{13}$/.test(query)&&r.o!==query)continue;
    // The search row is an official identification record, NOT a signed
    // extract or an assertion of current active status. A termination date
    // is a conflict; otherwise T-Bank must explicitly confirm activity.
    const termination=clean(r.e);
    const explicitInactive=!!termination||
      /прекращ|ликвидир|недействующ/iu.test(plain(r.status,200));
    rows.push({provider:"fns",url:fnsSourceUrl(r.i),record:{
      inn:r.i,kpp:r.p,ogrn:r.o,full_name:full,short_name:short,address,
      active:explicitInactive?false:null
    }});
  }
  // Live FNS 1.9.2 name searches (2026-11-24): 20 visible rows;
  // pg and possibly tot occur on the first row, not each record. Missing
  // metadata on subsequent rows is not a conflicting total. Explicit
  // invalid or inconsistent metadata, however, must fail closed.
  const totals=new Set(raw.filter(r=>r?.tot!==undefined).map(r=>asCount(r.tot)));
  const missingTotals=raw.filter(r=>r?.tot===undefined).length;
  const firstTotal=asCount(raw[0]?.tot),firstPageNumber=asCount(raw[0]?.pg);
  const distinctOgrns=new Set(rows.map(r=>r.record.ogrn)).size;
  const allRead=raw.length===rows.length&&raw.length<=100&&
    distinctOgrns===rows.length;
  const consistentTotal=totals.size===1&&totals.has(raw.length)&&firstTotal===raw.length;
  const firstPage=raw.every(r=>r?.pg===undefined||asCount(r.pg)===1);
  // Retain the former repeated-metadata proof. For sparse metadata,
  // require explicit page 1 and fewer than the observed 20-row boundary.
  // A capped first page, a nonnumeric/missing total or skipped record
  // can never establish uniqueness by name and locality.
  const sparseProof=missingTotals>0&&raw.length<20&&firstPageNumber===1&&
    raw.every(r=>r?.cnt===undefined||asCount(r.cnt)===raw.length);
  const countProven=raw.length>0&&consistentTotal&&
    (missingTotals===0||sparseProof);
  const complete=allRead&&countProven&&firstPage;
  // Fixed, count-only diagnostics; never log names, identifiers or tokens.
  const reportedTotal=totals.size===1?[...totals][0]:null;
  const completeness={raw_rows:raw.length,parsed_rows:rows.length,
    distinct_ogrns:distinctOgrns,reported_total:reportedTotal,
    total_proven:countProven,first_page_only:firstPage,
    missing_or_invalid_total_rows:raw.filter(r=>asCount(r?.tot)===null).length,
    missing_page_rows:raw.filter(r=>r?.pg===undefined).length,
    all_cards_read:allRead};
  const numeric=/^(?:\d{10}|\d{13})$/.test(query);
  return {state:"observed",provider:"fns",
    complete:complete&&(numeric||exactName===true||completeNameSearch===true),
    allCardsRead:allRead,records:rows,
    query_kind:numeric?"identifier":exactName?"exact_name":completeNameSearch?"complete_normal_name":"name",
    total_reported:countProven?raw.length:null,completeness};
}
// Region control in the actual public 1.9.2 form:
// input#region[name=region][data-dict=REGIONS][data-kind=SET].
// Operate only the visible widget, verify the selected value with FormData,
// and then correlate it with the submitted request. No invented region code.
function regionKey(s){
  return clean(s).toLowerCase().replace(/ё/g,"е").replace(/[^а-яa-z0-9]+/gu," ").trim();
}
export function fnsRegionLabelMatches(label,region){
  const expected=regionKey(region);
  if(!expected||expected.length<4||!/[а-я]/u.test(expected))return false;
  const actual=regionKey(label);
  return actual===expected||
    actual.replace(/^\d{2,3}\s+/u,"")===expected||
    actual.replace(/\s+\d{2,3}$/u,"")===expected;
}
async function selectFnsRegion(page,region){
  try{
    const input=page.locator('input#region[name="region"][data-dict="REGIONS"][data-kind="SET"]');
    const form=page.locator("form#frmSearch");
    if(await input.count()!==1||await form.count()!==1)return "";
    const read=()=>form.evaluate(el=>new FormData(el).getAll("region").map(String));
    const before=(await read()).filter(v=>v.trim());
    if(before.length)return "";
    if(await input.isVisible())await input.click({timeout:3000});
    else{
      const field=page.locator("div.form-field").filter({has:input});
      const trigger=field.locator('input:not([type="hidden"]),button,[role="button"],[role="combobox"]').filter({visible:true});
      if(await trigger.count()!==1)return "";
      await trigger.click({timeout:3000});
    }
    // Match the actual displayed dictionary label (possibly prefixed or
    // suffixed by its code), not a guessed value or a substring.
    const escape=s=>s.replace(/[.*+?^$\{\}()|[\]\\]/g,"\\$&");
    const label=clean(region).split(" ").map(escape).join("\\s+");
    const pattern=new RegExp("^(?:\\s*\\d{2,3}\\s*[-–—.:]?\\s*)?"+label+
      "(?:\\s*[-–—.:]?\\s*\\(?\\d{2,3}\\)?)?\\s*$","iu");
    const option=page.getByText(pattern).filter({visible:true});
    await option.first().waitFor({state:"visible",timeout:3000});
    if(await option.count()!==1)return "";
    const optionLabel=await option.innerText();
    if(!fnsRegionLabelMatches(optionLabel,region))return "";
    const normalizedLabel=regionKey(optionLabel);
    const visibleCode=normalizedLabel.match(/^\d{2,3}(?=\s)/u)?.[0]||
      normalizedLabel.match(/(?<=\s)\d{2,3}$/u)?.[0]||"";
    await option.click({timeout:3000});
    const values=(await read()).map(v=>v.trim()).filter(Boolean);
    // A SET widget can require an additional confirmation. If no single
    // exact selected field is submitted, abandon the scoped query.
    if(values.length!==1||!(/^\d{2,3}$/.test(values[0])||
      fnsRegionLabelMatches(values[0],region)))return "";
    if(visibleCode&&/^\d{2,3}$/.test(values[0])&&values[0]!==visibleCode)return "";
    return values[0];
  }catch{return "";}
}
function observedRequest(response,query,exactName,regionValue=""){
  try{
    const u=new URL(response.url()),req=response.request();
    if(u.origin!==origin||u.username||u.password||u.hash)return null;
    if(req.method()==="POST"&&(u.pathname==="/"||u.pathname==="/index.html")){
      const fields=new URLSearchParams(req.postData()||"");
      if(clean(fields.get("query"))!==query)return null;
      if(exactName&&!["on","true","1"].includes(fields.get("nameEq")))return null;
      const actual=fields.getAll("region").map(v=>v.trim()).filter(Boolean);
      return {kind:"submit",regionMatches:!regionValue||
        (actual.length===1&&actual[0]===regionValue)};
    }
    if(req.method()==="GET"){
      const m=/^\/search-result\/([a-z0-9_-]{8,512})$/i.exec(u.pathname);
      if(m)return {kind:"result",token:m[1]};
    }
  }catch{}
  return null;
}
export async function lookupFnsViaBrowser(page,{query,navigate,readBody,completeNameSearch=false,region=""}){
  query=clean(query);
  if(!query||query.length>250)throw fail("fns_invalid_query");
  const exactName=!completeNameSearch&&!/^(?:\d{10}|\d{13})$/.test(query);
  // The root HTTPS URL can return a 307 downgrade to HTTP. The VPS
  // cannot reach that HTTP endpoint, while the direct HTTPS form returns
  // 200. Start on the canonical form; never follow a downgrade on purpose.
  const ok=await navigate(origin+"/index.html",isFnsFormRoute);
  if(!ok)throw fail("registry_http_unavailable");
  await readBody(isFnsFormRoute);
  // Verified on the actual VPS FNS 1.9.2 UI: the button is displayed
  // as "НАЙТИ" and the native exact-name input is visually hidden.
  // Use the observed stable identifiers, not case-sensitive visible text.
  const input=page.locator('input#query[name="query"][type="text"]');
  const submit=page.locator('button#btnSearch[type="submit"]');
  let formStage="fns_query_input_unavailable";
  try{
    await input.waitFor({state:"visible",timeout:10000});
    if(await input.count()!==1||!await input.isEnabled())
      throw fail(formStage);
    formStage="fns_submit_button_unavailable";
    await submit.waitFor({state:"visible",timeout:10000});
    if(await submit.count()!==1||!await submit.isEnabled())
      throw fail(formStage);
    formStage="fns_query_not_set";
    await input.fill(query);
    if(clean(await input.inputValue())!==query)throw fail(formStage);
    if(exactName){
      formStage="fns_exact_checkbox_unavailable";
      const checkbox=page.locator('input#nameEq[name="nameEq"][type="checkbox"]');
      if(await checkbox.count()!==1||!await checkbox.isEnabled())
        throw fail(formStage);
      formStage="fns_exact_checkbox_not_selected";
      if(!await checkbox.isChecked()){
        if(await checkbox.isVisible()){
          await checkbox.check({timeout:5000});
        }else{
          // Use an ordinary user-facing label click for a CSS-styled
          // hidden native input. Never set checked through DOM mutation,
          // force-click the hidden input, or fabricate form parameters.
          const label=page.locator('label[for="nameEq"], label:has(input#nameEq)').filter({visible:true});
          if(await label.count()===1){
            await label.click({timeout:5000});
          }else{
            const text=page.getByText("Искать по точному соответствию наименования юридического лица или фамилии, имени и отчеству",{exact:true});
            if(await text.count()!==1||!await text.isVisible())
              throw fail(formStage);
            await text.click({timeout:5000});
          }
        }
      }
      if(!await checkbox.isChecked())throw fail(formStage);
    }
    formStage="fns_query_not_set";
    if(clean(await input.inputValue())!==query)throw fail(formStage);
  }catch{
    throw fail(formStage);
  }
  let regionValue="";
  if(region){
    if(!completeNameSearch||/^(?:\d{10}|\d{13})$/.test(query))
      throw fail("fns_region_filter_unavailable");
    regionValue=await selectFnsRegion(page,region);
    if(!regionValue)throw fail("fns_region_filter_unavailable");
  }
  let token="",fault="",submitSeen=false;
  const responses=new Map();
  let closed=false;
  const observer=async response=>{
    if(closed)return;
    const match=observedRequest(response,query,exactName,regionValue);
    if(!match)return;
    try{
      if(response.status()!==200){
        if(match.kind==="submit"||token===match.token)
          fault="registry_http_unavailable";
        return;
      }
      const payload=await response.json();
      if(closed)return;
      if(match.kind==="submit"){
        submitSeen=true;
        if(hasChallenge(payload?.captchaRequired)||hasChallenge(payload?.captcha)){
          fault="fns_captcha_required";return;
        }
        if(!match.regionMatches){fault="fns_region_filter_unavailable";return;}
        const value=typeof payload?.t==="string"?payload.t:"";
        if(!tokenPattern.test(value)){fault="fns_search_token_missing";return;}
        if(token&&token!==value){fault="fns_search_token_conflict";return;}
        token=value;
      }else if(responses.size<20||responses.has(match.token)){
        // Pending polling responses must not overwrite a completed result.
        const previous=responses.get(match.token);
        if(!Array.isArray(previous?.rows)||Array.isArray(payload?.rows)||
          hasChallenge(payload?.captchaRequired))
          responses.set(match.token,payload);
      }
    }catch{
      if(match.kind==="submit"||token===match.token)
        fault="fns_response_unreadable";
    }
  };
  page.on("response",observer);
  try{
    try{await submit.click({timeout:10000});}
    catch{throw fail("fns_submit_failed");}
    for(let i=0;i<40;i++){
      if(fault)throw fail(fault);
      if(!isFnsFormRoute(page.url()))throw fail("registry_route_untrusted");
      if(token&&responses.has(token)){
        const result=parseFnsSearchResult(responses.get(token),{query,exactName,completeNameSearch});
        if(result)return regionValue?{...result,search_region:region}:result;
      }
      if(i%5===0){
        const body=await readBody(isFnsFormRoute);
        if(/(?:введите код с картинки|введите символы с картинки|подтвердите,? что вы не робот|проверка безопасности)/iu.test(body))
          throw fail("fns_captcha_required");
      }
      if(i<39)await page.waitForTimeout(500);
    }
    throw fail(submitSeen?"fns_result_unavailable":"fns_submit_unobserved");
  }finally{
    closed=true;
    page.off("response",observer);
  }
}
