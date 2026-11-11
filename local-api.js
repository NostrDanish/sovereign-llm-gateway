'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1_048_576);
const MAX_UPSTREAM_BYTES = Number(process.env.MAX_UPSTREAM_BYTES || 4_194_304);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120_000);
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');

function json(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req, maxBytes = MAX_BODY_BYTES, signal) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks = [];
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      signal?.removeEventListener('abort', onSignalAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      if (tooLarge) {
        finish(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })); }
    };
    const onError = error => finish(error);
    const onAborted = () => finish(Object.assign(new Error('request body aborted'), { statusCode: 400 }));
    const onSignalAbort = () => {
      finish(Object.assign(new Error('local inference timed out'), { statusCode: 504 }));
      req.resume();
    };
    if (signal?.aborted) {
      onSignalAbort();
      return;
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    signal?.addEventListener('abort', onSignalAbort, { once: true });
  });
}

async function readUpstreamJson(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw Object.assign(new Error('local Ollama response too large'), { statusCode: 502 });
  }
  if (!response.body) throw Object.assign(new Error('local Ollama returned an empty response'), { statusCode: 502 });
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error('local Ollama response too large'), { statusCode: 502 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('local Ollama returned invalid JSON'), { statusCode: 502 });
  }
}

function authorized(req, key) {
  if (!key) return true;
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 128) {
    throw Object.assign(new Error('messages must be a non-empty array of at most 128 entries'), { statusCode: 400 });
  }
  return messages.map(message => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw Object.assign(new Error('each message must have a supported role and string content'), { statusCode: 400 });
    }
    return { role: message.role, content: message.content };
  });
}

function createServer(options = {}) {
  const ollamaUrl = options.ollamaUrl || OLLAMA_URL;
  const model = options.model || MODEL;
  const apiKey = options.apiKey ?? process.env.GATEWAY_API_KEY ?? '';
  const maxConcurrent = options.maxConcurrent || MAX_CONCURRENT;
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
  const maxUpstreamBytes = options.maxUpstreamBytes || MAX_UPSTREAM_BYTES;
  let active = 0;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', inference: 'local-ollama', model });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: model, object: 'model', owned_by: 'local' }] });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return json(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
    }
    if (!authorized(req, apiKey)) {
      return json(res, 401, { error: { message: 'invalid or missing bearer token', type: 'authentication_error' } });
    }
    if (active >= maxConcurrent) {
      return json(res, 429, { error: { message: 'local inference concurrency limit reached', type: 'rate_limit_error' } });
    }

    active += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = await readJson(req, maxBodyBytes, controller.signal);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw Object.assign(new Error('request body must be a JSON object'), { statusCode: 400 });
      }
      if (body.stream === true) {
        return json(res, 400, { error: { message: 'streaming is not implemented by this local adapter yet; set stream=false', type: 'invalid_request_error' } });
      }
      if (body.tools || body.tool_choice) {
        return json(res, 400, { error: { message: 'tool calling is not implemented by this local adapter yet', type: 'invalid_request_error' } });
      }
      const messages = normalizeMessages(body.messages);
      const requestedModel = typeof body.model === 'string' && body.model.length > 0 ? body.model : model;
      const upstream = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: requestedModel, messages, stream: false }),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        return json(res, 502, { error: { message: `local Ollama returned HTTP ${upstream.status}`, type: 'upstream_error' } });
      }
      const result = await readUpstreamJson(upstream, maxUpstreamBytes);
      const content = result && result.message && result.message.content;
      if (typeof content !== 'string') {
        return json(res, 502, { error: { message: 'local Ollama returned an invalid chat response', type: 'upstream_error' } });
      }
      return json(res, 200, {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: Number(result.prompt_eval_count || 0),
          completion_tokens: Number(result.eval_count || 0),
          total_tokens: Number(result.prompt_eval_count || 0) + Number(result.eval_count || 0),
        },
      });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.statusCode || (error.name === 'AbortError' ? 504 : 502), {
        error: { message: error.statusCode ? error.message : (error.name === 'AbortError' ? 'local inference timed out' : 'local inference request failed'), type: 'gateway_error' },
      });
    } finally {
      clearTimeout(timeout);
      active -= 1;
    }
  });
}

if (require.main === module) {
  const host = process.env.GATEWAY_HOST || '127.0.0.1';
  const port = Number(process.env.GATEWAY_PORT || 8787);
  const key = process.env.GATEWAY_API_KEY || '';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GATEWAY_PORT must be a valid TCP port');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !key) {
    throw new Error('Refusing non-loopback bind without GATEWAY_API_KEY');
  }
  createServer().listen(port, host, () => {
    process.stdout.write(`Local Ollama OpenAI-compatible API listening on http://${host}:${port}\n`);
  });
}

module.exports = { createServer, normalizeMessages, authorized, readUpstreamJson };
