// Estimates only. Percent completion is NOT linear in elapsed time; use
// actual stage timings and historical completed runs in this process.
// Never treat STAGE10/11 target wall-time budgets as guaranteed deadlines.
const MINUTE = 60000;
const MAX_DURATION = 4 * 60 * MINUTE;
const STAGES = 11;
const DISCOVERY = 9;

function median(values) {
  const clean = values.filter(value => Number.isFinite(value) && value >= 1000 &&
    value <= MAX_DURATION).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function stageDuration(status) {
  if (status?.status !== "done") return null;
  const started = Number(status.startedAt);
  const ended = Number(status.completedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && started > 0 &&
    ended > started ? ended - started : null;
}

export function historicalStageDurations(jobs) {
  const samples = Array.from({ length: STAGES }, () => []);
  const finished = [...(jobs || [])].filter(job =>
    job?.state === "completed" && ["full", "resume"].includes(job.mode));
  for (const job of finished.slice(-16)) {
    const stages = job?.progress?.statuses;
    if (!Array.isArray(stages)) continue;
    for (let i = 0; i < STAGES; i++) {
      const duration = stageDuration(stages[i]);
      if (duration !== null) samples[i].push(duration);
    }
  }
  return samples.map(median);
}

function defaultLateMs(env, key) {
  const raw = Number(env?.[key]);
  return Number.isFinite(raw) && raw >= 60000 && raw <= MAX_DURATION
    ? raw : 28 * MINUTE;
}

const unestimated = (status, reason) => ({
  status, reason, remainingMs: null, confidence: "none"
});

export function estimateResearchEta(job, {
  now = Date.now(),
  history = [],
  env = process.env
} = {}) {
  if (!["full", "resume"].includes(job?.mode)) {
    return unestimated("not_applicable", "Обратный отсчёт доступен для полного исследования");
  }
  if (job.state === "completed") {
    return { status: "completed", reason: "Исследование завершено",
      remainingMs: 0, confidence: "final" };
  }
  if (job.state === "failed" || job.state === "cancelled") {
    return unestimated(job.state, "Исследование не выполняется");
  }
  if (job.state === "waiting" || job?.progress?.phase === "queued") {
    return unestimated("queued", "В очереди — время начала неизвестно");
  }
  if (job.state === "cancelling" || job.cancelled) {
    return unestimated("cancelling", "Останавливаем исследование");
  }
  if (job?.progress?.phase === "completed") {
    return unestimated("finishing", "Сохраняем итоговый результат");
  }
  const stages = job?.progress?.statuses;
  if (!Array.isArray(stages) || stages.length !== STAGES) {
    return unestimated("calibrating", "Оценка появится после двух этапов");
  }

  const discoverySamples = stages.slice(0, DISCOVERY).map(stageDuration)
    .filter(value => value !== null);
  const historyDiscovery = history.slice(0, DISCOVERY).filter(Number.isFinite);
  const discoveryBaseline = discoverySamples.length >= 2
    ? median(discoverySamples) : median(historyDiscovery);
  const discoveriesDone = stages.slice(0, DISCOVERY)
    .filter(stage => stage?.status === "done").length;

  // No invented early countdown. Nine discovery steps and the final INN /
  // contact stages can have dramatically different running times.
  if (discoveryBaseline === null && discoveriesDone < DISCOVERY) {
    return unestimated("calibrating", "Оценка появится после двух этапов");
  }

  const baselineLate = [defaultLateMs(env, "STAGE10_MAX_MS"),
    defaultLateMs(env, "STAGE11_MAX_MS")];
  let remaining = 0;
  let observed = 0;
  let source = "measured";

  for (let i = 0; i < STAGES; i++) {
    const step = stages[i] || {};
    if (step.status === "done") continue;
    const historical = Number(history[i]);
    const baseline = Number.isFinite(historical) && historical >= 1000 &&
      historical <= MAX_DURATION ? historical
      : i < DISCOVERY ? discoveryBaseline : baselineLate[i - DISCOVERY];
    if (!Number.isFinite(baseline) || baseline < 1000) {
      return unestimated("calibrating", "Уточняем скорость выполнения этапов");
    }

    if (i >= DISCOVERY && (!Number.isFinite(historical) || historical <= 0)) {
      source = "mixed";
    }
    if (step.status === "running" && Number.isFinite(Number(step.startedAt)) &&
        Number(step.startedAt) > 0) {
      const elapsed = Math.max(0, now - Number(step.startedAt));
      // When a stage substantially overruns its measured baseline, a numeric
      // countdown would claim a deadline we cannot support.
      if (elapsed > baseline * 1.25) {
        return unestimated("recalibrating",
          "Текущий этап длится дольше прогноза; оценка уточняется");
      }
      remaining += Math.max(1000, baseline - elapsed);
      observed++;
    } else {
      remaining += baseline;
    }
  }

  if (remaining < 1000) {
    return unestimated("finishing", "Завершаем обработку результата");
  }
  if (!Number.isFinite(remaining) || remaining > 24 * 60 * MINUTE) {
    return unestimated("recalibrating", "Время выполнения пока непредсказуемо");
  }
  const confidence = discoveriesDone >= 5 && source === "measured"
    ? "medium" : "low";
  return {
    status: "estimated",
    remainingMs: Math.ceil(remaining / 1000) * 1000,
    calculatedAt: now,
    confidence,
    basis: source,
    measuredDiscoveryStages: discoverySamples.length,
    completedStages: stages.filter(stage => stage?.status === "done").length,
    reason: source === "mixed"
      ? "Приблизительно: поздние этапы рассчитаны по лимитам времени"
      : "Приблизительно: по фактической длительности этапов"
  };
}
