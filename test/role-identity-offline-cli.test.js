import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import XLSX from "xlsx";

const script=fileURLToPath(new URL("../scripts/audit-role-identity-offline.js",import.meta.url));

test("offline role audit exports XLSX and JSON without changing original replay",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"role-identity-"));
 try {
   const input=path.join(dir,"replay.json");
   const output=path.join(dir,"audit");
   const data={checkpoint:"f677c97e-synthetic",rows:[
     {canonical_id:"a",organization:"Журнал «ЛесПромИнформ»",sheet:"direct_buyers",
       replay_grade:"C",inn:"",source_urls:["https://lesprominform.ru"],
       evidence_notes:["Роль — discovery-канал; конечными потенциальными покупателями являются указанные предприятия.",
         "Подтверждённый ИНН: 6731069440"]},
     {canonical_id:"b",organization:"АО «Спецавтохозяйство»",sheet:"direct_buyers",
       replay_grade:"B",inn:"6731069440",source_urls:["https://sah67.ru"],evidence_notes:[]}
   ]};
   fs.writeFileSync(input,JSON.stringify(data),"utf8");
   const before=fs.readFileSync(input);
   const run=spawnSync(process.execPath,[script,input,"--out="+output],
     {encoding:"utf8",timeout:45000});
   assert.equal(run.status,0,"CLI failure "+run.stderr);
   assert.deepEqual(fs.readFileSync(input),before);
   const audit=JSON.parse(fs.readFileSync(path.join(output,"role_identity_f677c97e.json"),"utf8"));
   assert.equal(audit.summary.role_issues,1);
   assert.equal(audit.summary.candidate_rows_without_inn,1);
   assert.equal(audit.openai_calls,0);
   const wb=XLSX.readFile(path.join(output,"role_identity_f677c97e.xlsx"));
   assert.ok(wb.SheetNames.includes("Противоречия ИНН"));
   assert.ok(wb.SheetNames.includes("Несовпадения ролей"));
   const attempts=spawnSync(process.execPath,[script,input,"--out="+output],
     {encoding:"utf8",timeout:45000});
   assert.notEqual(attempts.status,0,"Existing report must not be overwritten");
   assert.deepEqual(fs.readFileSync(input),before);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
