// Exact owner projection from the supplied rendered contractor card.
// Self-contained browser-side reader. No body-wide search, raw HTML,
// serialized app state, private network call or page-script evaluation.
// The root is returned ONLY to other code executing inside this DOM read.
export function scanSabyMarkupOwnerDOM({inn,nameTokens,legalWords}={}){
  if(!/^(?:\d{10}|\d{12})$/.test(inn||"")||!Array.isArray(nameTokens)||
     !nameTokens.length||!Array.isArray(legalWords))return null;
  const roots=[...document.querySelectorAll('[data-qa="contractorCard-dialog-Stack"]')];
  if(roots.length!==1||!roots[0].isConnected)return null;
  const root=roots[0];
  const visible=e=>{
    if(!e?.isConnected||typeof e.getBoundingClientRect!=="function")return false;
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=="none"&&
      !["hidden","collapse"].includes(s.visibility)&&s.opacity!=="0";
  };
  const clean=t=>String(t||"").replace(/\s+/gu," ").trim();
  const one=(scope,selector)=>{
    const nodes=[...scope.querySelectorAll(selector)].filter(visible);
    return nodes.length===1?nodes[0]:null;
  };
  // A shareholder, branch, or related-company INN is not the own row.
  const row=one(root,'[data-qa="ContractorCard-About-ИНН"]');
  if(!row)return null;
  const label=one(row,'.contractor-Dialog_About-publicINN_label');
  const value=one(row,'.contractor-Dialog_INNKPP-pointer');
  if(!label||!value||clean(label.textContent)!=="ИНН"||clean(value.textContent)!==inn)
    return null;
  const legal=new Set(legalWords);
  const tokens=name=>(String(name||"").normalize("NFKC").toLowerCase()
    .replace(/ё/g,"е").match(/[a-zа-я0-9]+/gu)||[]).filter(t=>!legal.has(t));
  const names=[...root.querySelectorAll('[data-qa="headersNew-Content"] h1')].filter(visible);
  if(!names.length||names.length>4)return null;
  const titles=names.map(n=>clean(n.innerText));
  // Compact and expanded copies of the SAME title are normal. A different
  // visible title, a mismatching tooltip, or an abbreviated alias must use
  // the existing full/independent legal-identity path instead.
  if(titles.some((t,i)=>{
    const attr=clean(names[i].getAttribute("title"));
    const actual=tokens(t);
    return t.length<3||t.length>180||attr&&attr!==t||
      actual.length!==nameTokens.length||actual.some((x,j)=>x!==nameTokens[j]);
  }))return null;
  return {root,name:titles[0]};
}
