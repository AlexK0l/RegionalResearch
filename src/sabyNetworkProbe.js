// Privacy-preserving Saby network/DOM diagnostic helpers.
// Browser response payloads are inspected in RAM ONLY. Never persist URL query
// values, headers, response text, contacts, emails, cookies or credentials.
import {createHash} from "node:crypto";

const sha = input=>createHash("sha256").update(input).digest("hex").slice(0,16);
const countMatches = (text, regex)=>regex.test(text);

export function safeNetworkEndpoint(rawUrl) {
  try {
    const u=new URL(String(rawUrl||""));
    if(!["https:","wss:"].includes(u.protocol))return null;
    if(!/(^|\.)(saby\.ru|sbis\.ru|tensor\.ru)$/i.test(u.hostname))return null;
    // Hash path AND query parameter NAMES. Query parameter VALUES could carry
    // an INN, identity/session token or the search text; NEVER persist them.
    const queryNames=[...new Set([...u.searchParams.keys()])].sort().join(",");
    const key=sha(u.hostname.toLowerCase()+u.pathname+"?"+queryNames);
    return {host:u.hostname.toLowerCase(),route:key};
  } catch {return null;}
}

export function safeResponseBody(body, contentType="") {
  const input=Buffer.isBuffer(body)?body:Buffer.from(String(body||""));
  const ct=String(contentType||"").toLowerCase().split(";",1)[0].trim();
  const type=ct.includes("json")?"json":
    /(?:text|javascript|xml|html)/.test(ct)?"text":"binary";
  const out={bytes:input.byteLength,sha256_16:sha(input),type,
    contact_marker:false,fleet_marker:false,
    phone_key:false,vehicle_key:false,error_key:false,
    access_marker:false,json_root:"unknown"};
  // Never retain or log raw text, which may contain sensitive contact data.
  if(type==="binary")return out;
  const text=input.toString("utf8").slice(0,400000);
  out.contact_marker=countMatches(text,/контакт|contacts?|электронн(?:ая|ой) почт|e-?mail/i);
  out.fleet_marker=countMatches(text,/автопарк|грузовые|транспорт|vehicles?|trucks?|carpark/i);
  out.phone_key=countMatches(text,/"(?:phone|phones|telephone|mobile|tel|phoneNumber|contactPhone)"\s*:/i);
  out.vehicle_key=countMatches(text,/"(?:vehicle|vehicles|truck|trucks|carPark|transport)"\s*:/i);
  out.error_key=countMatches(text,/"(?:error|errors|errorCode|exception)"\s*:/i);
  out.access_marker=countMatches(text,/access denied|forbidden|доступ ограничен|нет доступа|captcha|капча/i);
  if(type==="json" && input.byteLength<=2000000) {
    try {
      const parsed=JSON.parse(input.toString("utf8"));
      out.json_root=Array.isArray(parsed)?"array":
        parsed===null?"null":typeof parsed==="object"?"object":typeof parsed;
    } catch {out.json_root="parse_failed";}
  }
  return out;
}

export function compareSabyNetwork(left,right) {
  const a=new Map((left?.endpoints||[]).map(x=>[x.host+":"+x.route+":"+x.type+":"+x.method,x]));
  const b=new Map((right?.endpoints||[]).map(x=>[x.host+":"+x.route+":"+x.type+":"+x.method,x]));
  const onlyLeft=[...a.keys()].filter(k=>!b.has(k)).sort().slice(0,40);
  const onlyRight=[...b.keys()].filter(k=>!a.has(k)).sort().slice(0,40);
  const changed=[];
  for(const [key,l] of a){
    const r=b.get(key);
    if(!r)continue;
    const leftCodes=JSON.stringify(l.status_counts||{});
    const rightCodes=JSON.stringify(r.status_counts||{});
    const leftFlags=JSON.stringify(l.signals||{});
    const rightFlags=JSON.stringify(r.signals||{});
    if(leftCodes!==rightCodes || leftFlags!==rightFlags) {
      changed.push({route:key,status_left:l.status_counts,
        status_right:r.status_counts,signals_left:l.signals,
        signals_right:r.signals});
    }
  }
  return {only_left:onlyLeft,only_right:onlyRight,
    differences:changed.slice(0,40),
    left_api_count:(left?.endpoints||[]).length,
    right_api_count:(right?.endpoints||[]).length};
}
