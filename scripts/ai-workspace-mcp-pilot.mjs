// Deliberately NOT imported by the research pipeline. One operator-run pilot.
// No automatic approvals, agent runs, retries, SQLite access or service changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {createInterface} from "node:readline/promises";

const LABEL="ai_workspace";
const DISCOVERY=["list_shared_projects","google_search"];
const SEARCH=["google_search"];
const MAX_BODY=2*1024*1024;
const MAX_RESULT=128*1024;
class PilotError extends Error {}
const require=(condition,code)=>{if(!condition)throw new PilotError(code);};
const clean=value=>String(value??"").trim();
const oneLine=value=>typeof value==="string"&&!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);

export function readPilotConfig(env=process.env){
  const endpoint=clean(env.AI_WORKSPACE_MCP_SERVER_URL);
  const tunnel=clean(env.AI_WORKSPACE_MCP_TUNNEL_ID);
  require(Boolean(endpoint)!==Boolean(tunnel),"CONFIG_EXACTLY_ONE_SERVER_URL_OR_TUNNEL_ID");
  let connection;
  if(endpoint){
    let u;
    try{u=new URL(endpoint);}catch{throw new PilotError("CONFIG_INVALID_HTTPS_URL");}
    require(u.protocol==="https:"&&!u.username&&!u.password&&!u.search&&!u.hash,
      "CONFIG_INVALID_HTTPS_URL");
    connection={server_url:u.href};
  }else{
    require(/^tunnel_[a-z0-9]{32}$/.test(tunnel),"CONFIG_INVALID_TUNNEL_ID");
    connection={tunnel_id:tunnel};
  }
  const auth=clean(env.AI_WORKSPACE_MCP_AUTHORIZATION);
  require(oneLine(auth)&&auth.length<=8192,"CONFIG_INVALID_MCP_AUTHORIZATION");
  const model=clean(env.AI_WORKSPACE_MCP_MODEL||env.OPENAI_MODEL);
  require(/^[a-zA-Z0-9._:-]{1,100}$/.test(model),"CONFIG_MODEL_REQUIRED");
  const key=clean(env.OPENAI_API_KEY);
  require(key&&oneLine(key)&&key!=="your_openai_key_here","CONFIG_OPENAI_API_KEY_REQUIRED");
  return {connection,auth,model,key,projectId:clean(env.AI_WORKSPACE_MCP_PROJECT_ID)};
}
function tool(config,names){
  return {type:"mcp",server_label:LABEL,...config.connection,
    ...(config.auth?{authorization:config.auth}:{}),
    allowed_tools:[...names],require_approval:"always"};
}
function base(config,names){
  return {model:config.model,store:false,include:["reasoning.encrypted_content"],
    max_output_tokens:1024,max_tool_calls:1,parallel_tool_calls:false,
    tools:[tool(config,names)]};
}
export function discoveryRequest(config){
  return {...base(config,DISCOVERY),
    input:"Connection test only. Request approval to call list_shared_projects with no arguments. Do not access or search project data.",
    tool_choice:{type:"mcp",server_label:LABEL,name:"list_shared_projects"}};
}
function usage(response){
  const n=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  return {input_tokens:n(response?.usage?.input_tokens),output_tokens:n(response?.usage?.output_tokens),
    total_tokens:n(response?.usage?.total_tokens)};
}
function readOutput(response){
  require(!response?.error&&Array.isArray(response?.output),"RESPONSES_OUTPUT_UNAVAILABLE");
  return response.output;
}
function schemaMatches(item){
  const s=item?.input_schema;
  const p=s?.properties;
  return s?.type==="object"&&p?.project_id?.type==="string"&&
    p?.query?.type==="string"&&p?.limit?.type==="integer"&&
    Array.isArray(s.required)&&s.required.includes("project_id")&&s.required.includes("query");
}
function inspectTools(output,names){
  const lists=output.filter(i=>i?.type==="mcp_list_tools");
  require(lists.length===1&&lists[0].server_label===LABEL&&!lists[0].error&&
    Array.isArray(lists[0].tools),"MCP_LIST_TOOLS_FAILED");
  const items=lists[0].tools;
  require(items.length===names.length&&names.every(name=>items.filter(i=>i?.name===name).length===1),
    "MCP_TOOL_ALLOWLIST_MISMATCH");
  require(schemaMatches(items.find(i=>i.name==="google_search")),"MCP_SEARCH_SCHEMA_MISMATCH");
  return [...names];
}
export function inspectDiscovery(response){
  const output=readOutput(response);
  require(output.every(i=>["reasoning","message","mcp_list_tools","mcp_approval_request"].includes(i?.type)),
    "MCP_UNEXPECTED_EXECUTION");
  const names=inspectTools(output,DISCOVERY);
  require(output.filter(i=>i.type==="mcp_approval_request").every(i=>
    i.server_label===LABEL&&i.name==="list_shared_projects"),"MCP_UNEXPECTED_APPROVAL");
  return {status:"MCP_DISCOVERY_OK",tools:names,searchSchemaVerified:true,
    approvalsSent:0,usage:usage(response)};
}
export function publicSearchArguments(config,query){
  require(/^[a-zA-Z0-9_.:-]{1,128}$/.test(config.projectId),"CONFIG_SHARED_PROJECT_ID_REQUIRED");
  require(oneLine(query)&&query.trim()===query&&query.length>=2&&query.length<=240,
    "PUBLIC_QUERY_INVALID");
  // The operator must supply PUBLIC business keywords only. Reject common
  // credential/contact/URL formats as a defense in depth, not a DLP guarantee.
  require(!/https?:\/\/|www\.|@|bearer\s|api[_ -]?key|token\s*[:=]|password\s*[:=]|\bsk-[\w-]+/i.test(query),
    "PUBLIC_QUERY_REJECTED");
  return {project_id:config.projectId,query,limit:3};
}
export function searchRequest(config,args){
  require(sameArgs(args,publicSearchArguments(config,args?.query)),"MCP_SEARCH_ARGUMENTS_INVALID");
  const input="Prepare exactly ONE google_search call with the following JSON arguments. "+
    "The query consists only of operator-approved public business search keywords. "+
    "Do not change any argument. Do not use any other tools. "+JSON.stringify(args);
  return {...base(config,SEARCH),input,
    tool_choice:{type:"mcp",server_label:LABEL,name:"google_search"}};
}
function sameArgs(actual,expected){
  return actual!==null&&typeof actual==="object"&&!Array.isArray(actual)&&
    Object.keys(actual).sort().join(",")==="limit,project_id,query"&&
    actual.project_id===expected.project_id&&actual.query===expected.query&&actual.limit===expected.limit;
}
function parseArgs(item){
  try{return JSON.parse(item.arguments);}catch{throw new PilotError("MCP_ARGUMENTS_INVALID");}
}
function approvedItem(response,args){
  const output=readOutput(response);
  require(response.status==="completed","MCP_APPROVAL_PLAN_INCOMPLETE");
  require(output.every(i=>["reasoning","message","mcp_list_tools","mcp_approval_request"].includes(i?.type)),
    "MCP_UNEXPECTED_EXECUTION");
  inspectTools(output,SEARCH);
  const approvals=output.filter(i=>i.type==="mcp_approval_request");
  require(approvals.length===1,"MCP_EXPECTED_ONE_APPROVAL");
  const approval=approvals[0];
  require(approval.server_label===LABEL&&approval.name==="google_search"&&
    /^[a-zA-Z0-9_-]{1,256}$/.test(approval.id??"")&&sameArgs(parseArgs(approval),args),
    "MCP_APPROVAL_ARGUMENT_MISMATCH");
  return approval;
}
export function inspectSearchPlan(response,args){
  const approval=approvedItem(response,args);
  return {approvalId:approval.id,arguments:{...args},usage:usage(response)};
}
export function approvalRequest(config,firstRequest,response,args,confirmed){
  require(confirmed===true,"OWNER_APPROVAL_REQUIRED");
  const expected=searchRequest(config,args);
  require(JSON.stringify(firstRequest)===JSON.stringify(expected),"MCP_REQUEST_CHANGED");
  const approval=approvedItem(response,args);
  // With store:false, carry the prior output (including encrypted reasoning)
  // forward in input. Never approve a second call proposed by the model.
  return {...base(config,SEARCH),input:[
    {role:"user",content:expected.input},...response.output,
    {type:"mcp_approval_response",approval_request_id:approval.id,approve:true}
  ]};
}
export function inspectSearchResult(response,args,approvalId){
  const output=readOutput(response);
  require(output.every(i=>["reasoning","message","mcp_list_tools","mcp_approval_request","mcp_call"].includes(i?.type)),
    "MCP_UNEXPECTED_OUTPUT");
  const calls=output.filter(i=>i.type==="mcp_call");
  require(calls.length===1,"MCP_SEARCH_RESULT_UNCONFIRMED");
  const item=calls[0];
  require(item.server_label===LABEL&&item.name==="google_search"&&
    item.approval_request_id===approvalId&&sameArgs(parseArgs(item),args)&&!item.error&&
    (!item.status||item.status==="completed")&&typeof item.output==="string"&&item.output.length>0&&
    Buffer.byteLength(item.output)<=MAX_RESULT,"MCP_SEARCH_RESULT_UNCONFIRMED");
  return {source:"AI_WORKSPACE_SERPER",trust:"unverified_search_output",
    output:item.output,usage:usage(response),
    additionalApprovalsDenied:output.filter(i=>i.type==="mcp_approval_request").length};
}
export async function sendResponses(config,request,{fetchImpl=globalThis.fetch}={}){
  // Fixed first-party endpoint; never follow redirects or expose credentials.
  let response;
  try{
    response=await fetchImpl("https://api.openai.com/v1/responses",{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(60000),
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+config.key},
      body:JSON.stringify(request)
    });
  }catch{throw new PilotError("OPENAI_NETWORK_OR_TIMEOUT_OUTCOME_UNKNOWN");}
  if(!response.ok){
    try{await response.body?.cancel();}catch{}
    const status=Number.isInteger(response.status)?response.status:0;
    throw new PilotError("OPENAI_HTTP_"+status);
  }
  try{
    let size=0;const chunks=[];
    for await(const chunk of response.body){
      size+=chunk.byteLength;
      require(size<=MAX_BODY,"OPENAI_RESPONSE_SIZE_LIMIT");
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }catch(error){
    if(error instanceof PilotError)throw error;
    throw new PilotError("OPENAI_RESPONSE_UNREADABLE_OUTCOME_UNKNOWN");
  }
}
export async function runDiscovery(config,{send=sendResponses}={}){
  return inspectDiscovery(await send(config,discoveryRequest(config)));
}
export async function runManualSearch(config,query,{send=sendResponses,confirm}={}){
  require(typeof confirm==="function","OWNER_APPROVAL_REQUIRED");
  const args=publicSearchArguments(config,query);
  const request=searchRequest(config,args);
  const first=await send(config,request);
  const plan=inspectSearchPlan(first,args);
  if(await confirm(plan)!==true)return {status:"OWNER_DECLINED",usage:plan.usage};
  const second=approvalRequest(config,request,first,args,true);
  const result=inspectSearchResult(await send(config,second),args,plan.approvalId);
  return {status:"MCP_SEARCH_RETURNED",proposalUsage:plan.usage,...result};
}

