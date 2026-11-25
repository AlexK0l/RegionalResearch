import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {runResearchPipeline} from "../src/pipeline.js";
import {canResumeFromCompletedContacts} from "../src/lateCheckpointResume.js";

const uuid="f018225f-4270-4088-8914-283b3f57daba";
const row=()=>({
  "Организация":"ООО Тест",
  "ИНН":"7707083893",
  "Основание":"C — предполагаемый транспортный покупатель",
  "Наличие транспорта":"","Электронная почта":"","Телефон":"",
  __final_grade:"C",
  __evidence:{source_urls:[],notes:[]}
});
function checkpoint(phase="contacts"){
  return {
    version:1,pipeline_version:1,
    region:"Ленинградская область",source_mode:"full",
    phase,completed_stage:9,
    parts:[],stage11_completed:phase==="contacts",
    contact_completed_ids:["test:1"],
    contact_unsearched_ids:["test:2"],
    contact_stats:{version:2,ok:1,unavailable:0,notFound:0,
      unsearched:1,primaryProcessed:1},
    final_quality_gate:{
      active_commercial_records:1,grades:{A:0,B:0,C:1},
      review_records:0,excluded_records:0
    },
    final_result:{
      direct_buyers:[row()],intermediaries:[],
      leasing:[],statistics:[]
    }
  };
}
function job(cp){
  const history={saved:[],progress:[]};
  const data={
    id:uuid,region:"Ленинградская область",mode:"resume",
    data:{sourceJobId:uuid,checkpoint:structuredClone(cp)},
    cancelled:false,abortController:new AbortController(),
    updateProgress:async x=>history.progress.push(structuredClone(x)),
    updateCheckpoint:async x=>history.saved.push(structuredClone(x))
  };
  return {job:data,history};
}

test("only completed Stage11 and later complete snapshots skip paid Stage10",()=>{
  const cp=checkpoint();
  assert.equal(canResumeFromCompletedContacts(cp),true);
  assert.equal(canResumeFromCompletedContacts({...cp,stage11_completed:false}),false);
  assert.equal(canResumeFromCompletedContacts({...cp,phase:"statistics"}),false);
  assert.equal(canResumeFromCompletedContacts({...cp,phase:"final_inn"}),false);
  assert.equal(canResumeFromCompletedContacts({...cp,contact_stats:null}),false);
  assert.equal(canResumeFromCompletedContacts({...cp,final_result:null}),false);
  assert.equal(canResumeFromCompletedContacts({...cp,source_mode:"saby"}),false);
  assert.equal(canResumeFromCompletedContacts({...cp,phase:"saby",stage11_completed:false}),true);
  assert.equal(canResumeFromCompletedContacts({...cp,phase:"priority",stage11_completed:false}),true);
});

test("saved finished Stage11 resumes directly at Stage12/13, no paid contacts",async()=>{
  const cp=checkpoint(),before=structuredClone(cp);
  const oldStage13=process.env.STAGE13_AI_ENABLED;
  const oldSaby=process.env.SABY_STAGE12_ENABLED;
  try{
    process.env.STAGE13_AI_ENABLED="false";
    process.env.SABY_STAGE12_ENABLED="false";
    const {job:data,history}=job(cp);
    const out=await runResearchPipeline({job:data,apiKey:"sk-test-no-network"});
    assert.equal(out.mode,"resume");
    assert.equal(out.counts.direct_buyers,1);
    assert.equal(out.saby?.enabled,undefined);
    assert.equal(out.contacts.unsearched,1);
    assert.equal(history.saved.at(-1).phase,"completed");
    assert.equal(history.saved.at(-1).stage11_completed,true);
    assert.equal(history.saved.at(-1).contact_unsearched_ids[0],"test:2");
    assert.deepEqual(cp,before,"original source must not change");
    assert.ok(history.progress.some(x=>x.statuses[9].status==="done"&&
      x.statuses[10].status==="done"));
    assert.equal(history.progress.some(x=>
      x.statuses[9].status==="running"),false);
    assert.equal(history.saved.some(x=>
      ["enrichment","statistics","contacts","final_inn"].includes(x.phase)),false);
  }finally{
    if(oldStage13===undefined)delete process.env.STAGE13_AI_ENABLED;
    else process.env.STAGE13_AI_ENABLED=oldStage13;
    if(oldSaby===undefined)delete process.env.SABY_STAGE12_ENABLED;
    else process.env.SABY_STAGE12_ENABLED=oldSaby;
  }
});

