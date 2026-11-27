import test from "node:test";
import assert from "node:assert/strict";
import {readPilotConfig,discoveryRequest,inspectDiscovery,publicSearchArguments,
  searchRequest,inspectSearchPlan,approvalRequest,inspectSearchResult,runDiscovery,
  runManualSearch,sendResponses} from "../scripts/ai-workspace-mcp-pilot.mjs";

const env={OPENAI_API_KEY:"test-only-key",OPENAI_MODEL:"gpt-5.6-luna",
  AI_WORKSPACE_MCP_SERVER_URL:"https://mcp.example.test/mcp",
  AI_WORKSPACE_MCP_AUTHORIZATION:"test-only-token",AI_WORKSPACE_MCP_PROJECT_ID:"project-test"};
const config=()=>readPilotConfig(env);
const query="Public Test Company transport";
const schema={type:"object",properties:{project_id:{type:"string"},query:{type:"string"},
  limit:{type:"integer"}},required:["project_id","query"]};
const search={name:"google_search",input_schema:schema};
const list=(discovery=false)=>({type:"mcp_list_tools",id:"mcpl_test",server_label:"ai_workspace",
  tools:discovery?[{name:"list_shared_projects",input_schema:{type:"object"}},search]:[search]});
const plan=(args)=>({status:"completed",output:[list(),{type:"mcp_approval_request",
  server_label:"ai_workspace",name:"google_search",id:"mcpr_test",arguments:JSON.stringify(args)}]});
const result=(args)=>({status:"completed",output:[{type:"mcp_call",server_label:"ai_workspace",
  id:"mcp_test",name:"google_search",approval_request_id:"mcpr_test",status:"completed",
  arguments:JSON.stringify(args),output:'{"organic":[{"link":"https://company.example.test"}]}'}]});

test("configuration fails closed, supports HTTPS or a private Secure MCP Tunnel",()=>{
  assert.throws(()=>readPilotConfig({...env,AI_WORKSPACE_MCP_SERVER_URL:"http://localhost:8000"}),/HTTPS/);
  assert.throws(()=>readPilotConfig({...env,AI_WORKSPACE_MCP_SERVER_URL:"https://user:secret@example.test"}),/HTTPS/);
  assert.throws(()=>readPilotConfig({...env,AI_WORKSPACE_MCP_SERVER_URL:"https://example.test/?token=secret"}),/HTTPS/);
  assert.throws(()=>readPilotConfig({...env,AI_WORKSPACE_MCP_TUNNEL_ID:"tunnel_"+"a".repeat(32)}),/EXACTLY_ONE/);
  const c=readPilotConfig({...env,AI_WORKSPACE_MCP_SERVER_URL:"",
    AI_WORKSPACE_MCP_TUNNEL_ID:"tunnel_"+"a".repeat(32)});
  assert.equal(discoveryRequest(c).tools[0].tunnel_id,"tunnel_"+"a".repeat(32));
  assert.throws(()=>readPilotConfig({...env,OPENAI_API_KEY:""}),/KEY_REQUIRED/);
});

test("discovery imports only the two expected schemas, never grants approval",async()=>{
  let requests=0;
  const out=await runDiscovery(config(),{send:async(c,r)=>{
    requests++;
    assert.equal(r.store,false);
    assert.equal(r.tools[0].require_approval,"always");
    assert.deepEqual(r.tools[0].allowed_tools,["list_shared_projects","google_search"]);
    assert.equal(r.tools[0].authorization,env.AI_WORKSPACE_MCP_AUTHORIZATION);
    assert.ok(!JSON.stringify(r.input).includes(env.AI_WORKSPACE_MCP_PROJECT_ID));
    return {status:"completed",output:[list(true),{type:"mcp_approval_request",
      server_label:"ai_workspace",name:"list_shared_projects"}]};
  }});
  assert.equal(requests,1);
  assert.equal(out.approvalsSent,0);
  assert.equal(out.status,"MCP_DISCOVERY_OK");
  assert.throws(()=>inspectDiscovery({output:[{...list(true),error:"not initialized"}]}),/LIST_TOOLS/);
  assert.throws(()=>inspectDiscovery({output:[{...list(true),tools:[...list(true).tools,{name:"request_agent_run"}]}]}),/ALLOWLIST/);
  assert.throws(()=>inspectDiscovery({output:[list(true),{type:"mcp_call"}]}),/UNEXPECTED_EXECUTION/);
});

