import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildHistoricalRecallPlan, historicalRecallPrompt, filterHistoricalRecallFindings, auditHistoricalRecallOutcome, buildHistoricalCoverageLedger
} from "../src/historicalRecall.js";
import { researchWebScope } from "../src/researchCostPolicy.js";

const innA = "6732114166";
const innB = "6726504312";
const region = "Смоленская область";

const row = (name, inn, grade = "A", extra = {}) => ({
  "Организация": name,
  "ИНН": inn,
  "Город/район": "Смоленск",
  "Техника/сегмент": "Полуприцепы",
  "Основание": grade + " — архивное основание",
  __final_grade: grade,
  "Телефон": "79995556677",
  "__evidence": {
    identity_verification: {
      inn, source_urls: ["https://example.org/registry/" + inn]
    },
    source_urls: ["https://example.org/transport/company"],
    notes: ["Архивное подтверждение полуприцепа"]
  },
  ...extra
});
const run = (id, rows, attempted = []) => ({
  id, updated_at: "2026-11-04T13:39:17.559Z",
  final_result: { direct_buyers: rows, intermediaries: [], leasing: [],
    qualification_review: [row("ООО «Только ручная проверка»", innB)] },
  recall_attempted_inns: attempted
});

test("only completed commercial records with source-linked, checksum-valid INN can be historical hints", () => {
  const good = row("ООО «Первый перевозчик»", innA);
  const wrongProof = row("ООО «Недостоверная связь»", innB, "B", {
    __evidence: { identity_verification: { inn: innA,
      source_urls: ["https://example.org/registry"] } }
  });
  const noProof = row("ООО «Без источника»", innB, "B", { __evidence: {} });
  const agency = row("Администрация Смоленской области", innB);
  const plan = buildHistoricalRecallPlan([run("history-1",
    [good, wrongProof, noProof, agency])], [], { maxCandidates: 10 });
  assert.equal(plan.verified_history_unique, 1);
  assert.equal(plan.total_missing_candidates, 1);
  assert.equal(plan.candidates[0].inn, innA);
  assert.equal(plan.candidates[0].name, good["Организация"]);
  assert.equal(plan.candidates[0].source_job_id, "history-1");
  assert.ok(!JSON.stringify(plan.candidates[0]).includes("79995556677"));
});

test("confirmed INN found again is counted; matching name alone is not treated as verified", () => {
  const old = run("history-2", [
    row("ООО «Первый перевозчик»", innA),
    row("ООО «Второй перевозчик»", innB)
  ]);
  const observed = [
    { data: { "Организация": "ООО «Первый перевозчик»", "ИНН": innA } },
    { data: { "Организация": "ООО «Второй перевозчик»", "ИНН": "" } }
  ];
  const plan = buildHistoricalRecallPlan([old], observed);
  assert.equal(plan.verified_history_unique, 2);
  assert.equal(plan.already_seen_by_inn, 1);
  assert.equal(plan.already_seen_by_name_unverified, 1);
  assert.equal(plan.total_missing_candidates, 0);
});

test("different verified INNs sharing one company name are held out of automatic recall", () => {
  const history = run("conflicting", [
    row("ООО «Транском»", innA), row("ООО «Транском»", innB)
  ]);
  const plan = buildHistoricalRecallPlan([history], []);
  assert.equal(plan.ambiguous_history, 2);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.conflicts.length, 2);
  assert.ok(plan.conflicts.every(item => item.kind === "prior_same_name_multiple_inn"));
});

test("current identical name with a different verified INN is not auto-merged", () => {
  const plan = buildHistoricalRecallPlan([run("old", [row("ООО «Транском»", innA)])],
    [{ "Организация": "ООО «Транском»", "ИНН": innB }]);
  assert.equal(plan.current_name_inn_conflicts, 1);
  assert.equal(plan.total_missing_candidates, 0);
  assert.equal(plan.candidates.length, 0);
});

test("prior attempted names are rotated out of the next small paid recall allotment", () => {
  const history = [run("last", [row("ООО «Первый перевозчик»", innA),
    row("ООО «Второй перевозчик»", innB)], [innA])];
  const plan = buildHistoricalRecallPlan(history, []);
  assert.equal(plan.recently_attempted_in_previous_runs, 1);
  assert.equal(plan.total_missing_candidates, 1);
  assert.equal(plan.candidates[0].inn, innB);
});

