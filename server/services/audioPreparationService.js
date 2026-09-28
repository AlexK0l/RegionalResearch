const fs = require('fs/promises');
const path = require('path');
const { HttpError } = require('../utils/httpError');

const MIME_ALIAS = {
  'video/webm': 'audio/webm',
  'video/mp4': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/x-m4a': 'audio/m4a',
  'audio/x-flac': 'audio/flac',
  'audio/mp3': 'audio/mpeg'
};

const EXTENSION_BY_MIME = {
  'audio/webm': '.webm',
  'audio/wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.mp4',
  'audio/m4a': '.m4a',
  'audio/ogg': '.ogg',
  'audio/oga': '.oga',
  'audio/flac': '.flac',
  'audio/aac': '.aac'
};

const OPENAI_SUPPORTED_EXTENSIONS = new Set([
  '.flac',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.m4a',
  '.ogg',
  '.wav',
  '.webm'
]);

const OPENAI_SUPPORTED_MIME_TYPES = new Set(Object.keys(EXTENSION_BY_MIME));

function normalizeMimeType(mimeType) {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return MIME_ALIAS[normalized] || normalized;
}

function getExtensionFromName(filename) {
  return path.extname(String(filename || '')).trim().toLowerCase();
}

function guessExtension({ filePath, mimeType, originalName }) {
  const nameExtension = getExtensionFromName(originalName);
  if (nameExtension) {
    return nameExtension;
  }

  const filePathExtension = getExtensionFromName(filePath);
  if (filePathExtension) {
    return filePathExtension;
  }

  return EXTENSION_BY_MIME[normalizeMimeType(mimeType)] || '';
}

async function ensureReadableAudioFile(filePath) {
  const stats = await fs.stat(filePath).catch(() => null);

  if (!stats || !stats.isFile()) {
    throw new HttpError(400, 'Аудиофайл не найден на сервере после загрузки.');
  }

  if (stats.size <= 0) {
    throw new HttpError(400, 'Загруженный аудиофайл пустой. Повторите запись ещё раз.');
  }

  return stats;
}

async function prepareAudioForTranscription({ filePath, mimeType, originalName }) {
  await ensureReadableAudioFile(filePath);

  const normalizedMimeType = normalizeMimeType(mimeType);
  const guessedExtension = guessExtension({ filePath, mimeType: normalizedMimeType, originalName });
  const safeExtension = OPENAI_SUPPORTED_EXTENSIONS.has(guessedExtension)
    ? guessedExtension
    : EXTENSION_BY_MIME[normalizedMimeType] || '.webm';

  if (!OPENAI_SUPPORTED_MIME_TYPES.has(normalizedMimeType) && !OPENAI_SUPPORTED_EXTENSIONS.has(safeExtension)) {
    throw new HttpError(
      400,
      'Формат аудио не поддерживается для транскрибации. Используйте webm, mp4, m4a, mp3, wav, ogg или flac.'
    );
  }

  const baseName = path.parse(originalName || path.basename(filePath)).name || 'voice-note';

  return {
    preparedFilePath: filePath,
    preparedMimeType: OPENAI_SUPPORTED_MIME_TYPES.has(normalizedMimeType) ? normalizedMimeType : 'audio/webm',
    preparedFilename: `${baseName}${safeExtension}`,
    cleanup: async () => {}
  };
}

module.exports = {
  normalizeMimeType,
  guessExtension,
  prepareAudioForTranscription
};
