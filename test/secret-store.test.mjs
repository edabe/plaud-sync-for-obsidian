import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const secretModuleUrl = pathToFileURL(path.join(root, 'src/secret-store.ts')).href;
const {
  PLAUD_TOKEN_SECRET_KEY,
  getPlaudToken,
  setPlaudToken,
  clearPlaudToken
} = await import(secretModuleUrl);

const settingsSource = fs.readFileSync(path.join(root, 'src/settings.ts'), 'utf8');
const schemaSource = fs.readFileSync(path.join(root, 'src/settings-schema.ts'), 'utf8');

const FALLBACK_KEY = 'plaud-sync.token.fallback';

function createSecretStorage() {
  const secrets = new Map();
  return {
    secrets,
    getSecret(id) {
      return secrets.get(id) ?? null;
    },
    setSecret(id, secret) {
      // Mirrors Obsidian, which throws on an ID outside this format.
      assert.match(id, /^[a-z0-9-]+$/);
      secrets.set(id, secret);
    }
  };
}

function createHost({fallbackToken, secretStorage = createSecretStorage()} = {}) {
  const kv = new Map();
  if (fallbackToken) {
    kv.set(FALLBACK_KEY, fallbackToken);
  }
  return {
    kv,
    secretStorage,
    loadLocalStorage(key) {
      return kv.get(key) ?? null;
    },
    saveLocalStorage(key, value) {
      if (value === null) {
        kv.delete(key);
        return;
      }
      kv.set(key, value);
    }
  };
}

test('secret key constant is stable, plugin-scoped and a valid secret ID', () => {
  assert.equal(PLAUD_TOKEN_SECRET_KEY, 'plaud-sync-token');
});

test('secretStorage is used when available', async () => {
  const host = createHost();

  await setPlaudToken(host, 'tok_abc');

  assert.equal(host.secretStorage.secrets.get(PLAUD_TOKEN_SECRET_KEY), 'tok_abc');
  assert.equal(host.kv.size, 0);
  assert.equal(await getPlaudToken(host), 'tok_abc');
});

test('clearing leaves no token behind in secretStorage', async () => {
  const host = createHost();
  await setPlaudToken(host, 'tok_abc');

  await clearPlaudToken(host);

  assert.equal(host.secretStorage.secrets.get(PLAUD_TOKEN_SECRET_KEY), '');
  assert.equal(await getPlaudToken(host), null);
});

test('reading moves an existing fallback token into secretStorage', async () => {
  const host = createHost({fallbackToken: 'tok_old'});

  assert.equal(await getPlaudToken(host), 'tok_old');

  assert.equal(host.secretStorage.secrets.get(PLAUD_TOKEN_SECRET_KEY), 'tok_old');
  assert.equal(host.kv.has(FALLBACK_KEY), false);
  assert.equal(await getPlaudToken(host), 'tok_old');
});

test('a failed move keeps the fallback token working', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const secretStorage = createSecretStorage();
  secretStorage.setSecret = () => {
    throw new Error('storage unavailable');
  };
  const host = createHost({fallbackToken: 'tok_old', secretStorage});

  assert.equal(await getPlaudToken(host), 'tok_old');

  assert.equal(host.kv.get(FALLBACK_KEY), 'tok_old');
});

test('saving a token removes the old fallback copy', async () => {
  const host = createHost({fallbackToken: 'tok_old'});

  await setPlaudToken(host, 'tok_new');

  assert.equal(host.kv.has(FALLBACK_KEY), false);
  assert.equal(await getPlaudToken(host), 'tok_new');
});

test('a failed save reports the error and does not fall back to local storage', async () => {
  const secretStorage = createSecretStorage();
  secretStorage.setSecret = () => {
    throw new Error('storage unavailable');
  };
  const host = createHost({secretStorage});

  await assert.rejects(() => setPlaudToken(host, 'tok_abc'), /storage unavailable/);

  assert.equal(host.kv.size, 0);
});

test('clearing also removes a fallback token, so it cannot come back', async () => {
  const host = createHost({fallbackToken: 'tok_old'});

  await clearPlaudToken(host);

  assert.equal(await getPlaudToken(host), null);
});

test('fallback storage path still keeps token out of plugin saveData payload', async () => {
  const kv = new Map();
  const host = {
    loadLocalStorage(key) {
      return kv.get(key) ?? null;
    },
    saveLocalStorage(key, value) {
      if (value === null) {
        kv.delete(key);
        return;
      }
      kv.set(key, value);
    }
  };

  await setPlaudToken(host, 'tok_local');
  assert.equal(await getPlaudToken(host), 'tok_local');
  await clearPlaudToken(host);
  assert.equal(await getPlaudToken(host), null);

  assert.doesNotMatch(schemaSource, /token/i);
});

test('settings uses secret input flow and token feedback copy', () => {
  assert.match(settingsSource, /setPlaudToken\(/);
  assert.match(settingsSource, /getPlaudToken\(/);
  assert.match(settingsSource, /type\s*=\s*'password'/);
  assert.match(settingsSource, /Plaud token/);
});
