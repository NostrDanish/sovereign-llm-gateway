'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../local-api');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('serves OpenAI-compatible models and local chat completions', async t => {
  const ollama = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.model, 'test-model');
      assert.equal(parsed.stream, false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: 'local reply' }, prompt_eval_count: 3, eval_count: 2 }));
    });
  });
  const ollamaPort = await listen(ollama);
  const gateway = createServer({ ollamaUrl: `http://127.0.0.1:${ollamaPort}`, model: 'test-model', apiKey: 'test-key' });
  const gatewayPort = await listen(gateway);
  t.after(() => { ollama.close(); gateway.close(); });

  const models = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`).then(r => r.json());
  assert.equal(models.data[0].id, 'test-model');

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.choices[0].message.content, 'local reply');
  assert.equal(result.usage.total_tokens, 5);
});

test('rejects missing authentication', async t => {
  const gateway = createServer({ apiKey: 'secret' });
  const port = await listen(gateway);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(response.status, 401);
});

test('rejects unsupported tools and streaming rather than pretending support', async t => {
  const gateway = createServer({ apiKey: 'secret' });
  const port = await listen(gateway);
  t.after(() => gateway.close());
  for (const payload of [
    { stream: true, messages: [{ role: 'user', content: 'x' }] },
    { tools: [], messages: [{ role: 'user', content: 'x' }] },
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
  }
});


test('returns 413 for oversized JSON without abruptly destroying the request', async t => {
  const gateway = createServer({ apiKey: 'secret', maxBodyBytes: 32 });
  const port = await listen(gateway);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'this request is deliberately much too large' }] }),
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error.message, /too large/);
});

test('keeps the inference timeout active while reading the Ollama response body', async t => {
  const ollama = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ message: { content: 'too late' } })), 100);
  });
  const ollamaPort = await listen(ollama);
  const gateway = createServer({ ollamaUrl: `http://127.0.0.1:${ollamaPort}`, timeoutMs: 20 });
  const gatewayPort = await listen(gateway);
  t.after(() => { ollama.close(); gateway.close(); });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error.message, /timed out/);
});


test('times out a client that stalls while uploading its JSON body', async t => {
  const gateway = createServer({ timeoutMs: 30 });
  const port = await listen(gateway);
  t.after(() => gateway.close());
  const responsePromise = new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write('{"messages":[');
    setTimeout(() => req.end('{"role":"user","content":"late"}]}'), 100);
  });
  const response = await responsePromise;
  assert.equal(response.status, 504);
  assert.match(JSON.parse(response.body).error.message, /timed out/);
});
