// Read-only observation of the three-dot widget between a contractor's
// last truck row and the next vehicle category. The image in v20 showed
// three blue dots there, but neither a button nor a loading role was
// identified. Never click the unidentified widget or print DOM/CSS strings.
import {sabyCardRoute} from "./sabyCard.js";

const bounded=(n,cap=5000)=>typeof n==="number"&&
  Number.isSafeInteger(n)&&n>=0?Math.min(n,cap):null;
const statuses=new Set([
  "observed","panel_not_found","gap_not_visible",
  "not_detail","unavailable"
]);

export function safeSabyFleetTailSignals(value={}) {
  return {
    status:statuses.has(value.status)?value.status:"unavailable",
    panel_matches:bounded(value.panel_matches,16),
    truck_row_count:bounded(value.truck_row_count),
    gap_height:bounded(value.gap_height,920),
    small_dot_candidates:bounded(value.small_dot_candidates,40),
    three_dot_cluster:value.three_dot_cluster===true,
    dot_semantic_click:value.dot_semantic_click===true,
    dot_pointer_cursor:value.dot_pointer_cursor===true,
    dot_animated:value.dot_animated===true,
    dot_loading_class:value.dot_loading_class===true,
    dot_more_class:value.dot_more_class===true,
    gap_interactive_elements:bounded(value.gap_interactive_elements,30)
  };
}

export function safeSabyFleetTailComparison(before,after,waitMs) {
  return {
    status:before.status==="observed"&&after.status==="observed"?
      "observed":"incomplete_observation",
    sample_before:safeSabyFleetTailSignals(before),
    sample_after:safeSabyFleetTailSignals(after),
    waited_ms:bounded(waitMs,16000),
    truck_row_count_changed:before.status==="observed"&&
      after.status==="observed"&&
      Number.isSafeInteger(before.truck_row_count)&&
      Number.isSafeInteger(after.truck_row_count)&&
      before.truck_row_count!==after.truck_row_count
  };
}

