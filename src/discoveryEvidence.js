// Preserve an explicitly cited model-authored discovery basis as a SAME-CLAIM
// evidence note. This is not live URL verification, and it never borrows a
// general company URL to support an unrelated claim.
const LINK_IN_TEXT = /https?:\/\/[^\s<>\])]+/gi;
const txt = v => String(v ?? "").trim();

function oneInlineUrl(value) {
  const raw = txt(value);
  const list = [...new Set([...raw.matchAll(LINK_IN_TEXT)].map(x =>
    x[0].replace(/[.,;!?]+$/g, "")))];
  if (list.length !== 1) return "";
  try {
    const u = new URL(list[0]);
    if (u.protocol !== "https:" || !u.hostname.includes(".") ||
        u.username || u.password) return "";
  } catch { return ""; }
  return list[0];
}

export function preserveCitedDiscoveryBasis(row) {
  if (!row || typeof row !== "object") return row;
  const basis = txt(row["Основание"]);
  // Preserve only an explicit model-positive A claim with its own URL.
  // Cited weaker B/C notes should not change the deterministic qualification
  // merely because the model supplied a URL in the preliminary basis.
  if (!/^A\s*[—–:\-]/i.test(basis) || !oneInlineUrl(basis)) return row;
  const ev = row.__evidence && typeof row.__evidence === "object"
    ? row.__evidence : {};
  const notes = Array.isArray(ev.notes) ? ev.notes : [];
  if (notes.includes(basis)) return row;
  return { ...row, __evidence: { ...ev, notes: [...notes, basis] } };
}

/**
 * Common model formatting: "([display](https://domain/page))". Extract
 * only an unambiguous real URL without assigning it to any particular claim.
 * Invalid pseudolinks are retained for a separate source-quality audit.
 */
export function normalizeDiscoverySourceUrls(row) {
  if (!row || typeof row !== "object" || !row.__evidence ||
      !Array.isArray(row.__evidence.source_urls)) return row;
  const urls = row.__evidence.source_urls.map(value => {
    const raw = txt(value);
    const wrapped = raw.match(/^\(?\[[^\]]{1,220}\]\((https:\/\/[^)\s]+)\)\)?$/i);
    return wrapped && oneInlineUrl(wrapped[1]) ? wrapped[1] : raw;
  });
  if (urls.every((url, index) => url === row.__evidence.source_urls[index])) return row;
  return { ...row, __evidence: { ...row.__evidence, source_urls: urls } };
}
