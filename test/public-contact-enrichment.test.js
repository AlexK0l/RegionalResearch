import test from "node:test";
import assert from "node:assert/strict";
import {contactPublicUrl,isPublicContactIPv4,resolvePublicContactAddress,
  robotsAllows,createPublicContactHttp} from "../src/publicContactHttp.js";
import {registeredContactName,parsePublicContactPage,extractVerifiedPublicContacts,
  contactSourceCandidates,lookupPublicCompanyContacts} from "../src/publicContactParser.js";
import {needsAnyContact,knownContactLeader,planPublicContactEnrichment,
  runPublicContactEnrichment,applyPublicContactFacts,publicContactOwnership} from "../src/publicContactEnrichment.js";
import {lookupFnsCompanyContacts,runFnsContactEnrichment} from "../src/publicContactFns.js";
import {sabyEligibleRows} from "../src/sabyEnrichment.js";
import {validBatchContactItem,contactResearchPriority} from "../src/researchCostPolicy.js";
import {decorateCompanyBasisForExport} from "../src/companyBasisNarrative.js";
const inn="7707083893",otherInn="7702070139",
  name='ООО «АЛЬФА»',base="https://alpha.example/",
  contact=base+"contacts",identity=base+"requisites";
const company=(extra={})=>({
  "Организация":name,"ИНН":inn,"Телефон":"","Электронная почта":"",
  "Руководитель / ЛПР":"","Основание":"A — подтверждённая эксплуатация полуприцепов",
  "Выручка последнего подтвержденного года":1000,"Численность":7,
  __canonical_id:"a",__final_grade:"A",
  __evidence:{source_urls:[contact],notes:["Сохранённое исходное подтверждение"]},
  ...extra});
const result=rows=>({direct_buyers:rows,intermediaries:[],leasing:[],statistics:[]});
const identityHtml='<h1>ООО &laquo;АЛЬФА&raquo; — официальный сайт</h1>'+
  '<table><tr><td>ИНН</td><td>'+inn+'</td></tr></table><a href="/contacts">Контакты</a>';
const contactHtml='<h1>Контакты ООО &laquo;АЛЬФА&raquo;</h1>'+
  '<p>Отдел закупок: <a href="tel:+74951234567">+7 (495) 123-45-67</a></p>'+
  '<p>Email: <a href="mailto:sales@alpha.example">sales@alpha.example</a></p>'+
  '<p>Генеральный директор: Иванов Иван Иванович</p>'+
  '<a href="/requisites">Реквизиты</a>'+
  '<p>Факс: +7 (495) 111-22-33</p>'+
  '<p>Разработка сайта: <a href="mailto:developer@web.example">developer@web.example</a></p>'+
  '<script>var x="Телефон: +7 495 9999999";</script>'+
  '<p hidden>Телефон: +7 495 9999998</p>'+
  '<p><a href="tel:+74959999997">Написать нам</a></p>';