test("history prompt never reveals or promotes the previous INN and fields", () => {
  const hint = buildHistoricalRecallPlan(
    [run("old", [row("ООО «Первый перевозчик»", innA)])], []).candidates;
  const prompt = historicalRecallPrompt(region, hint);
  assert.match(prompt, /историческ/i);
  assert.match(prompt, /Первый перевозчик/);
  assert.match(prompt, /web_search/);
  assert.match(prompt, /example\.org/);
  assert.doesNotMatch(prompt, new RegExp(innA));
  assert.doesNotMatch(prompt, /79995556677/);
  assert.equal(researchWebScope("historical recall | batch 1/3", "full"), "discovery");
});

test("recovered search rows contain only fresh discovery facts and no inherited identity or contact", () => {
  const hint = buildHistoricalRecallPlan(
    [run("old", [row("ООО «Первый перевозчик»", innA)])], []).candidates;
  const found = filterHistoricalRecallFindings({
    direct_buyers: [
      {
        "Организация": "ООО «Первый перевозчик»",
        "ИНН": innA,
        "Город/район": "Смоленск",
        "Телефон": "79990001122",
        "Руководитель / ЛПР": "Неизвестный",
        "Техника/сегмент": "Тентованные полуприцепы",
        "Основание": "На новом сайте указан парк",
        __evidence: { source_urls: ["https://carrier.example.org/fleet"],
          notes: ["Компания эксплуатирует тентованные полуприцепы"] }
      },
      { "Организация": "ООО «Посторонняя фирма»",
        "__evidence": { source_urls: ["https://example.org/other"], notes: ["Не из списка"] } }
    ],
    intermediaries: [], leasing: []
  }, hint);
  assert.equal(found.accepted_count, 1);
  assert.equal(found.rejected_count, 1);
  const accepted = found.result.direct_buyers[0];
  assert.equal(accepted["ИНН"], "");
  assert.equal(accepted["Телефон"], undefined);
  assert.equal(accepted["Руководитель / ЛПР"], undefined);
  assert.equal(accepted.__historical_recall.historical_inn_copied, false);
  assert.deepEqual(accepted.__evidence.source_urls, ["https://carrier.example.org/fleet"]);
  assert.equal(accepted.__evidence.identity_verification, undefined);
});

test("a generic pseudolink, missing evidence, or mismatched company cannot produce a history recovery", () => {
  const candidates = buildHistoricalRecallPlan(
    [run("old", [row("ООО «Первый перевозчик»", innA)])], []).candidates;
  const found = filterHistoricalRecallFindings({
    direct_buyers: [
      { "Организация": "ООО «Первый перевозчик»",
        __evidence: { source_urls: ["https://turn112808search10"], notes: ["something"] } },
      { "Организация": "ООО «Первый перевозчик»",
        __evidence: { source_urls: ["https://carrier.example.org/fleet"], notes: [] } },
      { "Организация": "ООО «Совсем другой перевозчик»",
        __evidence: { source_urls: ["https://carrier.example.org/fleet"], notes: ["something"] } }
    ], intermediaries: [], leasing: []
  }, candidates);
  assert.equal(found.accepted_count, 0);
  assert.equal(found.rejected_count, 3);
});

test("recent completed SQLite studies are readable without loading resumable checkpoints", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regional-history-test-"));
  const old = process.env.CHECKPOINT_DB_PATH;
  process.env.CHECKPOINT_DB_PATH = path.join(dir, "history.sqlite");
  try {
    const { saveCheckpoint, loadRecentCompletedResearch } =
      await import("../src/checkpointStore.js?historical-recall-test");
    const source = { direct_buyers: [row("ООО «Первый перевозчик»", innA)] };
    await saveCheckpoint("complete-a", { version: 1, region, source_mode: "full",
      phase: "completed", final_result: source,
      historical_recall: { attempted_inns: [innB] } });
    await saveCheckpoint("incomplete", { version: 1, region, source_mode: "full",
      phase: "discovery", final_result: source });
    await saveCheckpoint("elsewhere", { version: 1, region: "Тульская область",
      source_mode: "full", phase: "completed", final_result: source });
    const history = await loadRecentCompletedResearch(region, 3);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, "complete-a");
    assert.equal(history[0].final_result.direct_buyers.length, 1);
    assert.deepEqual(history[0].recall_attempted_inns, [innB]);
  } finally {
    if (old === undefined) delete process.env.CHECKPOINT_DB_PATH;
    else process.env.CHECKPOINT_DB_PATH = old;
  }
});