test("public query and exact project, query, limit are mandatory",()=>{
  const c=config(),args=publicSearchArguments(c,query);
  assert.throws(()=>publicSearchArguments(c,"private user@example.test"),/REJECTED/);
  assert.throws(()=>publicSearchArguments(c,"token=abc"),/REJECTED/);
  assert.throws(()=>publicSearchArguments(c,"public\nhidden"),/INVALID/);
  assert.throws(()=>publicSearchArguments({...c,projectId:""},query),/PROJECT_ID/);
  assert.throws(()=>searchRequest(c,{...args,limit:100}),/ARGUMENTS_INVALID/);
  for(const tampered of [{...args,query:"different"},{...args,project_id:"another"},
    {...args,limit:4},{...args,extra:true}]){
    assert.throws(()=>inspectSearchPlan(plan(tampered),args),/ARGUMENT_MISMATCH/);
  }
  assert.throws(()=>inspectSearchPlan({...plan(args),output:[...plan(args).output,plan(args).output[1]]},args),/ONE_APPROVAL/);
  assert.throws(()=>approvalRequest(c,searchRequest(c,args),plan(args),args,false),/OWNER_APPROVAL_REQUIRED/);
  const ambiguous=plan(args);
  ambiguous.output[1].arguments='{"query":"another",'+JSON.stringify(args).slice(1);
  assert.throws(()=>inspectSearchPlan(ambiguous,args),/MCP_ARGUMENTS_INVALID/);
  const spaced=plan(args);
  spaced.output[1].arguments=JSON.stringify(args,null,2);
  assert.deepEqual(inspectSearchPlan(spaced,args).arguments,args);
});

test("declining the exact proposal never sends a second request",async()=>{
  const c=config(),args=publicSearchArguments(c,query);
  let count=0;
  const out=await runManualSearch(c,query,{send:async()=>{count++;return plan(args);},confirm:async()=>false});
  assert.equal(count,1);
  assert.equal(out.status,"OWNER_DECLINED");
});

test("one explicit approval, exact call ID and args, no further approvals",async()=>{
  const c=config(),args=publicSearchArguments(c,query);
  const calls=[];
  const out=await runManualSearch(c,query,{confirm:async p=>{
    assert.deepEqual(p.arguments,args);return true;
  },send:async(_c,r)=>{
    calls.push(r);
    if(calls.length===1)return plan(args);
    assert.deepEqual(r.tools[0].allowed_tools,["google_search"]);
    assert.equal(r.tools[0].require_approval,"always");
    assert.equal(r.store,false);
    assert.equal(r.input.filter(x=>x.type==="mcp_approval_response").length,1);
    assert.deepEqual(r.input.at(-1),{type:"mcp_approval_response",approval_request_id:"mcpr_test",approve:true});
    return {...result(args),output:[...result(args).output,{type:"mcp_approval_request",id:"another"}]};
  }});
  assert.equal(calls.length,2);
  assert.equal(out.status,"MCP_SEARCH_RETURNED");
  assert.equal(out.trust,"unverified_search_output");
  assert.equal(out.additionalApprovalsDenied,1);
  assert.throws(()=>inspectSearchResult(result({...args,limit:4}),args,"mcpr_test"),/UNCONFIRMED/);
  assert.throws(()=>inspectSearchResult(result(args),args,"wrong"),/UNCONFIRMED/);
  assert.throws(()=>inspectSearchResult({output:[...result(args).output,...result(args).output]},args,"mcpr_test"),/UNCONFIRMED/);
});

test("transport uses only OpenAI Responses HTTPS, bounded body, no retry and safe error",async()=>{
  const c=config();let n=0;
  const r=await sendResponses(c,discoveryRequest(c),{fetchImpl:async(url,init)=>{
    n++;
    assert.equal(url,"https://api.openai.com/v1/responses");
    assert.equal(init.redirect,"error");
    assert.equal(init.headers.Authorization,"Bearer "+env.OPENAI_API_KEY);
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify({output:[list(true)]}));
  }});
  assert.equal(n,1);assert.ok(r.output);
  await assert.rejects(sendResponses(c,discoveryRequest(c),{fetchImpl:async()=>{
    n++;throw Error("secret-raw-error");
  }}),{message:"OPENAI_NETWORK_OR_TIMEOUT_OUTCOME_UNKNOWN"});
  assert.equal(n,2);
  await assert.rejects(sendResponses(c,discoveryRequest(c),{fetchImpl:async()=>{
    n++;return new Response("raw-private-error",{status:403});
  }}),{message:"OPENAI_HTTP_403"});
  assert.equal(n,3);
  await assert.rejects(sendResponses(c,discoveryRequest(c),{fetchImpl:async()=>
    new Response("x".repeat(2*1024*1024+1))}),/SIZE_LIMIT/);
});

test("unknown paid result is never retried",async()=>{
  const c=config(),args=publicSearchArguments(c,query);let n=0;
  await assert.rejects(runManualSearch(c,query,{confirm:async()=>true,send:async()=>{
    if(++n===1)return plan(args);
    throw Error("timeout after approval");
  }}),/timeout/);
  assert.equal(n,2);
});
