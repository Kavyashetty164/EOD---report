// Usage:  ADMIN_PASSWORD='new-strong-password' [ADMIN_NAME=Admin] npm run reset-admin
// Creates the administrator, or re-enables + resets the password of an existing/disabled one.
const { createStore } = require('../lib/db');
const { ensureAdmin } = require('../lib/admin');

(async () => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    console.error('Set ADMIN_PASSWORD (min 8 characters), e.g.\n  ADMIN_PASSWORD=\'MyNewPassw0rd\' npm run reset-admin');
    process.exit(1);
  }
  const store = createStore();
  await store.init();
  try {
    await ensureAdmin(store, { name: process.env.ADMIN_NAME || 'Admin', password, force: true });
  } finally {
    await store.close();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
