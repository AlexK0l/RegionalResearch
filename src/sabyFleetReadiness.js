// Scope: a freshly verified private detail card, after contact overlays
// have been closed. The scroll wrapper is the same one observed in the
// user's 2026-11-19 Saby HTML and used by sabyFinancials.js. No selectors
// for speculative alternate fleet labels, no global body scroll, no clicks.
import {setTimeout as sleep} from "node:timers/promises";

const PROFILE_SCROLL='[data-qa="contractorCard-dialog-Stack"] '+
  '.controls-SlidingPanel__scrollWrapper > [data-qa="controls-Scroll__content"]';

// Only the full collector calls this after the original exact heading
// lookup failed. A ready card never enters recovery. Restore the prior
// position on failure (only while still the same verified contractor).
export async function recoverSabyFleetHeading(page,{
  readHeading,sameCompany,wait=ms=>sleep(ms)
}={}){
  let scroller,original,scrollSteps=0,found=false;
  const outcome=(status,heading=null)=>({status,heading,scrollSteps});
  const safe=()=>sameCompany?.()===true;
  const read=async()=>{
    if(!safe())return null;
    const heading=await readHeading();
    return safe()?heading:null;
  };
  try{
    if(!safe()||typeof readHeading!=="function")return outcome("card_changed");
    // Some cards mount the heading shortly after the finance viewer
    // restored its scroll position. Avoid any interaction if it appears.
    for(let i=0;i<3;i++){
      const heading=await read();
      if(!safe())return outcome("card_changed");
      if(heading){found=true;return outcome("hydrated",heading);}
      if(i<2)await wait(350);
    }
    if(typeof page?.locator!=="function")return outcome("scroller_unavailable");
    const locator=page.locator(PROFILE_SCROLL);
    if(await locator.count()!==1||!await locator.isVisible()||!safe())
      return outcome("scroller_unavailable");
    scroller=locator;
    original=await scroller.evaluate(el=>({
      top:el.scrollTop,max:Math.max(0,el.scrollHeight-el.clientHeight)
    }),undefined,{timeout:1800});
    if(!safe())return outcome("card_changed");
    if(!Number.isFinite(original?.top)||!Number.isFinite(original?.max)||
       original.max<=20)return outcome("scroller_unavailable");
    for(const fraction of [0,.25,.5,.75,1]){
      if(!safe())return outcome("card_changed");
      // Re-selecting a different wrapper or scrolling unrelated body
      // content is forbidden. Abort on virtualization/ambiguity.
      if(await scroller.count()!==1||!await scroller.isVisible())
        return outcome("scroller_unavailable");
      if(!safe())return outcome("card_changed");
      await scroller.evaluate((el,part)=>{
        el.scrollTop=Math.round(Math.max(0,el.scrollHeight-el.clientHeight)*part);
      },fraction,{timeout:1800});
      scrollSteps++;
      if(!safe())return outcome("card_changed");
      await wait(450);
      const heading=await read();
      if(!safe())return outcome("card_changed");
      if(heading){found=true;return outcome("revealed",heading);}
    }
    return outcome("heading_not_found");
  }catch{return outcome(safe()?"recovery_unavailable":"card_changed");}
  finally{
    if(!found&&scrollSteps&&scroller&&Number.isFinite(original?.top)&&safe()){
      try{
        if(await scroller.count()===1&&await scroller.isVisible()&&safe())
          await scroller.evaluate((el,top)=>{el.scrollTop=top;},
            original.top,{timeout:1800});
      }catch{/* No fallback to another scroller. */}
    }
  }
}
