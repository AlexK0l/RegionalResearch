import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {
  registeredSourceName,preciseLocalityMatch,chooseIndependentInnCandidate,
  verifyIndependentInnCandidate,planIndependentInnBackfill,runIndependentInnBackfill
} from "../src/independentInnBackfill.js";
import {inspectRegistrySearch,exactRegistrySearchRoute,registrySearchUrl,
  extractRegistryVbrRecord,extractRegistryTbankRecord,createPublicRegistryLookup
} from "../src/independentInnRegistryBrowser.js";
const inn="4706000909",kpp="470601001",ogrn="1024701329377";
const name='АО "Пример"';
const address="187300, Ленинградская область, г. Кировск, ул. Железнодорожная, д. 59";
const record={inn,kpp,ogrn,full_name:'АКЦИОНЕРНОЕ ОБЩЕСТВО "ПРИМЕР"',
  short_name:name,address,active:true};
const url="https://kontragent.vbr.ru/company/ao-primer-"+ogrn+"/";
const tbank="https://www.tbank.ru/business/contractor/legal/"+ogrn+"/";
const row=(id="k1",org=name,city="Кировск",extra={})=>({
  __canonical_id:id,"Организация":org,"ИНН":"","Город/район":city,
  "Выручка последнего подтвержденного года":1000000,"Численность":15,
  "Телефон":"1234567890",__comment:"Сайт/источник: источник\nИНН: не подтверждено\nДеятельность: перевозки",
  ...extra});
const cp=rows=>({version:1,source_mode:"saby",phase:"saby",region:"Ленинградская область",
  final_result:{direct_buyers:rows,intermediaries:[],leasing:[],statistics:[]},
  saby_finance_backfill_attempted_inns:["7707083893"]});
const target=(extra={})=>({organization:name,decision:"external_registry_search_required",candidates:[],...extra});
const search=(extra={})=>({state:"observed",complete:true,allCardsRead:true,
  records:[{record,url}],...extra});
const vbrText=[name,"Действующая организация. Проверено: 20.11.2026",
  "Общая информация","Полное наименование",record.full_name,
  "Краткое наименование",name,"ОГРН",ogrn,"ИНН",inn,"КПП",kpp,
  "Юридический адрес",address,"Сведения об организации"].join("\n");
const tbankText=[name,"Действующая организация","Реквизиты",
  "Полное название",record.full_name,"Краткое название",name,
  "ИНН",inn,"КПП",kpp,"ОГРН",ogrn,"Регистрация ФНС"].join("\n");
