import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import oauthRefresh from '../dist/main/oauthRefresh.js';

const {
  initOAuthRefresh,
  shouldPreflightRefresh,
  refreshNow,
  __setOAuthRefreshPostForTest,
  __clearOAuthRefreshForTest,
} = oauthRefresh;

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalDisableRefresh = process.env.WMT_DISABLE_REFRESH;
const COOLDOWN_KEY = '_oauthRefreshCooldown';
let tempDirs = [];

function makeStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    get(key) {
      return values[key];
    },
    set(key, value) {
      values[key] = value;
    },
    delete(key) {
      delete values[key];
    },
  };
}

function makeTempConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-oauth-refresh-'));
  tempDirs.push(dir);
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

function writeCredentials(dir, claudeAiOauth) {
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    topLevelUnknown: 'keep-me',
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      nestedUnknown: 'keep-me-too',
      ...claudeAiOauth,
    },
  }, null, 2));
}

function initOAuthRefreshForTest(store) {
  initOAuthRefresh(store);
}

test.afterEach(() => {
  __clearOAuthRefreshForTest();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalDisableRefresh === undefined) delete process.env.WMT_DISABLE_REFRESH;
  else process.env.WMT_DISABLE_REFRESH = originalDisableRefresh;
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

test('shouldPreflightRefresh - far future', () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { expiresAt: Date.now() + 60 * 60 * 1000 });

  assert.equal(shouldPreflightRefresh(), false);
});

test('shouldPreflightRefresh - soon', () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { expiresAt: Date.now() + 4 * 60 * 1000 });

  assert.equal(shouldPreflightRefresh(), true);
});

test('shouldPreflightRefresh - past', () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });

  assert.equal(shouldPreflightRefresh(), true);
});

test('shouldPreflightRefresh - missing field', () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { expiresAt: undefined });

  assert.equal(shouldPreflightRefresh(), false);
});

test('refreshNow writes credentials atomically while preserving unknown fields', async () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  __setOAuthRefreshPostForTest(async () => ({
    status: 200,
    body: JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 28800,
    }),
  }));

  const outcome = await refreshNow('claude-code/test');

  assert.equal(outcome.kind, 'ok');
  const credPath = path.join(dir, '.credentials.json');
  const updated = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  assert.equal(updated.topLevelUnknown, 'keep-me');
  assert.equal(updated.claudeAiOauth.nestedUnknown, 'keep-me-too');
  assert.equal(updated.claudeAiOauth.accessToken, 'new-access');
  assert.equal(updated.claudeAiOauth.refreshToken, 'new-refresh');
  assert.equal(fs.existsSync(`${credPath}.bak`), true);
  const backup = JSON.parse(fs.readFileSync(`${credPath}.bak`, 'utf-8'));
  assert.equal(backup.claudeAiOauth.accessToken, 'old-access');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp.')), []);
});

test('singleflight concurrent refreshNow calls share one request', async () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      status: 200,
      body: JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 28800,
      }),
    };
  });

  const outcomes = await Promise.all([
    refreshNow('claude-code/test'),
    refreshNow('claude-code/test'),
    refreshNow('claude-code/test'),
    refreshNow('claude-code/test'),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['ok', 'ok', 'ok', 'ok']);
});

test('refreshNow classifies OAuth 429 as rate-limited', async () => {
  const dir = makeTempConfigDir();
  const store = makeStore();
  initOAuthRefreshForTest(store, dir);
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  __setOAuthRefreshPostForTest(async () => ({
    status: 429,
    headers: { 'retry-after': '60' },
    body: JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: 'Rate limited. Please try again later.',
      },
    }),
  }));

  const outcome = await refreshNow('claude-code/test');

  assert.equal(outcome.kind, 'rate-limited');
  assert.match(outcome.serverMessage ?? '', /Rate limited/);
  assert.equal(outcome.retryAfterMs, 30 * 60_000);
  assert.equal(outcome.serverRetryAfterMs, 60_000);
  assert.equal(store.values[COOLDOWN_KEY].reason, 'http-429');
  assert.equal(store.values[COOLDOWN_KEY].consecutiveCount, 1);
});

test('refreshNow uses cooldown after OAuth 429', async () => {
  const dir = makeTempConfigDir();
  const store = makeStore();
  initOAuthRefreshForTest(store, dir);
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return {
      status: 429,
      body: JSON.stringify({ error: { message: 'Rate limited. Please try again later.' } }),
    };
  });

  const first = await refreshNow('claude-code/test');
  const second = await refreshNow('claude-code/test');

  assert.equal(first.kind, 'rate-limited');
  assert.equal(second.kind, 'rate-limited');
  assert.equal(calls, 1);
  assert.equal(first.retryAfterMs, 30 * 60_000);
  assert.ok((second.retryAfterMs ?? 0) > 0);
});

test('refreshNow honors persisted OAuth 429 cooldown without network', async () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  const seedStore = makeStore();
  initOAuthRefreshForTest(seedStore, dir);
  __setOAuthRefreshPostForTest(async () => ({
    status: 429,
    body: JSON.stringify({ error: { message: 'persisted rate limit' } }),
  }));
  await refreshNow('claude-code/test');
  const persistedCooldown = {
    ...seedStore.values[COOLDOWN_KEY],
    until: Date.now() + 60 * 60_000,
    consecutiveCount: 2,
    serverMessage: 'persisted rate limit',
  };
  const store = makeStore({ [COOLDOWN_KEY]: persistedCooldown });
  initOAuthRefreshForTest(store, dir);
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return { status: 200, body: '{}' };
  });

  const outcome = await refreshNow('claude-code/test');

  assert.equal(outcome.kind, 'rate-limited');
  assert.equal(outcome.serverMessage, 'persisted rate limit');
  assert.equal(outcome.consecutiveCount, 2);
  assert.equal(calls, 0);
});

