import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  inspectSabySearchDOM,classifySabySearchZeroState,readSabySearchState
} from "../src/sabySearchState.js";

const stable={inputExact:true,explicitEmpty:true,
  spinnerVisible:false,serviceError:false};

test("Saby explicit no-results needs two stable, exact-query, unloaded samples",()=>{
  assert.equal(classifySabySearchZeroState(stable,stable),
    "confirmed_empty");
  assert.equal(classifySabySearchZeroState(stable,stable,{
    onListRoute:false}),"uncertain");
  for(const change of [
    {inputExact:false},{explicitEmpty:false},{spinnerVisible:true},
    {serviceError:true}
  ]){
    assert.equal(classifySabySearchZeroState(stable,{...stable,...change}),
      "uncertain");
  }
  assert.equal(classifySabySearchZeroState(null,stable),"uncertain");
  assert.equal(classifySabySearchZeroState(stable,null),"uncertain");
});

test("two visible provider service errors are systemic, not a company absence",()=>{
  const error={inputExact:true,explicitEmpty:false,
    spinnerVisible:false,serviceError:true};
  assert.equal(classifySabySearchZeroState(error,error),"service_unavailable");
  assert.equal(classifySabySearchZeroState(error,{...error,serviceError:false}),
    "uncertain");
  assert.equal(classifySabySearchZeroState(error,error,{onListRoute:false}),
    "uncertain");
});

test("two stable busy exact-INN samples after the search timeout are a systemic stall",()=>{
  const busy={inputExact:true,explicitEmpty:false,
    serviceError:false,spinnerVisible:true};
  assert.equal(classifySabySearchZeroState(busy,busy),"loading_stalled");
  assert.equal(classifySabySearchZeroState(busy,busy,
    {onListRoute:false}),"uncertain");
  for(const changed of [
    {inputExact:false},{spinnerVisible:false},{explicitEmpty:true},
    {serviceError:true}
  ]){
    assert.equal(classifySabySearchZeroState(busy,{...busy,...changed}),
      "uncertain","a single non-busy or inconsistent sample must not be considered a stall");
  }
  assert.equal(classifySabySearchZeroState({...busy,spinnerVisible:false},
    busy),"uncertain");
  const explicit={...busy,explicitEmpty:true};
  assert.equal(classifySabySearchZeroState(explicit,explicit),"uncertain",
    "the visible empty banner with a spinner is ambiguous, never accepted as absence");
});

test("Saby DOM probe is self-contained in page.evaluate; never returns the INN or text",async()=>{
  const inn="4718000935";
  const input={
    value:inn,type:"text",isConnected:true,
    hasAttribute:()=>false,getClientRects:()=>[{}],
    children:[],textContent:""
  };
  const msg={
    value:undefined,isConnected:true,getClientRects:()=>[{}],
    children:[],textContent:"Ничего не найдено"
  };
  const hidden={
    ...msg,
    getClientRects:()=>[],
    textContent:"Слишком много запросов"
  };
  const doc={
    querySelectorAll(selector){
      if(selector.startsWith("input[type="))return [input];
      if(selector==="body *")return [msg,hidden];
      return [];
    }
  };
  const output=vm.runInNewContext(
    "("+inspectSabySearchDOM.toString()+")({inn})",{
      document:doc,inn,getComputedStyle:()=>({
        visibility:"visible",display:"block"
      })
    });
  assert.deepEqual(JSON.parse(JSON.stringify(output)),{
    inputExact:true,explicitEmpty:true,
    serviceError:false,spinnerVisible:false
  });
  assert.doesNotMatch(JSON.stringify(output),new RegExp(inn));
  const fakePage={evaluate:async (fn,args)=>vm.runInNewContext(
    "("+fn.toString()+")("+JSON.stringify(args)+")",{
      document:doc,getComputedStyle:()=>({
        visibility:"visible",display:"block"
      })
    })
  };
  assert.deepEqual(await readSabySearchState(fakePage,inn),{
    inputExact:true,explicitEmpty:true,
    serviceError:false,spinnerVisible:false
  });
});

test("hidden and unrelated Saby empty messages are not grounds for skipping an INN",()=>{
  const inputs=[{value:"4718000935",type:"text",isConnected:true,
    children:[],hasAttribute:()=>false,getClientRects:()=>[{}]}];
  const hidden={textContent:"Ничего не найдено",
    isConnected:true,children:[],getClientRects:()=>[]};
  const unrelated={textContent:"Ничего не найдено в связанных компаниях",
    isConnected:true,children:[],getClientRects:()=>[{}]};
  const document={
    querySelectorAll:selector=>
      selector.startsWith("input[type=")?inputs:
      selector==="body *"?[hidden,unrelated]:[]
  };
  const value=vm.runInNewContext(
    "("+inspectSabySearchDOM.toString()+")({inn:'4718000935'})",{
      document,getComputedStyle:()=>({display:"block",visibility:"visible"})
    });
  assert.equal(value.inputExact,true);
  assert.equal(value.explicitEmpty,false);
});
