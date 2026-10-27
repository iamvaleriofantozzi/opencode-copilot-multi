/**
 * opencode-copilot-multi-proxy
 * 
 * HTTP proxy che traduce richieste OpenAI (da OpenCode via @ai-sdk/openai-compatible)
 * in richieste API GitHub Copilot, roteando sull'account corretto.
 * 
 * Flusso:
 *   OpenCode → @ai-sdk/openai-compatible → questo proxy → api.githubcopilot.com
 */

import fs from 'fs';
import path from 'path';
import http from 'http';

const PORT = process.env.PROXY_PORT || 3001;
const COPILOT_API_URL = process.env.COPILOT_API_URL || 'https://api.githubcopilot.com';
const CLIENT_ID = process.env.COPILOT_MULTI_CLIENT_ID || '';
const ACCOUNTS_FILE = process.env.ACCOUNTS_POOL_PATH || '/Users/valeriofantozzi/.local/share/opencode/copilot-multi-accounts.json';

// Carica accounts dallo stesso pool usato dal plugin opencode-copilot-multi
let accounts = [];
function loadAccounts() {
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    accounts = data.accounts || [];
    console.log(`[proxy] Loaded ${accounts.length} account(s): ${accounts.map(a => a.username).join(', ') || 'none'}`);
  } catch (e) {
    console.error('[proxy] Failed to load accounts pool:', e.message);
    accounts = [];
  }
}

function findAccount(username) {
  return accounts.find(a => a.username === username);
}

// Token refresh via GitHub OAuth
async function refreshToken(account) {
  if (!CLIENT_ID) {
    console.warn('[proxy] COPILOT_MULTI_CLIENT_ID not set, cannot refresh');
    return false;
  }
  try {
    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: account.auth.refresh,
      }),
    });
    if (!resp.ok) {
      console.error(`[proxy] Refresh failed for ${account.username}: ${resp.status}`);
      return false;
    }
    const data = await resp.json();
    if (data.error || !data.access_token) {
      console.error(`[proxy] Refresh error for ${account.username}:`, data.error || 'no token');
      return false;
    }
    account.auth.access = data.access_token;
    if (data.refresh_token) account.auth.refresh = data.refresh_token;
    account.auth.expires = Date.now() + (data.expires_in || 28800) * 1000;
    console.log(`[proxy] Token refreshed for ${account.username}`);
    return true;
  } catch (e) {
    console.error(`[proxy] Refresh exception for ${account.username}:`, e.message);
    return false;
  }
}

function tokenNeedsRefresh(account) {
  if (!account.auth || account.auth.expires === 0) return false;
  return Date.now() > account.auth.expires - 5 * 60 * 1000;
}

// Header richiesti da GitHub Copilot
const COPILOT_HEADERS = {
  'Editor-Version': 'vscode/1.95.0',
  'Editor-Plugin-Version': 'copilot/1.250.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'Openai-Intent': 'conversation-panel',
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'opencode-copilot-multi-proxy/1.0',
};

// Leggi body richiesta
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Traduce body OpenAI → formato Copilot
function translateBody(body) {
  if (!body || typeof body !== 'object') return body;
  
  const out = { ...body };
  
  // Rimuovi campi che Copilot potrebbe non gestire
  const removeKeys = ['user', 'n'];
  for (const k of removeKeys) {
    if (k in out) delete out[k];
  }
  
  return out;
}

