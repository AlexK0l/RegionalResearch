// Recovery for a transient, unhydrated Saby detail screen.
//
// A verified legal entity can render without either requested widget. A
// single bounded reopening of the same INN is cheaper and safer than marking
// missing data as confirmed absence or silently completing the company.
// The browser collector verifies company identity independently on each
// attempt. No credentials are resubmitted by this helper.
export function sabyNeedsSectionRetry(result) {
  return result?.contacts?.status === "missing" &&
    result?.trucks?.status === "missing";
}

/**
 * Collect once; only when BOTH sections are missing reopen the company once.
 * On an unsuccessful reopen retain the incomplete first response, which
 * Stage 12 marks review/deferred rather than writing or checkpointing it.
 * Retry errors are reported through a sanitized callback, not their message.
 */
export async function recoverSabyMissingSections(
  collect, {wait = async () => {}, onRetry = () => {},
    onRetryError = () => {}} = {}
) {
  const initial = await collect();
  if (!sabyNeedsSectionRetry(initial)) return initial;
  onRetry();
  try {
    await wait();
    return await collect();
  } catch {
    onRetryError();
    return initial;
  }
}
