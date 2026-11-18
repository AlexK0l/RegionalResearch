// A diagnostic smoke must test the requested legal entity, never an array
// offset that changes when Stage12 reorders previously visited INNs.
// Pure, one-entity fixture; it cannot mutate the source or SQLite.
import {sabyInn,sabyEligibleRows} from "./sabyEnrichment.js";

const SECTIONS=["direct_buyers","intermediaries","leasing"];

export function selectSabySmokeTarget(base, rawInn) {
  const inn=sabyInn(rawInn);
  if(!inn || String(rawInn??"").trim()!==inn)
    throw new Error("Saby smoke: --target-inn должен содержать ровно 10 или 12 цифр ИНН");
  if(!base || SECTIONS.some(key=>!Array.isArray(base[key])))
    throw new Error("Saby smoke: отсутствуют разделы организаций");
  const matches=SECTIONS.flatMap(section=>
    base[section].filter(row=>sabyInn(row?.["ИНН"])===inn)
      .map(row=>({section,row})));
  if(matches.length!==1)
    throw new Error("Saby smoke: ИНН найден "+matches.length+
      " раз; требуется ровно одна организация среди коммерческих разделов");
  const [{section,row}]=matches;
  // The same eligibility policy as the live Saby runner. Never inject an
  // excluded/intermediary-with-phone company into a different production
  // queue merely to make the smoke green.
  const eligible=sabyEligibleRows(base).eligible.some(entry=>entry.row===row);
  if(!eligible)
    throw new Error("Saby smoke: компания не входит в допустимую очередь Stage12");
  const result={direct_buyers:[],intermediaries:[],leasing:[],statistics:[]};
  result[section]=[structuredClone(row)];
  return {result,inn,section};
}
