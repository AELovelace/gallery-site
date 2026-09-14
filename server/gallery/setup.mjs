import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initAccounts, bindOwner } from './identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const usage = 'Usage: node server/gallery/setup.mjs bind-owner --auth-db /var/lib/lidoll/auth/auth.sqlite --username lidoll [--issuer https://auth.sadgirlsclub.wtf]';
let auth, gallery;
try {
  if (args[0] !== 'bind-owner') throw Error(usage);
  const values = {};
  for (let index=1; index<args.length; index+=2) {
    if (!['--auth-db','--username','--issuer'].includes(args[index]) || !args[index+1] || values[args[index]]) throw Error(usage);
    values[args[index]] = args[index+1];
  }
  if (!values['--auth-db'] || !values['--username']) throw Error(usage);
  const issuer = values['--issuer'] || process.env.GALLERY_OIDC_ISSUER || 'https://auth.sadgirlsclub.wtf';
  const parsed = new URL(issuer);
  if (parsed.protocol !== 'https:' || parsed.origin !== issuer) throw Error('Use the exact public HTTPS LiDollID issuer origin.');
  const dataDir = path.resolve(process.env.GALLERY_DATA_DIR || path.join(root,'gallery-data'));
  const dbFile = path.join(dataDir,'gallery.sqlite');
  if (!existsSync(dbFile)) throw Error('Start the updated gallery once to initialize its database, then stop it before binding its owner.');
  auth = new DatabaseSync(path.resolve(values['--auth-db']), { readOnly: true });
  const matches = auth.prepare('SELECT id,username,disabled FROM accounts WHERE username=?').all(values['--username']);
  if (matches.length !== 1 || matches[0].disabled) throw Error('Expected exactly one enabled LiDollID account with that exact username. No gallery ownership was changed.');
  gallery = new DatabaseSync(dbFile);
  gallery.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  initAccounts(gallery);
  const account = matches[0];
  bindOwner(gallery, issuer, account.id, account.username); // Reads the identity database without editing it and never matches ownership by a browser-supplied username.
  console.log('Gallery owner bound to LiDollID account ' + account.username + '. Existing unowned collections now belong to this account.');
} catch(error) { console.error(error.message); process.exitCode=1; }
finally { gallery?.close(); auth?.close(); }
