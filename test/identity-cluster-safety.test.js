import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveClusterWithoutWeb,applyIdentityResult,extractInnFromEvidenceNotes
} from "../src/pipeline.js";

const make=(id,name,inn="",notes=[],urls=[])=>({
  candidate_id:id,source_step:1,source_sheet:"direct_buyers",
  data:{
    "Организация":name,"ИНН":inn,"Город/район":"Смоленская область",
    "__evidence":{source_urls:urls,notes}
  }
});
const cluster=items=>({cluster_id:"i000001",items});

test("discovery cluster does not assign the verified INN of one company to a same-name neighbour",()=>{
  const a=make("a","ООО «Альфа-Транс»","6732114166",
    ["ООО «Альфа-Транс», ИНН 6732114166."],["https://registry.example.org/a"]);
  const b=make("b","ООО «Альфа-Транс»","",
    ["Найдена одноимённая транспортная компания."],["https://directory.example.org/b"]);
  const output=resolveClusterWithoutWeb(cluster([a,b]));
  assert.equal(output[0].data["ИНН"],"6732114166");
  assert.equal(output[1].data["ИНН"],"");
  assert.equal(output[1].data.__evidence.source_urls.length,1);
  assert.deepEqual([a,b].map(x=>x.data["ИНН"]),["6732114166",""]);
});

test("a note about a foreign party to a contract is not own-company INN proof",()=>{
  const note="ООО «АГРО-ФОРС» покупает услуги у ООО «Кроношпан», ИНН 5011021227.";
  const row=make("a","ООО «АГРО-ФОРС»","",[note]).data;
  assert.equal(extractInnFromEvidenceNotes(row),"");
  assert.equal(resolveClusterWithoutWeb(cluster([make("a","ООО «АГРО-ФОРС»","",[note])]))[0].data["ИНН"],"");
});

test("one self-named evidence note may recover a syntactically valid INN offline",()=>{
  const note="ООО «Кардымовский комбинат» ИНН: 6708000520, адрес: Смоленская область.";
  const row=make("one","ООО «Кардымовский комбинат»","",[note]);
  const output=resolveClusterWithoutWeb(cluster([row]))[0];
  assert.equal(extractInnFromEvidenceNotes(row.data),"6708000520");
  assert.equal(output.data["ИНН"],"6708000520");
  assert.ok(output.data.__evidence.notes.some(x=>x.includes("первичный источник не перепроверен")));
});

test("a legal entity in a model response cannot rename an unrelated applicant",()=>{
  const row=make("k1","ООО «АГРО-ФОРС»","",
    ["Перевозка зерна."],["https://agro.example.org/"]);
  const output=applyIdentityResult(cluster([row]),{
    entities:[{
      candidate_ids:["k1"],confirmed_inn:"5011021227",
      legal_name:"ООО «Кроношпан»",city:"Смоленск",
      source_urls:["https://registry.example.org/kronospan"],
      note:"ИНН принадлежит иной организации."
    }]
  },"Смоленская область");
  assert.equal(output[0].data["Организация"],"ООО «АГРО-ФОРС»");
  assert.equal(output[0].data["ИНН"],"");
  assert.deepEqual(output[0].data.__evidence.source_urls,["https://agro.example.org/"]);
  assert.equal(output[0].data.__evidence.unmatched_identity_candidates.length,1);
});

test("a multi-candidate LLM merge cannot propagate one company's INN without each source",()=>{
  const source="https://registry.example.org/alpha";
  const a=make("k1","ООО «Альфа-Транс»","",[],[source]);
  const b=make("k2","ООО «Альфа-Транс»","",[],
    ["https://directory.example.org/other"]);
  const output=applyIdentityResult(cluster([a,b]),{
    entities:[{
      candidate_ids:["k1","k2"],confirmed_inn:"6732114166",
      legal_name:"ООО «Альфа-Транс»",city:"Смоленск",
      source_urls:[source],note:"ООО Альфа-Транс ИНН 6732114166."
    }]
  },"Смоленская область");
  assert.equal(output.find(x=>x.candidate_id==="k1").data["ИНН"],"6732114166");
  assert.equal(output.find(x=>x.candidate_id==="k2").data["ИНН"],"");
  assert.equal(output.find(x=>x.candidate_id==="k2").data.__evidence.source_urls.length,1);
});

test("model response with different valid INN flags conflict and retains original name and INN",()=>{
  const row=make("k1","ООО «Альфа-Транс»","6732114166");
  const output=applyIdentityResult(cluster([row]),{
    entities:[{
      candidate_ids:["k1"],confirmed_inn:"6732132711",
      legal_name:"ООО «Альфа-Транс»",city:"",
      source_urls:["https://registry.example.org/new"],note:"Other ID"
    }]
  },"Смоленская область");
  assert.equal(output[0].data["ИНН"],"6732114166");
  assert.equal(output[0].data.__evidence.legal_identity_conflicts[0].status,"manual_review_required");
});

test("a single self-named, sourced company remains recoverable from identity search",()=>{
  const row=make("k1","ООО «Альфа-Транс»","");
  const url="https://registry.example.org/company/6732114166";
  const output=applyIdentityResult(cluster([row]),{
    entities:[{
      candidate_ids:["k1"],confirmed_inn:"6732114166",
      legal_name:"ООО «Альфа-Транс»",city:"Смоленск",
      source_urls:[url],note:"Проверено по реквизитам."
    }]
  },"Смоленская область");
  assert.equal(output[0].data["ИНН"],"6732114166");
  assert.deepEqual(output[0].data.__evidence.identity_verification.source_urls,[url]);
});
