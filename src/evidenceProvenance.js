// Strict, offline claim-to-source preservation. We never infer provenance from
// a shared URL list, and this audit NEVER promotes qualifications or asserts
// that an external URL has been rechecked.
const METADATA_NOTE = /^(?:identity:|final inn:|подтвержд[её]нный инн:|identity без нового web-search:|контакт восстановлен по подтвержд[её]нному инн)/i;
const INLINE_URL_PATTERN = /https?:\/\/[^\s<>\])]+/gi;
const MARKDOWN_LINK = /\[([^\]]{1,220})\]\((https?:\/\/[^)\s]+)\)/gi;

function usableUrl(s) {
  try {
    const url = new URL(s);
    return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".");
  } catch { return false; }
}

function extractInlineUrls(note) {
  const found = [...String(note).matchAll(INLINE_URL_PATTERN)]
    .map((m) => m[0].replace(/[.,;!?]+$/g, ""))
    .filter(usableUrl);
  return [...new Set(found)];
}

export function attachInlineNoteProvenance(row) {
  if (!row || typeof row !== "object") return { note_count: 0, linked: 0, ambiguous: 0, unlinked: 0 };
  row.__evidence ||= {};
  const evidence = row.__evidence;
  const notes = Array.isArray(evidence.notes) ? evidence.notes : [];
  const citations = [];
  const audit = {
    note_count: notes.length, linked: 0, ambiguous: 0,
    unlinked: 0, metadata_skipped: 0, source_list_is_not_attribution: true,
    live_sources_rechecked: false
  };
  for (let i = 0; i < notes.length; i++) {
    const raw = String(notes[i] || "").trim();
    if (!raw || METADATA_NOTE.test(raw)) { audit.metadata_skipped++; continue; }
    const urls = extractInlineUrls(raw);
    if (urls.length !== 1) {
      if (urls.length > 1) audit.ambiguous++;
      else audit.unlinked++;
      continue;
    }
    const statement = raw.replace(MARKDOWN_LINK, "$1").replace(INLINE_URL_PATTERN, "")
      .replace(/\s+/g, " ").trim();
    if (statement.length < 25) { audit.unlinked++; continue; }
    citations.push({
      note_index: i, statement, source_url: urls[0],
      status: "inline_citation_only_not_live_verified",
      source_scope: "same_note",
      automatic_qualification_proof: false
    });
    audit.linked++;
  }
  evidence.inline_note_provenance = citations;
  evidence.inline_note_provenance_audit = audit;
  return audit;
}
