import test from "node:test";
import assert from "node:assert/strict";
import { attachInlineNoteProvenance } from "../src/evidenceProvenance.js";

test("inline cited note has the exact same-note URL and remains unverified", () => {
  const row = { __evidence: {
    source_urls: ["https://different.example/misc"],
    facts: [],
    notes: ["Завод эксплуатирует собственный транспорт для доставки древесины ([company.example](https://company.example/delivery?region=67))."]
  }};
  const result = attachInlineNoteProvenance(row);
  assert.equal(result.linked, 1);
  assert.equal(row.__evidence.inline_note_provenance[0].source_url, "https://company.example/delivery?region=67");
  assert.equal(row.__evidence.inline_note_provenance[0].automatic_qualification_proof, false);
  assert.deepEqual(row.__evidence.facts, []);
  assert.equal(row.__evidence.inline_note_provenance_audit.live_sources_rechecked, false);
});

test("separate source URL collection does not fabricate claim attribution", () => {
  const row = { __evidence: {
    source_urls: ["https://example.org/forest"],
    notes: ["Компания перевозит лес своими лесовозами."]
  }};
  const result = attachInlineNoteProvenance(row);
  assert.equal(result.linked, 0);
  assert.equal(result.unlinked, 1);
  assert.deepEqual(row.__evidence.inline_note_provenance, []);
});

test("more than one URL in one note is ambiguous and excluded from automatic claims", () => {
  const row = { __evidence: {
    notes: ["Разные сообщения о транспортной деятельности: https://a.example/a и https://b.example/b."]
  }};
  const result = attachInlineNoteProvenance(row);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.linked, 0);
});

test("identity metadata never becomes a transportation claim", () => {
  const row = { __evidence: {
    notes: ["Final INN: подтверждён ИНН 6731000000: https://company.example/inn", "Подтверждённый ИНН: 6731000000"]
  }};
  const result = attachInlineNoteProvenance(row);
  assert.equal(result.metadata_skipped, 2);
  assert.equal(result.linked, 0);
});

test("repeat audit is idempotent and source notes stay untouched", () => {
  const note = "Сайт подтверждает собственную доставку щебня грузовым транспортом. https://example.org/delivery";
  const row = { __evidence: { notes: [note], facts: [{ fact_type: "known", statement: "Existing", source_url: "https://original.example/test" }] } };
  const first = attachInlineNoteProvenance(row);
  const once = structuredClone(row);
  const twice = attachInlineNoteProvenance(row);
  assert.deepEqual(twice, first);
  assert.deepEqual(row, once);
  assert.equal(row.__evidence.notes[0], note);
  assert.equal(row.__evidence.facts.length, 1);
});
