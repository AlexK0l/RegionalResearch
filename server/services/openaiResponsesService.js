const OpenAI = require('openai');
const { env } = require('../config/env');
const { modelConfig } = require('../config/models');
const { HttpError } = require('../utils/httpError');

const client = new OpenAI({ apiKey: env.openAiApiKey });

const generationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: { type: 'string' },
    placeholders_used: {
      type: 'array',
      items: { type: 'string' }
    },
    missing_but_required: {
      type: 'array',
      items: { type: 'string' }
    },
    notes: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['prompt', 'placeholders_used', 'missing_but_required', 'notes']
};

async function sendStructuredOpenAiRequest({ instructions, userInput }) {
  if (!env.openAiApiKey) {
    throw new HttpError(500, 'Не задан OPENAI_API_KEY.');
  }

  try {
    const response = await client.responses.create(
      {
        model: modelConfig.llm.model,
        reasoning: { effort: modelConfig.llm.reasoningEffort },
        max_output_tokens: modelConfig.llm.maxOutputTokens,
        instructions,
        input: userInput,
        text: {
          format: {
            type: 'json_schema',
            name: 'generated_prompt_payload',
            strict: true,
            schema: generationSchema
          }
        }
      },
      {
        signal: AbortSignal.timeout(modelConfig.llm.timeoutMs)
      }
    );

    const rawText = response.output_text;

    if (!rawText || typeof rawText !== 'string') {
      throw new HttpError(502, 'OpenAI вернул пустой или некорректный ответ.', { response });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      throw new HttpError(502, 'OpenAI вернул невалидный JSON.', { rawText });
    }

    return {
      raw: response,
      text: rawText,
      parsed
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      throw new HttpError(504, 'Таймаут запроса к OpenAI Responses API.');
    }

    const apiMessage = error?.error?.message || error?.message || 'Неизвестная ошибка OpenAI API.';
    throw new HttpError(502, `Ошибка OpenAI API: ${apiMessage}`);
  }
}

module.exports = { sendStructuredOpenAiRequest };