test('refreshNow escalates consecutive OAuth 429 cooldowns', async () => {
  const dir = makeTempConfigDir();
  const store = makeStore();
  initOAuthRefreshForTest(store, dir);
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return {
      status: 429,
      body: JSON.stringify({ error: { message: 'Rate limited. Please try again later.' } }),
    };
  });

  const first = await refreshNow('claude-code/test');
  store.values[COOLDOWN_KEY].until = Date.now() - 1;
  const second = await refreshNow('claude-code/test');
  store.values[COOLDOWN_KEY].until = Date.now() - 1;
  const third = await refreshNow('claude-code/test');

  assert.equal(first.kind, 'rate-limited');
  assert.equal(second.kind, 'rate-limited');
  assert.equal(third.kind, 'rate-limited');
  assert.equal(first.retryAfterMs, 30 * 60_000);
  assert.equal(second.retryAfterMs, 120 * 60_000);
  assert.equal(third.retryAfterMs, 360 * 60_000);
  assert.equal(third.consecutiveCount, 3);
  assert.equal(calls, 3);
});

test('refreshNow resets OAuth 429 consecutive count after credentials change', async () => {
  const dir = makeTempConfigDir();
  const store = makeStore();
  initOAuthRefreshForTest(store, dir);
  writeCredentials(dir, { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() - 1000 });
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return {
      status: 429,
      body: JSON.stringify({ error: { message: 'Rate limited. Please try again later.' } }),
    };
  });

  const first = await refreshNow('claude-code/test');
  store.values[COOLDOWN_KEY].until = Date.now() - 1;
  writeCredentials(dir, { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() - 1000 });
  const second = await refreshNow('claude-code/test');

  assert.equal(calls, 2);
  assert.equal(first.kind, 'rate-limited');
  assert.equal(second.kind, 'rate-limited');
  assert.equal(first.consecutiveCount, 1);
  assert.equal(second.consecutiveCount, 1);
  assert.equal(second.retryAfterMs, 30 * 60_000);
});

test('refreshNow ignores active cooldowns written for a previous credential file', async () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() - 1000 });
  const store = makeStore({
    [COOLDOWN_KEY]: {
      until: Date.now() + 60 * 60_000,
      reason: 'http-429',
      consecutiveCount: 3,
      recordedAt: Date.now() - 10_000,
      credentialMarker: 'old-credential-marker',
    },
  });
  initOAuthRefreshForTest(store, dir);
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return {
      status: 200,
      body: JSON.stringify({
        access_token: 'newer-access',
        refresh_token: 'newer-refresh',
        expires_in: 28800,
      }),
    };
  });

  const outcome = await refreshNow('claude-code/test');

  assert.equal(calls, 1);
  assert.equal(outcome.kind, 'ok');
  assert.equal(store.values[COOLDOWN_KEY], undefined);
});

test('refreshNow migrates old markerless OAuth cooldowns to the first backoff step', async () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  const recordedAt = Date.now() - 31 * 60_000;
  const store = makeStore({
    [COOLDOWN_KEY]: {
      until: Date.now() + 23 * 60 * 60_000,
      reason: 'http-429',
      consecutiveCount: 4,
      recordedAt,
      serverMessage: 'old markerless cooldown',
    },
  });
  initOAuthRefreshForTest(store, dir);
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return {
      status: 429,
      body: JSON.stringify({ error: { message: 'Rate limited. Please try again later.' } }),
    };
  });

  const outcome = await refreshNow('claude-code/test');

  assert.equal(calls, 1);
  assert.equal(outcome.kind, 'rate-limited');
  assert.equal(outcome.consecutiveCount, 2);
  assert.equal(outcome.retryAfterMs, 120 * 60_000);
});

test('refreshNow clears persisted cooldown after a successful refresh', async () => {
  const dir = makeTempConfigDir();
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  const store = makeStore({
    [COOLDOWN_KEY]: {
      until: Date.now() - 1,
      reason: 'http-429',
      consecutiveCount: 3,
      recordedAt: Date.now() - 10_000,
    },
  });
  initOAuthRefreshForTest(store, dir);
  __setOAuthRefreshPostForTest(async () => ({
    status: 200,
    body: JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 28800,
    }),
  }));

  const outcome = await refreshNow('claude-code/test');

  assert.equal(outcome.kind, 'ok');
  assert.equal(store.values[COOLDOWN_KEY], undefined);
});

test('refreshNow kill switch avoids all refresh network calls', async () => {
  const dir = makeTempConfigDir();
  const store = makeStore();
  initOAuthRefreshForTest(store, dir);
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  process.env.WMT_DISABLE_REFRESH = '1';
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    return { status: 200, body: '{}' };
  });

  const outcome = await refreshNow('claude-code/test');

  assert.equal(outcome.kind, 'rate-limited');
  assert.equal(outcome.reason, 'kill-switch');
  assert.match(outcome.serverMessage ?? '', /WMT_DISABLE_REFRESH/);
  assert.equal(calls, 0);
  assert.equal(store.values[COOLDOWN_KEY], undefined);
});

test('refreshNow shares singleflight joiners without extra network attempts', async () => {
  const dir = makeTempConfigDir();
  const store = makeStore();
  initOAuthRefreshForTest(store, dir);
  writeCredentials(dir, { expiresAt: Date.now() - 1000 });
  let calls = 0;
  __setOAuthRefreshPostForTest(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      status: 200,
      body: JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 28800,
      }),
    };
  });

  const outcomes = await Promise.all([
    refreshNow('claude-code/test', '401-retry'),
    refreshNow('claude-code/test', '401-retry'),
    refreshNow('claude-code/test', '401-retry'),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['ok', 'ok', 'ok']);
});
