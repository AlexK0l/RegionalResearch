const { HttpError } = require('../utils/httpError');

function cleanText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeNoteInput({ noteText, transcriptText, combinedText }) {
  const cleanedCombined = cleanText(combinedText);
  const cleanedNote = cleanText(noteText);
  const cleanedTranscript = cleanText(transcriptText);

  const normalizedInput = [cleanedCombined || cleanedNote, cleanedTranscript]
    .filter(Boolean)
    .join('\n\n');

  if (!normalizedInput) {
    throw new HttpError(400, 'Нужно передать текст заметки для генерации промпта.');
  }

  return {
    noteText: normalizedInput,
    transcriptText: cleanedTranscript,
    normalizedInput
  };
}

module.exports = { normalizeNoteInput };