test("final recall trace records name matches but NEVER confirms identity by name", () => {
  const recall = {
    accepted_candidates: [
      {name:"ООО «ПАРТНЕР ЛАЙН»"},
      {name:"ООО «МОВЕТ»"},
      {name:"ООО «ТЭК Симплекс»"},
      {name:"ООО «Без ответа»"}
    ],
    plan:{candidates:[
      {name:"ООО «ПАРТНЕР ЛАЙН»",inn:innA},
      {name:"ООО «МОВЕТ»",inn:innB}
    ]}
  };
  const current = {
    direct_buyers:[{"Организация":"ООО «ПАРТНЕР ЛАЙН»","ИНН":innB},
      {"Организация":"ООО «МОВЕТ»","ИНН":innB}],
    intermediaries:[],leasing:[],
    qualification_review:[{"Организация":"ООО «ТЭК Симплекс»","ИНН":""}],
    qualification_excluded:[]
  };
  const trace = auditHistoricalRecallOutcome(recall,current);
  assert.equal(trace.accepted_discovery_candidates,4);
  assert.equal(trace.active_name_matches,2);
  assert.equal(trace.review_name_matches,1);
  assert.equal(trace.unmatched_by_name,1);
  assert.equal(trace.possible_inn_conflicts,1);
  assert.equal(trace.identity_verified_by_name,false);
  assert.equal(trace.entries[0].possible_distinct_legal_person,true);
  assert.equal(trace.entries[0].identity_verified_by_name,false);
});

test("historical recall reserves part of unchanged 24-lead cap for older completed studies", () => {
  const oldInn = "6950267331";
  const history = [
    run("recent-a", [row("ООО «Актуальный один»", innA),
      row("ООО «Актуальный два»", innB)]),
    run("recent-b", [row("ООО «Актуальный три»", "6714048954")]),
    run("recent-c", [row("ООО «Актуальный четыре»", "7702349370")]),
    run("older", [row("ООО «Давно найденный перевозчик»", oldInn, "C")])
  ];
  const plan = buildHistoricalRecallPlan(history, [], {maxCandidates: 4});
  assert.equal(plan.verified_history_unique, 5);
  assert.equal(plan.candidates.length, 4);
  assert.equal(plan.older_history_eligible, 1);
  assert.equal(plan.older_history_selected, 1);
  assert.ok(plan.candidates.some(x => x.inn === oldInn));
  assert.equal(plan.deferred_candidates, 1);
  assert.equal(plan.candidates.some(x => x.inn === "6950267331"), true);
});

test("older paid recall attempts do not permanently blacklist candidates", () => {
  const history = [
    run("recent", [row("ООО «Текущий»", innA)]),
    run("recent2", []),
    run("recent3", []),
    run("ancient", [row("ООО «Прошлый»", "6714048954")], ["6714048954"])
  ];
  const plan = buildHistoricalRecallPlan(history, [], {maxCandidates: 4});
  assert.equal(plan.recently_attempted_in_previous_runs, 0);
  assert.ok(plan.candidates.some(x => x.inn === "6714048954"));
});