test("saved full Stage13 priority finishes entirely offline without Stage10/11 replay",async()=>{
  const cp={...checkpoint("priority"),
    saby_stats:{enabled:true,processed:1,deferred:0},
    priority_ai_stats:{version:1,calls:0,classified:0,cached:0,deferred:0,
      stopped_reason:""}
  };
  const source=structuredClone(cp);
  const {job:data,history}=job(cp);
  const out=await runResearchPipeline({job:data,apiKey:"sk-test-no-network"});
  assert.equal(out.counts.direct_buyers,1);
  assert.equal(out.mode,"resume");
  assert.equal(history.saved.length,1);
  assert.equal(history.saved[0].phase,"completed");
  assert.equal(history.saved[0].offline_recovery.new_openai_calls,0);
  assert.equal(history.saved[0].offline_recovery.sqlite_writes,0);
  assert.deepEqual(cp,source);
  assert.equal(history.progress.some(x=>x.statuses[9].status==="running"),false);
});

test("partial Saby checkpoint reuses verified company and deferred INN",async()=>{
  const cp={...checkpoint("saby"),stage11_completed:false,
    saby_completed_inns:["7707083893"],
    saby_deferred_inns:["7702070139"],
    saby_attempted_inns:["7702070139"],
    saby_stats:{enabled:true,processed:2,deferred:1}
  };
  const oldSaby=process.env.SABY_STAGE12_ENABLED;
  const oldAI=process.env.STAGE13_AI_ENABLED;
  try{
    process.env.SABY_STAGE12_ENABLED="false";
    process.env.STAGE13_AI_ENABLED="false";
    const {job:data,history}=job(cp);
    await runResearchPipeline({job:data,apiKey:"sk-test-no-network"});
    assert.deepEqual(history.saved.at(-1).saby_deferred_inns,["7702070139"]);
    assert.deepEqual(history.saved.at(-1).saby_completed_inns,["7707083893"]);
    assert.equal(history.saved.at(-1).phase,"completed");
  }finally{
    if(oldSaby===undefined)delete process.env.SABY_STAGE12_ENABLED;
    else process.env.SABY_STAGE12_ENABLED=oldSaby;
    if(oldAI===undefined)delete process.env.STAGE13_AI_ENABLED;
    else process.env.STAGE13_AI_ENABLED=oldAI;
  }
});

test("regular stage11 saves explicit final-quality and contact completion marker",()=>{
  const source=fs.readFileSync(new URL("../src/pipeline.js",import.meta.url),"utf8");
  assert.match(source,/await contactCheckpointBatcher\.flush\(\)/);
  assert.match(source,/await persistCheckpoint\("contacts",\{\s*completed_stage:9,stage11_completed:true/);
  assert.match(source,/final_result:finalResult,final_quality_gate:finalQuality\.report/);
  assert.match(source,/contact_unsearched_ids:\[\.\.\.contactUnsearched\]/);
  assert.match(source,/CHECKPOINT_PHASE_REGRESSION_BLOCKED/);
  assert.match(source,/canResumeFromCompletedContacts\(resumeCheckpoint\)/);
});

test("post-Saby public-contact pause resumes without starting Saby or paid contact work again",async()=>{
  const cp={...checkpoint("saby"),stage11_completed:true,
    public_contact_post_saby_ready:true,saby_stats:{enabled:true,processed:1,deferred:1},
    saby_completed_inns:[],saby_deferred_inns:["7707083893"],
    saby_attempted_inns:["7707083893"]};
  const previous={};
  for(const name of ["SABY_STAGE12_ENABLED","GIRBO_STAGE_ENABLED","PUBLIC_CONTACTS_ENABLED",
    "PUBLIC_CONTACTS_FNS_ENABLED","STAGE13_AI_ENABLED"])previous[name]=process.env[name];
  try{
    process.env.SABY_STAGE12_ENABLED="true";
    process.env.GIRBO_STAGE_ENABLED="true";
    process.env.PUBLIC_CONTACTS_ENABLED="false";
    process.env.PUBLIC_CONTACTS_FNS_ENABLED="false";
    process.env.STAGE13_AI_ENABLED="false";
    const {job:data,history}=job(cp);
    const out=await runResearchPipeline({job:data,apiKey:"sk-test-no-network"});
    assert.equal(out.saby.processed,1);
    assert.deepEqual(history.saved.at(-1).saby_deferred_inns,cp.saby_deferred_inns);
    assert.equal(history.saved.at(-1).phase,"completed");
  }finally{
    for(const [name,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
  }
});
