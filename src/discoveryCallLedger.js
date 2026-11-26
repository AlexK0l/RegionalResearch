// Cache only complete discovery responses, never truncated or failed replies.
// The caller persists the ledger and the completed branch prefix atomically.
// Replay feeds the same response into the same deterministic aggregation.
export function createDiscoveryCallLedger(initial={},persist=async()=>{}){
  const values=Object.create(null);
  for(const [key,value] of Object.entries(initial||{})){
    if(/^(?:archive|primary|recovery|census|gap):[a-z0-9:_-]+$/i.test(key)&&value&&typeof value==="object")
      values[key]=structuredClone(value);
  }
  const snapshot=()=>({...values});
  return {
    snapshot,
    clear:()=>{for(const key of Object.keys(values))delete values[key];},
    async run(key,request){
      if(Object.hasOwn(values,key)){
        console.info("[DISCOVERY_CALL_RESTORED] "+JSON.stringify({key}));
        return structuredClone(values[key]);
      }
      const value=await request();
      if(!value||typeof value!=="object")throw Error("DISCOVERY_RESPONSE_NOT_OBJECT");
      values[key]=structuredClone(value);
      try{await persist();}
      catch(error){
        if(error?.name==="MemoryPauseError")throw error;
        const failure=new Error("DISCOVERY_CHECKPOINT_WRITE_FAILED",{cause:error});
        failure.code="DISCOVERY_CHECKPOINT_WRITE_FAILED";
        throw failure;
      }
      return value;
    }
  };
}
export function fatalDiscoveryError(error){
  return error?.code==="DISCOVERY_CHECKPOINT_WRITE_FAILED"||
    error?.code==="OPENAI_BILLING_STOP"||error?.name==="MemoryPauseError"||
    error?.name==="AbortError"||error?.message==="JOB_CANCELLED";
}
