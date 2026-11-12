// ONE explicitly requested first-party fleet-panel tail click.
// The custom three dots were observed as a stable, unanimated,
// pointer-cursor element after 40/220 trucks. Clicking is never enabled
// in ordinary production Stage12 and never infers missing vehicle rows.
import {sabyCardRoute} from "./sabyCard.js";
import {compareSabyVerifiedFleetDetail}
  from "./sabyFleetRouteContinuity.js";

const states=new Set([
  "invalid_setup","not_eligible","company_changed","target_missing",
  "target_ambiguous","target_not_pointer","target_not_at_end",
  "target_blocked","click_failed","rows_extended","rows_replaced",
  "rows_unchanged","panel_closed","invalid_rows"
]);
const number=(x,cap=5000)=>Number.isSafeInteger(x)&&x>=0?
  Math.min(x,cap):null;

export function safeSabyFleetTailClickReport(report={}) {
  return {
    status:states.has(report?.status)?report.status:"invalid_setup",
    click_attempted:report?.click_attempted===true,
    rows_before:number(report?.rows_before),
    rows_after:number(report?.rows_after),
    row_sequence_changed:report?.row_sequence_changed===true,
    panel_open_after:report?.panel_open_after===true,
    samples:number(report?.samples,12)
  };
}

export function isSabyFleetTailClickEligible(tail,rowsBefore) {
  if(!Number.isSafeInteger(rowsBefore)||rowsBefore<1||
    tail?.status!=="observed"||
    tail?.truck_row_count_changed!==false||
    (tail?.waited_ms??0)<8000)return false;
  const a=tail.sample_before,b=tail.sample_after;
  return [a,b].every(s=>
    s?.status==="observed"&&
    s.truck_row_count===rowsBefore&&
    s.three_dot_cluster===true&&
    s.dot_pointer_cursor===true&&
    s.dot_animated===false&&
    s.dot_loading_class===false&&
    s.small_dot_candidates===3&&
    s.gap_interactive_elements===0);
}

/**
 * Find the EXACT 3-dot capsule in the physical 40px gap between
 * the last model-year row and the following vehicle category.
 * No raw DOM/text/classes/model names leave the page.
 */
export async function locateSabyFleetTailClick(page,{expected,rowsBefore}={}){
  if(!Number.isSafeInteger(expected)||expected<2||expected>5000||
     !Number.isSafeInteger(rowsBefore)||rowsBefore<1||
     rowsBefore>=expected||sabyCardRoute(page?.url?.())!=="detail")
    return {status:"target_missing"};
  try {
    const observed=await page.evaluate(({expected,rowsBefore})=>{
      const norm=s=>String(s||"").replace(/\s+/g," ").trim();
      const visible=e=>{
        if(!e?.getBoundingClientRect)return false;
        const b=e.getBoundingClientRect(),st=getComputedStyle(e);
        return b.width>0&&b.height>0&&st.display!=="none"&&
          st.visibility!=="hidden";
      };
      const all=[...document.querySelectorAll("body *")];
      const heads=all.filter(e=>visible(e)&&e.children.length===0&&
        norm(e.textContent)==="Автопарк");
      const cats=/^(?:Легковые|Коммерческие|Грузовые|Автобусы|Спецтехника|Прицепы|Мотоциклы)(?:\s+\d+)?$/i;
      const matches=[];
      for(const h of heads) {
        let node=h;
        for(let depth=0;node&&depth<12;depth++,node=node.parentElement){
          const b=node.getBoundingClientRect(),t=node.innerText||"";
          if(b.width<250||b.height<180||b.right<innerWidth*.60||
             t.length>26000||!t.includes("Грузовые"))continue;
          const leaves=[...node.querySelectorAll("*")].filter(e=>
            visible(e)&&e.children.length===0);
          const labels=leaves.filter(e=>cats.test(norm(e.textContent)));
          const truck=labels.find(e=>/^Грузовые(?:\s+\d+)?$/i.test(
            norm(e.textContent)));
          if(!truck)continue;
          const label=norm(truck.textContent)+" "+
            norm(truck.parentElement?.innerText);
          if(!new RegExp("Грузовые\\s*"+expected+"(?:\\D|$)","i")
            .test(label))continue;
          matches.push({panel:node,truck,labels,leaves,area:b.width*b.height});
        }
      }
      matches.sort((a,b)=>a.area-b.area);
      if(!matches.length)return {status:"target_missing"};
      const {panel,truck,labels,leaves}=matches[0];
      const next=labels.slice(labels.indexOf(truck)+1)[0];
      if(!next)return {status:"target_missing"};
      const betweenHeads=e=>
        e!==truck &&
        Boolean(truck.compareDocumentPosition(e)&
          Node.DOCUMENT_POSITION_FOLLOWING)&&
        Boolean(e.compareDocumentPosition(next)&
          Node.DOCUMENT_POSITION_FOLLOWING);
      const models=leaves.filter(e=>betweenHeads(e)&&
        /^.{3,150}[,;]\s*(?:19|20)\d{2}(?:\s*г\.?)?$/.test(
          norm(e.textContent)));
      if(models.length!==rowsBefore)return {status:"target_missing"};
      const scrollers=[panel,...panel.querySelectorAll("*")].filter(e=>{
        const st=getComputedStyle(e);
        return visible(e)&&e.scrollHeight>e.clientHeight+15&&
          /(auto|scroll)/.test(st.overflowY);
      });
      if(scrollers.length!==1||
         scrollers[0].scrollHeight-scrollers[0].clientHeight-
           scrollers[0].scrollTop>2)
        return {status:"target_not_at_end"};
      const lastBottom=Math.max(...models.map(
        e=>e.getBoundingClientRect().bottom));
      const nextTop=next.getBoundingClientRect().top;
      const b=panel.getBoundingClientRect();
      const minY=lastBottom+2,maxY=nextTop-2;
      const center=(b.left+b.right)/2;
      if(maxY-minY<12||maxY-minY>90||
        minY<0||maxY>innerHeight)
        return {status:"target_missing"};
      const points=[];
      for(const e of panel.querySelectorAll("*")){
        if(!visible(e))continue;
        const q=e.getBoundingClientRect();
        const x=(q.left+q.right)/2,y=(q.top+q.bottom)/2;
        if(q.width<2||q.width>13||q.height<2||q.height>13||
          q.top<minY-1||q.bottom>maxY+1||
          Math.abs(x-center)>100)continue;
        if(points.some(p=>Math.abs(p.x-x)<2&&Math.abs(p.y-y)<2))
          continue;
        points.push({x,y});
      }
      if(points.length!==3)
        return {status:"target_ambiguous"};
      points.sort((a,b)=>a.x-b.x);
      const [a,c,d]=points;
      if(Math.max(a.y,c.y,d.y)-Math.min(a.y,c.y,d.y)>5||
        c.x-a.x<5||d.x-c.x<5||d.x-a.x>55)
        return {status:"target_ambiguous"};
      const x=Math.round(c.x),y=Math.round(c.y);
      const hit=document.elementFromPoint(x,y);
      // The dots may be absolutely positioned late in the DOM. Their
      // physical location, unique triple geometry, first-party panel
      // ownership and pointer cursor are the required evidence; do not
      // require the dot's DOM index to fall between category headings.
      if(!hit||!panel.contains(hit))
        return {status:"target_blocked"};
      if(hit.closest("a[href],form,input,select,textarea"))
        return {status:"target_blocked"};
      let node=hit,pointer=false,animated=false;
      for(let i=0;node&&i<6;i++,node=node.parentElement){
        const q=node.getBoundingClientRect();
        if(q.width>110||q.height>65)break;
        const style=getComputedStyle(node);
        pointer ||=style.cursor==="pointer";
        animated ||=style.animationName!=="none"||
          Boolean(node.getAnimations?.().length);
        const label=norm(node.getAttribute?.("aria-label")||"")+" "+
          norm(node.getAttribute?.("title")||"");
        if(/(?:удал|оплат|купить|сохран|отправ|заказ|edit|delete|pay|buy)/i
          .test(label))
          return {status:"target_blocked"};
      }
      if(animated)return {status:"target_blocked"};
      if(!pointer)return {status:"target_not_pointer"};
      return {status:"ready",x,y};
    },{expected,rowsBefore});
    if(observed?.status==="ready"&&
       Number.isSafeInteger(observed.x)&&
       Number.isSafeInteger(observed.y))
      return {status:"ready",x:observed.x,y:observed.y};
    return {status:states.has(observed?.status)?
      observed.status:"target_missing"};
  }catch{return {status:"target_missing"};}
}

