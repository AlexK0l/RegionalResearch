const { app } = require('./app');
const { env, validateEnv } = require('./config/env');

validateEnv();

app.listen(env.port, () => {
  console.log(`Server is running on http://localhost:${env.port}`);
});
