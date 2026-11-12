// Explicitly opted-in screenshot of ONLY the Saby contractor fleet side panel.
// Images can contain private business data. Never emit their pixels/DOM to logs
// or GitHub. Save locally as mode 0600, never overwrite an existing image.
import fs from "node:fs/promises";
import path from "node:path";
import {sabyCardRoute} from "./sabyCard.js";
import {compareSabyVerifiedFleetDetail}
  from "./sabyFleetRouteContinuity.js";

export function sabyFleetScreenshotPath(jsonOutput) {
  const file=path.resolve(String(jsonOutput||""));
  if(!file.toLowerCase().endsWith(".json"))
    throw new Error("Screenshot requires a JSON output path");
  return file.slice(0,-5)+".fleet-panel.png";
}

export async function captureSabyFleetPanelScreenshot(
  page,{originalUrl,expected,targetPath}={}
) {
  const fail=status=>({status});
  if(typeof targetPath!=="string"||!targetPath.endsWith(".png")||
     !path.isAbsolute(targetPath))
    return fail("invalid_path");
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000)
    return fail("invalid_count");
  const stillVerified=()=>sabyCardRoute(page?.url?.())==="detail"&&
    compareSabyVerifiedFleetDetail(originalUrl,page.url()).ok===true;
  if(!stillVerified())return fail("company_route_not_verified");
  try {
    // Read only geometry. Never materialize page text into Node memory.
    // Select the same right-hand fleet panel as sidePanelTrucks, requiring
    // the exact independently observed truck count and a visible heading.
    const rect=await page.evaluate(({expected})=>{
      const clean=s=>String(s||"").replace(/\s+/g," ").trim();
      const visible=el=>{
        if(!el||typeof el.getBoundingClientRect!=="function")return false;
        const r=el.getBoundingClientRect(),css=getComputedStyle(el);
        return r.width>0&&r.height>0&&css.display!=="none"&&
          css.visibility!=="hidden";
      };
      const cats=/^Грузовые(?:\s+\d+)?$/i;
      const headings=[...document.querySelectorAll("body *")]
        .filter(e=>visible(e)&&e.children.length===0&&
          clean(e.textContent)==="Автопарк");
      const matches=[];
      for(const heading of headings){
        let node=heading;
        for(let depth=0;node&&depth<12;depth++,node=node.parentElement){
          const box=node.getBoundingClientRect(),text=node.innerText||"";
          if(box.width<250||box.height<180||
             box.right<innerWidth*.60||text.length>26000||
             !text.includes("Грузовые"))continue;
          const truck=[...node.querySelectorAll("*")].find(e=>
            visible(e)&&e.children.length===0&&cats.test(clean(e.textContent)));
          if(!truck)continue;
          const label=clean(truck.textContent)+" "+
            clean(truck.parentElement?.innerText);
          const found=label.match(/Грузовые\s*(\d+)/i);
          if(!found||Number(found[1])!==expected)continue;
          const x=Math.max(0,Math.ceil(box.left));
          const y=Math.max(0,Math.ceil(box.top));
          const width=Math.min(innerWidth-x,Math.floor(box.right-x));
          const height=Math.min(innerHeight-y,Math.floor(box.bottom-y));
          if(width<250||height<170||x<innerWidth*.40)continue;
          matches.push({x,y,width,height,area:width*height});
        }
      }
      matches.sort((a,b)=>a.area-b.area);
      if(!matches.length)return null;
      const {x,y,width,height}=matches[0];
      return {x,y,width,height};
    },{expected});
    if(!stillVerified())return fail("company_route_changed");
    if(!rect||![rect.x,rect.y,rect.width,rect.height].every(
      n=>Number.isSafeInteger(n)&&n>=0))
      return fail("panel_not_located");
    if(rect.width<250||rect.height<170||rect.width>1440||
       rect.height>920)
      return fail("panel_bounds_invalid");
    const bytes=await page.screenshot({
      type:"png",clip:rect,animations:"disabled",caret:"hide",
      timeout:15000
    });
    if(!stillVerified())return fail("company_route_changed");
    if(!Buffer.isBuffer(bytes)||bytes.length<8||
       !bytes.subarray(0,8).equals(
         Buffer.from([137,80,78,71,13,10,26,10])))
      return fail("invalid_image");
    // Exclusive creation prevents accidental overwrites of a previous
    // diagnostic. Store screenshot only on the user's VPS filesystem.
    await fs.mkdir(path.dirname(targetPath),{recursive:true});
    await fs.writeFile(targetPath,bytes,{flag:"wx",mode:0o600});
    return {status:"saved",file_path:targetPath};
  } catch(error) {
    // Browser/FS errors may contain private URLs or profile data. Return
    // fixed codes ONLY, not error.message or rendered page strings.
    return fail(error?.code==="EEXIST"?"already_exists":"capture_failed");
  }
}
