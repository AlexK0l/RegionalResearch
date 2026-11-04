import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyEntityType,
  deterministicQualificationDecision,
  postInnDedupe,
  duplicateInnConflictGroups,
  clearUnresolvedInnConflicts
} from "../src/pipeline.js";

function record(name, note, extra = {}) {
  return {
    id: "q1",
    sheet: "direct_buyers",
    row: {
      "Организация": name,
      "ИНН": extra.inn || "",
      "Город/район": "Смоленская область",
      "Техника/сегмент": extra.segment || "",
      "Основание": extra.basis || "",
      "__evidence": {
        source_urls: ["https://example.org/source"],
        notes: [note]
      }
    }
  };
}

test("commercial cargo owner can survive as C without a known fleet", () => {
  const decision = deterministicQualificationDecision(
    record(
      "ООО Зерновой Поток",
      "Компания выращивает и перерабатывает зерно, ведет регулярную отгрузку продукции со своей производственной площадки.",
      {
        segment: "зерно, производство и отгрузка",
        basis: "Подтвержден действующий производственный процесс и физический грузопоток."
      }
    )
  );

  assert.equal(decision.decision, "include");
  assert.equal(decision.grade, "C");
  assert.equal(decision.signals.entityType, "commercial");
  assert.equal(decision.signals.operatingProcess, true);
});

test("government bodies are excluded even when procurement evidence is strong", () => {
  const decision = deterministicQualificationDecision(
    record(
      "Администрация муниципального образования Ярцевский муниципальный округ",
      "Администрация заключила договор на приобретение полуприцепа ТОНАР для муниципальных нужд.",
      {
        segment: "полуприцеп ТОНАР",
        basis: "закупка прицепной техники"
      }
    )
  );

  assert.equal(
    classifyEntityType({
      "Организация": "Администрация муниципального образования Ярцевский муниципальный округ"
    }),
    "government_body"
  );
  assert.equal(decision.decision, "exclude");
  assert.equal(decision.grade, "");
  assert.equal(decision.signals.entityType, "government_body");
});

test("budget institutions are excluded while public operators remain a separate type", () => {
  assert.equal(
    classifyEntityType({ "Организация": "ФКУ Колония-поселение № 7" }),
    "budget_institution"
  );
  assert.equal(
    classifyEntityType({ "Организация": "МУП Коммунальник" }),
    "public_operator"
  );
});

test("post-INN dedupe merges compatible aliases with one confirmed INN", () => {
  const finalResult = {
    direct_buyers: [
      {
        "Организация": "ООО Альфа Транс",
        "ИНН": "6732000000",
        "Город/район": "Смоленск",
        "Техника/сегмент": "зерно",
        "Основание": "C — зерновой грузопоток",
        "__canonical_id": "k1",
        "__evidence": { source_urls: [], notes: ["Перевозка зерна."] }
      },
      {
        "Организация": "АЛЬФА ТРАНС ООО",
        "ИНН": "6732000000",
        "Город/район": "Смоленск",
        "Техника/сегмент": "зерно",
        "Основание": "C — зерновой грузопоток",
        "__canonical_id": "k2",
        "__evidence": { source_urls: [], notes: ["Отгрузка зерна."] }
      }
    ],
    intermediaries: [],
    leasing: []
  };

  const result = postInnDedupe(finalResult, "Смоленская область", { merges: [] });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].row["ИНН"], "6732000000");
});

test("unresolved incompatible same-INN claimants are quarantined with originals preserved", () => {
  const finalResult = {
    direct_buyers: [
      {
        "Организация": "ООО Альфа",
        "ИНН": "6732000000",
        "__evidence": { source_urls: [], notes: [] }
      },
      {
        "Организация": "ООО Бета",
        "ИНН": "6732000000",
        "__evidence": { source_urls: [], notes: [] }
      }
    ],
    intermediaries: [], leasing: [], qualification_review: []
  };
  assert.equal(duplicateInnConflictGroups(finalResult).length, 1);
  const resolution = clearUnresolvedInnConflicts(finalResult);
  assert.equal(resolution.groups, 1);
  assert.equal(resolution.clearedRows, 0);
  assert.equal(resolution.quarantinedRows, 2);
  assert.equal(duplicateInnConflictGroups(finalResult).length, 0);
  assert.equal(finalResult.direct_buyers.length, 0);
  assert.equal(finalResult.qualification_review.length, 2);
  assert.deepEqual(finalResult.qualification_review.map(r=>r["ИНН"]),
    ["6732000000","6732000000"]);
});


test("deterministic quality gate runs before paid enrichment and again after contacts",()=>{
  const pre=pipeline.indexOf('[PRE_ENRICHMENT_QUALITY_GATE]');
  const paid=pipeline.indexOf('const finalCompaniesForEnrichment = allResearchRows(finalResult)');
  const post=pipeline.indexOf('[FINAL_PRODUCTION_QUALITY_GATE]');
  assert.ok(pre>0,"must report pre-enrichment gate");
  assert.ok(paid>pre,"pre-enrichment quality gate precedes paid enrichment");
  assert.ok(post>paid,"post-contact gate still rechecks later evidence");
  assert.match(pipeline,/FINAL_INN_REDUNDANT_RETRY/);
  assert.match(pipeline,/shouldRetryFinalInn/);
});
