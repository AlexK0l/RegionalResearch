#!/usr/bin/env node
// Default offline plan. No API key, paid subscription, Saby or OpenAI.
import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {GIRBO_BASE,planGirBoBackfill,runGirBoBackfill,girboPdfHash} from "../src/girBoBackfill.js";
const args=process.argv.slice(2),arg=(k,d="")=>args.find(a=>a.startsWith("--"+k+"="))?.slice(k.length+3)??d;
const metric=(n,x)=>console.log("["+n+"] "+JSON.stringify(x));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const int=(k,d,max)=>{
  const v=Number(arg(k,String(d)));
  if(!Number.isSafeInteger(v)||v<1||v>max)throw Error("GIRBO_BAD_ARGS");
  return v;
};
function createLookup(maxRequests){
  let requests=0,last=0;
  async function request(url,{pdf=false}={}){
    const u=new URL(url);
    if(u.origin!==GIRBO_BASE||u.username||u.password||u.hash)
      throw Error("GIRBO_RESPONSE_UNPROVEN");
    if(requests>=maxRequests)throw Error("GIRBO_REQUEST_BUDGET");
    await delay(Math.max(0,1500-(Date.now()-last)));
    requests++;last=Date.now();
    let response;
    try{response=await fetch(u,{redirect:"error",signal:AbortSignal.timeout(45000),
      headers:{"Accept":pdf?"application/pdf":"application/json","User-Agent":"RegionalResearch/2.1"}});}
    catch{throw Error("GIRBO_HTTP_UNAVAILABLE");}
    const reject=async code=>{
      await response.body?.cancel().catch(()=>{});
      throw Error(code);
    };
    if(response.status===429||response.headers.has("retry-after"))return reject("GIRBO_RATE_LIMITED");
    if(response.status===401||response.status===403)return reject("GIRBO_HTTP_DENIED");
    if(!response.ok)return reject("GIRBO_HTTP_UNAVAILABLE");
    if(response.url!==u.href||!response.body||
      !(response.headers.get("content-type")||"").toLowerCase().includes(pdf?"application/pdf":"application/json"))
      return reject("GIRBO_RESPONSE_UNPROVEN");
    const cap=pdf?24*1024*1024:12*1024*1024,reader=response.body.getReader(),chunks=[];
    let total=0;
    try{
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        total+=value.length;
        if(total>cap){await reader.cancel();throw Error(pdf?"GIRBO_PDF_SIZE_LIMIT":"GIRBO_RESPONSE_UNPROVEN");}
        chunks.push(Buffer.from(value));
      }
    }catch(e){throw Error(["GIRBO_PDF_SIZE_LIMIT","GIRBO_RESPONSE_UNPROVEN"].includes(e.message)?e.message:"GIRBO_HTTP_UNAVAILABLE");}
    const buffer=Buffer.concat(chunks);
    if(pdf)return buffer;
    try{return JSON.parse(buffer.toString("utf8"));}catch{throw Error("GIRBO_RESPONSE_UNPROVEN");}
  }
  return {get requests(){return requests;},
    search:inn=>request(GIRBO_BASE+"/advanced-search/organizations/search?"+new URLSearchParams({query:inn,page:"0",size:"20"})),
    reports:id=>request(GIRBO_BASE+"/nbo/organizations/"+id+"/bfo/"),
    async pdf(candidate){
      const buffer=await request(candidate.report_url,{pdf:true});
      if(buffer.subarray(0,5).toString()!=="%PDF-")return {text:"",sha256:""};
      const out=spawnSync("pdftotext",["-layout","-","-"],{input:buffer,encoding:"utf8",
        maxBuffer:8*1024*1024,timeout:45000,windowsHide:true});
      if(out.error?.code==="ENOENT")throw Error("GIRBO_PDFTOTEXT_MISSING");
      if(out.error||out.status!==0)return {text:"",sha256:""};
      return {text:out.stdout,sha256:girboPdfHash(buffer)};
    }};
}
async function main(){
  if(args.includes("--help")){
    console.log("node scripts/girbo-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> [--limit=10000] [--year=2025] [--max-requests=1500] [--run]");
    return;
  }
  const file=arg("db"),sourceId=arg("checkpoint"),year=int("year",new Date().getUTCFullYear()-1,2100),
    limit=int("limit",10000,10000),maxRequests=int("max-requests",1500,3000);
  if(!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sourceId))throw Error("GIRBO_BAD_ARGS");
  const db=new DatabaseSync(file,{readOnly:true});
  let cp;
  try{
    db.exec("PRAGMA query_only=ON");
    const row=db.prepare("SELECT payload FROM research_checkpoints WHERE id=?").get(sourceId);
    if(!row?.payload)throw Error("GIRBO_CHECKPOINT_NOT_FOUND");
    cp=JSON.parse(row.payload);
  }finally{db.close();}
  const plan=planGirBoBackfill(cp,{limit,year}),run=args.includes("--run");
  const {selected,...summary}=plan;
  metric("GIRBO_PLAN",{source_checkpoint:sourceId,region:cp.region,dry_run:!run,
    ...summary,scheduled:selected.length,max_requests:maxRequests,openai_requests:0,saby_requests:0});
  if(!run||!selected.length)return;
  const poppler=spawnSync("pdftotext",["-v"],{encoding:"utf8",timeout:5000,windowsHide:true});
  if(poppler.error||poppler.status!==0)throw Error("GIRBO_PDFTOTEXT_MISSING");
  process.env.CHECKPOINT_DB_PATH=file;
  const {saveCheckpoint,PIPELINE_VERSION}=await import("../src/checkpointStore.js");
  if(Number(cp.pipeline_version||PIPELINE_VERSION)!==PIPELINE_VERSION)throw Error("GIRBO_CHECKPOINT_VERSION_MISMATCH");
  const lookup=createLookup(maxRequests),childId=randomUUID();
  let saved=false;
  const result=await runGirBoBackfill({checkpoint:cp,sourceId,childId,limit,year,lookup,
    onCheckpoint:async child=>{
      await saveCheckpoint(childId,child);
      if(!saved){saved=true;metric("GIRBO_CHILD",{child_checkpoint:childId,parent_checkpoint:sourceId});}
    },
    onProgress:stats=>metric("GIRBO_PROGRESS",{...stats,http_requests:lookup.requests})});
  metric("GIRBO_DONE",{child_checkpoint:childId,parent_checkpoint:sourceId,
    ...result.stats,http_requests:lookup.requests,original_checkpoint_unchanged:true});
  if(result.stats.stop_reason)process.exitCode=2;
}
main().catch(e=>{metric("GIRBO_ERROR",{reason:/^GIRBO_[A-Z_]{1,90}$/.test(e?.message||"")?e.message:"GIRBO_UNAVAILABLE"});process.exitCode=2;});
