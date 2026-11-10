# Stage 12: experimental exact-INN, officially registered short-name fallback

This feature is intentionally disabled by default. It does not change the
standard SAT XLSX schema, source JSON, SQLite checkpoint format, or normal
Saby identity matching until specifically enabled for a Saby-only smoke run.

## The verified 2026-11-10 live evidence

Saby's public profile for AО "ДСК Автобан" (source row #8, INN
7725104641, KPP 504301001) gave:

    [SABY_PUBLIC_REQUISITES] #8 status=verified
      reason=same_public_profile_short_and_registered_name

This confirms that public company pages can safely join one short Saby
heading with an independently labelled registered full name, INN and KPP
from the same company. The general production Stage 12 still requires
careful private detail and source association.

## Strict acceptance chain

1. Search the authenticated Saby company list by the source 10/12-digit
   INN. A unique exact-INN result can be opened as a **candidate only**,
   even if its displayed name differs. Multiple exact-INN matches with
   no uniquely matching source name remain ambiguous.
2. In the opened authenticated `/page/contractor-info` page, first run
   the existing ordinary strict title/INN check. If it passes, no public
   lookup is needed.
3. Only if the name mismatches but the detail has an independently
   scoped INN, extract exact labelled INN + unique 9-digit KPP from one
   bounded `Реквизиты` block; never take KPP from URL guesses, other
   organisations or nearby contact/branch text.
4. Open exactly `https://saby.ru/profile/{INN}-{KPP}`. Validate canonical
   origin and URL. Require same labelled INN, KPP and legal full name
   inside its **registered** `Реквизиты` section.
5. Accept short or long alias only if the source matches the registered
   full name or the public short title of the **same** registered entity,
   and the authenticated private heading independently matches that
   public short/full name. A historical rename or unrelated company must
   not be inferred from INN alone.
6. Only after this verification may Stage12 collect contacts and truck
   evidence. In the fallback, the identity object preserves source
   display name, registered legal name, public title, exact KPP and
   verification method. Existing phone/transport export validation remains
   unchanged.

All failures leave the company under review, with a small allowlisted
reason code. No company-specific INN, KPP or title mappings are present.

## Small safe test on VPS

First update code from `main`. In the production env keep:

    SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED=false

This switch is separate from `SABY_STAGE12_ENABLED`; the standalone
smoke flag below turns it on **for that process only**, not the service.

No other Chromium should use the same persistent browser profile.

    sudo -u regionalresearch env -u DISPLAY \
      HOME=/var/lib/regionalresearch \
      PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      npm --prefix /opt/regionalresearch run saby:smoke -- \
      --result=/opt/regionalresearch/SAT_Смоленская_область.json \
      --offset=1 --limit=3 --headless --public-identity-fallback \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110

Important: these source rows may already pass strict name verification;
this smoke checks that the new option does not break previous success. An
abbreviated-title company can benefit only if private detail also shows
labelled INN/KPP; if not, it must remain `review`. We do not weaken
missing-KPP rules to force success.

The test does not use OpenAI or update source JSON/SQLite, and uses a
separate result output. Refrain from paid full-region tests.
