import { gunzipSync } from "node:zlib";

const COURT_INDEX_GZIP_BASE64 = "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";
let cache;

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

function significantRegionTokens(region) {
  const stop = new Set(["область","край","республика","автономная","автономный","округ","город","г"]);
  return normalize(region)
    .split(" ")
    .filter((x) => x && !stop.has(x))
    .map((x) => x.length > 7 ? x.slice(0, 7) : x)
    .filter((x) => x.length >= 4);
}

function loadIndex() {
  if (cache) return cache;

  try {
    const packed = Buffer.from(COURT_INDEX_GZIP_BASE64, "base64");
    const text = gunzipSync(packed).toString("utf8");
    cache = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [court, organizations = ""] = line.split("\t");
        return {
          court,
          organizations: organizations.split("|").map((x) => x.trim()).filter(Boolean)
        };
      });
  } catch (error) {
    console.error(
      "Court archive compact index is unavailable; continuing without compact fallback:",
      error?.message || error
    );
    cache = [];
  }

  return cache;
}

export function courtArchiveCandidates(region, limit = 180) {
  const tokens = significantRegionTokens(region);
  if (!tokens.length) return [];

  const matches = loadIndex().filter((entry) => {
    const court = normalize(entry.court);
    return tokens.some((token) => court.includes(token));
  });

  const seen = new Set();
  const out = [];
  for (const entry of matches) {
    for (const organization of entry.organizations) {
      const key = normalize(organization);
      if (!key || seen.has(key)) continue;
      if (/^(данные изъяты|адрес|\*+|ооо)$/i.test(organization)) continue;
      seen.add(key);
      out.push({ organization, court: entry.court, source: "uploaded_court_archive" });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function courtArchiveStats() {
  const index = loadIndex();
  return {
    documents: 10109,
    uniqueOrganizations: 2452,
    courts: index.length
  };
}
