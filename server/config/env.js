const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const env = {
  port: toNumber(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
  openAiApiKey: process.env.OPENAI_API_KEY || '',
  openAiModel: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  openAiMaxOutputTokens: toNumber(process.env.OPENAI_MAX_OUTPUT_TOKENS, 2200),
  openAiReasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'low',
  openAiTimeoutMs: toNumber(process.env.OPENAI_TIMEOUT_MS, 60000),
  transcriptionModel: process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  transcriptionLanguage: process.env.TRANSCRIPTION_LANGUAGE || 'ru',
  transcriptionTimeoutMs: toNumber(process.env.TRANSCRIPTION_TIMEOUT_MS, 90000),
  maxAudioSizeMb: toNumber(process.env.MAX_AUDIO_SIZE_MB, 25)
};

function validateEnv() {
  if (!env.openAiApiKey) {
    console.warn('[env] Missing variable: OPENAI_API_KEY');
  }
}

module.exports = { env, validateEnv };
