import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {inspectScopedSabyEmptyDOM,scopedSabyEmptyConfirmed} from "../src/sabyScopedSearchEmpty.js";
const before={scope:"company_tabs",inputExact:false,empty:false,busy:false};
const sample={scope:"company_tabs",inputExact:true,empty:true,busy:false};
const options={settled:true,observed:0,onListRoute:true};
test("only new stable scoped empty after exact successful query can end a search early",()=>{
  assert.equal(scopedSabyEmptyConfirmed(before,sample,sample,options),true);
  for(const change of [{inputExact:true},{empty:true},{scope:""}])
    assert.equal(scopedSabyEmptyConfirmed({...before,...change},sample,sample,options),false);
  for(const change of [{inputExact:false},{empty:false},{busy:true},{scope:"named_company_search"}])
    assert.equal(scopedSabyEmptyConfirmed(before,sample,{...sample,...change},options),false);
  for(const change of [{settled:false},{observed:1},{observed:undefined},{onListRoute:false}])
    assert.equal(scopedSabyEmptyConfirmed(before,sample,sample,{...options,...change}),false);
  assert.equal(scopedSabyEmptyConfirmed(null,sample,sample,options),false);
});
function fixture({scope=true,hidden=false,selected="Компании",busy=false,label="Не найдено",duplicate=false}={}){
  const make=(text="",attrs={})=>({isConnected:true,children:[],textContent:text,innerText:text,
    getAttribute:k=>attrs[k]??null,getClientRects:()=>[{}],querySelectorAll:()=>[]});
  const input={...make(),value:"1659029846"};
  const tabs=["Компании","Владельцы","Управляющие"].map(t=>make(t,{"aria-selected":t===selected?"true":"false"}));
  const msg=make(label);
  if(hidden)msg.getClientRects=()=>[];
  const spinner=make();
  const root={...make(tabs.map(t=>t.innerText).join(" ")+" "+label),
    querySelectorAll:q=>q.startsWith("input")?[input]:q==='[role="tab"]'?tabs:q==="*"?[input,...tabs,msg]:busy?[spinner]:[]};
  const document={querySelectorAll:()=>scope?(duplicate?[root,root]:[root]):[]};
  const result=vm.runInNewContext("("+inspectScopedSabyEmptyDOM.toString()+")({inn:'1659029846'})",{
    document,getComputedStyle:()=>({display:"block",visibility:"visible",opacity:"1"})});
  return JSON.parse(JSON.stringify(result));
}
test("DOM probe rejects hidden, unrelated, ambiguous and noncompany messages",()=>{
  assert.deepEqual(fixture(),sample);
  assert.equal(fixture({hidden:true}).empty,false);
  assert.equal(fixture({scope:false}).scope,"");
  assert.equal(fixture({duplicate:true}).scope,"");
  assert.equal(fixture({selected:"Владельцы"}).scope,"");
  assert.equal(fixture({busy:true}).busy,true);
  assert.equal(fixture({label:"Не найдено в связанных компаниях"}).empty,false);
  assert.equal(fixture({label:"Сервис временно недоступен"}).busy,true);
  assert.doesNotMatch(JSON.stringify(fixture()),/1659029846|Не найдено/);
});