export async function observeSabyFleetTail(
  page,{expected,wait=ms=>new Promise(r=>setTimeout(r,ms)),waitMs=11000}={}
) {
  const fail=status=>safeSabyFleetTailComparison({status},{status},0);
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000||
     sabyCardRoute(page?.url?.())!=="detail")
    return fail("not_detail");
  const observe=async()=>{
    try {
      const result=await page.evaluate(({expected})=>{
        const norm=s=>String(s||"").replace(/\s+/g," ").trim();
        const visible=el=>{
          if(!el?.getBoundingClientRect)return false;
          const b=el.getBoundingClientRect(),s=getComputedStyle(el);
          return b.width>0&&b.height>0&&s.visibility!=="hidden"&&
            s.display!=="none";
        };
        const all=[...document.querySelectorAll("body *")];
        const heads=all.filter(e=>visible(e)&&e.children.length===0&&
          norm(e.textContent)==="Автопарк");
        const categories=/^(?:Легковые|Коммерческие|Грузовые|Автобусы|Спецтехника|Прицепы|Мотоциклы)(?:\s+\d+)?$/i;
        const matching=[];
        for(const h of heads){
          let node=h;
          for(let depth=0;node&&depth<12;depth++,node=node.parentElement){
            const b=node.getBoundingClientRect(),txt=node.innerText||"";
            if(b.width<250||b.height<180||b.right<innerWidth*.60||
               txt.length>26000||!txt.includes("Грузовые"))continue;
            const leaves=[...node.querySelectorAll("*")].filter(e=>
              visible(e)&&e.children.length===0);
            const cats=leaves.filter(e=>categories.test(norm(e.textContent)));
            const truck=cats.find(e=>/^Грузовые(?:\s+\d+)?$/i.test(
              norm(e.textContent)));
            if(!truck)continue;
            const label=norm(truck.textContent)+" "+
              norm(truck.parentElement?.innerText);
            if(!new RegExp("Грузовые\\s*"+expected+"(?:\\D|$)","i")
              .test(label))continue;
            matching.push({panel:node,truck,cats,leaves,area:b.width*b.height});
          }
        }
        matching.sort((a,b)=>a.area-b.area);
        if(!matching.length)
          return {status:"panel_not_found",panel_matches:0};
        const {panel,truck,cats,leaves}=matching[0];
        const next=cats.slice(cats.indexOf(truck)+1)[0];
        const inTrucks=e=>{
          if(e===truck)return false;
          if(!(truck.compareDocumentPosition(e)&
               Node.DOCUMENT_POSITION_FOLLOWING))return false;
          return !next||Boolean(e.compareDocumentPosition(next)&
            Node.DOCUMENT_POSITION_FOLLOWING);
        };
        // Model-year leaves are inferred only for counting: no text or
        // model name ever leaves the browser evaluate() call.
        const modelLeaves=leaves.filter(e=>inTrucks(e)&&
          /^.{3,150}[,;]\s*(?:19|20)\d{2}(?:\s*г\.?)?$/.test(
            norm(e.textContent)));
        const total=modelLeaves.length;
        if(!next||!modelLeaves.length)
          return {status:"gap_not_visible",panel_matches:matching.length,
            truck_row_count:total};
        const lastBottom=Math.max(...modelLeaves.map(
          e=>e.getBoundingClientRect().bottom));
        const nextTop=next.getBoundingClientRect().top;
        const rect=panel.getBoundingClientRect();
        const minY=lastBottom+2,maxY=nextTop-2;
        const middle=(rect.left+rect.right)/2;
        if(maxY-minY<8||minY<0||maxY>innerHeight)
          return {status:"gap_not_visible",panel_matches:matching.length,
            truck_row_count:total};
        const within=e=>{
          const b=e.getBoundingClientRect();
          return visible(e)&&b.top>=minY-1&&b.bottom<=maxY+1&&
            (b.left+b.right)/2>middle-100&&
            (b.left+b.right)/2<middle+100;
        };
        const between=[...panel.querySelectorAll("*")].filter(within);
        // Saby may render the blue dots as three tiny SVG circles or
        // CSS-rounded spans. Group by geometric centers, not class names.
        const geometric=[];
        for(const el of between){
          const b=el.getBoundingClientRect();
          if(b.width<2||b.width>13||b.height<2||b.height>13)continue;
          const cx=(b.left+b.right)/2,cy=(b.top+b.bottom)/2;
          if(geometric.some(v=>Math.abs(v.x-cx)<2&&
            Math.abs(v.y-cy)<2))continue;
          geometric.push({x:cx,y:cy,el});
        }
        geometric.sort((a,b)=>a.x-b.x);
        let dots=null;
        for(let i=0;i<geometric.length-2&&!dots;i++){
          const a=geometric[i],b=geometric[i+1],c=geometric[i+2];
          if(Math.max(a.y,b.y,c.y)-Math.min(a.y,b.y,c.y)>5)continue;
          if(b.x-a.x<5||c.x-b.x<5||c.x-a.x>55)continue;
          dots=[a,b,c];
        }
        const root=dots?.[1].el||null;
        let ancestor=root,clickable=false,pointer=false;
        let animated=false,loadingClass=false,moreClass=false;
        for(let i=0;ancestor&&i<5;i++,ancestor=ancestor.parentElement){
          const box=ancestor.getBoundingClientRect();
          if(box.width>140||box.height>70)break;
          const c=getComputedStyle(ancestor);
          pointer ||=c.cursor==="pointer";
          clickable ||=Boolean(ancestor.matches(
            'button,a,[role="button"],[onclick]'));
          animated ||=c.animationName!=="none"||
            Boolean(ancestor.getAnimations?.().length);
          const cls=typeof ancestor.className==="string"?
            ancestor.className:String(ancestor.className?.baseVal||"");
          loadingClass ||=/load|wait|spin|busy|process|fetch|progress/i.test(cls);
          moreClass ||=/more|ellipsis|three.?dot|expand|paging|page/i.test(cls);
        }
        const interactives=between.filter(e=>e.matches(
          'button,a,[role="button"],[onclick]'));
        return {
          status:"observed",panel_matches:matching.length,
          truck_row_count:total,
          gap_height:Math.round(maxY-minY),
          small_dot_candidates:geometric.length,
          three_dot_cluster:Boolean(dots),
          dot_semantic_click:clickable,
          dot_pointer_cursor:pointer,
          dot_animated:animated,
          dot_loading_class:loadingClass,
          dot_more_class:moreClass,
          gap_interactive_elements:interactives.length
        };
      },{expected});
      return safeSabyFleetTailSignals(result);
    } catch {
      return safeSabyFleetTailSignals({status:"unavailable"});
    }
  };
  const before=await observe();
  if(before.status!=="observed")
    return safeSabyFleetTailComparison(before,before,0);
  const duration=Math.max(0,Math.min(16000,Math.floor(waitMs)));
  try {
    await wait(duration);
  }catch{
    return safeSabyFleetTailComparison(before,{status:"unavailable"},0);
  }
  // No clicks and no changes to the page. A later DOM sample can show
  // whether an apparent loading indicator eventually added rows.
  const after=await observe();
  return safeSabyFleetTailComparison(before,after,duration);
}
