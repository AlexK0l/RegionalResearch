// Saby fleet read-only diagnostics. DOM and URL values are never logged.
// This does not grant a verified fleet or alter the browser collection path.
import {sabyCardRoute} from "./sabyCard.js";
import {safeSabyFleetPaginationSignals}
  from "./sabyFleetPaginationDiagnostic.js";

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
const routeReasons=new Set([
  "same_detail","ui_navigation_only","stable_card_id_missing",
  "company_card_id_changed","not_same_first_party_detail",
  "origin_changed","detail_path_changed","non_ui_query_changed",
  "non_ui_fragment_changed","second_click_after_ui_change_blocked"
]);
const stitchReasons=new Set([
  "exact_count","invalid_setup","invalid_rows","empty_window",
  "same_window","unanchored_window","ambiguous_overlap",
  "count_exceeded","window_not_updated","scroll_not_advanced",
  "scroll_not_available","panel_not_observed","panel_unrecognized",
  "preview_click_unavailable","detail_changed","bounded_limit"
]);
const capped=(v,upper=5000)=>
  typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?
    Math.min(v,upper):null;
function safeRouteDelta(delta) {
  if(delta?.status==="not_comparable")
    return {status:"not_comparable"};
  if(delta?.status!=="observed")return null;
  return {
    status:"observed",
    non_ui_added:capped(delta.non_ui_added,64),
    non_ui_removed:capped(delta.non_ui_removed,64),
    non_ui_values_changed:capped(delta.non_ui_values_changed,64),
    ui_values_changed:capped(delta.ui_values_changed,64)
  };
}

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
    window_count:capped(report.window_count,96),
    scroll_moves:capped(report.scroll_moves,128),
    stale_scroll_moves:capped(report.stale_scroll_moves,128),
    consecutive_stale_scroll_moves:
      capped(report.consecutive_stale_scroll_moves,12),
    scroll_candidates:capped(report.scroll_candidates,40),
    scroll_selected_from_vehicle_rows:
      report.scroll_selected_from_vehicle_rows===true,
    scroll_target_contains_truck:report.scroll_target_contains_truck===true,
    scroll_target_vehicle_leaves:
      capped(report.scroll_target_vehicle_leaves,5000),
    scroll_target_is_panel:report.scroll_target_is_panel===true,
    scroll_at_end:report.scroll_at_end===true,
    scroll_top:capped(report.scroll_top,10000000),
    scroll_max:capped(report.scroll_max,10000000),
    stitch_reason:stitchReasons.has(report.stitch_reason)?
      report.stitch_reason:"not_attempted",
    panel_open_attempts:capped(report.panel_open_attempts,2),
    panel_wait_polls:capped(report.panel_wait_polls,50),
    panel_title_seen:report.panel_title_seen===true,
    fleet_ui_route_updated:report.fleet_ui_route_updated===true,
    fleet_route_reason:routeReasons.has(report.route_guard_reason)?
      report.route_guard_reason:"not_observed",
    fleet_route_delta:safeRouteDelta(report.route_delta),
    fleet_pagination:report.fleet_pagination?
      safeSabyFleetPaginationSignals(report.fleet_pagination):null,
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
