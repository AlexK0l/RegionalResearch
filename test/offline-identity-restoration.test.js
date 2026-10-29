import test from "node:test";
import assert from "node:assert/strict";
import { restoreAliasesOffline } from "../src/offlineIdentityRestoration.js";

const inn = "6731069440";
const url = "https://e-disclosure.azipi.ru/messages/4495353/";
const make = (name, { innValue = "", proof = true, notes = [], URLs = [url],
  city = "Смоленск", phone = "", leader = "", grade = "B" } = {}) => ({
  "Организация": name, "ИНН": innValue, "Город/район": city,
  "Основание": grade + " — свидетельство",
  "Техника/сегмент": "Самосвалы, перевозка отходов",
  "Телефон": phone, "Руководитель / ЛПР": leader,
  __canonical_id: name.slice(0, 14),
  __evidence: {
    source_urls: URLs,
    notes: [...notes, "Final INN conflict: ИНН " + inn + " встретился у несовместимых сущностей и очищен до однозначного подтверждения."],
    ...(proof ? { identity_verification: { inn, method: "final_inn_web", source_urls: URLs } } : {})
  }
});
const result = (...rows) => ({ final_result: { direct_buyers: rows,
  intermediaries: [], leasing: [], statistics: [{ Показатель: "Население", Значение: 100 }] } });

test("approved shortened legal name merges, restores INN and preserves source evidence", () => {
  const old = make("АО «СпецАТХ»", { notes: [
    "Final INN: АО «СпецАТХ» является сокращённым наименованием АО «Спецавтохозяйство» с ИНН 6731069440."
  ], phone: "+7 4812 123 456", leader: "Сотрудник 1", grade: "A" });
  const newer = make("АО «Спецавтохозяйство»", { phone: "+7 4812 654 321", grade: "B" });
  const checkpoint = result(old, newer);
  const snapshot = JSON.stringify(checkpoint);
  const output = restoreAliasesOffline(checkpoint, { checkpointId: "saved" });
  assert.equal(output.audit.input_rows, 2);
  assert.equal(output.audit.output_rows, 1);
  assert.equal(output.audit.restored_inns, 1);
  assert.equal(output.audit.merged_away_rows, 1);
  const survivor = output.final_result.direct_buyers[0];
  assert.equal(survivor["ИНН"], inn);
  assert.equal(survivor["Организация"], "АО «Спецавтохозяйство»");
  assert.match(survivor["Телефон"], /123 456/);
  assert.match(survivor["Телефон"], /654 321/);
  assert.ok(survivor.__evidence.legal_identity_merges[0].source_urls.includes(url));
  assert.equal(survivor.__evidence.previous_conflict_status, "resolved_alias_in_offline_copy");
  assert.equal(JSON.stringify(checkpoint), snapshot, "original checkpoint must remain byte-identical");
  assert.equal(output.final_result.statistics.length, 1);
});

test("a second run does not restore twice or edit an existing recovered result", () => {
  const a = make("АО «СпецАТХ»", { notes: [
    "Final INN: АО «СпецАТХ» является сокращённым наименованием АО «Спецавтохозяйство» с ИНН 6731069440."
  ]});
  const b = make("АО «Спецавтохозяйство»");
  const once = restoreAliasesOffline(result(a, b), { checkpointId: "x" });
  const twice = restoreAliasesOffline({ final_result: once.final_result }, { checkpointId: "x" });
  assert.equal(twice.audit.merged_away_rows, 0);
  assert.equal(twice.final_result.direct_buyers[0]["ИНН"], inn);
});

test("refuse different OGRNs even for identical legal names", () => {
  const a = make("ООО «Смолвторсырьё»", { notes: [
    "Final INN: ОГРН 1166733053079."
  ]});
  const b = make("ООО «Смолвторсырьё»", { notes: [
    "Final INN: ОГРН 1166733058557."
  ]});
  const r = restoreAliasesOffline(result(a, b), { checkpointId: "conflict" });
  assert.equal(r.audit.restored_inns, 0);
  assert.equal(r.final_result.direct_buyers.length, 2);
  assert.ok(r.final_result.direct_buyers.every((x) => x["ИНН"] === ""));
});

test("the same INN is not restored to unrelated or unsourced company", () => {
  const a = make("ООО «СпецАТХ»");
  const b = make("ООО «Чужая организация»");
  const unsourced = make("ООО «Спецавтохозяйство»", { proof: false });
  const r = restoreAliasesOffline(result(a, b, unsourced), { checkpointId: "no" });
  assert.equal(r.audit.restored_inns, 0);
  assert.equal(r.final_result.direct_buyers.length, 3);
  assert.ok(r.audit.untrusted_or_unmatched.some((x) => x.reason === "no_source_backed_identity_attestation"));
});

test("different existing INN is never overwritten from contaminated notes", () => {
  const a = make("ООО «СпецАТХ»", { innValue: "6706005273" });
  const b = make("ООО «Спецавтохозяйство»");
  const r = restoreAliasesOffline(result(a, b), { checkpointId: "bad" });
  assert.equal(r.audit.restored_inns, 0);
  assert.equal(r.final_result.direct_buyers[0]["ИНН"], "6706005273");
  assert.ok(r.audit.untrusted_or_unmatched.some((x) => x.reason === "existing_inn_not_blank"));
});

test("existing nonconflicting INN owner blocks reuse in another restored alias group", () => {
  const a = make("АО «СпецАТХ»", { notes: [
    "Final INN: АО «СпецАТХ» является сокращённым наименованием АО «Спецавтохозяйство» с ИНН 6731069440."
  ]});
  const b = make("АО «Спецавтохозяйство»");
  const owner = { "Организация": "Третье юридическое лицо", "ИНН": inn };
  const r = restoreAliasesOffline(result(a, b, owner), { checkpointId: "reuse" });
  assert.equal(r.audit.restored_inns, 0);
  assert.equal(r.audit.unresolved.find((x) => x.inn === inn).status, "inn_already_assigned_elsewhere");
});

