// Stage-12 integration boundary used by the production pipeline AND
// exercised by offline regression tests. It writes a complete consistent
// snapshot at each Saby checkpoint without asking OpenAI or Google Sheets.
//
// The research pipeline owns final QA and XLSX generation; this adapter may
// mutate only the already-vetted result rows, through runSabyStage12.
import { runSabyStage12, sabyStage12Settings } from "./sabyStage12.js";
import { sabyEligibleRows, sabyInn, sabyStoredSectionCoverage } from "./sabyEnrichment.js";
import { runSabyOnlyWithRecovery } from "./sabyOnlyRecovery.js";

export async function runCheckpointedSabyStage12({
  result,
  completedInns = [],
  attemptedInns = [],
  maxDurationMs = null,
  signal = null,
  env = process.env,
  startedAt = Date.now(),
  onProgress = async () => {},
  persistCheckpoint = async () => {},
  sessionRunner,
  collectCompany,
  // Normal full/late resumes reconnect transient browser failures. Saby-only
  // already has an outer recovery and must not multiply retry sessions.
  recoverBrowserSession = false,
  recoveryWait = undefined
} = {}) {
  if (!result || !Array.isArray(result.direct_buyers) ||
      !Array.isArray(result.intermediaries) ||
      !Array.isArray(result.leasing)) {
    throw new TypeError("Stage 12 requires finalized commercial research result");
  }
  const options = {
    result, completedInns, attemptedInns, maxDurationMs,
    signal, env, onProgress,
    onCheckpoint: async ({stats, completedInns: done, deferredInns,
      attemptedInns:visited}) => {
      await persistCheckpoint("saby", {
        completed_stage: 9,
        final_result: result,
        saby_completed_inns: done,
        saby_deferred_inns: deferredInns,
        saby_attempted_inns: visited,
        saby_stats: stats,
        stage12_duration_ms: Math.max(0, Date.now() - startedAt)
      });
    }
  };
  // In production these are the real Playwright functions; offline CI passes
  // deterministic stubs and cannot start a browser or paid API request.
  if (sessionRunner) options.sessionRunner = sessionRunner;
  if (collectCompany) options.collectCompany = collectCompany;
  const settings = sabyStage12Settings(env);
  if (!recoverBrowserSession || !settings.enabled) {
    return runSabyStage12(options);
  }
  // Exactly the same fair-queue plan as runSabyStage12. This count is only
  // for progress aggregation, never an excuse to treat unvisited records as
  // completed when a browser could not start.
  const completed = new Set(completedInns.map(sabyInn).filter(Boolean));
  const eligible = sabyEligibleRows(result).eligible;
  for (const entry of eligible) {
    const inn = sabyInn(entry.row["ИНН"]);
    if (!completed.has(inn)) continue;
    const coverage = sabyStoredSectionCoverage(entry.row,
      { transport: entry.transport });
    if (coverage.trusted && !coverage.complete) completed.delete(inn);
  }
  const pending = eligible.filter(entry =>
    !completed.has(sabyInn(entry.row["ИНН"])));
  const total = Math.min(pending.length,
    settings.maxCompanies || pending.length);
  if (!total) return runSabyStage12(options);
  const duration = maxDurationMs == null
    ? settings.maxMs : Number(maxDurationMs);
  return runSabyOnlyWithRecovery({
    runPass: ({completedInns:done, attemptedInns:visited,
      maxDurationMs:remaining, onProgress:report}) =>
      runSabyStage12({
        ...options,
        completedInns:done,
        attemptedInns:visited,
        maxDurationMs:remaining,
        onProgress:report
      }),
    completedInns, attemptedInns, total,
    startedAt, maxDurationMs:duration, minimumSessionMs:1000, signal,
    ...(recoveryWait ? {wait:recoveryWait} : {}),
    onProgress,
    onRecovery:async state=>{
      console.warn("[SABY_STAGE12_BROWSER_RECONNECT] "+JSON.stringify({
        attempt:state.browserRestarts,
        max_attempts:state.maxBrowserRestarts,
        processed:state.processed,
        pending:state.deferred,
        reason:state.reason
      }));
      await onProgress({
        enabled:true,scheduled:total,
        processed:state.processed,verified:0,
        deferred:state.deferred,restarting:true,
        browserRestarts:state.browserRestarts,
        browserError:"",
        recoveryReason:state.reason
      });
    }
  });
}
