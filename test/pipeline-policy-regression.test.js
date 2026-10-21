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

test("unresolved incompatible duplicate INN is cleared rather than silently assigned twice", () => {
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
    intermediaries: [],
    leasing: []
  };

  assert.equal(duplicateInnConflictGroups(finalResult).length, 1);
  const cleared = clearUnresolvedInnConflicts(finalResult);
  assert.equal(cleared.groups, 1);
  assert.equal(cleared.clearedRows, 2);
  assert.equal(duplicateInnConflictGroups(finalResult).length, 0);
  assert.equal(finalResult.direct_buyers[0]["ИНН"], "");
  assert.equal(finalResult.direct_buyers[1]["ИНН"], "");
});
