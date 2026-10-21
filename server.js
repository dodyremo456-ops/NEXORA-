
'use strict';
// NEXORA backend with secure Gemini API support.
// Node.js 18+; no extra packages required.

const http = require('http');
const fs = require('fs');
const path = require('path');

const env = process.env;
const PORT = Number(env.PORT) || 8080;
const HOST = env.HOST || '0.0.0.0';
const RATE = Number(env.RATE_LIMIT_PER_MIN) || 10;
const MAX_PROMPT = 4000;
const MAX_BODY = 16384;
const MAX_INFLIGHT = 20;

const INDEX_FILE = fs.existsSync(path.join(__dirname, 'index.html'))
  ? 'index.html'
  : 'NEXORA.html';

const FILES = {
  '/': INDEX_FILE,
  '/index.html': INDEX_FILE,
  '/NEXORA.html': INDEX_FILE,
  '/manifest.json': 'manifest.json',
  '/sw.js': 'sw.js',
  '/icon.svg': 'icon.svg'
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const idx = fs.readFileSync(path.join(__dirname, INDEX_FILE), 'utf8');
const cspMatch = idx.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
const SEC = {
  'Content-Security-Policy': (cspMatch ? cspMatch[1] : "default-src 'self'") + "; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

const base = (key, fallback) => (env[key] || fallback).replace(/\/+$/, '');

const PROV = {
  gemini: {
    label: 'Google Gemini',
    key: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || 'gemini-2.5-flash',
    build: (prompt, model) => ({
      url: base('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com')
        + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
      headers: { 'x-goog-api-key': PROV.gemini.key },
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1000 }
      }
    }),
    parse: data => {
      const parts = data?.candidates?.[0]?.content?.parts;
      return Array.isArray(parts)
        ? parts.filter(p => typeof p.text === 'string').map(p => p.text).join('\n')
        : '';
    }
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    key: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    url: base('ANTHROPIC_BASE_URL', 'https://api.anthropic.com') + '/v1/messages',
    build: (prompt, model) => ({
      headers: {
        'x-api-key': PROV.anthropic.key,
        'anthropic-version': '2023-06-01'
      },
      body: { model, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }
    }),
    parse: data => Array.isArray(data.content)
      ? data.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
      : ''
  },
  openai: {
    label: 'OpenAI',
    key: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || 'gpt-4o-mini',
    url: base('OPENAI_BASE_URL', 'https://api.openai.com') + '/v1/chat/completions',
    build: (prompt, model) => ({
      headers: { Authorization: 'Bearer ' + PROV.openai.key },
      body: {
        model,
        max_completion_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      }
    }),
    parse: data => data?.choices?.[0]?.message?.content || ''
  }
};

const hits = new Map();
let inflight = 0;

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= RATE) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, values] of hits) {
    if (!values.some(t => now - t < 60000)) hits.delete(key);
  }
}, 60000).unref();

function send(res, status, object, extra = {}) {
  const body = JSON.stringify(object);
  res.writeHead(status, {
    ...SEC,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extra
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function ask(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = env.ALLOWED_ORIGIN
      ? env.ALLOWED_ORIGIN.split(',').map(v => v.trim())
      : ['http://' + req.headers.host, 'https://' + req.headers.host];
    if (!allowed.includes(origin)) return send(res, 403, { error: 'Origin not allowed.' });
  }

  if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
    return send(res, 415, { error: 'Send JSON.' });
  }

  const ip = req.socket.remoteAddress || 'unknown';
  if (limited(ip)) {
    return send(res, 429, { error: 'Too many requests. Try again in a minute.' }, { 'Retry-After': '60' });
  }
  if (inflight >= MAX_INFLIGHT) {
    return send(res, 503, { error: 'Busy. Try again shortly.' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    return send(res, error.code === 413 ? 413 : 400, {
      error: error.code === 413 ? 'Request too large.' : 'Invalid JSON.'
    });
  }

  if (!body || body.consent !== true) {
    return send(res, 400, { error: 'Consent is required to send data to a provider.' });
  }

  const provider = typeof body.provider === 'string' && Object.hasOwn(PROV, body.provider)
    ? PROV[body.provider]
    : null;

  if (!provider || !provider.key) {
    return send(res, 400, { error: 'Unknown or unconfigured provider.' });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_PROMPT) {
    return send(res, 400, { error: 'Prompt must be 1 to ' + MAX_PROMPT + ' characters.' });
  }

  const request = provider.build(prompt, provider.model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  inflight++;

  try {
    const upstream = await fetch(request.url || provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: controller.signal
    });

    if (!upstream.ok) {
      console.error('AI provider returned status', body.provider, upstream.status);
      return send(res, 502, {
        error: 'The provider returned an error (' + upstream.status + '). Check the API key, model, and provider quota.'
      });
    }

    const data = await upstream.json().catch(() => ({}));
    const answer = String(provider.parse(data) || '').slice(0, 20000);
    if (!answer) return send(res, 502, { error: 'Empty answer from the provider.' });

    return send(res, 200, {
      text: answer,
      provider: provider.label,
      model: provider.model
    });
  } catch (_) {
    return send(res, 504, { error: 'The provider did not respond in time.' });
  } finally {
    clearTimeout(timeout);
    inflight--;
  }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/status') {
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
      return send(res, 200, {
        providers: Object.entries(PROV)
          .filter(([, p]) => Boolean(p.key))
          .map(([id, p]) => ({ id, label: p.label, model: p.model })),
        maxPromptChars: MAX_PROMPT
      });
    }

    if (url.pathname === '/api/ask') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
      return await ask(req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SEC);
      return res.end();
    }

    const file = Object.hasOwn(FILES, url.pathname) ? FILES[url.pathname] : null;
    if (!file) {
      res.writeHead(404, { ...SEC, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    const headers = {
      ...SEC,
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': file === 'sw.js' ? 'no-cache' : 'no-store'
    };

    fs.readFile(path.join(__dirname, file), (error, data) => {
      if (error) {
        res.writeHead(500, SEC);
        return res.end('Error');
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  } catch (_) {
    try { send(res, 500, { error: 'Server error.' }); } catch (_) {}
  }
}).listen(PORT, HOST, () => {
  const enabled = Object.entries(PROV).filter(([, p]) => Boolean(p.key)).map(([id]) => id);
  console.log(`NEXORA listening on ${HOST}:${PORT} | providers: ${enabled.join(', ') || 'none (live AI is off)'}`);
});
        
