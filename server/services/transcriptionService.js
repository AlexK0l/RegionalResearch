const fs = require('fs');
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');
const { env } = require('../config/env');
const { modelConfig } = require('../config/models');
const { HttpError } = require('../utils/httpError');
const { prepareAudioForTranscription } = require('./audioPreparationService');

const openai = new OpenAI({ apiKey: env.openAiApiKey });

async function transcribeAudio(filePath, mimeType, originalName) {
  if (!env.openAiApiKey) {
    throw new HttpError(500, 'Не задан OPENAI_API_KEY.');
  }

  let preparedAudio = null;

  try {
    preparedAudio = await prepareAudioForTranscription({ filePath, mimeType, originalName });

    const fileBuffer = await fs.promises.readFile(preparedAudio.preparedFilePath);
    const file = await toFile(fileBuffer, preparedAudio.preparedFilename, {
      type: preparedAudio.preparedMimeType
    });

    const result = await openai.audio.transcriptions.create(
      {
        file,
        model: modelConfig.transcription.model,
        language: modelConfig.transcription.language,
        response_format: 'json'
      },
      {
        signal: AbortSignal.timeout(modelConfig.transcription.timeoutMs)
      }
    );

    const transcript = typeof result.text === 'string' ? result.text.trim() : '';

    if (!transcript) {
      throw new HttpError(502, 'Сервис транскрибации вернул пустой текст.');
    }

    return {
      transcript,
      mimeType: preparedAudio.preparedMimeType,
      model: modelConfig.transcription.model
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      throw new HttpError(504, 'Таймаут запроса к сервису транскрибации.');
    }

    const apiMessage = error?.error?.message || error?.message || 'Неизвестная ошибка транскрибации.';
    throw new HttpError(502, `Ошибка сервиса транскрибации: ${apiMessage}`);
  } finally {
    await preparedAudio?.cleanup?.().catch(() => {});
  }
}

module.exports = { transcribeAudio };
