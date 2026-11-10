import test from "node:test";
import assert from "node:assert/strict";
import {
  sabyPublicProfileCandidate,chooseSabyPublicProfile,
  discoverSabyPublicProfileByInn
} from "../src/sabyPublicSearch.js";

const INN="6700018766",KPP="670001001";
const URL="https://saby.ru/profile/"+INN+"-"+KPP;

test("only exact canonical first-party Saby public INN/KPP links are accepted",()=>{
  assert.deepEqual(sabyPublicProfileCandidate(URL,INN),{url:URL,kpp:KPP});
  for(const raw of [
    "https://fake.example/profile/"+INN+"-"+KPP,
    "https://saby.ru.evil.example/profile/"+INN+"-"+KPP,
    "https://user:secret@saby.ru/profile/"+INN+"-"+KPP,
    "http://saby.ru/profile/"+INN+"-"+KPP,
    "https://saby.ru/profile/"+INN+"-67000100",
    "https://saby.ru/profile/"+INN+"-6700010011",
    "https://saby.ru/profile/67000187660-"+KPP,
    "https://saby.ru/profile/"+INN+"-"+KPP+"/related",
    "https://saby.ru:444/profile/"+INN+"-"+KPP
  ]) assert.equal(sabyPublicProfileCandidate(raw,INN),null,raw);
  assert.equal(sabyPublicProfileCandidate(URL,"6700018767"),null);
});

test("public search never chooses between different KPP profiles of the same INN",()=>{
  const both=chooseSabyPublicProfile([
    URL,"https://saby.ru/profile/"+INN+"-670001002"
  ],INN);
  assert.equal(both.status,"ambiguous");
  assert.equal(both.candidate,null);
  assert.equal(both.count,2);
  const repeated=chooseSabyPublicProfile([URL,URL+"/",URL+"?anchor=info"],INN);
  assert.equal(repeated.status,"unique");
  assert.equal(repeated.count,1);
  assert.deepEqual(repeated.candidate,{url:URL,kpp:KPP});
  assert.equal(chooseSabyPublicProfile(["https://evil.example/"+INN],INN).status,"missing");
});

function mockedPublicSearch({
  anchors=[URL],resultRoute="https://saby.ru/profile/results",
  beforeEnter=[],origin="https://saby.ru/profile"
}={}) {
  let opened=0,closed=0,fillValue="",entered=false,presses=0;
  const input={
    isVisible:async()=>true,isEnabled:async()=>true,
    evaluate:async fn=>fn({
      tagName:"INPUT",
      getAttribute:key=>({
        type:"text",placeholder:"Компания, ИНН или руководитель"
      })[key]||null,
      isContentEditable:false
    }),
    fill:async value=>{fillValue=value;},
    press:async key=>{
      if(key==="Enter"){presses++;entered=true;}
    }
  };
  const page={
    context:()=>({newPage:async()=>{
      opened++;
      return {
        goto:async()=>{},
        url:()=>entered?resultRoute:origin,
        locator:()=>({
          count:async()=>1,nth:()=>input
        }),
        evaluate:async()=>entered?anchors:beforeEnter,
        close:async()=>{closed++;}
      };
    }})
  };
  return {page,stats:()=>({opened,closed,fillValue,entered,presses})};
}

test("public Saby company search discovers exact INN/KPP after entering INN",async()=>{
  const {page,stats}=mockedPublicSearch();
  const result=await discoverSabyPublicProfileByInn(page,INN,{timeoutMs:3000});
  assert.deepEqual(result,{status:"unique",candidate:{url:URL,kpp:KPP},count:1});
  assert.deepEqual(stats(),{opened:1,closed:1,fillValue:INN,entered:true,presses:1});
});

test("public Saby company search finds unique suggestion href before Enter",async()=>{
  const {page,stats}=mockedPublicSearch({
    beforeEnter:[URL],anchors:[]
  });
  const result=await discoverSabyPublicProfileByInn(page,INN,{timeoutMs:3000});
  assert.equal(result.status,"unique");
  assert.equal(stats().presses,0);
  assert.equal(stats().closed,1);
});

test("public Saby company search rejects ambiguous candidates and closes tab",async()=>{
  const {page,stats}=mockedPublicSearch({
    anchors:[URL,"https://saby.ru/profile/"+INN+"-670001002"]
  });
  const result=await discoverSabyPublicProfileByInn(page,INN,{timeoutMs:3000});
  assert.equal(result.status,"ambiguous");
  assert.equal(result.candidate,null);
  assert.deepEqual(stats(),{opened:1,closed:1,fillValue:INN,entered:true,presses:1});
});

test("public Saby company search refuses third party landing origin",async()=>{
  const {page,stats}=mockedPublicSearch({
    origin:"https://evil.example/profile"
  });
  const result=await discoverSabyPublicProfileByInn(page,INN,{timeoutMs:3000});
  assert.equal(result.status,"untrusted_search_origin");
  assert.equal(result.candidate,null);
  assert.deepEqual(stats(),{opened:1,closed:1,fillValue:"",entered:false,presses:0});
});
