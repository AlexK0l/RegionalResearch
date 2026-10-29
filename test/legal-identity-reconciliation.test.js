import test from "node:test";
import assert from "node:assert/strict";
import { confirmedInnAliasDecision, identityOgrns, legalNameKey, normalizedOgrn } from "../src/legalIdentity.js";
import { postInnDedupe, duplicateInnConflictGroups, clearUnresolvedInnConflicts } from "../src/pipeline.js";

const make = (name, inn, {
  notes = [], proofUrls = ["https://registry.example.org/verified"],
  urls = [], extra = {}
} = {}) => ({
  "Организация": name,
  "ИНН": inn,
  "Город/район": "Смоленская область",
  "Техника/сегмент": "перевозка нерудных материалов, собственные самосвалы",
  "Основание": "C — действующее производство и грузопоток",
  __evidence: {
    notes: [...notes, "Компания добывает щебень и выполняет отгрузку материалов."],
    source_urls: [...urls, "https://business.example.org/cargo"],
    identity_verification: {
      inn, method: "final_inn_web", source_urls: proofUrls
    }
  },
  ...extra
});
const decision = (a, b, inn) => confirmedInnAliasDecision(a, b, inn);

test("checksums reject malformed OGRN and accept real historical examples", () => {
  assert.equal(normalizedOgrn("1026700850032"), "1026700850032");
  assert.equal(normalizedOgrn("1186733003236"), "1186733003236");
  assert.equal(normalizedOgrn("1026700850033"), "");
});

test("same INN and name despite legal form transition: Вязьмадор", () => {
  const inn = "6722009927";
  const a = make("АКЦИОНЕРНОЕ ОБЩЕСТВО «ВЯЗЬМАДОР»", inn, {
    notes: ["Identity: АО «Вязьмадор» с ОГРН 1026700850032 и ИНН 6722009927."]
  });
  const b = make("ЗАО «Вязьмадор»", inn);
  assert.equal(legalNameKey(a["Организация"]), legalNameKey(b["Организация"]));
  assert.equal(decision(a, b, inn).merge, true);
});

test("ё/e variants and historical spelling merge with same INN", () => {
  const inn = "6722026390";
  const a = make("ООО «Вяземский щебеночный завод»", inn);
  const b = make("ООО «Вяземский щебёночный завод»", inn);
  assert.equal(decision(a, b, inn).reason, "same_normalized_legal_name");
});

test("СпецАТХ and Спецавтохозяйство merge on attested shortened name plus shared proof", () => {
  const inn = "6731069440";
  const urls = ["https://e-disclosure.azipi.ru/messages/4495353/"];
  const a = make("АО «СпецАТХ»", inn, {
    proofUrls: urls, notes: [
      "Final INN: АО «СпецАТХ» является сокращённым наименованием АО «Спецавтохозяйство» с подтверждённым ИНН 6731069440."
    ]
  });
  const b = make("АО «Спецавтохозяйство»", inn, { proofUrls: urls });
  assert.equal(decision(a, b, inn).reason, "sourced_explicit_alias");
  const final = { direct_buyers: [a, b], intermediaries: [], leasing: [] };
  const merged = postInnDedupe(final, "Смоленская область");
  assert.equal(merged.records.length, 1);
  assert.equal(merged.records[0].row["ИНН"], inn);
  assert.equal(duplicateInnConflictGroups(merged.qualified.result).length, 0);
});

test("Стройиндустрия and СТИНД merge with same verified alias reference", () => {
  const inn = "6731056049";
  const urls = ["https://firmoteka.ru/6731056049"];
  const a = make("АО «СТИНД»", inn, {
    proofUrls: urls,
    notes: ["Final INN: ИНН подтверждён для АО «СТИНД», полное наименование — АО «Стройиндустрия»."]
  });
  const b = make("АО «Стройиндустрия»", inn, { proofUrls: urls });
  assert.equal(decision(a, b, inn).merge, true);
});

test("Смоленский КХП is verified abbreviation of same grain processor", () => {
  const inn = "6732154666";
  const urls = ["https://licreestr.fsvps.ru/license/show/pdf?id=ebc5ac3a-23a7-45aa-83c0-dcdbf1c58dda"];
  const a = make("ООО «Смоленский КХП»", inn, {
    proofUrls: urls,
    notes: [
      "Final INN: ИНН подтверждён для ООО «Смоленский КХП», сокращённого наименования ООО «Смоленский комбинат хлебопродуктов»."
    ]
  });
  const b = make("ООО «Смоленский комбинат хлебопродуктов»", inn, { proofUrls: urls });
  assert.equal(decision(a, b, inn).merge, true);
});

