// Passive readiness is not collection evidence. All sections of one
// freshly verified SPA card hydrate during the same elapsed-time window.
// Keep full finance/fleet recovery independent of the passive budget.
import {setTimeout as sleep} from "node:timers/promises";
const KINDS=new Set(["contacts","financials","fleet"]);

export function createSabyCardReadiness({
  timeoutMs=7000,pollMs=450,now=()=>performance.now(),
  wait=ms=>sleep(ms),sameCard,readVisible
}={}){
  if(typeof sameCard!=="function"||typeof readVisible!=="function")
    throw Error("SABY_READINESS_GUARDS_REQUIRED");
  const budget=Number.isFinite(timeoutMs)?Math.max(0,Math.min(10000,timeoutMs)):7000;
  const interval=Number.isFinite(pollMs)?Math.max(50,Math.min(1000,pollMs)):450;
  const deadline=now()+budget;
  const remaining=()=>Math.max(0,deadline-now());
  // No cached locator, text, readiness flag or result across sections.
  // Even when the time budget has expired, do one fresh, guarded read.
  return {
    remaining,
    async waitFor(kind){
      if(!KINDS.has(kind))throw Error("SABY_READINESS_KIND_INVALID");
      let polls=0;
      const finish=status=>({status,polls});
      // Fixed upper bound also protects against an injected frozen clock.
      const maxPolls=Math.ceil(budget/interval)+2;
      while(polls<maxPolls){
        if(!sameCard())return finish("card_changed");
        let visible=false;
        try{visible=await readVisible(kind)===true;}catch{/* Transient remount. */}
        polls++;
        if(!sameCard())return finish("card_changed");
        if(visible)return finish("visible");
        const left=remaining();
        if(left<=0)return finish("budget_exhausted");
        await wait(Math.min(interval,left));
      }
      return finish("budget_exhausted");
    }
  };
}
