# Targeted fixes after manual Saby verification

Live diagnostics: 52 full-card attempts, 26 uncertain empty searches, 13
legal-name rejections, one branch-only result, 12 reached the parser.
Exact-INN XHRs were observed with no 401/403/429/5xx in the supplied sample.
This is not evidence that every uncertain empty result is a missing company.

Manual examples:
* INN 1659029846: Saby's global search showed "Не найдено".
  Public corporate sources identify ZAO Kazanvtortsvetmet, OGRN
  1021603463452, liquidated 2013-04-01. The screenshots do not prove
  the automated catalog has the same empty-message DOM. Do not shorten
  its search deadline or treat the global spinner as a stalled request.
* INN 1650017638, KPP 165001001, OGRN 1021602014500: private and
  canonical public Saby title add "(Бухгалтерия Управления)" to the
  registered ZAOR short name. The independent T-Bank record supplies
  both exact registered aliases. The company's own requisites page
  corroborates the registered names (it lists another tax-office KPP).
  Preserve strict independent three-identifier validation.

Recognize ZAOR as its own explicit legal form, and only the observed
ZAOR display decoration as a candidate match to its exact independent
registered alias. Do not strip arbitrary parentheses, branch titles or
decoration from the source research name or actual registered fields.
No name-token overlap or INN-only identity acceptance. A mismatch to
both independently confirmed full and short registered names stays review.

Prioritize never-attempted companies in the full-card phase within the
missing-phone / known-phone cohorts. Preserve every committed attempt
and all retry budgets; no replay, reset or changed frozen plan.

Skip rows that ALREADY have accepted entity-specific primary-registry
cessation evidence (the same strict acceptedLegalStatusProof used by
final commercial QA). Record the skip separately, not as a verified
collection, confirmed zero fleet or missing-data success. Do not delete
rows or create legal status proof from uncertain Saby results. No new
FNS/AI/Saby requests or changes to the independent FNS audit's
non-destructive evidence policy. The upstream status-validation gap
for companies without a primary-registry proof still needs attention.

UI distinguishes visited companies from confirmed companies. Tests use
public example identifiers, synthetic other data, and no authenticated
content or network. Offline pass cannot prove live acceptance or speed.
