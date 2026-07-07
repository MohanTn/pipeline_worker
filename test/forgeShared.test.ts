import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { forgeFetch, isRetryableStatus, parseRetryAfterMs } from '../src/forge/shared.js';

const FAST_RETRY = { maxRetries: 4, baseDelayMs: 1, maxDelayMs: 5 };

function startServer(handler: http.RequestListener): Promise<{ server: Server; port: number }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function url(port: number): string {
  return `http://127.0.0.1:${port}/thing`;
}

test('isRetryableStatus is true for 429 and every 5xx, false for other 4xx', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(599), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(422), false);
});

test('parseRetryAfterMs parses delta-seconds form', () => {
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs('0'), 0);
});

test('parseRetryAfterMs parses an HTTP-date form as a non-negative delta from now', () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = parseRetryAfterMs(future);
  assert.ok(ms !== undefined && ms > 0 && ms <= 5500);
});

test('parseRetryAfterMs returns undefined for absent/unparseable header', () => {
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs('not-a-value-or-date'), undefined);
});

test('forgeFetch retries a 500 then succeeds', async () => {
  let calls = 0;
  const { server, port } = await startServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  try {
    const res = await forgeFetch('Test API', '/thing', url(port), {}, undefined, FAST_RETRY);
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    server.close();
  }
});

test('forgeFetch retries a 429 honoring Retry-After', async () => {
  let calls = 0;
  const start = Date.now();
  const { server, port } = await startServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { 'retry-after': '0.01' });
      res.end('slow down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  try {
    const res = await forgeFetch('Test API', '/thing', url(port), {}, undefined, FAST_RETRY);
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.ok(Date.now() - start >= 8); // Retry-After was ~10ms (within FAST_RETRY's own backoff cap); allow a little slack
  } finally {
    server.close();
  }
});

test('forgeFetch does not retry 404 — exactly one request, throws immediately', async () => {
  let calls = 0;
  const { server, port } = await startServer((req, res) => {
    calls += 1;
    res.writeHead(404);
    res.end('not found');
  });
  try {
    await assert.rejects(() => forgeFetch('Test API', '/thing', url(port), {}, undefined, FAST_RETRY), /404/);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test('forgeFetch does not retry 401', async () => {
  let calls = 0;
  const { server, port } = await startServer((req, res) => {
    calls += 1;
    res.writeHead(401);
    res.end('unauthorized');
  });
  try {
    await assert.rejects(() => forgeFetch('Test API', '/thing', url(port), {}, undefined, FAST_RETRY), /401/);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test('forgeFetch exhausts retries against an always-500 server, throwing after maxRetries + 1 requests', async () => {
  let calls = 0;
  const { server, port } = await startServer((req, res) => {
    calls += 1;
    res.writeHead(500);
    res.end('still broken');
  });
  try {
    await assert.rejects(() => forgeFetch('Test API', '/thing', url(port), {}, undefined, FAST_RETRY), /500/);
    assert.equal(calls, FAST_RETRY.maxRetries + 1);
  } finally {
    server.close();
  }
});

test('forgeFetch retries a connection-refused network error, then throws the final labeled error', async () => {
  // Nothing listening on this port — every attempt is a network-level failure.
  const { server, port } = await startServer(() => {});
  server.close();
  await assert.rejects(
    () => forgeFetch('Test API', '/thing', url(port), {}, undefined, FAST_RETRY),
    /Test API GET \/thing failed after \d+ attempt\(s\)/,
  );
});
