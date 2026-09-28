const { sendStructuredOpenAiRequest } = require('./openaiResponsesService');
const { generationSystemPrompt } = require('../prompts/systemPrompts');
const { HttpError } = require('../utils/httpError');

function requireObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(502, 'Некорректный формат ответа модели.', { parsed });
  }
  return parsed;
}

async function runPromptPipeline(normalizedInput) {
  const userMessage = `
Сырые данные пользователя:
${normalizedInput}

Сгенерируй итоговый промпт согласно инструкции.
`.trim();

  const response = await sendStructuredOpenAiRequest({
    instructions: generationSystemPrompt(),
    userInput: userMessage
  });

  const parsed = requireObject(response.parsed);

  const prompt = parsed.prompt || '';
  if (!prompt) {
    throw new HttpError(502, 'Модель не вернула итоговый промпт.');
  }

  return {
    prompt,
    placeholdersUsed: Array.isArray(parsed.placeholders_used) ? parsed.placeholders_used : [],
    missingButRequired: Array.isArray(parsed.missing_but_required) ? parsed.missing_but_required : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    rawText: response.text
  };
}

module.exports = { runPromptPipeline };
