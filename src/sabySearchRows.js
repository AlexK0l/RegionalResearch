// Read-only Saby company-search DOM adapter. Stage12 must distinguish
// *visible company result cards* from nested highlighted INN fragments.
// Two separate cards are never merged merely because they have the same
// INN or title. This is candidate collection, NOT legal identity proof.

const SEARCH_TITLE_EXCLUSIONS=/^(?:инн|кпп|огрн|огрнип|окпо|ооо|оао|пао|ао|зао|ип|найдено|поиск|результаты поиска|список компаний|компании|карточка компании|реквизиты|контакты|сведения о компании|о компании|показать еще|загрузка|организации)\s*[:：.-]?\s*$/iu;

export function sabySearchDisplayName(text,inn) {
  const prefix=String(text||"").split(String(inn||""),1)[0];
  return prefix.split(/[\r\n|·]/,1)[0]
    .replace(/(?:^|\s)ИНН\s*[:：№#-]?\s*$/iu,"")
    .replace(/\s+/g," ").trim();
}
export function plausibleSabySearchName(text,inn) {
  const title=sabySearchDisplayName(text,inn);
  return title.length>=3&&title.length<=220 &&
    /[\p{L}]{3,}/u.test(title) &&
    !SEARCH_TITLE_EXCLUSIONS.test(title) &&
    !/^(?:найдено|загрузка|искать|поиск по|список|результаты|номер|показать)\b/iu.test(title);
}

/**
 * Standalone Playwright page.evaluate callback: references only browser
 * built-ins plus parameters, never module closures. Visible geometry is
 * evidence of which text fragments belong to the same card.
 */
export function scanSabyResultDOM({
  inn,includeInnOnly=false,includeBranches=false,branchSource
}) {
  const norm=s=>String(s||"").replace(/\s+/g," ").trim();
  const matchesInn=s=>new RegExp("(?:^|\\D)"+inn+"(?!\\d)").test(s);
  const branchPattern=new RegExp(branchSource,"iu");
  const eligibleFirstLine=raw=>{
    const prefix=String(raw||"").split(inn,1)[0];
    const title=prefix.split(/[\r\n|·]/,1)[0]
      .replace(/(?:^|\s)ИНН\s*[:：№#-]?\s*$/iu,"").trim();
    if(title.length<3||title.length>220||! /[\p{L}]{3,}/u.test(title))
      return false;
    if(/^(?:инн|кпп|огрн|огрнип|окпо|ооо|оао|пао|ао|зао|ип|найдено|поиск|результаты поиска|список компаний|компании|карточка компании|реквизиты|контакты|сведения о компании|о компании|показать еще|загрузка|организации)\s*[:：.-]?\s*$/iu.test(title))
      return false;
    return true;
  };
  const visible=el=>{
    const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
    return rect.width>0 && rect.height>0 &&
      style.visibility!=="hidden" && style.display!=="none";
  };
  const legal=/(?:^|\W)(?:ООО|ПАО|АО|ОАО|ЗАО|ИП)(?:\W|$)/iu;
  const rows=[];
  let leafHits=0,rawCapped=false;
  const leaves=document.querySelectorAll("body *");
  for(const leaf of leaves) {
    if(!visible(leaf)||!matchesInn(norm(leaf.textContent)))continue;
    if([...leaf.children].some(child=>matchesInn(norm(child.textContent))))continue;
    leafHits++;
    let node=leaf;
    for(let depth=0;node&&depth<12;depth++,node=node.parentElement) {
      if(!visible(node))continue;
      const rect=node.getBoundingClientRect();
      const raw=String(node.innerText||node.textContent||"");
      const text=norm(raw);
      if(rect.height>190||text.length>700)break;
      if(rect.width<190||rect.height<24||!matchesInn(text))continue;
      if(!includeInnOnly&&!legal.test(text))continue;
      // Previously "ИНН: 7725104641" could be treated as a company card
      // and stop the parent walk. Keep walking until a real name precedes
      // that INN in the SAME visible row.
      if(!eligibleFirstLine(raw))continue;
      if(!includeBranches&&branchPattern.test(raw.split(inn,1)[0]))break;
      rows.push({text:raw,rect:{x:rect.x,y:rect.y,
        w:rect.width,h:rect.height}});
      break;
    }
    if(rows.length>=320){rawCapped=true;break;}
  }
  return {rows,leafHits,rawCapped};
}
const normalized=s=>String(s||"").normalize("NFKC").toLocaleLowerCase("ru")
  .replace(/ё/g,"е").replace(/\s+/g," ").trim();
const intersection=(a,b,axis,dim)=>{
  const first=Number(a?.[axis]),second=Number(b?.[axis]);
  const sizeA=Number(a?.[dim]),sizeB=Number(b?.[dim]);
  if(!Number.isFinite(first)||!Number.isFinite(second)||
     !Number.isFinite(sizeA)||!Number.isFinite(sizeB)||
     sizeA<=0||sizeB<=0)return 0;
  const common=Math.max(0,
    Math.min(first+sizeA,second+sizeB)-Math.max(first,second));
  return common/Math.min(sizeA,sizeB);
};
export function overlappingSabyCard(a,b) {
  // Both rectangles must substantially overlap on BOTH axes. Two cards
  // in adjacent rows/columns must not be merged even if their names match.
  return intersection(a,b,"x","w")>=0.70 &&
    intersection(a,b,"y","h")>=0.70;
}
export function consolidateSabyResultRows(input,inn,{maxRows=120}={}) {
  const raw=Array.isArray(input)?input:
    Array.isArray(input?.rows)?input.rows:[];
  const merged=[];
  let rejectedFragments=0,geometryDuplicates=0;
  for(const item of raw) {
    if(!new RegExp("(?:^|\\D)"+String(inn||"")+"(?!\\d)")
      .test(String(item?.text||"")) ||
      !plausibleSabySearchName(item?.text,inn)) {
      rejectedFragments++;
      continue;
    }
    const title=normalized(sabySearchDisplayName(item.text,inn));
    const duplicate=merged.find(existing=>
      existing.canonicalTitle===title &&
      overlappingSabyCard(existing.item.rect,item.rect));
    if(duplicate) {
      geometryDuplicates++;
      // A larger fragment may contain the entire visible card. Preserve
      // clickable geometry of that same overlapping card and fuller text.
      if(String(item.text).length>String(duplicate.item.text).length)
        duplicate.item=item;
    } else {
      merged.push({item,canonicalTitle:title});
    }
  }
  const tooMany=merged.length>maxRows;
  const rows=merged.slice(0,maxRows).map(x=>x.item);
  const uniqueTitles=new Set(merged.map(x=>x.canonicalTitle)).size;
  Object.defineProperty(rows,"meta",{value:{
    rawCandidates:raw.length,
    rejectedFragments,geometryDuplicates,
    distinctCards:merged.length,uniqueTitles,
    rawCapped:input?.rawCapped===true,
    truncated:tooMany||input?.rawCapped===true
  },enumerable:false});
  return rows;
}
