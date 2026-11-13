// Stage-12 integration boundary used by the production pipeline AND
// exercised by offline regression tests. It writes a complete consistent
// snapshot at each Saby checkpoint without asking OpenAI or Google Sheets.
//
// The research pipeline owns final QA and XLSX generation; this adapter may
// mutate only the already-vetted result rows, through runSabyStage12.
import { runSabyStage12 } from "./sabyStage12.js";

export async function runCheckpointedSabyStage12({
  result,
  completedInns = [],
  attemptedInns = [],
  signal = null,
  env = process.env,
  startedAt = Date.now(),
  onProgress = async () => {},
  persistCheckpoint = async () => {},
  sessionRunner,
  collectCompany
} = {}) {
  if (!result || !Array.isArray(result.direct_buyers) ||
      !Array.isArray(result.intermediaries) ||
      !Array.isArray(result.leasing)) {
    throw new TypeError("Stage 12 requires finalized commercial research result");
  }
  const options = {
    result, completedInns, attemptedInns, signal, env, onProgress,
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
  return runSabyStage12(options);
}