/** Performs AT MOST ONE bounded mouse click, then only reads the panel. */
export async function probeSabyFleetTailClick(page,{
  originalUrl,expected,baselineRows,tail,readPanel,
  wait=async()=>{},polls=8,pollMs=550
}={}){
  let clicked=false,seenOpen=false,samples=0,rowsAfter=baselineRows?.length||0;
  const result=(status,changed=false)=>safeSabyFleetTailClickReport({
    status,click_attempted:clicked,rows_before:baselineRows?.length,
    rows_after:rowsAfter,row_sequence_changed:changed,
    panel_open_after:seenOpen,samples
  });
  if(!Array.isArray(baselineRows)||
     !Number.isSafeInteger(expected)||expected<2||expected>5000||
     typeof readPanel!=="function"||typeof wait!=="function")
    return result("invalid_setup");
  if(!isSabyFleetTailClickEligible(tail,baselineRows.length))
    return result("not_eligible");
  const sameCompany=()=>sabyCardRoute(page?.url?.())==="detail"&&
    compareSabyVerifiedFleetDetail(originalUrl,page.url()).ok;
  if(!sameCompany())return result("company_changed");
  const pos=await locateSabyFleetTailClick(page,{
    expected,rowsBefore:baselineRows.length
  });
  if(pos.status!=="ready")return result(pos.status);
  if(!sameCompany())return result("company_changed");
  try {
    clicked=true;
    await page.mouse.click(pos.x,pos.y);
  }catch{return result("click_failed");}
  const baseline=JSON.stringify(baselineRows);
  const limit=Math.max(1,Math.min(10,Math.floor(polls)||8));
  for(let i=0;i<limit;i++){
    if(!sameCompany())return result("company_changed");
    try{
      const snapshot=await readPanel();
      samples++;
      if(snapshot?.routeChanged===true||!sameCompany())
        return result("company_changed");
      if(snapshot?.opened===true){
        seenOpen=true;
        if(!Array.isArray(snapshot.rows)||
           snapshot.rows.length>expected)
          return result("invalid_rows");
        rowsAfter=snapshot.rows.length;
        if(rowsAfter>baselineRows.length)
          return result("rows_extended",true);
        if(rowsAfter===baselineRows.length&&
           JSON.stringify(snapshot.rows)!==baseline)
          return result("rows_replaced",true);
      }
    }catch{return result("invalid_rows");}
    if(i<limit-1)await wait(Math.max(200,Math.min(1000,pollMs)));
  }
  return result(seenOpen?"rows_unchanged":"panel_closed");
}
