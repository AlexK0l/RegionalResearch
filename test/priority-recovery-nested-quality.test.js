import test from "node:test";
import assert from "node:assert/strict";
import {recoverPriorityCheckpointOffline}
  from "../src/priorityCheckpointRecovery.js";

test("offline recovery preserves QA report already nested in final_result",()=>{
  const qa={version:"2",active_commercial_records:1,
    review_records:0,excluded_records:0,grades:{A:0,B:0,C:1}};
  const cp={
    source_mode:"full",phase:"priority",region:"Тестовый регион",
    contact_stats:{version:2,ok:0},
    saby_stats:{enabled:true,processed:0},
    priority_ai_stats:{calls:0,cached:0,classified:0,deferred:0,stopped_reason:""},
    final_result:{
      direct_buyers:[{"Организация":"ООО «Тест»","ИНН":"",
        "Наличие транспорта":"","Основание":"C — целевой процесс",
        "__evidence":{source_urls:[],notes:[]}}],
      intermediaries:[],leasing:[],statistics:[],
      final_quality_gate:qa
    }
  };
  const snapshot=structuredClone(cp);
  const {recovered,summary}=recoverPriorityCheckpointOffline(cp,{jobId:"test"});
  assert.deepEqual(cp,snapshot);
  assert.equal(summary.final_quality_report_present,true);
  assert.equal(recovered.offline_recovery.final_quality_report_present,true);
  assert.deepEqual(recovered.final_quality_gate,qa);
  assert.deepEqual(recovered.final_result.final_quality_gate,qa);
  assert.notStrictEqual(recovered.final_quality_gate,cp.final_result.final_quality_gate);
  assert.equal(recovered.offline_recovery.new_openai_calls,0);
  assert.equal(recovered.phase,"completed");
});
