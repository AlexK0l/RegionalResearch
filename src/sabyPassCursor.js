// Lightweight cursor semantics shared by scheduling, admission and resume.
export const SABY_FULL_CARD_STRATEGY="full_card_v3";
export const SABY_LEGACY_PHASES=Object.freeze(["contacts","contact_retry","details","details_retry"]);
export const SABY_FULL_CARD_PHASES=Object.freeze(["full","retry"]);
export const sabyPassPhases=raw=>raw?.strategy===SABY_FULL_CARD_STRATEGY?
  SABY_FULL_CARD_PHASES:SABY_LEGACY_PHASES;
export const sabyPassFinished=raw=>Boolean(raw)&&
  Number(raw.phase_index)>=sabyPassPhases(raw).length;
