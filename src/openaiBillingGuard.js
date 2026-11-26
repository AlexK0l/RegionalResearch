// Credit exhaustion is account-wide, unlike ordinary rate limiting.
// Hooks are optional for offline tests and non-server CLI clients.
export function isOpenAIBillingStop(error){
  const codes=[error?.code,error?.error?.code,error?.type,error?.error?.type]
    .map(x=>String(x||"").toLowerCase());
  if(codes.some(x=>["openai_billing_stop","insufficient_quota","billing_hard_limit_reached","billing_not_active"].includes(x)))return true;
  const message=String(error?.message||error||"").toLowerCase();
  return /no credits remaining|insufficient_quota|exceeded your current quota|billing hard limit|billing.{0,80}credit.{0,40}(?:exhaust|remain|limit)/.test(message);
}
export class OpenAIBillingPauseError extends Error{
  constructor(){
    super("OpenAI API: credits exhausted; restore the balance and resume paid research");
    this.name="OpenAIBillingPauseError";
    this.code="OPENAI_BILLING_STOP";
  }
}
export function guardOpenAIResponses(client,{beforeRequest,onBillingStop}={}){
  if(typeof client?.responses?.create!=="function")return;
  const create=client.responses.create.bind(client.responses);
  client.responses.create=async(request,options)=>{
    // Synchronous in production: no new API work may race after the latch.
    beforeRequest?.();
    try{return await create(request,options);}
    catch(error){
      if(!isOpenAIBillingStop(error))throw error;
      onBillingStop?.();
      throw new OpenAIBillingPauseError();
    }
  };
}
