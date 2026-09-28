const fs = require('fs/promises');
const { normalizeNoteInput } = require('../services/noteNormalizerService');
const { runPromptPipeline } = require('../services/promptPipelineService');
const { transcribeAudio } = require('../services/transcriptionService');
const { HttpError } = require('../utils/httpError');

async function transcribeAudioController(req, res, next) {
  const file = req.file;

  if (!file) {
    return next(new HttpError(400, 'Аудиофайл не был загружен.'));
  }

  try {
    const result = await transcribeAudio(file.path, file.mimetype, file.originalname);
    return res.json({
      ok: true,
      transcript: result.transcript,
      meta: {
        mimeType: result.mimeType,
        model: result.model,
        originalName: file.originalname,
        size: file.size
      }
    });
  } catch (error) {
    return next(error);
  } finally {
    await fs.unlink(file.path).catch(() => {});
  }
}

async function runPipelineController(req, res, next) {
  try {
    const { noteText, transcriptText, combinedText } = req.body || {};
    const normalized = normalizeNoteInput({ noteText, transcriptText, combinedText });
    const result = await runPromptPipeline(normalized.normalizedInput);

    return res.json({
      ok: true,
      source: {
        noteText: normalized.noteText,
        transcriptText: normalized.transcriptText,
        normalizedInput: normalized.normalizedInput
      },
      results: {
        prompt: result.prompt,
        meta: {
          placeholdersUsed: result.placeholdersUsed,
          missingButRequired: result.missingButRequired,
          generationNotes: result.notes
        }
      }
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  transcribeAudioController,
  runPipelineController
};
