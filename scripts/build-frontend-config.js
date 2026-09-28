const fs = require('fs');
const path = require('path');

const outputPath = path.resolve(process.cwd(), 'public', 'config.js');
const apiBaseUrl = String(process.env.FRONTEND_API_BASE_URL || '').trim().replace(/\/$/, '');

const content = `window.APP_CONFIG = ${JSON.stringify({ API_BASE_URL: apiBaseUrl }, null, 2)};\n`;

fs.writeFileSync(outputPath, content, 'utf8');
console.log(`[build-frontend-config] wrote ${outputPath} with API_BASE_URL=${apiBaseUrl || '(empty)'}`);
