import test from "node:test";
import assert from "node:assert/strict";
import {
  fullWebLimits, researchWebScope, costEnvLimitUsd, contactLimits,
  validBatchContactItem, mayRetryContactPhone, normalizeRussianPhone
} from "../src/researchCostPolicy.js";
import { identitySnippetFact, reuseIdentityObservedFacts } from "../src/identityFactReuse.js";

test("default cost plan preserves discovery while capping optional phases", () => {
  const plan = fullWebLimits({});
  assert.equal(plan.total, 1850);
  assert.equal(plan.discovery, 1050);
  assert.ok(plan.identity >= 500);
  assert.ok(plan.contacts < 350);
  assert.equal(costEnvLimitUsd({}), 25);
  assert.equal(costEnvLimitUsd({ OPENAI_MAX_RESEARCH_COST_USD: "27.5" }), 27.5);
  assert.equal(fullWebLimits({ OPENAI_FULL_WEB_MAX_CALLS: "1234" }).total, 1234);
  const contacts = contactLimits({});
  assert.equal(contacts.batchSize, 5);
  assert.ok(contacts.individualFallbacks <= 30);
  assert.ok(contacts.phoneRetries <= 12);
});
test("web requests are charged to the correct phase", () => {
  const cases = [
    ["этап 9 | направление", "discovery"],
    ["coverage gap | quarry", "discovery"],
    ["география региона | районы", "discovery"],
    ["entity census | carriers", "discovery"],
    ["identity | cluster 1", "identity"],
    ["final inn | 1/100", "identity"],
    ["enrichment batch | 5 companies", "enrichment"],
    ["targeted enrichment | single", "enrichment"],
    ["contact batch | 5 companies", "contacts"],
    ["contact web | ООО", "contacts"],
    ["contact phone retry | ООО", "contacts"],
    ["phone verify | 79000000000", "contacts"],
    ["regional statistics", "statistics"],
    ["unknown web step", "other"]
  ];
  for (const [name, scope] of cases) assert.equal(researchWebScope(name, "full"), scope, name);
  assert.equal(researchWebScope("этап 1 | quality", "quality"), "stage1");
  assert.equal(researchWebScope("этап 2 | quality", "quality"), "stage2");
});
const row = (name = "ООО «Перевозчик»", inn = "6732111122") =>
  ({ "Организация": name, "ИНН": inn, "__final_grade": "A" });
const validContact = {
  id: "k1", organization: "ООО «Перевозчик»", inn: "6732111122",
  phones: ["8 (900) 123-45-67"], leader: "Иванов И. И.",
  official_site: "https://carrier.example.org/contacts",
  source_urls: ["https://carrier.example.org/contacts"], note: "Контакты юрлица"
};
test("batch contact result accepted only with exact id, legal INN and URL", () => {
  const result = validBatchContactItem(validContact, row(), "k1");
  assert.equal(result.phones[0], "79001234567");
  assert.equal(result.leader, "Иванов И. И.");
  assert.equal(result.official_site, "https://carrier.example.org/contacts");
  assert.equal(result.status, "ok");
  assert.equal(normalizeRussianPhone("+7 900 123 45 67"), "79001234567");
  assert.equal(validBatchContactItem({ ...validContact, inn: "6732124140" }, row(), "k1"), null);
  assert.equal(validBatchContactItem({ ...validContact, id: "k2" }, row(), "k1"), null);
  assert.equal(validBatchContactItem({ ...validContact, organization: "ООО «Соседняя компания»" }, row(), "k1"), null);
  assert.equal(validBatchContactItem({ ...validContact, inn: "" }, row(), "k1"), null);
});
test("noncited phones and leaders from contact batch are discarded", () => {
  const untrusted = validBatchContactItem({
    ...validContact, source_urls: [], official_site: "https://carrier.example.org/contacts"
  }, row(), "k1");
  assert.equal(untrusted, null,
    "No cited page means the company was not actually verified in this batch");
});
test("only A with a sourced website and remaining quota can retry missing phone", () => {
  const a = row(), answer = { phones: [], official_site: "https://carrier.example.org/contacts",
    source_urls: ["https://carrier.example.org/contacts"], leader: "Директор найден" };
  assert.equal(mayRetryContactPhone(a, answer, 2, 10000), true);
  assert.equal(mayRetryContactPhone(a, answer, 0, 10000), false);
  assert.equal(mayRetryContactPhone(a, answer, 2, 5000), false);
  assert.equal(mayRetryContactPhone({ ...a, __final_grade: "B" }, answer, 2, 10000), false);
  assert.equal(mayRetryContactPhone(a, { ...answer, phones: ["79001234567"] }, 2, 10000), false);
  assert.equal(mayRetryContactPhone(a, { ...answer, source_urls: ["https://unrelated.example.com/"] }, 2, 10000), false);
  assert.equal(mayRetryContactPhone(a, { ...answer, official_site: "" }, 2, 10000), false);
});

function innResult() {
  return {
    confirmed_inn: "6732111122", source_urls: ["https://directory.example.org/6732111122"],
    observed_facts: [
      {
        field: "Телефон", value: "+7 900 123-45-67",
        source_url: "https://directory.example.org/6732111122",
        evidence_excerpt: "ООО Перевозчик ИНН 6732111122 телефон +7 900 123-45-67"
      },
      {
        field: "Руководитель / ЛПР", value: "Иванов И.И.",
        source_url: "https://directory.example.org/6732111122",
        evidence_excerpt: "ООО Перевозчик ИНН 6732111122 директор Иванов И.И."
      },
      {
        field: "Выручка последнего подтвержденного года", value: "5200000",
        source_url: "https://directory.example.org/6732111122",
        evidence_excerpt: "ИНН 6732111122 выручка 5200000 руб."
      }
    ]
  };
}
test("single source INN lookup can populate three strongly attributed fields without new web calls", () => {
  const source = innResult(), company = { ...row(), __evidence: { source_urls: [], notes: [] } };
  const accepted = reuseIdentityObservedFacts(company, source);
  assert.equal(accepted.length, 3);
  assert.equal(company["Телефон"], "79001234567");
  assert.equal(company["Руководитель / ЛПР"], "Иванов И.И.");
  assert.equal(company["Выручка последнего подтвержденного года"], 5200000);
  assert.equal(company.__evidence.identity_observed_facts.length, 3);
  assert.equal(company.__evidence.contact_verification.inn, company["ИНН"]);
  assert.equal(reuseIdentityObservedFacts(company, source).length, 0, "No overwriting or dupes");
});
test("different INN, source URL or missing excerpt never supplies identity-sourced contacts", () => {
  const r = innResult(), company = { ...row("ООО «Чужая компания»", "6732124140"), __evidence: {} };
  assert.equal(reuseIdentityObservedFacts(company, r).length, 0);
  assert.equal(company["Телефон"], undefined);
  const same = { ...row(), __evidence: {} };
  const altered = {
    ...r, observed_facts: [
      { ...r.observed_facts[0], source_url: "https://unknown.example.org/" },
      { ...r.observed_facts[1], evidence_excerpt: "Директор Иванов И.И. (без ИНН)" },
      { ...r.observed_facts[2], evidence_excerpt: "ИНН 6732111122 сумма 1 руб." }
    ]
  };
  assert.equal(reuseIdentityObservedFacts(same, altered).length, 0);
  assert.equal(identitySnippetFact(r, r.observed_facts[0], same)?.field, "Телефон");
});