async function main(){
  const [mode,query,...extra]=process.argv.slice(2);
  if(!mode||mode==="--help"){
    console.log("Usage: node --env-file=.env scripts/ai-workspace-mcp-pilot.mjs --discover");
    console.log("Manual credit-consuming pilot: --search 'PUBLIC COMPANY KEYWORDS' (interactive only)");
    return;
  }
  require((mode==="--discover"&&query===undefined)||
    (mode==="--search"&&typeof query==="string"&&!extra.length),"INVALID_CLI_ARGUMENTS");
  const config=readPilotConfig();
  if(mode==="--discover"){
    console.log(JSON.stringify(await runDiscovery(config),null,2));
    return;
  }
  require(process.stdin.isTTY&&process.stdout.isTTY,"INTERACTIVE_OWNER_REQUIRED");
  // Create the protected output location before any provider call; never
  // put raw search results into tracked files, the service log or SQLite.
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"rr-ai-workspace-"));
  fs.chmodSync(directory,0o700);
  const outputPath=path.join(directory,"search-result.json");
  const fd=fs.openSync(outputPath,"wx",0o600);
  try{
    const result=await runManualSearch(config,query,{confirm:async plan=>{
      console.log("Exact proposed search arguments (sent to AI-Workspace/Serper):");
      console.log(JSON.stringify(plan.arguments,null,2));
      console.log("One Serper credit and OpenAI tokens may be charged.");
      const rl=createInterface({input:process.stdin,output:process.stdout});
      try{return (await rl.question("Type SEARCH ONCE to approve this call: "))==="SEARCH ONCE";}
      finally{rl.close();}
    }});
    const {output,...metadata}=result;
    if(result.status==="MCP_SEARCH_RETURNED"){
      fs.writeFileSync(fd,JSON.stringify({...metadata,output},null,2)+"\n");
      fs.fsyncSync(fd);
      console.log(JSON.stringify({...metadata,outputPath},null,2));
    }else{
      console.log(JSON.stringify(metadata,null,2));
    }
  }finally{fs.closeSync(fd);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  main().catch(error=>{
    // Never print remote descriptions, model text, arguments or raw errors.
    console.error("PILOT_STOPPED",error instanceof PilotError?error.message:"LOCAL_FAILURE");
    console.error("No automatic retry. If a search was approved, check the provider before repeating it.");
    process.exitCode=1;
  });
}
