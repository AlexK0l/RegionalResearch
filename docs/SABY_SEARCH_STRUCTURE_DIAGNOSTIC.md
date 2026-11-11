# Saby: structural evidence for a 40-result INN search

## Why this diagnostic exists

On 2026-11-11, Time4VPS ran an opt-in Stage12 smoke for the previously
verified first-party public profile with INN 7725104641. It stopped
before opening a company with:

    SABY_SEARCH_AMBIGUITY_DIAG
    reason=result_window_full, observed=40, primary=40,
    raw_candidates=40, geometry_duplicates=0,
    fragments_rejected=0, unique_titles=33, raw_capped=false

These **40 DOM candidates are not evidence of 40 distinct companies**.
The scanner walks up from every visible exact-INN text node, but does not
prove the selected ancestor belongs to the company search-result list
rather than another search sidebar, overlay, table, or unrelated block.
It also may capture the SPA while it is still changing search results.

Do not raise the 20-distinct-card safety cap, choose the first result,
assume Cyrillic branch markers explain the issue, or run 473 companies
again without diagnosing the UI structure.

## Bounded read-only VPS diagnostic (single INN, zero company clicks)

After updating main (no service restart required), ensure **no other Saby
process** is running against the same persistent browser profile:

    sudo -u regionalresearch env -u DISPLAY \
      HOME=/var/lib/regionalresearch \
      PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      npm --prefix /opt/regionalresearch run saby:search-structure -- \
      --inn=7725104641 \
      --name='АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН' \
      --headless \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
      --out=/opt/regionalresearch/exports/saby-search-structure-7725104641-20261111.json

The report contains three snapshots of the **same search** at roughly
0.9, 2.4, and 4.8 seconds, with up to 80 candidate rows per snapshot.
The report stores only masked first-line business name fragments and
structural evidence: DOM element/parent semantic role, CSS class category
flags (not values), relative geometry, whether a result is in the
viewport, whether it is clickable, a scroll-container group identifier,
and whether the INN is explicitly labelled in that same element. It
never saves arbitrary page text, phone numbers, email, input values,
cookies, credentials or full URLs.

Open a local secure PowerShell session to download:

    scp root@IP_VPS:/opt/regionalresearch/exports/saby-search-structure-7725104641-20261111.json "$HOME\Downloads\"

Attach that JSON for analysis. It will show whether the 33 distinct
titles are actual company result cards, false ancestors from other UI
sections, or a changing search list. Only after this evidence can a
correct root-cause fix be made to search result scope and clicking.

The command does not invoke runSabyStage12, open company details,
mutate the SAT JSON, alter SQLite, call OpenAI, or touch the five-sheet
reference Excel. The experimental fallback remains disabled by default.