test("separate branch survives without automatic restoration of parent's INN", () => {
  const parent = make("ЗАО «Тропарево»", { notes: ["Final INN: реестр подтверждает собственность."] });
  const parentVariant = make("ЗАО «Тропарёво»");
  const branch = make("Обособленное подразделение «Тропарёво-Сычёвка»", { notes: ["Final INN: подразделение ЗАО «Тропарёво»."] });
  const r = restoreAliasesOffline(result(parent, parentVariant, branch), { checkpointId: "branch" });
  assert.equal(r.audit.restored_inns, 1);
  assert.equal(r.final_result.direct_buyers.length, 2);
  const site = r.final_result.direct_buyers.find((row) => row["Организация"].startsWith("Обособленное"));
  assert.equal(site["ИНН"], "");
  assert.equal(r.audit.divisions.length, 1);
});

test("unconfirmed single contested record never gets an INN", () => {
  const r = restoreAliasesOffline(result(make("ООО «ИЗ ДСП»")), { checkpointId: "single" });
  assert.equal(r.audit.restored_inns, 0);
  assert.equal(r.audit.unresolved.length, 1);
  assert.equal(r.final_result.direct_buyers[0]["ИНН"], "");
});


test("historical Гагаринский фанерный завод resolves to current ЭГГЕР name", () => {
  const olderName = "ООО «Гагаринский фанерный завод»";
  const currentName = "ООО «ЭГГЕР ДРЕВПРОДУКТ ГАГАРИН»";
  const relatedInn = "6723019741";
  const proof = ["https://www.admin-smolensk.ru/novosti/news/news_13441-html/"];
  const makeAlias = (name, note) => ({
    "Организация": name, "ИНН": "", "Основание": "C — производство",
    __canonical_id: "k" + name.length,
    __evidence: {
      source_urls: proof,
      notes: [note,
        "Final INN conflict: ИНН " + relatedInn + " встретился у несовместимых сущностей и очищен до однозначного подтверждения."],
      identity_verification: { inn: relatedInn, method: "final_inn_web", source_urls: proof }
    }
  });
  const a = makeAlias(olderName,
    "Final INN: ООО «Гагаринский фанерный завод» позднее переименованного в ООО «ЭГГЕР ДРЕВПРОДУКТ ГАГАРИН».");
  const b = makeAlias(currentName,
    "Final INN: ИНН подтверждён для ООО «ЭГГЕР ДРЕВПРОДУКТ ГАГАРИН».");
  const out = restoreAliasesOffline(result(a, b), { checkpointId: "renamed" });
  assert.equal(out.audit.merged_away_rows, 1);
  assert.equal(out.final_result.direct_buyers[0]["Организация"], currentName);
  assert.equal(out.final_result.direct_buyers[0]["ИНН"], relatedInn);
  assert.ok(out.final_result.direct_buyers[0].__evidence.notes.some((x) => x.includes(olderName)));
});


test("restored INN updates public comment and marks A/B disagreement without inventing a grade", () => {
  const shortName = make("АО «СпецАТХ»", {
    grade: "A",
    notes: ["Final INN: АО «СпецАТХ» является сокращённым наименованием АО «Спецавтохозяйство» с ИНН 6731069440."]
  });
  shortName.__comment = "Сайт/источник: https://example.org/old\nИНН: не подтверждено\nДеятельность: отходы";
  const fullName = make("АО «Спецавтохозяйство»", { grade: "B" });
  fullName.__comment = "Сайт/источник: https://example.org/new\nИНН: не подтверждено\nДеятельность: отходы";
  const input = result(shortName, fullName);
  const before = JSON.stringify(input);
  const out = restoreAliasesOffline(input, { checkpointId: "grades" });
  assert.equal(out.audit.restored_inns, 1);
  assert.equal(out.audit.qualification_conflicts.length, 1);
  const conflict = out.audit.qualification_conflicts[0];
  assert.deepEqual(conflict.source_grades.map((x) => x.grade).sort(), ["A", "B"]);
  assert.equal(conflict.selected_grade, "B");
  assert.equal(conflict.status, "manual_review_required");
  const row = out.final_result.direct_buyers[0];
  assert.match(row.__comment, /ИНН: 6731069440 \(восстановлен офлайн/);
  assert.doesNotMatch(row.__comment, /ИНН: не подтверждено/);
  assert.match(row.__comment, /\[ПРОВЕРКА A\/B\/C\]/);
  assert.equal(row["Основание"].slice(0, 1), "B");
  assert.equal(row.__final_grade, undefined);
  assert.equal(row.__evidence.qualification_review.source_grades.length, 2);
  assert.deepEqual(row.__evidence.original_comments.map((x) => x.value), [
    fullName.__comment, shortName.__comment
  ]);
  assert.equal(JSON.stringify(input), before);
});

test("same initial grade does not create a false conflict", () => {
  const shortName = make("АО «СпецАТХ»", { grade: "B", notes: [
    "Final INN: АО «СпецАТХ» является сокращённым наименованием АО «Спецавтохозяйство» с ИНН 6731069440."
  ]});
  const fullName = make("АО «Спецавтохозяйство»", { grade: "B" });
  const out = restoreAliasesOffline(result(shortName, fullName), { checkpointId: "same-grade" });
  assert.equal(out.audit.qualification_conflicts.length, 0);
  assert.equal(out.final_result.direct_buyers[0].__evidence.qualification_review, undefined);
});
