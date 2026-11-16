import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFinalBatchDelta,applyFinalQa,mergeQaRecordRows
} from "../src/pipeline.js";

const row=(email,id="k1")=>({
  "Организация":"ООО Эталон","ИНН":"7707083893",
  "Электронная почта":email,
  "Телефон":"79991112233","Основание":"C — перевозчик",
  __canonical_id:id,__evidence:{
    source_urls:["https://company.example/contacts"],notes:[],
    facts:[]
  },__comment:"Email: "+email
});

test("stage10 final batch delta cannot erase an address from discovery",()=>{
  const canonical={
    canonical_id:"k1",source_sheets:["direct_buyers"],
    evidence:[{data:row("sales@example.ru")}]
  };
  const delta={items:[{
    canonical_id:"k1",sheet:"direct_buyers",decision:"keep",
    changes:[{field:"Электронная почта",value:""}]
  }]};
  const out=applyFinalBatchDelta([canonical],delta);
  assert.equal(out.direct_buyers.length,1);
  assert.equal(out.direct_buyers[0]["Электронная почта"],"sales@example.ru");
  const extra=applyFinalBatchDelta([canonical],{
    items:[{...delta.items[0],changes:[{
      field:"Электронная почта",value:"info@example.ru"
    }]}]
  });
  assert.equal(extra.direct_buyers[0]["Электронная почта"],
    "sales@example.ru; info@example.ru");
});

test("final QA patch with missing/updated email is monotonic",()=>{
  const current=row("sales@example.ru"),items=[{
    id:"q000001",canonical_id:"k1",sheet:"direct_buyers",row:current
  }];
  const blanks=applyFinalQa(items,{patches:[{
    id:"q000001",fields:{"Электронная почта":""}
  }]});
  assert.equal(blanks.direct_buyers[0]["Электронная почта"],
    "sales@example.ru");
  const updated=applyFinalQa(items,{patches:[{
    id:"q000001",changes:[{field:"Электронная почта",value:"new@example.ru"}]
  }]});
  assert.equal(updated.direct_buyers[0]["Электронная почта"],
    "new@example.ru; sales@example.ru");
  assert.equal(current["Электронная почта"],"sales@example.ru",
    "QA must never mutate the input row");
});

test("dedupe retains two independently verified addresses of one legal entity",()=>{
  const one={id:"q1",sheet:"direct_buyers",row:row("sales@example.ru","k1")};
  const two={id:"q2",sheet:"direct_buyers",row:row("shipping@example.ru","k2")};
  const merged=mergeQaRecordRows([one,two]);
  assert.equal(merged.row["ИНН"],"7707083893");
  assert.equal(merged.row["Электронная почта"],
    "sales@example.ru; shipping@example.ru");
  assert.equal(one.row["Электронная почта"],"sales@example.ru");
  assert.equal(two.row["Электронная почта"],"shipping@example.ru");
});
