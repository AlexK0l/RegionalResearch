const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { modelConfig } = require('../config/models');
const { runPipelineController, transcribeAudioController } = require('../controllers/promptController');
const { HttpError } = require('../utils/httpError');
const { normalizeMimeType, guessExtension } = require('../services/audioPreparationService');

const router = express.Router();
const uploadDir = path.join(process.cwd(), 'tmp', 'audio');

fs.mkdirSync(uploadDir, { recursive: true });

const allowedMimeTypes = new Set([
  'audio/webm',
  'video/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'video/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/ogg',
  'audio/oga',
  'audio/flac',
  'audio/x-flac',
  'audio/aac',
  'application/octet-stream'
]);

const allowedExtensions = new Set([
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.oga',
  '.ogg',
  '.wav',
  '.webm'
]);

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, uploadDir);
  },
  filename: (req, file, callback) => {
    const safeExt = guessExtension({
      filePath: file.originalname,
      mimeType: file.mimetype,
      originalName: file.originalname
    }) || '.bin';
    const uniqueName = `${Date.now()}-${crypto.randomUUID()}${safeExt}`;
    callback(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: modelConfig.transcription.maxAudioSizeBytes
  },
  fileFilter: (req, file, callback) => {
    const normalizedMimeType = normalizeMimeType(file.mimetype);
    const extension = guessExtension({
      filePath: file.originalname,
      mimeType: file.mimetype,
      originalName: file.originalname
    });

    if (!allowedMimeTypes.has(normalizedMimeType) && !allowedExtensions.has(extension)) {
      return callback(
        new HttpError(
          400,
          `Неподдерживаемый тип аудио: ${file.mimetype || 'unknown'}${extension ? ` (${extension})` : ''}`
        )
      );
    }

    return callback(null, true);
  }
});

router.get('/health', (req, res) => {
  res.json({ ok: true, message: 'API is healthy' });
});

router.post('/transcribe', upload.single('audio'), transcribeAudioController);
router.post('/prompt/pipeline', runPipelineController);

module.exports = { router };
