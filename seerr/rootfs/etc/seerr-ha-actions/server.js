#!/usr/bin/env node

const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 8099;
const SEERR_BASE_URL = process.env.SEERR_BASE_URL || 'http://127.0.0.1:5055';
const SETTINGS_PATH = process.env.CONFIG_DIRECTORY
  ? path.join(process.env.CONFIG_DIRECTORY, 'settings.json')
  : '/config/settings.json';

function readEnvBoolean(name) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env[name] || '').toLowerCase()
  );
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function getActionToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  const customHeader = req.headers['x-seerr-action-token'];
  return typeof customHeader === 'string' ? customHeader.trim() : '';
}

async function parseJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

async function getSeerrApiKey() {
  const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
  const settings = JSON.parse(raw);
  const apiKey = settings?.main?.apiKey;

  if (!apiKey) {
    throw new Error(`Unable to find Seerr API key in ${SETTINGS_PATH}`);
  }

  return apiKey;
}

async function callSeerr(endpoint, options = {}) {
  const apiKey = await getSeerrApiKey();
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    ...options.headers,
  };

  const response = await fetch(`${SEERR_BASE_URL}${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      (data && (data.message || data.error)) ||
      `Seerr returned HTTP ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function normalizeSearchResults(results, mediaType) {
  const items = Array.isArray(results?.results) ? results.results : [];

  return items
    .filter((item) => mediaType === 'all' || item.mediaType === mediaType)
    .map((item) => ({
      id: item.id,
      mediaType: item.mediaType,
      title: item.title || item.name,
      originalTitle: item.originalTitle || item.originalName || null,
      releaseDate: item.releaseDate || item.firstAirDate || null,
      overview: item.overview || '',
      posterPath: item.posterPath || null,
      backdropPath: item.backdropPath || null,
      mediaInfo: item.mediaInfo || null,
    }));
}

async function handleSearch(req, res, url) {
  const query = (url.searchParams.get('query') || '').trim();
  const mediaType = url.searchParams.get('mediaType') || 'all';
  const language = url.searchParams.get('language') || '';
  const page = url.searchParams.get('page') || '1';

  if (!query) {
    return sendJson(res, 400, { error: 'Missing query parameter.' });
  }

  if (!['all', 'movie', 'tv'].includes(mediaType)) {
    return sendJson(res, 400, { error: 'mediaType must be one of: all, movie, tv.' });
  }

  const seerrUrl = new URL('/api/v1/search', SEERR_BASE_URL);
  seerrUrl.searchParams.set('query', query);
  seerrUrl.searchParams.set('page', page);
  if (language) {
    seerrUrl.searchParams.set('language', language);
  }

  const rawResults = await callSeerr(
    `${seerrUrl.pathname}${seerrUrl.search}`
  );

  return sendJson(res, 200, {
    query,
    mediaType,
    results: normalizeSearchResults(rawResults, mediaType),
  });
}

async function handleRequest(req, res) {
  const body = await parseJsonBody(req);
  const userId =
    body.userId ?? Number(process.env.HA_ACTIONS_USER_ID || '1');

  if (!body.mediaType || !['movie', 'tv'].includes(body.mediaType)) {
    return sendJson(res, 400, {
      error: 'mediaType is required and must be movie or tv.',
    });
  }

  if (!Number.isInteger(body.mediaId)) {
    return sendJson(res, 400, {
      error: 'mediaId is required and must be an integer.',
    });
  }

  const requestBody = {
    mediaType: body.mediaType,
    mediaId: body.mediaId,
    tvdbId: body.tvdbId,
    seasons: body.seasons,
    is4k: body.is4k,
    serverId: body.serverId,
    profileId: body.profileId,
    rootFolder: body.rootFolder,
    languageProfileId: body.languageProfileId,
    userId,
    ignoreQuota: body.ignoreQuota,
  };

  const created = await callSeerr('/api/v1/request', {
    method: 'POST',
    headers: { 'X-Api-User': String(userId) },
    body: requestBody,
  });

  return sendJson(res, 201, created);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!readEnvBoolean('HA_ACTIONS_ENABLED')) {
      return sendJson(res, 503, { error: 'Home Assistant actions are disabled.' });
    }

    const expectedToken = String(process.env.HA_ACTIONS_TOKEN || '').trim();
    if (!expectedToken) {
      return sendJson(res, 503, {
        error: 'Home Assistant actions token is not configured.',
      });
    }

    const providedToken = getActionToken(req);
    if (providedToken !== expectedToken) {
      return sendJson(res, 401, { error: 'Unauthorized.' });
    }

    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/search') {
      return handleSearch(req, res, url);
    }

    if (req.method === 'POST' && url.pathname === '/request') {
      return handleRequest(req, res);
    }

    return sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    return sendJson(res, error.statusCode || 500, {
      error: error.message || 'Unexpected error.',
      details: error.details || null,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Seerr HA actions listening on http://${HOST}:${PORT}`);
});