test("strict name and precise locality, including non-region INN",()=>{
  assert.equal(registeredSourceName(name,record),true);
  assert.equal(registeredSourceName('ООО "Пример"',record),false);
  assert.equal(registeredSourceName('Пример',record),false);
  assert.equal(registeredSourceName('АО "Пример Север"',record),false);
  assert.equal(preciseLocalityMatch("г. Кировск",address),true);
  assert.equal(preciseLocalityMatch("Ленинградская область",address),false);
  assert.equal(preciseLocalityMatch("Киров",address),false);
  assert.equal(preciseLocalityMatch("Железнодорожная",address),false);
  assert.equal(preciseLocalityMatch("Кировский район",address),false);
});
test("only a complete observed registry result and exact locality may resolve a missing INN by name",()=>{
  const good=chooseIndependentInnCandidate({row:row(),target:target(),search:search()});
  assert.equal(good.status,"candidate");
  assert.equal(good.sourceBasis,"complete_name_search_exact_locality");
  assert.equal(verifyIndependentInnCandidate(good,{record,url:tbank},target()).status,"verified");
  for(const bad of [
    {record:{...record,inn:"7707083893"},url:tbank},
    {record:{...record,kpp:"470601002"},url:tbank},
    {record:{...record,active:false},url:tbank},
    {record,url:"https://evil.test/business/contractor/legal/"+ogrn+"/"},
    {record:{...record,full_name:"ООО ПРИМЕР"},url:tbank}
  ])assert.equal(verifyIndependentInnCandidate(good,bad,target()).status,"review");
  for(const incomplete of [{complete:false},{allCardsRead:false}]){
    assert.equal(chooseIndependentInnCandidate({row:row(),target:target(),
      search:search(incomplete)}).status,"review");
  }
  assert.equal(chooseIndependentInnCandidate({row:row("k","АО Пример","Тосно"),
    target:target(),search:search()}).status,"review");
  assert.equal(chooseIndependentInnCandidate({row:row(),target:target(),
    search:search(),owners:new Set([inn])}).reason,"inn_already_owned");
  const secondOgrn="1024701479571";
  assert.equal(chooseIndependentInnCandidate({row:row(),target:target(),
    search:search({records:[{record,url},{record:{...record,ogrn:secondOgrn,active:false},
      url:"https://kontragent.vbr.ru/company/another-"+secondOgrn+"/"}]})}).status,"review");
});
test("prior public profile hint resolves incomplete search but rejected or occupied hints never write",()=>{
  const hint={inn,checksum_valid:true,rejected_claim:false,ownership_risk:"not_occupied",
    sources:[{kind:"saby_public_profile_link",source_url:"https://saby.ru/profile/"+inn+"-"+kpp}]};
  const entry=target({candidates:[hint],decision:"independent_registry_confirmation_required"});
  const a=chooseIndependentInnCandidate({row:row(),target:entry,search:search({complete:false})});
  assert.equal(a.status,"candidate");
  assert.equal(a.sourceBasis,"same_saved_public_inn_kpp");
  assert.equal(chooseIndependentInnCandidate({row:row(),target:target({
    candidates:[{...hint,rejected_claim:true}]}),search:search()}).reason,"source_identity_conflict");
  assert.equal(chooseIndependentInnCandidate({row:row(),target:target({
    decision:"candidate_legal_form_conflict",candidates:[hint]}),search:search()}).reason,"source_identity_conflict");
  assert.equal(chooseIndependentInnCandidate({row:row("x",name,"Кировск",
    {"Юридический адрес":"Другой адрес, ул. Садовая, д. 10"}),
    target:entry,search:search()}).status,"review");
});
test("search completeness requires explicit count, exact input, no pagination",()=>{
  const q=name;
  const snap={text:"Найдено 1 организация",inputs:[q],links:[{url,title:name}]};
  assert.equal(inspectRegistrySearch(snap,q).complete,true);
  for(const change of [{text:"Всего в нашей базе 1 организация"},{hasMore:true},
    {inputs:["другой запрос"]},{text:"Найдено 10 организаций"},{truncated:true}])
    assert.equal(inspectRegistrySearch({...snap,...change},q).complete,false);
  assert.equal(inspectRegistrySearch({text:"Ничего не найдено",inputs:[q],links:[]},q).empty,true);
  assert.equal(inspectRegistrySearch({text:"",inputs:[q],links:[]},q).empty,false);
  assert.equal(exactRegistrySearchRoute(registrySearchUrl(q),q),true);
  assert.equal(exactRegistrySearchRoute(registrySearchUrl(q),inn),false);
  assert.equal(exactRegistrySearchRoute("https://evil.test/search/?s="+encodeURIComponent(q),q),false);
});
test("only bounded registry requisites panels prove records and active status",()=>{
  assert.deepEqual(extractRegistryVbrRecord(vbrText),record);
  assert.deepEqual(extractRegistryTbankRecord(tbankText),{
    inn,kpp,ogrn,full_name:record.full_name,short_name:name,active:true});
  assert.equal(extractRegistryVbrRecord(vbrText.replace("Юридический адрес","Неизвестное поле")),null);
  assert.equal(extractRegistryVbrRecord(vbrText.replace("Действующая организация","Ликвидирована")).active,false);
  assert.equal(extractRegistryTbankRecord(tbankText.replace("Действующая организация","Ликвидирована")).active,false);
});
test("backfill saves immutable child after each row, skips brands and prevents duplicate INN",async()=>{
  const original=cp([
    row("k1"),row("k2",name),row("k3","Бренд Пример","Кировск"),
    row("k4","ООО Другая","Тосно",{"ИНН":"7707083893"})
  ]);
  const before=JSON.stringify(original),calls=[],snapshots=[];
  const result=await runIndependentInnBackfill({
    checkpoint:original,sourceId:"parent",childId:"child",limit:10,
    lookup:{search:async t=>{calls.push(t.original_canonical_id);return search();},
      confirm:async()=>({record,url:tbank})},
    onCheckpoint:async x=>snapshots.push(x)
  });
  assert.equal(result.stats.added,1);
  assert.equal(result.stats.processed,3);
  assert.equal(result.stats.review,2);
  assert.deepEqual(calls,["k1","k2"]);
  assert.equal(snapshots.length,4);
  assert.equal(JSON.stringify(original),before);
  assert.equal(result.snapshot.final_result.direct_buyers[0]["ИНН"],inn);
  assert.equal(result.snapshot.final_result.direct_buyers[0]["Численность"],15);
  assert.equal(result.snapshot.final_result.direct_buyers[0]["Телефон"],"1234567890");
  assert.match(result.snapshot.final_result.direct_buyers[0].__comment,/ИНН: 4706000909/);
  assert.equal(result.snapshot.final_result.direct_buyers[1]["ИНН"],"");
  assert.deepEqual(result.snapshot.saby_finance_backfill_attempted_inns,["7707083893"]);
  assert.equal(planIndependentInnBackfill(result.snapshot).pending,0);
});
test("navigation budget stops before marking next row attempted, allowing safe continuation",async()=>{
  const original=cp([row("k1"),row("k2","АО Иное")]);
  const out=await runIndependentInnBackfill({checkpoint:original,
    sourceId:"p",childId:"c",limit:2,
    lookup:{search:async t=>{
      if(t.original_canonical_id==="k2")
        throw Object.assign(Error("budget"),{code:"navigation_budget"});
      return search();
    },confirm:async()=>({record,url:tbank})},
    onCheckpoint:async()=>{}});
  assert.equal(out.stats.added,1);
  assert.equal(out.stats.processed,1);
  assert.equal(out.stats.stop_reason,"navigation_budget");
  assert.equal(planIndependentInnBackfill(out.snapshot).pending,1);
  assert.equal(Object.hasOwn(out.snapshot.independent_inn_backfill_outcomes,"k2"),false);
});
test("browser adapter enforces real navigation cap and never uses untrusted links",async()=>{
  const q=name,visits=[];
  const page={
    current:"",
    goto:async function(u){this.current=u;visits.push(u);return {status:()=>200};},
    url(){return this.current;},
    waitForTimeout:async()=>{},
    evaluate:async function(){
      if(this.current===registrySearchUrl(q))return {text:"Найдено 1 организация",inputs:[q],
        links:[{url,title:name},{url:"https://evil.test/company/fake-"+ogrn+"/",title:name}]};
      if(this.current===url)return vbrText;
      if(this.current===tbank)return tbankText;
      throw Error("unexpected page");
    }
  };
  const lookup=await createPublicRegistryLookup(page,{maxPages:3});
  const observed=await lookup.search(target(),null);
  assert.equal(observed.complete,true);
  assert.equal(observed.records.length,1);
  assert.equal((await lookup.confirm(ogrn)).record.inn,inn);
  assert.deepEqual(visits,[registrySearchUrl(q),url,tbank]);
  await assert.rejects(lookup.search(target(),null),e=>e.code==="navigation_budget");
});
test("CLI dry-run reads an exact SQLite checkpoint without writes",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"independent-inn-plan-"));
  const filename=path.join(dir,"cp.sqlite");
  const id="bdb18cf0-b339-4a4d-9b09-65e9498ddfc2";
  let db;
  try{
    db=new DatabaseSync(filename);
    db.exec("CREATE TABLE research_checkpoints (id TEXT PRIMARY KEY, payload TEXT)");
    db.prepare("INSERT INTO research_checkpoints(id,payload) VALUES(?,?)")
      .run(id,JSON.stringify(cp([row()])));
    db.close();db=null;
    const before=fs.readFileSync(filename);
    const result=spawnSync(process.execPath,[fileURLToPath(new URL(
      "../scripts/independent-inn-backfill.js",import.meta.url)),
      "--db="+filename,"--checkpoint="+id,"--limit=1"],{encoding:"utf8",timeout:30000});
    assert.equal(result.status,0,result.stderr+result.stdout);
    assert.match(result.stdout,/"dry_run":true/);
    assert.match(result.stdout,/"scheduled":1/);
    assert.doesNotMatch(result.stdout,/INDEPENDENT_INN_CHILD/);
    assert.deepEqual(fs.readFileSync(filename),before);
  }finally{db?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
