// A single bounded projection of the browser's already-parsed HTML.
// No page.content(), script-state export, disk snapshots, or hidden-data
// extraction. Reuse the same validated finance and vehicle parsers.
import {scanSabyMarkupOwnerDOM} from "./sabyMarkupOwnerDOM.js";
import {scanSabyFinancialDOM,parseSabyFinancialSnapshot} from "./sabyFinancials.js";
import {scanSabyVehicleSummaryDOM,validateSabyVehicleSummary} from "./sabyVehicleSummary.js";
import {verifiedSabyVehicleFleet} from "./sabyVehicleInventory.js";
import {compareSabyVerifiedFleetDetail} from "./sabyFleetRouteContinuity.js";
import {sabyCardRoute} from "./sabyCard.js";
import {sabyInn,sabyNameMatches,sabyNameTokens,SABY_LEGAL_NAME_WORDS,sabyFinancialGaps} from "./sabyEnrichment.js";
import {extractSabyPhoneDetails,parsePhoneEntries} from "./phoneExport.js";
import {companyEmailCell} from "./emailContact.js";

function inspectSabyMarkupDOM(args,ownerScan,financeScan,fleetScan){
  const own=ownerScan(args);
  if(!own)return {status:"scope_unavailable"};
  const root=own.root,sections=args.sections||{},out={status:"observed"};
  const visible=e=>{
    if(!e?.isConnected||typeof e.getBoundingClientRect!=="function")return false;
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=="none"&&
      !["hidden","collapse"].includes(s.visibility)&&s.opacity!=="0";
  };
  if(sections.contacts){
    try{
      const blocks=[...root.querySelectorAll('.contractorDialog-Contacts__Block-mainContacts')].filter(visible);
      if(blocks.length===1){
        const block=blocks[0];
        const headings=[...block.querySelectorAll('[data-qa="ContractorCard_Person"]')].filter(e=>
          visible(e)&&String(e.textContent||"").trim()==="Контакты");
        // Read only this known own-company contact block; not website,
        // address, shareholder or related-company widgets.
        if(headings.length===1){
          const value=String(block.innerText||"");
          if(value.length<=8000){
            out.contactText=value.split(/Контакты связанных компаний/i,1)[0];
            out.moreContacts=[...block.querySelectorAll('[data-qa="ContractorCard-Contacts__more"]')].some(visible);
          }
        }
      }
    }catch{/* A malformed widget is a gap, not a card-wide failure. */}
  }
  if(sections.financials){
    try{out.financial=financeScan(root);}catch{}
  }
  if(sections.fleet){
    try{out.fleet=fleetScan(root);}catch{}
  }
  return out;
}
// Function source is exclusively our local static DOM readers. No source
// string from the page or a company row is ever interpreted as code.
export const scanSabyMarkupSnapshotDOM=new Function("args",
  "return ("+inspectSabyMarkupDOM.toString()+")(args,("+
  scanSabyMarkupOwnerDOM.toString()+"),("+scanSabyFinancialDOM.toString()+"),("+
  scanSabyVehicleSummaryDOM.toString()+"));");

export async function readSabyMarkupSnapshot(page,{row,identity,originalUrl,sections,allVehicles=false}={}){
  const inn=sabyInn(row?.["ИНН"]),name=row?.["Организация"];
  const same=()=>{
    const current=page.url();
    return sabyCardRoute(originalUrl)==="detail"&&
      (current===originalUrl||compareSabyVerifiedFleetDetail(originalUrl,current).ok);
  };
  if(!inn||identity?.verified!==true||sabyInn(identity.inn)!==inn||
     !sabyNameMatches(name,identity.name)||!same())return null;
  let raw;
  try{
    raw=await page.evaluate(scanSabyMarkupSnapshotDOM,{
      inn,nameTokens:sabyNameTokens(name),legalWords:SABY_LEGAL_NAME_WORDS,
      sections:{contacts:sections?.contacts===true,financials:sections?.financials===true,
        fleet:sections?.trucks===true&&allVehicles===true}
    });
  }catch{return null;}
  // The snapshot is ephemeral and tied to this freshly verified route.
  if(!same()||raw?.status!=="observed")return null;
  const out={contacts:null,financials:null,fleet:null,trucks:null,moreContacts:raw.moreContacts===true};
  if(sections?.contacts&&typeof raw.contactText==="string"&&raw.contactText.length<=8000){
    const text=raw.contactText.split(/Контакты связанных компаний/i,1)[0];
    const phoneDetails=extractSabyPhoneDetails(text),phones=phoneDetails.map(x=>x.phone);
    const emails=[...new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)||[])
      .map(x=>x.toLowerCase()))];
    // Completion means the requested CRM fields can be filled, not
    // that all entries behind "Еще N" were disclosed. Missing fields
    // always go through the existing collector and retry policy.
    if((phones.length||emails.length)&&
       (phones.length||parsePhoneEntries(row?.["Телефон"]).length)&&
       (emails.length||companyEmailCell(row))){
      out.contacts={phones,phone_details:phoneDetails,emails,status:"collected"};
    }
  }
  if(sections?.financials&&raw.financial){
    const value=parseSabyFinancialSnapshot(raw.financial),gaps=sabyFinancialGaps(row);
    if(value.status==="collected"&&(!gaps.revenue||value.revenue_rub!==null)&&
       (!gaps.employees||value.employees!==null))out.financials=value;
  }
  if(sections?.trucks&&allVehicles&&raw.fleet&&compareSabyVerifiedFleetDetail(originalUrl,page.url()).ok){
    const summary=validateSabyVehicleSummary(raw.fleet);
    if(summary){
      // Independent navigation total, every supported category, and
      // every listed vehicle must reconcile. Partial previews do not
      // suppress the full drawer/tree recovery, including Gazprom.
      const fleet=verifiedSabyVehicleFleet({status:"verified",count:summary.count,groups:summary.groups});
      if(fleet){
        out.fleet=fleet;
        const trucks=fleet.groups.find(g=>g.category==="Грузовые");
        if(trucks)out.trucks={status:"verified",count:trucks.count,vehicles:trucks.vehicles};
      }
    }
  }
  return same()?out:null;
}
