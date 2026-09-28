const express = require('express');
const cors = require('cors');
const path = require('path');
const { env } = require('./config/env');
const { router } = require('./routes/api');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(cors({
  origin: env.clientOrigin,
  credentials: false
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.use('/api', router);

app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = { app };
