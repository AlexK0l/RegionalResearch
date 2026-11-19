import { validSabyFinancialEvidence } from "./sabyFinancials.js";

// Recovery for a transient, unhydrated Saby detail screen.
//
// A verified legal entity can render without either requested widget. A
// single bounded reopening of the same INN is cheaper and safer than marking
// missing data as confirmed absence or silently completing the company.
// The browser collector verifies company identity independently on each
// attempt. No credentials are resubmitted by this helper.
// During a single browser visit contacts/fleet can hydrate only on the
// second attempt. Keep independently verified financials from the first
// attempt ONLY when both screens belong to the same exact private card
// or same verified INN/KPP. Never join values across related companies.
function sameVerifiedSabyCard(first,second){
  if(first?.identity?.verified!==true||second?.identity?.verified!==true||
     first.identity.inn!==second.identity.inn)return false;
  const a=String(first.identity.kpp||""),b=String(second.identity.kpp||"");
  if(/^\d{9}$/.test(a)&&a===b)return true;
  try{
    const old=new URL(first.source_url),next=new URL(second.source_url);
    return old.protocol==="https:" && next.protocol==="https:" &&
      old.hostname==="profile.saby.ru" &&
      next.hostname==="profile.saby.ru" &&
      old.pathname==="/page/contractor-info" &&
      next.pathname===old.pathname &&
      old.searchParams.has("id") &&
      old.searchParams.get("id")===next.searchParams.get("id");
  }catch{return false;}
}

export function sabyNeedsSectionRetry(result) {
  return result?.contacts?.status === "missing" &&
    result?.trucks?.status === "missing";
}

/**
 * Collect once; only when BOTH sections are missing reopen the company once.
 * On an unsuccessful reopen retain the incomplete first response, which
 * Stage 12 marks review/deferred rather than writing or checkpointing it.
 * Retry errors are reported through a sanitized callback, not their message.
 */
export async function recoverSabyMissingSections(
  collect, {wait = async () => {}, onRetry = () => {},
    onRetryError = () => {}} = {}
) {
  const initial = await collect();
  if (!sabyNeedsSectionRetry(initial)) return initial;
  onRetry();
  try {
    await wait();
    const retried=await collect();
    const financials=validSabyFinancialEvidence(initial?.financials);
    if(financials && !validSabyFinancialEvidence(retried?.financials) &&
       sameVerifiedSabyCard(initial,retried)){
      return {...retried,financials};
    }
    return retried;
  } catch {
    onRetryError();
    return initial;
  }
}