test("full historical ledger retains every source-linked INN without CRM promotion", () => {
  const prior = [
    run("recent", [
      row("ООО «Работает»", innA),
      row("ООО «В REVIEW»", innB),
      row("ООО «В EXCLUDED»", "6714048954"),
      row("ООО «Только имя»", "7702349370"),
      row("ООО «Конфликтующее имя»", "6950267331")
    ]),
    run("old", [
      row("ООО «Не найден»", "6229026994"),
      row("ООО «Многократный»", "5024179934"),
      row("ООО «Два ИНН»", "6732208880"),
      row("ООО «Два ИНН»", "6722003019"),
      row("ООО «Работает»", innA)
    ])
  ];
  const current = {
    direct_buyers: [{"Организация":"ООО «Работает»","ИНН":innA}],
    intermediaries:[],
    leasing:[],
    qualification_review: [{"Организация":"ООО «В REVIEW»","ИНН":innB},
      {"Организация":"ООО «Только имя»","ИНН":""}],
    qualification_excluded: [{"Организация":"ООО «В EXCLUDED»","ИНН":"6714048954"},
      {"Организация":"ООО «Конфликтующее имя»","ИНН":"6726504312"}]
  };
  const snapshot = structuredClone(current);
  const ledger = buildHistoricalCoverageLedger(prior, current);
  assert.deepEqual(current,snapshot,"report must not mutate current CRM");
  assert.equal(ledger.counts.historic_source_linked_inn,9);
  assert.equal(ledger.counts.present_active_by_inn,1);
  assert.equal(ledger.counts.present_review_by_inn,1);
  assert.equal(ledger.counts.present_excluded_by_inn,1);
  assert.equal(ledger.counts.current_same_name_unverified,1);
  assert.equal(ledger.counts.current_same_name_different_inn,1);
  assert.equal(ledger.counts.historic_name_multiple_inn,2);
  assert.equal(ledger.counts.not_found_in_current,2);
  assert.equal(ledger.missing_or_conflicting,6);
  assert.equal(ledger.entries.length,9);
  const seen = ledger.entries.find(x => x.historical_inn === innA);
  assert.equal(seen.observed_in_completed_runs,2);
  const conflict = ledger.entries.find(x => x.historical_inn === "6950267331");
  assert.deepEqual(conflict.current_same_name_inns_audit_only,["6726504312"]);
  assert.equal(conflict.automatically_promoted_to_crm,false);
  assert.equal(ledger.auto_promoted_records,0);
  assert.equal(ledger.extra_web_calls,0);
});

test("bad identity provenance does not enter full history ledger", () => {
  const bad = row("ООО «Подмена»", innA, "A", {
    __evidence: {identity_verification:{
      inn: innB,source_urls:["https://registry.example.org/other"]
    }}
  });
  const ledger = buildHistoricalCoverageLedger([run("old",[
    bad,row("ООО «Подтвержденный источник»",innB)
  ])],[]);
  assert.equal(ledger.counts.historic_source_linked_inn,1);
  assert.equal(ledger.entries[0].historical_inn,innB);
  assert.equal(ledger.entries[0].automatically_promoted_to_crm,false);
});

test("long-form regional budget education institutions are not commercial history candidates", () => {
  const budget = row("Смоленское областное государственное бюджетное профессиональное образовательное учреждение «Верхнеднепровский технологический техникум»", innA);
  const plan = buildHistoricalRecallPlan([run("old-budget", [budget])], []);
  const ledger = buildHistoricalCoverageLedger([run("old-budget", [budget])], []);
  assert.equal(plan.verified_history_unique, 0);
  assert.equal(ledger.counts.historic_source_linked_inn, 0);
});

test("historical identity URLs shared by many INNs are flagged, not treated as independently verified", () => {
  const shared = "https://office.example.org/companies/multiple-firms.pdf";
  const a = row("ООО «Первый перевозчик»", innA);
  const b = row("ООО «Второй перевозчик»", innB);
  for (const item of [a, b])
    item.__evidence.identity_verification.source_urls = [shared];
  const ledger = buildHistoricalCoverageLedger([run("shared-url", [a, b])], []);
  assert.equal(ledger.counts.historical_identity_source_reused_across_inns, 2);
  assert.equal(ledger.counts.historical_identity_source_contains_other_valid_inn, 0);
  assert.ok(ledger.entries.every(e => e.historical_identity_source_reused_by_inns === 2));
  assert.ok(ledger.entries.every(e => e.historical_identity_url_needs_manual_review));
  assert.ok(ledger.entries.every(e => e.historical_source_contents_rechecked === false));
  assert.equal(ledger.auto_promoted_records, 0);
});

test("historical URL that names another checksum-valid INN is a manual conflict, not company proof", () => {
  const a = row("ООО «СОТРАНС ЛИЗИНГ»", "4716045183");
  a.__evidence.identity_verification.source_urls =
    ["https://e-ecolog.ru/entity/7802403007/links"];
  const ledger = buildHistoricalCoverageLedger([run("linked-other-inn",[a])],[]);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.counts.historical_identity_source_contains_other_valid_inn, 1);
  assert.equal(ledger.entries[0].historical_identity_url_contains_own_inn, false);
  assert.deepEqual(ledger.entries[0].historical_identity_url_contains_other_valid_inns,
    ["7802403007"]);
  assert.equal(ledger.entries[0].historical_identity_url_needs_manual_review, true);
  assert.equal(ledger.entries[0].automatically_promoted_to_crm, false);
});
