// One authoritative email contract across discovery, identity, Stage11, Saby
// and XLSX export. Visible cells contain ONLY verified-looking addresses;
// source provenance stays in __evidence / existing organization comments.
// No network requests, no guessed domains, no group-to-subsidiary transfers.

export const EMAIL_COLUMN="Электронная почта";
const EMAIL_PATTERN=/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;
const EXACT_EMAIL=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function normalizeEmail(value) {
  const candidate=String(value??"").trim()
    .replace(/^mailto:/i,"").toLowerCase();
  if(candidate.length>254||!EXACT_EMAIL.test(candidate))return "";
  const [local,domain]=candidate.split("@");
  if(!local||local.length>64||local.startsWith(".")||
      local.endsWith(".")||local.includes("..")||
      domain.split(".").some(part=>part.length>63))return "";
  return candidate;
}

export function parseEmailEntries(value) {
  if(value==null)return [];
  const inputs=Array.isArray(value)?value:[value];
  const result=[],seen=new Set();
  for(const item of inputs){
    const text=String(item??"").slice(0,3000);
    for(const match of text.matchAll(EMAIL_PATTERN)){
      const email=normalizeEmail(match[0]);
      if(email&&!seen.has(email)){
        seen.add(email);result.push(email);
      }
      if(result.length>=20)return result;
    }
  }
  return result;
}

export function formatEmailCell(...values){
  const seen=new Set(),result=[];
  for(const input of values)for(const address of parseEmailEntries(input)){
    if(!seen.has(address)){seen.add(address);result.push(address);}
    if(result.length>=20)return result.join("; ");
  }
  return result.join("; ");
}

function commentEmails(comment){
  const line=String(comment||"").match(/^Email:\s*([^\r\n]*)/im);
  return line?.[1]||"";
}

function trustedSabyEmails(row){
  const saby=row?.__evidence?.saby;
  const inn=String(row?.["ИНН"]??"").trim();
  if(!inn||!saby||String(saby.inn??"")!==inn||
      saby.collection?.contacts!=="collected"||
      !/^https:\/\/profile\.saby\.ru\//i.test(String(saby.source_url||"")))
    return [];
  return Array.isArray(saby.emails)?saby.emails:[];
}

// Legacy research stored e-mails only in an evidence field or the Excel note.
// Read these when reopening an old SQLite checkpoint, without changing it.
export function companyEmailCell(row){
  if(!row||typeof row!=="object")return "";
  const evidence=row.__evidence||{};
  return formatEmailCell(
    row[EMAIL_COLUMN],row.Email,evidence.email,
    commentEmails(row.__comment),trustedSabyEmails(row)
  );
}

export function mergeCompanyEmail(row,...newValues){
  if(!row||typeof row!=="object")return false;
  const previous=companyEmailCell(row);
  const merged=formatEmailCell(previous,...newValues);
  const changed=merged!==formatEmailCell(row[EMAIL_COLUMN]);
  row[EMAIL_COLUMN]=merged;
  return changed;
}
