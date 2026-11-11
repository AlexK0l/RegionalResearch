// Strict continuity for an ALREADY VERIFIED Saby contractor while its
// fleet panel switches in-page UI state. This is not an identity verifier.
// The existing public-name + stable private INN/KPP/H1 gate must finish
// before this helper may be used. All returned fields are value-free.
import {
  compareSabyPrivateDetailUrl,summarizeSabyPrivateRouteDelta
} from "./sabyPrivateDetailUrl.js";
import {sabyCardRoute} from "./sabyCard.js";

// An opaque first-party contractor ID is mandatory. This specifically
// refuses relying solely on name, IP, UI heading or an "anchor" query.
// No opaque ID ever leaves this pure comparison as a returned value.
function contractorIdEvidence(url) {
  try {
    const u=new URL(String(url||""));
    if(sabyCardRoute(u.href)!=="detail"||u.username||u.password)
      return null;
    const available=[];
    for(const key of ["id","contractorId"]){
      const vals=u.searchParams.getAll(key);
      if(!vals.length)continue;
      if(vals.length!==1||!/^[-a-zA-Z0-9_]{6,128}$/.test(vals[0]))
        return null;
      available.push([key,vals[0]]);
    }
    return available.length?JSON.stringify(available):null;
  }catch{return null;}
}

export function compareSabyVerifiedFleetDetail(original,current) {
  const baseId=contractorIdEvidence(original);
  const currentId=contractorIdEvidence(current);
  const delta=summarizeSabyPrivateRouteDelta(original,current);
  if(!baseId||!currentId)
    return {ok:false,reason:"stable_card_id_missing",route_delta:delta};
  if(baseId!==currentId)
    return {ok:false,reason:"company_card_id_changed",route_delta:delta};
  // Same opaque ID alone is insufficient: unknown first-party query keys,
  // path, fragments or new credentials must also pass the EXISTING strict
  // safe-Saby-UI-navigation classifier. No blanket ignore-query shortcut.
  const report=compareSabyPrivateDetailUrl(original,current);
  if(!report.ok)
    return {ok:false,reason:report.reason,route_delta:delta};
  return {ok:true,reason:report.reason,
    ui_navigation_only:report.reason==="ui_navigation_only"};
}
