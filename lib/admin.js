// Safe administrator bootstrap / recovery, shared by the server (startup) and `npm run reset-admin`.
const bcrypt = require('bcryptjs');

const DEV_DEFAULT_PASSWORD = 'admin123';

// Makes sure at least one ACTIVE administrator exists.
//  - No admin exists            -> create one.
//  - Admin exists but disabled  -> only re-enabled when a password is explicitly provided (opts.password)
//                                  or opts.force is set; otherwise a warning is logged.
// Returns a short description of what happened (or null if nothing was needed).
async function ensureAdmin(store, { name = 'Admin', password, force = false, production = false, log = console } = {}) {
  const active = await store.countActiveAdmins();
  if (active > 0 && !force) return null;

  const users = await store.listUsers();
  const existing = users.find(u => u.name.toLowerCase() === name.toLowerCase()) || users.find(u => u.role === 'admin');

  if (!existing) {
    let pw = password;
    let mustChange = false;
    if (!pw) {
      if (production) {
        throw new Error('ADMIN_PASSWORD must be set (min 8 characters) to create the first administrator in production.');
      }
      pw = DEV_DEFAULT_PASSWORD;
      mustChange = true; // forced to choose a new password at first login
    }
    if (pw.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
    await store.createUser({ name, passwordHash: bcrypt.hashSync(pw, 10), role: 'admin', status: 'active', mustChangePassword: mustChange });
    log.log(`[setup] Created administrator "${name}"` + (mustChange ? ` with the development default password "${DEV_DEFAULT_PASSWORD}" (you will be asked to change it at first login).` : '.'));
    return 'created';
  }

  if (!password && !force) {
    log.warn(`[setup] WARNING: no active administrator exists ("${existing.name}" is ${existing.status}). ` +
      'Run `ADMIN_PASSWORD=<new password> npm run reset-admin` (or set ADMIN_PASSWORD and restart) to recover access.');
    return 'warned';
  }
  if (!password || password.length < 8) throw new Error('A password of at least 8 characters is required to recover the administrator.');
  await store.updateUser(existing.id, {
    role: 'admin', status: 'active', passwordHash: bcrypt.hashSync(password, 10), mustChangePassword: false
  });
  log.log(`[setup] Administrator "${existing.name}" re-enabled with the provided password.`);
  return 'recovered';
}

module.exports = { ensureAdmin, DEV_DEFAULT_PASSWORD };
