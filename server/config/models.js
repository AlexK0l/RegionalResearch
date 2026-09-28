const { env } = require('./env');

const modelConfig = {
  llm: {
    model: env.openAiModel,
    maxOutputTokens: env.openAiMaxOutputTokens,
    reasoningEffort: env.openAiReasoningEffort,
    timeoutMs: env.openAiTimeoutMs
  },
  transcription: {
    model: env.transcriptionModel,
    language: env.transcriptionLanguage,
    timeoutMs: env.transcriptionTimeoutMs,
    maxAudioSizeBytes: env.maxAudioSizeMb * 1024 * 1024
  }
};

module.exports = { modelConfig };
