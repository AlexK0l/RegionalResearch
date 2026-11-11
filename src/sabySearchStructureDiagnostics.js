// Diagnostic ONLY: read-only structural observations about the FIRST-PARTY
// Saby company-search DOM. No arbitrary DOM text, contacts, cookies, URLs,
// credentials or form values are exported. The optional first-line business
// labels are capped, masked, and kept in a local 0600 audit JSON.

import {sabySearchDisplayName} from "./sabySearchRows.js";
import {sabyInn,sabyNameTokens} from "./sabyEnrichment.js";

export function safeSabySearchTitle(raw,inn) {
  return String(sabySearchDisplayName(raw,inn)||"")
    .replace(/[\p{Cc}\p{Cf}]/gu," ")
    .replace(/[^\S\r\n]+/gu," ").trim()
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu,"[EMAIL]")
    .replace(/(?:\+7|8)[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/gu,"[PHONE]")
    .replace(/\b\d{10,12}\b/gu,"[REGISTRY_NUMBER]")
    .slice(0,140);
}
const coords=v=>{
  const x=Number(v);
  return Number.isFinite(x)?Math.round(x):null;
};
export function summarizeSabySearchLayout(rows,inn,expectedName,layout=[]) {
  const list=Array.isArray(rows)?rows.slice(0,80):[];
  const tokens=sabyNameTokens(expectedName).filter(s=>s.length>=4);
  const shape=Array.isArray(layout)?layout:[];
  const items=list.map((row,i)=>{
    const heading=safeSabySearchTitle(row?.text,inn);
    const match=sabyNameTokens(heading);
    return {
      index:i+1,
      title:heading,
      title_token_overlap:tokens.filter(x=>match.includes(x)).length,
      x:coords(row?.rect?.x),y:coords(row?.rect?.y),
      width:coords(row?.rect?.w),height:coords(row?.rect?.h),
      ...(shape[i]||{})
    };
  });
  return {
    candidate_rows:items.length,
    distinct_titles:new Set(items.map(x=>x.title.toLocaleLowerCase("ru"))).size,
    titles_with_source_token:items.filter(x=>x.title_token_overlap>0).length,
    inside_viewport:items.filter(x=>x.viewport_visible===true).length,
    has_row_context:items.filter(x=>x.semantic_row===true).length,
    with_clickability:items.filter(x=>x.clickable===true).length,
    items
  };
}
export async function inspectSabySearchLayout(page,rows,inn) {
  if(!sabyInn(inn)||!Array.isArray(rows)||!rows.length)return [];
  const rectangles=rows.slice(0,80).map(row=>({
    x:Number(row?.rect?.x),y:Number(row?.rect?.y),
    w:Number(row?.rect?.w),h:Number(row?.rect?.h)
  }));
  return page.evaluate(({rectangles,inn})=>{
    const safeTag=el=>{
      const tag=String(el?.tagName||"").toLowerCase();
      return ["div","li","tr","a","section","article","button","td",
        "span","p","ul","ol","nav","main","aside"].includes(tag)?tag:"other";
    };
    const visible=el=>{
      if(!el)return false;
      const r=el.getBoundingClientRect();
      const style=getComputedStyle(el);
      return r.width>0&&r.height>0&&
        style.visibility!=="hidden"&&style.display!=="none";
    };
    const role=el=>{
      const value=String(el?.getAttribute?.("role")||"").toLowerCase();
      return ["row","listitem","option","dialog","grid","listbox",
        "menu","link","button","article"].includes(value)?value:"";
    };
    const hints=el=>{
      const value=String(el?.className?.baseVal||el?.className||"");
      const result=[];
      for(const hint of ["search","result","company","contractor",
        "option","list","menu","row","item","card","tile","popup"]){
        if(new RegExp(hint,"i").test(value))result.push(hint);
      }
      return result.slice(0,6);
    };
    const all=[...document.querySelectorAll("body *")];
    const parentIds=new WeakMap();
    let nextId=0;
    const id=node=>{
      if(!node)return 0;
      if(!parentIds.has(node))parentIds.set(node,++nextId);
      return parentIds.get(node);
    };
    return rectangles.map(rect=>{
      let chosen=null,best=Infinity;
      for(const el of all){
        const r=el.getBoundingClientRect();
        if(Math.abs(r.x-rect.x)>2||
           Math.abs(r.y-rect.y)>2||
           Math.abs(r.width-rect.w)>3||
           Math.abs(r.height-rect.h)>3)continue;
        // Expensive computed style reads only for exact-geometry matches.
        if(!visible(el))continue;
        // If several nested elements have identical geometry, prefer the
        // one with fewer innerText chars while still containing exact INN.
        const raw=String(el.innerText||el.textContent||"");
        if(!new RegExp("(?:^|\\D)"+inn+"(?!\\d)").test(raw))continue;
        if(raw.length<best){chosen=el;best=raw.length;}
      }
      if(!chosen)return {matched:false};
      const rect=chosen.getBoundingClientRect();
      const isInViewport=rect.bottom>0&&rect.top<innerHeight &&
        rect.right>0&&rect.left<innerWidth;
      let semantic=null,nav=false,dialog=false,clickable=false,
        scroller=null,ancestorDepth=0;
      for(let el=chosen;el&&ancestorDepth<9;el=el.parentElement,ancestorDepth++){
        const tag=safeTag(el),r=role(el);
        if(!semantic&&(r==="row"||r==="listitem"||r==="option"||
             tag==="tr"||tag==="li"))semantic=el;
        if(tag==="a"||tag==="button"||r==="button"||r==="link"||
           (typeof el.hasAttribute==="function"&&el.hasAttribute("onclick")))
          clickable=true;
        if(typeof getComputedStyle==="function" &&
           getComputedStyle(el).cursor==="pointer")clickable=true;
        if(tag==="nav"||r==="navigation")nav=true;
        if(r==="dialog")dialog=true;
        if(!scroller&&el.scrollHeight>el.clientHeight+25 &&
           el.clientHeight>0)scroller=el;
      }
      const text=String(chosen.innerText||"").slice(0,850);
      const numbers=new Set(text.match(/(?:^|\D)(\d{10}|\d{12})(?!\d)/gu)||[]);
      const parent=chosen.parentElement;
      return {
        matched:true,
        tag:safeTag(chosen),role:role(chosen),
        class_hints:hints(chosen),
        parent_tag:safeTag(parent),parent_role:role(parent),
        parent_class_hints:hints(parent),
        parent_group:id(parent),
        parent_siblings:Math.min(200,parent?.children?.length||0),
        semantic_row:Boolean(semantic),
        semantic_role:role(semantic),semantic_tag:safeTag(semantic),
        semantic_class_hints:hints(semantic),
        inside_navigation:nav,
        inside_dialog:dialog,
        scroll_container:Boolean(scroller),
        scroll_group:id(scroller),
        viewport_visible:isInViewport,
        clickable,
        own_text_lines:Math.min(100,text.split(/[\r\n]+/).length),
        own_text_chars:text.length,
        has_explicit_inn_label:new RegExp("(?:^|\\s)ИНН\\s*[:№#-]?\\s*"+inn+"(?!\\d)","iu").test(text.replace(/\s+/g," ")),
        has_other_registry_number:[...numbers].some(s=>!s.includes(inn))
      };
    });
  },{rectangles,inn});
}
