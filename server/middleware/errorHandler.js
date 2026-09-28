const multer = require('multer');

function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: {
      message: 'Маршрут не найден.'
    }
  });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      ok: false,
      error: {
        message: err.code === 'LIMIT_FILE_SIZE'
          ? 'Аудиофайл слишком большой.'
          : `Ошибка загрузки файла: ${err.message}`
      }
    });
  }

  const status = err.status || 500;
  const message = err.message || 'Внутренняя ошибка сервера.';

  return res.status(status).json({
    ok: false,
    error: {
      message,
      details: process.env.NODE_ENV === 'development' ? err.details || null : null
    }
  });
}

module.exports = { notFoundHandler, errorHandler };