test("same OGRN and same commercial-name anchor can merge ГК Вектор", () => {
  const inn = "5024179934", url = "https://companies.rbc.ru/id/1175024029267-ooo-albatros/";
  const a = make("ГК «Вектор»", inn, { urls: [url] });
  const b = make("Группа компаний «ВЕКТОР»", inn, { urls: [url] });
  const x = decision(a, b, inn);
  assert.equal(x.reason, "matching_ogrn_and_name_anchor");
});

test("former formal registered name can merge if two entity proofs corroborate", () => {
  const inn = "6723019741";
  const a = make("ООО «Гагаринский фанерный завод»", inn, {
    proofUrls: ["https://www.admin-smolensk.ru/novosti/news/news_13441-html/"],
    notes: ["Final INN: ИНН подтверждён для ООО «Гагаринский фанерный завод», позднее переименованного в ООО «Эггер Древпродукт Гагарин»."]
  });
  const b = make("ООО «Эггер Древпродукт Гагарин»", inn, {
    proofUrls: ["https://rosavtotransport.ru/netcat_files/583/800/20200519_Perechen__sistemoobrazuyuschih_organizatsiy_rossiyskoy_ekonomiki.pdf"]
  });
  assert.equal(decision(a, b, inn).reason, "sourced_historical_rename");
});

test("different OGRN block even textually identical names", () => {
  const inn = "6732124140";
  const a = make("ООО «Смолвторсырьё»", inn, {
    notes: ["Final INN: ИНН подтвержден для ООО «Смолвторсырьё» с ОГРН 1166733053079."]
  });
  const b = make("ООО «Смолвторсырье»", inn, {
    urls: ["https://check.tochka.com/company/1166733058557/"]
  });
  const r = decision(a, b, inn);
  assert.equal(r.merge, false);
  assert.equal(r.reason, "different_ogrns");
});

test("an identity contaminated with two separate OGRNs is never an alias anchor", () => {
  const inn = "6726024147";
  const a = make("ООО «ГВАРДИЯ»", inn, {
    notes: ["Identity: Упоминаются ОГРН 1176658047862 и ОГРН 1186733003236 как разные организации."]
  });
  const b = make("ООО «ИЗ ДСП»", inn);
  assert.equal(identityOgrns(a).length, 2);
  assert.equal(decision(a, b, inn).reason, "conflicting_ogrns_in_one_record");
});

test("same INN for unrelated names is not a merger authorization", () => {
  const inn = "6732132711";
  const a = make("ООО «ЭКОВТОРПРОМ»", inn, { proofUrls: ["https://base.garant.ru/403073160/"] });
  const b = make("ООО «Экопром»", inn, { proofUrls: ["https://xfirm.ru/catalog-org/38?page=151"] });
  assert.equal(decision(a, b, inn).merge, false);
});

test("branch or separate company group is never silently merged into a parent", () => {
  const inn = "5028001885";
  const parent = make("ЗАО «Тропарёво»", inn);
  const branch = make("Обособленное подразделение «Тропарёво-Сычёвка» / группа «Останкино»", inn, {
    notes: ["Final INN: Обособленное подразделение «Тропарёво-Сычёвка» относится к ЗАО «Тропарёво»."]
  });
  assert.equal(decision(parent, branch, inn).reason, "different_legal_roles");
});

test("conflicting name with unproven identity remains separate, never receives INN via alias", () => {
  const inn = "6731069440";
  const a = make("АО «СпецАТХ»", inn, {
    notes: ["Final INN: АО «СпецАТХ» является сокращённым наименованием АО «Спецавтохозяйство»."]
  });
  const b = make("АО «Спецавтохозяйство»", inn, {
    proofUrls: ["https://another.example.org/document"]
  });
  assert.equal(decision(a, b, inn).merge, false);
});

test("an irreconcilable same-INN conflict is recorded and cleared without dropping businesses", () => {
  const inn = "6732132711";
  const a = make("ООО «ЭКОВТОРПРОМ»", inn);
  const b = make("ООО «Экопром»", inn);
  const final = { direct_buyers: [a, b], intermediaries: [], leasing: [] };
  const merged = postInnDedupe(final, "Смоленская область");
  assert.equal(merged.records.length, 2);
  const conflicts = duplicateInnConflictGroups(merged.qualified.result);
  assert.equal(conflicts.length, 1);
  const cleared = clearUnresolvedInnConflicts(merged.qualified.result);
  assert.equal(cleared.clearedRows, 2);
  assert.equal(merged.qualified.result.direct_buyers.length, 2);
  for (const row of merged.qualified.result.direct_buyers) {
    const audit = row.__evidence.legal_identity_conflicts;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].contested_inn, inn);
    assert.equal(audit[0].status, "manual_review_required");
    assert.equal(audit[0].conflicting_organizations.length, 2);
    assert.equal(row["ИНН"], "");
  }
});
