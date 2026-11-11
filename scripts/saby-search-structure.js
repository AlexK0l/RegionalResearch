#!/usr/bin/env node
// A SINGLE READ-ONLY snapshot of the authenticated Saby company search.
// Does not open any company detail, change source JSON/SQLite/CRM, use
// OpenAI, scrape contacts or export raw DOM. Intended for diagnosing the
// observed 40 candidate results / 33 names before changing Stage12.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {withSabyBrowser,findResultRows} from "../src/sabyBrowser.js";
import {findSabyCompanySearch} from "../src/sabySearch.js";
import {sabyInn} from "../src/sabyEnrichment.js";
import {selectSabyInnCandidate,SABY_BRANCH_MARKER_SOURCE} from
  "../src/sabyPublicIdentityFallback.js";
import {
  summarizeSabySearchLayout,inspectSabySearchLayout
} from "../src/sabySearchStructureDiagnostics.js";

const option=(args,key)=>{
  const value=args.find(a=>a.startsWith("--"+key+"="));
  return value?value.slice(key.length+3):"";
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  const args=process.argv.slice(2);
  if(args.includes("--help")){
    console.log("Read-only Saby search structure: "+
      "--inn=7725104641 --name='Expected registered name' "+
      "--profile=AUTH_PROFILE --out=private-report.json --headless");
    return;
  }
  const inn=sabyInn(option(args,"inn"));
  const name=option(args,"name").trim(),output=option(args,"out");
  const profile=option(args,"profile");
  if(!inn||!name||!profile||!output||name.length>300)
    throw Error("Нужны --inn, --name, --profile и --out");
  const env={...process.env,SABY_HEADLESS:args.includes("--headless")?"true":"false",
    SABY_PROFILE_DIR:path.resolve(profile)};
  const results=[];
  await withSabyBrowser(async ({page,settings})=>{
    await page.goto("https://profile.saby.ru/page/company-list-prof",{
      waitUntil:"domcontentloaded",timeout:settings.timeoutMs
    });
    if(new URL(page.url()).hostname!=="profile.saby.ru")
      throw Error("Сессия Saby не открыла каталог компаний");
    const search=await findSabyCompanySearch(page,{timeoutMs:15000});
    if(!search.field)throw Error("Поле поиска Saby не распознано");
    await search.field.fill(inn);
    await search.field.press("Enter");
    for(const holdMs of [900,1500,2400]) {
      await sleep(holdMs);
      if(new URL(page.url()).hostname!=="profile.saby.ru")
        throw Error("Поиск покинул Saby");
      const rows=await findResultRows(page,inn,{
        includeInnOnly:true,includeBranches:true
      });
      const shapes=await inspectSabySearchLayout(page,rows,inn);
      const selected=selectSabyInnCandidate(rows,inn,name);
      results.push({
        after_search_ms:results.reduce((n,x)=>n+x.poll_delay_ms,0)+holdMs,
        poll_delay_ms:holdMs,
        source:"authenticated_company_list",
        safe_selected_reason:selected.reason,
        raw_candidates:rows.meta?.rawCandidates||0,
        fragments_rejected:rows.meta?.rejectedFragments||0,
        geometry_duplicates:rows.meta?.geometryDuplicates||0,
        raw_capped:rows.meta?.rawCapped===true,
        truncated:rows.meta?.truncated===true,
        search_results:summarizeSabySearchLayout(rows,inn,name,shapes)
      });
      console.log("[SABY_SEARCH_FORENSICS] "+JSON.stringify({
        snapshot:results.length,
        candidates:rows.length,distinct_titles:
          results.at(-1).search_results.distinct_titles,
        title_overlap:results.at(-1).search_results.titles_with_source_token,
        semantic_rows:results.at(-1).search_results.has_row_context,
        clickable:results.at(-1).search_results.with_clickability,
        result:selected.reason
      }));
    }
  },{env});
  const target=path.resolve(output);
  await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
  const report={
    kind:"saby_search_structure_diagnostic",schema_version:1,
    generated_at:new Date().toISOString(),
    inn_sha256:crypto.createHash("sha256").update(inn).digest("hex"),
    profile_used:"user_provided_persistent_auth_profile",
    source_file_unchanged:true,sqlite_writes:0,openai_requests:0,
    note:"Read-only snapshots. Search result names are UNVERIFIED and "+
      "must never be treated as proof of exact legal identity. "+
      "Names are limited to a masked first line; no phones, email, "+
      "credentials, full page text or URLs are recorded.",
    branch_marker_source:SABY_BRANCH_MARKER_SOURCE,
    snapshots:results
  };
  await fs.writeFile(target,JSON.stringify(report,null,2)+"\n",
    {flag:"wx",mode:0o600});
  console.log(JSON.stringify({
    snapshots:results.length,
    latest:results.at(-1)?{
      candidates:results.at(-1).search_results.candidate_rows,
      distinct_titles:results.at(-1).search_results.distinct_titles,
      semantic_rows:results.at(-1).search_results.has_row_context,
      clickable:results.at(-1).search_results.with_clickability
    }:null,
    out:target,openai_requests:0,source_file_unchanged:true
  },null,2));
}
main().catch(e=>{
  const m=String(e?.message||"");
  console.error(m.startsWith("Нужны")||m.startsWith("Сессия")||
    m.startsWith("Поле поиска")||m.startsWith("Поиск покинул")?
    m:"Не удалось выполнить Saby search-structure диагностику");
  process.exitCode=1;
});