function isHealthPath(urlPath) {
  return urlPath === '/health' || urlPath === '/';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (isHealthPath(pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  // GET /proxy/{username}/models - lista modelli disponibili per l'account
  if (req.method === 'GET' && pathname.match(/^\/proxy\/([^\/]+)\/models$/)) {
    const m = pathname.match(/^\/proxy\/([^\/]+)\/models$/);
    const username = m[1];
    const account = findAccount(username);
    if (!account) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Account not found: ${username}` }));
      return;
    }
    if (tokenNeedsRefresh(account)) {
      await refreshToken(account);
    }
    const headers = { 'Authorization': `Bearer ${account.auth.access}`, 'Accept': 'application/json' };
    try {
      const modelsResp = await fetch(`${COPILOT_API_URL}/models`, { headers, redirect: 'manual' });
      const modelsBody = await modelsResp.text();
      let modelsJson;
      try {
        modelsJson = JSON.parse(modelsBody);
      } catch (e) {
        res.writeHead(modelsResp.status, { 'Content-Type': 'application/json' });
        res.end(modelsBody);
        return;
      }
      // Filtra solo modelli che supportano /chat/completions (quelli usabili dal proxy)
      // Se supported_endpoints è assente, includi per default (molti provider OpenAI non lo dichiarano)
      if (modelsJson.data && Array.isArray(modelsJson.data)) {
        modelsJson.data = modelsJson.data.filter(m => {
          const eps = m.supported_endpoints || [];
          if (eps.length === 0) return true;
          return eps.includes('/chat/completions');
        });
      }
      res.writeHead(modelsResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(modelsJson));
      return;
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy error\n');
      return;
    }
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed\n');
    return;
  }

  const match = pathname.match(/^\/proxy\/([^\/]+)\/(.*)$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Use /proxy/{username}/{path}\n');
    return;
  }

  const username = match[1];
  const copilotPath = match[2];

  const account = findAccount(username);
  if (!account) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Account not found: ${username}` }));
    return;
  }

  if (tokenNeedsRefresh(account)) {
    console.log(`[proxy] Token expiring for ${username}, refreshing...`);
    await refreshToken(account);
  }

  let bodyBuffer;
  try {
    bodyBuffer = await readBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request body\n');
    return;
  }

  let bodyObj;
  try {
    bodyObj = bodyBuffer.length ? JSON.parse(bodyBuffer.toString()) : {};
  } catch (e) {
    bodyObj = {};
  }

  const translatedBody = translateBody(bodyObj);
  const bodyString = JSON.stringify(translatedBody);

  const headers = {};
  for (const [k, v] of Object.entries(COPILOT_HEADERS)) {
    headers[k] = v;
  }
  headers['Authorization'] = `Bearer ${account.auth.access}`;

  const passthrough = ['x-request-id', 'traceparent'];
  for (const k of passthrough) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }

  const targetUrl = `${COPILOT_API_URL}/${copilotPath}${url.search}`;

  console.log(`[proxy] ${req.method} ${username} -> ${copilotPath} model=${bodyObj.model || '(none)'}`);

  async function forward(headersToSend) {
    return fetch(targetUrl, {
      method: req.method,
      headers: headersToSend,
      body: bodyString,
      redirect: 'manual',
    });
  }

  try {
    let copilotResp = await forward(headers);

    if (copilotResp.status === 401) {
      console.log(`[proxy] 401 for ${username}, refreshing token...`);
      const refreshed = await refreshToken(account);
      if (refreshed) {
        headers['Authorization'] = `Bearer ${account.auth.access}`;
        copilotResp = await forward(headers);
      }
    }

    // Leggi il body della risposta una sola volta per evitare "Body is unusable"
    let respBody;
    try {
      const arr = await copilotResp.arrayBuffer();
      respBody = Buffer.from(arr);
    } catch {}

    if (copilotResp.status === 400 && respBody) {
      console.error(`[proxy] 400 for ${username}: ${respBody.toString().substring(0, 500)}`);
    }

    const respHeaders = {};
    copilotResp.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    delete respHeaders['transfer-encoding'];
    delete respHeaders['connection'];

    res.writeHead(copilotResp.status, respHeaders);
    if (respBody) {
      res.end(respBody);
    } else {
      res.end();
    }
  } catch (e) {
    console.error(`[proxy] Forward error for ${username}:`, e.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy error\n');
  }
});

loadAccounts();
setInterval(loadAccounts, 60000);

server.listen(PORT, () => {
  console.log(`[proxy] Listening on http://localhost:${PORT}`);
  console.log(`[proxy] Accounts: ${accounts.map(a => a.username).join(', ') || 'none'}`);
});
