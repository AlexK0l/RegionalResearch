import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

test("SQLite upsert leaves large caller checkpoint immutable and preserves every section",()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"rr-checkpoint-memory-"));
  const dbPath=path.join(temp,"checkpoint.sqlite");
  const repo=fileURLToPath(new URL("../",import.meta.url));
  const script=`
    import assert from "node:assert/strict";
    import {saveCheckpoint,loadCheckpoint} from "./src/checkpointStore.js";
    const id="b0a85dd8-6f3a-4988-a143-30e2b5a9e6ca";
    const cp={
      version:1,region:"Тестовый регион",source_mode:"full",phase:"contacts",
      stage11_completed:true,contact_completed_ids:["a","b"],
      contact_unsearched_ids:["c"],
      contact_stats:{version:2,ok:2,unsearched:1},
      final_result:{
        direct_buyers:Array.from({length:150},(_,i)=>({
          "Организация":"ООО Тест "+i,"ИНН":"",
          "__evidence":{notes:[("evidence "+i).repeat(50)]}
        })),
        intermediaries:[],leasing:[],statistics:[]
      }
    };
    const snapshot=JSON.stringify(cp);
    await saveCheckpoint(id,cp);
    assert.equal(JSON.stringify(cp),snapshot);
    assert.equal(cp.pipeline_version,undefined);
    const loaded=await loadCheckpoint(id);
    assert.equal(loaded.pipeline_version,1);
    assert.equal(loaded.final_result.direct_buyers.length,150);
    assert.equal(loaded.contact_unsearched_ids[0],"c");
    cp.final_result.direct_buyers[0]["Организация"]="Изменён";
    const still=await loadCheckpoint(id);
    assert.equal(still.final_result.direct_buyers[0]["Организация"],"ООО Тест 0");
    await saveCheckpoint(id,cp);
    const latest=await loadCheckpoint(id);
    assert.equal(latest.final_result.direct_buyers[0]["Организация"],"Изменён");
    console.log("sqlite_checkpoints_immutable_ok");
  `;
  try{
    const run=spawnSync(process.execPath,["--input-type=module","-e",script],{
      cwd:repo,
      env:{...process.env,CHECKPOINT_DB_PATH:dbPath},
      encoding:"utf8",timeout:12000
    });
    assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,/sqlite_checkpoints_immutable_ok/);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
