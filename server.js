const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8080;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini';

const SYSTEM_MESSAGE = {
  role: 'system',
  content: `Eres el asistente de startups.coffee, un portal de códigos de referido y descuentos para emprendedores y startups.
Ayudas a los usuarios a encontrar herramientas, recursos y descuentos útiles para sus proyectos.
Eres amigable, conciso y útil. Puedes hablar sobre herramientas SaaS, recursos para startups,
estrategias de emprendimiento y todo lo relacionado con el ecosistema startup.
Responde siempre en el mismo idioma que el usuario.`
};

// DB
const db = new Pool({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'postgres',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB ready');
}

async function saveLog(sessionId, userMsg, assistantMsg, usage) {
  try {
    await db.query(
      `INSERT INTO chat_logs (session_id, user_message, assistant_message, input_tokens, output_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, userMsg, assistantMsg, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0]
    );
  } catch (err) {
    console.error('DB log error:', err.message);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function streamOpenAI(messages, onChunk, onDone, onError) {
  const endpoint = new URL(
    `openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-02-01`,
    AZURE_OPENAI_ENDPOINT
  );
  const payload = JSON.stringify({
    messages,
    max_tokens: 800,
    temperature: 0.7,
    stream: true,
    stream_options: { include_usage: true }
  });

  const options = {
    hostname: endpoint.hostname,
    path: endpoint.pathname + endpoint.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': AZURE_OPENAI_KEY,
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, res => {
    let buffer = '';
    let usage = {};
    let done = false;
    res.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { if (!done) { done = true; onDone(usage); } return; }
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) usage = parsed.usage;
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) onChunk(token);
        } catch (_) {}
      }
    });
    res.on('end', () => { if (!done) { done = true; onDone(usage); } });
  });

  req.on('error', onError);
  req.write(payload);
  req.end();
}

http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  if (parsed.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { messages, sessionId } = JSON.parse(body);
      const userMsg = messages[messages.length - 1]?.content || '';

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      let fullReply = '';

      streamOpenAI(
        [SYSTEM_MESSAGE, ...messages],
        token => {
          fullReply += token;
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        },
        usage => {
          res.write('data: [DONE]\n\n');
          res.end();
          saveLog(sessionId || 'anonymous', userMsg, fullReply, usage);
        },
        err => { console.error('Stream error:', err); res.end(); }
      );
    } catch (err) {
      console.error('Chat error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Error interno' }));
    }
    return;
  }

  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); res.end('Error'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
  initDB().catch(err => console.error('DB init failed (non-fatal):', err.message));
});