const pages=()=>[parsePublicContactPage(identityHtml,identity),parsePublicContactPage(contactHtml,contact)];
test("independent missing email triggers paid eligibility and Saby channel eligibility",()=>{
  const row=company({"Телефон":"74951234567","Руководитель / ЛПР":"Иванов Иван Иванович"});
  assert.equal(needsAnyContact(row),true);
  assert.equal(knownContactLeader({...row,"Руководитель / ЛПР":"не найден"}),false);
  assert.equal(needsAnyContact({...row,"Электронная почта":"a@alpha.example"}),false);
  const r={direct_buyers:[],intermediaries:[row],leasing:[],statistics:[]};
  assert.equal(sabyEligibleRows(r).eligible.length,1);
  row["Электронная почта"]="a@alpha.example";
  assert.equal(sabyEligibleRows(r).eligible.length,0);
  const unknown=company({"ИНН":""});
  assert.equal(validBatchContactItem({id:"a",inn:"",organization:"",
    source_urls:[contact],phones:["74951234567"]},unknown,"a"),null);
  assert.ok(contactResearchPriority(company({"Руководитель / ЛПР":"Иванов Иван"}))>
    contactResearchPriority(company({"Телефон":"74951234567"})));
});
test("HTML proof requires exact legal name and labelled INN, actual linked contact page; ignores hidden, unrelated and fake links",()=>{
  assert.equal(registeredContactName('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "Альфа"'),"ООО АЛЬФА");
  const [id,con]=pages();
  assert.deepEqual(id.inns,[inn]);
  assert.deepEqual(id.names,["ООО АЛЬФА"]);
  assert.deepEqual(con.names,["ООО АЛЬФА"]);
  const out=extractVerifiedPublicContacts([id,con],company());
  assert.equal(out.reason,"verified_contacts");
  assert.deepEqual(out.facts.map(x=>[x.field,x.value]),[
    ["Телефон","74951234567"],["Электронная почта","sales@alpha.example"],
    ["Руководитель / ЛПР","Иванов Иван Иванович (генеральный директор)"]]);
  assert.equal(out.facts[0].department,"отдел закупок");
  assert.equal(out.facts[0].identity_url,identity);
  assert.match(out.facts[0].source_sha256,/^[a-f0-9]{64}$/);
  assert.equal(extractVerifiedPublicContacts([con],company()).facts.length,0);
  assert.equal(extractVerifiedPublicContacts([id,con],company({"Организация":"АО Альфа"})).facts.length,0);
  assert.equal(extractVerifiedPublicContacts([id,con],company({"ИНН":otherInn})).facts.length,0);
  const wrong=parsePublicContactPage(contactHtml+'<p>ИНН: '+otherInn+'</p>',contact);
  assert.equal(extractVerifiedPublicContacts([id,wrong],company()).facts.length,0);
  const unlinked=parsePublicContactPage(identityHtml.replace('<a href="/contacts">Контакты</a>',""),identity);
  const unlinkedContact=parsePublicContactPage(contactHtml.replace('<a href="/requisites">Реквизиты</a>',""),contact);
  assert.equal(extractVerifiedPublicContacts([unlinked,unlinkedContact],company()).facts.length,0);
});
test("ownership conflicts held; no overwrite, no new A/B/C evidence; source-specific notes exported",()=>{
  const row=company(),other=company({"Организация":"ООО Бета","ИНН":otherInn,
    "Телефон":"74951234567","Электронная почта":"sales@alpha.example"});
  const r=result([row,other]),old=structuredClone(row);
  const out=applyPublicContactFacts(row,extractVerifiedPublicContacts(pages(),row).facts,
    {owners:publicContactOwnership(r)});
  assert.equal(out.conflicts,2);
  assert.equal(row["Телефон"],"");assert.equal(row["Электронная почта"],"");
  assert.equal(out.leader,1);
  assert.equal(row["Выручка последнего подтвержденного года"],old["Выручка последнего подтвержденного года"]);
  assert.equal(row["Основание"],old["Основание"]);
  assert.deepEqual(row.__evidence.source_urls,old.__evidence.source_urls);
  assert.deepEqual(row.__evidence.notes,old.__evidence.notes);
  const exported=decorateCompanyBasisForExport(r).direct_buyers[0];
  assert.match(exported.__comment,/Руководитель \/ ЛПР: .*https:\/\/alpha\.example\/contacts/);
});
test("URL and DNS rules fail closed; robots exclusion and redirect target validation",async()=>{
  for(const u of ["file:///etc/passwd","http://127.0.0.1/","http://169.254.169.254/",
    "https://user:pass@alpha.example/","https://alpha.example:8443/",
    "https://alpha.example/admin","https://alpha.example/?token=x","https://alpha.example/file.pdf"])
    assert.equal(contactPublicUrl(u),"",u);
  for(const ip of ["0.0.0.0","127.0.0.1","10.1.1.1","169.254.169.254","172.31.2.3",
    "192.168.1.1","100.64.0.1","198.18.0.1","::1","::ffff:127.0.0.1"])
    assert.equal(isPublicContactIPv4(ip),false,ip);
  assert.equal(isPublicContactIPv4("93.184.216.34"),true);
  await assert.rejects(resolvePublicContactAddress("alpha.example",{lookup:async()=>[
    {address:"93.184.216.34"},{address:"127.0.0.1"}]}),/CONTACT_PRIVATE_ADDRESS/);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /private\nAllow: /private/contacts$","/private/contacts"),true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /private","/private/contacts"),false);
  assert.equal(robotsAllows("User-agent: *\nDisallow:\nUser-agent: RegionalResearchContact\nDisallow: /","/contacts"),false);
  const calls=[];
  const mock=async(url,ip)=>{
    calls.push([url,ip]);
    if(url.endsWith("/robots.txt"))return {status:404,headers:{},body:Buffer.alloc(0)};
    return {status:302,headers:{location:"https://other.example/contacts"},body:Buffer.alloc(0)};
  };
  const client=createPublicContactHttp({resolve:async()=>"93.184.216.34",request:mock,
    schedule:task=>task()});
  await assert.rejects(client.fetch(contact),/CONTACT_REDIRECT_UNSAFE/);
  assert.equal(calls.length,2);
  assert.equal(calls.every(x=>x[1]==="93.184.216.34"),true);
  const denied=createPublicContactHttp({resolve:async()=>"93.184.216.34",
    request:async url=>({status:200,headers:{"content-type":"text/plain"},
      body:Buffer.from("User-agent: *\nDisallow: /contacts")}),schedule:task=>task()});
  await assert.rejects(denied.fetch(contact),/CONTACT_ROBOTS_DENIED/);
  assert.equal(denied.requests,1);
});
test("crawler visits only saved source and actual same-host contact/requisite link; exact evidence fills three independent fields",async()=>{
  const row=company(),calls=[];
  const client={get requests(){return calls.length;},get exhausted(){return false;},
    async fetch(url){calls.push(url);return {status:200,url,
      html:url===contact?contactHtml:identityHtml};}};
  const observed=await lookupPublicCompanyContacts(row,client);
  assert.deepEqual(calls,[contact,identity]);
  assert.equal(observed.facts.length,3);
  const r=result([row]);
  const gains=applyPublicContactFacts(row,observed.facts,{owners:publicContactOwnership(r)});
  assert.deepEqual(gains,{phone:1,email:1,leader:1,department:1,conflicts:0});
  assert.equal(row["Телефон"],"74951234567 (отдел закупок)");
  assert.equal(row["Электронная почта"],"sales@alpha.example");
  assert.equal(row.__evidence.public_contact_facts.length,3);
  assert.equal(planPublicContactEnrichment(r).eligible,0);
});
test("new sources reopen only one company; source attempts, partial budget and checkpoint resume retain previous results",async()=>{
  const a=company(),b=company({"Организация":"ООО Бета","ИНН":otherInn,__canonical_id:"b"});
  const r=result([a,b]),env={PUBLIC_CONTACTS_ENABLED:"true",PUBLIC_CONTACTS_CHECKPOINT_EVERY:"1",
    PUBLIC_CONTACTS_MAX_COMPANIES:"1"};
  let calls=0,saved;
  const lookup=async()=>{calls++;return {reason:"identity_unproven",facts:[]};};
  const factory=()=>({requests:calls,exhausted:false});
  const first=await runPublicContactEnrichment({result:r,env,lookup,clientFactory:factory,
    onCheckpoint:x=>{saved=structuredClone(x);}});
  assert.equal(calls,1);assert.equal(first.stats.processed,1);
  assert.equal(first.stats.pending,1);
  const second=await runPublicContactEnrichment({result:r,env:{...env,PUBLIC_CONTACTS_MAX_COMPANIES:"2"},
    priorOutcomes:saved.outcomes,previousStats:saved.stats,lookup,clientFactory:factory});
  assert.equal(calls,2);assert.equal(second.stats.processed,2);
  assert.equal(planPublicContactEnrichment(r,{priorOutcomes:second.outcomes}).eligible,0);
  a.__evidence.public_contact_site_hints=["https://new-alpha.example/contacts"];
  assert.equal(planPublicContactEnrichment(r,{priorOutcomes:second.outcomes}).eligible,1);
  assert.equal(planPublicContactEnrichment(result([a,{...a}])).duplicate_identity,2);
  let paused=false,committed=0;
  await assert.rejects(runPublicContactEnrichment({result:r,env,
    clientFactory:factory,lookup:async()=>{paused=true;return {reason:"identity_unproven",facts:[]};},
    shouldPause:()=>paused,onCheckpoint:async x=>{committed=x.stats.processed;throw Error("safe-pause");}}),/safe-pause/);
  assert.equal(committed,1);
});
test("FNS accepts only exact current official extract proof; mismatch and source error never become a contact",async()=>{
  const row=company(),record={inn,ogrn:"1027700132195",kpp:"770701001",
    full_name:'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "АЛЬФА"',short_name:name,active:true};
  const proof={kind:"fns_extract",url:"https://egrul.nalog.ru/index.html",record,
    extract:{sha256:"a".repeat(64),date:"25.11.2026",number:"ЮЭ123456",page_count:2,
      status_basis:"complete_extract_no_adverse_status"},
    contact_facts:[{field:"Электронная почта",value:"office@alpha.example",excerpt:"Адрес электронной почты: office@alpha.example"}]};
  const lookup={pages:2,search:async()=>({state:"observed",complete:true,allCardsRead:true,records:[{record}]}),
    confirm:async()=>proof};
  assert.equal((await lookupFnsCompanyContacts(row,lookup)).facts.length,1);
  assert.equal((await lookupFnsCompanyContacts(row,{...lookup,
    confirm:async()=>({...proof,record:{...record,inn:otherInn}})})).facts.length,0);
  const r=result([row]);let closed=false;
  const done=await runFnsContactEnrichment({result:r,env:{PUBLIC_CONTACTS_FNS_ENABLED:"true"},
    sessionRunner:async task=>{try{return await task(lookup);}finally{closed=true;}}});
  assert.equal(done.stats.email_added,1);assert.equal(closed,true);
  assert.equal(row["Электронная почта"],"office@alpha.example");
});
