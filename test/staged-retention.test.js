import test from "node:test";
import assert from "node:assert/strict";
import { stagedRetentionReview } from "../src/stagedRetention.js";
import { commercialEligibility } from "../src/qualificationSafety.js";

function row(name, inn = "", canonical = "", source = true) {
  return {
    "Организация": name, "ИНН": inn,
    "Город/район": "Смоленская область",
    "Техника/сегмент": "Грузоперевозки, полуприцепы",
    "Основание": "A — сведения о грузоперевозках",
    "__canonical_id": canonical,
    "__evidence": { source_urls: source ? ["https://example.org/transport"] : [],
      notes: ["Проверить владение полуприцепом; текущий собственник не установлен."] }
  };
}
const result = (a = []) => ({ direct_buyers: a, intermediaries: [], leasing: [], qualification_review: [] });
const filters = {
  isActionable: () => true,
  isExcluded: (row) => commercialEligibility(row).blocked
};
test("stage candidate vanishing before final is preserved with source/INN, never added to CRM", () => {
  const lost = row("ООО «Автогруз»", "6732167788", "k0009");
  const originalNotes = structuredClone(lost.__evidence.notes);
  const output = result([]);
  const recovery = stagedRetentionReview(result([lost]), output, filters);
  assert.equal(recovery.rows.length, 1);
  assert.equal(recovery.diagnostics.preserved, 1);
  assert.equal(recovery.rows[0].__review_stage, "staged_retention");
  assert.equal(recovery.rows[0].__qualification_origin_sheet, "direct_buyers");
  assert.equal(recovery.rows[0].__final_grade, "");
  assert.equal(recovery.rows[0]["ИНН"], "6732167788");
  assert.deepEqual(recovery.rows[0].__evidence.notes, originalNotes);
  assert.equal(lost.__decision, undefined, "source staged row never mutated");
  assert.equal(output.direct_buyers.length, 0);
});

test("same confirmed INN with normalized same name stays counted in commercial result", () => {
  const source = row("Общество с ограниченной ответственностью «Грузовоз»", "6732167788", "k01");
  const current = row("ООО «Грузовоз»", "6732167788", "k25");
  const review = stagedRetentionReview(result([source]), result([current]), filters);
  assert.equal(review.rows.length, 0);
  assert.equal(review.diagnostics.covered, 1);
});

test("same legal name with two different INNs is not silently considered covered", () => {
  const source = row("ООО «Промлес»", "7733850330", "k001");
  const incorrect = row("Общество с ограниченной ответственностью «Промлес»", "6723011580", "k002");
  const review = stagedRetentionReview(result([source]), result([incorrect]), filters);
  assert.equal(review.rows.length, 1);
  assert.equal(review.rows[0]["ИНН"], "7733850330");
});

test("same canonical ID is preserved through legitimate alias and legal rename", () => {
  const source = row("ООО «ТМК-ЯМЗ»", "6623122216", "k003");
  const current = row("ООО «Ярцевский металлургический завод»", "6623122216", "k003");
  assert.equal(stagedRetentionReview(result([source]), result([current]), filters).rows.length, 0);
});

test("budget institution, source-free listings and already reviewed rows do not inflate review", () => {
  const publicInstitution = row("СОГБУ «Смоленскавтодор»", "6731020765", "budget");
  const noSource = row("ООО «Объявления»", "", "no-source", false);
  const prior = row("ООО «Ожидает»", "", "prior");
  const final = result([]);
  final.qualification_review.push(prior);
  const scan = stagedRetentionReview(
    result([publicInstitution, noSource, prior]),
    final, filters
  );
  assert.equal(scan.rows.length, 0);
  assert.equal(scan.diagnostics.blocked, 1);
  assert.equal(scan.diagnostics.weak_or_unsourced, 1);
});

test("staged retention applies to intermediaries and leasing, not just direct buyers", () => {
  const staged = { direct_buyers: [], intermediaries: [row("ООО «Сервис Полуприцепов»", "", "int")],
    leasing: [row("ООО «Лизинг Техника»", "", "lease")] };
  const scan = stagedRetentionReview(staged, result([]), filters);
  assert.equal(scan.rows.length, 2);
  assert.deepEqual(scan.rows.map((x) => x.__qualification_origin_sheet), ["intermediaries", "leasing"]);
});
