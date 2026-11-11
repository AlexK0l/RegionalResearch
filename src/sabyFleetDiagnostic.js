// Saby fleet read-only diagnostics. DOM and URL values are never logged.
// This does not grant a verified fleet or alter the browser collection path.
import {sabyCardRoute} from "./sabyCard.js";

const reasons=new Set([
  "contact_overlay_not_closed",
  "fleet_heading_missing",
  "truck_preview_missing",
  "truck_preview_ambiguous",
  "truck_count_invalid",
  "vehicle_rows_incomplete",
  "fleet_interaction_failed"
]);
const phases=new Set(["overlay","heading","preview","vehicles","unknown"]);
const capped=(v,upper=5000)=>
  typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?
    Math.min(v,upper):null;

export function safeSabyFleetFailure(report={},observed={}) {
  const phase=phases.has(report.phase)?report.phase:"unknown";
  const reason=reasons.has(report.reason)?
    report.reason:"fleet_interaction_failed";
  const status=observed?.status==="observed"?"observed":
    observed?.status==="not_detail"?"not_detail":"unavailable";
  return {
    status:"incomplete",
    phase,reason,dom_status:status,
    exact_fleet_heading:observed?.exact_fleet_heading===true,
    contact_overlay_title:observed?.contact_overlay_title===true,
    fleet_panel_title:observed?.fleet_panel_title===true,
    truck_category_labels:capped(observed?.truck_category_labels,30),
    truck_count_label:observed?.truck_count_label===true,
    category_expand_control:observed?.category_expand_control===true,
    preview_status:["missing","ambiguous","found"].includes(report.preview_status)?
      report.preview_status:"not_observed",
    expected_trucks:capped(report.expected_trucks),
    parsed_vehicle_rows:capped(report.parsed_vehicle_rows),
    side_panel_observed:report.side_panel_observed===true,
    expanded:report.expanded===true
  };
}

export async function observeSabyFleetDOM(page) {
  try {
    if(sabyCardRoute(page?.url?.())!=="detail")
      return {status:"not_detail"};
    const raw=await page.evaluate(()=>{
      const visible=el=>{
        if(!el||typeof el.getBoundingClientRect!=="function")return false;
        const r=el.getBoundingClientRect(),s=getComputedStyle(el);
        return r.width>0&&r.height>0&&
          s.display!=="none"&&s.visibility!=="hidden";
      };
      const clean=t=>String(t||"").replace(/\s+/g," ").trim();
      const matched=(regex)=>[...document.querySelectorAll("body *")]
        .filter(el=>visible(el)&&el.children.length===0&&
          regex.test(clean(el.textContent)));
      const truckLabels=matched(/^Грузовые(?:\s+\d+)?$/i);
      return {
        status:"observed",
        exact_fleet_heading:matched(/^Автопарк компании$/i).length>0,
        contact_overlay_title:matched(/^Контакты и телефоны$/i).length>0,
        fleet_panel_title:matched(/^Автопарк$/i).length>0,
        truck_category_labels:truckLabels.length,
        truck_count_label:truckLabels.some(el=>
          /^Грузовые\s+\d+$/i.test(clean(el.textContent))),
        category_expand_control:truckLabels.some(el=>
          Boolean(el.closest('[role="button"],button,[aria-expanded]')||
            el.parentElement?.querySelector('[aria-expanded]')))
      };
    });
    // The browser result is not trusted; only allowlisted booleans and
    // capped numeric counters may reach the diagnostic.
    return {
      status:raw?.status==="observed"?"observed":"unavailable",
      exact_fleet_heading:raw?.exact_fleet_heading===true,
      contact_overlay_title:raw?.contact_overlay_title===true,
      fleet_panel_title:raw?.fleet_panel_title===true,
      truck_category_labels:capped(raw?.truck_category_labels,30),
      truck_count_label:raw?.truck_count_label===true,
      category_expand_control:raw?.category_expand_control===true
    };
  } catch {
    return {status:"unavailable"};
  }
}
