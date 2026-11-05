import test from "node:test";
import assert from "node:assert/strict";
import { preserveCitedDiscoveryBasis, normalizeDiscoverySourceUrls } from "../src/discoveryEvidence.js";
import { attachInlineNoteProvenance } from "../src/evidenceProvenance.js";

test("actual Smolensk discovery A claim carries its OWN inline source into final evidence", () => {
  const original = {
    "Организация": "ООО КСП «Струково»",
    "Основание": "A — собственник полуприцепа KRONE SD ООО КСП «Струково». ([Источник](https://konfiskatik.ru/regions/smolenskaya-oblast/inoj-transport))",
    __evidence: {
      source_urls: ["https://unrelated.example.org/company", "https://konfiskatik.ru/regions/smolenskaya-oblast/inoj-transport"],
      notes: ["Техника упомянута в региональной выдаче."]
    }
  };
  const result = preserveCitedDiscoveryBasis(original);
  assert.equal(result.__evidence.notes.length, 2);
  assert.equal(result.__evidence.notes[1], original["Основание"]);
  assert.equal(original.__evidence.notes.length, 1, "Do not mutate input checkpoint");
  const attribution = attachInlineNoteProvenance(result);
  assert.equal(attribution.linked, 1);
  assert.equal(result.__evidence.inline_note_provenance[0].source_url,
    "https://konfiskatik.ru/regions/smolenskaya-oblast/inoj-transport");
  assert.equal(result.__evidence.inline_note_provenance[0].automatic_qualification_proof, false);
  assert.equal(result.__evidence.inline_note_provenance_audit.live_sources_rechecked, false);
});

test("general URL list never grants a source to a model A assertion", () => {
  const row = {
    "Основание": "A — собственный парк полуприцепов Schmitz подтверждён.",
    __evidence: { source_urls: ["https://site.example.org/fleet"], notes: ["Завод выпускает детали."] }
  };
  const result = preserveCitedDiscoveryBasis(row);
  assert.strictEqual(result, row);
  assert.deepEqual(result.__evidence.notes, ["Завод выпускает детали."]);
});

test("two different inline sources are ambiguous; do not fabricate a precise attribution", () => {
  const row = {
    "Основание": "A — покупка полуприцепа; https://site.example.org/a и https://other.example.org/b",
    __evidence: { source_urls: [], notes: [] }
  };
  assert.strictEqual(preserveCitedDiscoveryBasis(row), row);
});

test("an explicit B or C source remains a weaker model basis, not new A proof", () => {
  for (const grade of ["B", "C"]) {
    const row = {
      "Основание": grade + " — грузовые перевозки, парк не указан. ([Источник](https://carrier.example.org/about))",
      __evidence: { source_urls: [], notes: [] }
    };
    assert.strictEqual(preserveCitedDiscoveryBasis(row), row);
  }
});

test("model-supplied Markdown wrapper is parsed as a URL without claim laundering", () => {
  const row = {
    "Основание": "C — зерновой поток, полуприцеп не доказан",
    __evidence: { source_urls: [
      "([rcfh.ru](https://rcfh.ru/upload/head/docs/info_o_pm.pdf?utm_source=openai))",
      "https://233991search14"
    ], notes: ["Отдельного подтверждения тягача нет."] }
  };
  const next = normalizeDiscoverySourceUrls(row);
  assert.equal(next.__evidence.source_urls[0],
    "https://rcfh.ru/upload/head/docs/info_o_pm.pdf?utm_source=openai");
  assert.equal(next.__evidence.source_urls[1], "https://233991search14",
    "Preserve invalid original for QA instead of inventing a URL");
  assert.equal(next.__evidence.notes.length, 1);
  assert.equal(row.__evidence.source_urls[0].startsWith("("), true);
});

test("capturing citation twice is idempotent and keeps original evidence", () => {
  const row = { "Основание": "A — конкретная сделка прицепа. https://source.example.org/contract",
    __evidence: { source_urls: [], notes: ["Боковой факт."] } };
  const once = preserveCitedDiscoveryBasis(row);
  const twice = preserveCitedDiscoveryBasis(once);
  assert.deepEqual(once, twice);
});
