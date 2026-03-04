const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini';
const AZURE_REALTIME_DEPLOYMENT = process.env.AZURE_REALTIME_DEPLOYMENT || 'gpt-realtime-mini';
const AZURE_REALTIME_ENDPOINT = process.env.AZURE_REALTIME_ENDPOINT || AZURE_OPENAI_ENDPOINT;
const AZURE_REALTIME_KEY = process.env.AZURE_REALTIME_KEY || AZURE_OPENAI_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'startups-coffee-secret-2026';

// ── DB ──────────────────────────────────────────────────────────────────────
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
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      type TEXT NOT NULL CHECK (type IN ('referido', 'perk')),
      category TEXT NOT NULL,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      code TEXT NOT NULL,
      url TEXT,
      discount TEXT,
      approved BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE codes ADD COLUMN IF NOT EXISTS company_image TEXT`);
  await db.query(`ALTER TABLE codes ADD COLUMN IF NOT EXISTS guest_name TEXT`);
  await db.query(`ALTER TABLE codes ADD COLUMN IF NOT EXISTS guest_email TEXT`);
  // Seed admin from env var
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    await db.query(`UPDATE users SET is_admin = true WHERE email = lower($1)`, [adminEmail]);
  }
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
  // Seed some sample approved codes for demo
  const { rows } = await db.query('SELECT COUNT(*) FROM codes');
  if (parseInt(rows[0].count) === 0) {
    // Insert demo user
    const hash = await bcrypt.hash('demo1234', 10);
    const userRes = await db.query(
      "INSERT INTO users (email, password_hash, name) VALUES ('demo@startups.coffee', $1, 'Demo User') ON CONFLICT DO NOTHING RETURNING id",
      [hash]
    );
    if (userRes.rows.length > 0) {
      const uid = userRes.rows[0].id;
      const demoData = [
        ['referido', 'ia-automatizacion', 'Make', 'Make.com — 1 mes gratis Pro', 'Automatiza flujos entre apps sin código', 'STARTUPS-MAKE24', 'https://make.com', '1 mes Pro gratis'],
        ['referido', 'cloud-infra', 'Hetzner', 'Hetzner — €20 de crédito', 'VPS europeo de alto rendimiento y bajo costo', 'HET-20EUR', 'https://hetzner.com', '€20 crédito'],
        ['referido', 'diseno', 'Canva', 'Canva Pro — 45 días gratis', 'Diseño profesional para tu marca', 'CANVA-PRO45', 'https://canva.com', '45 días Pro'],
        ['referido', 'desarrollo-nocode', 'Bubble', 'Bubble — 25% off primer mes', 'Construye apps sin código', 'BUBBLE25', 'https://bubble.io', '25% descuento'],
        ['referido', 'finanzas', 'Brex', 'Brex — $250 de crédito', 'Tarjeta corporativa para startups', 'BREX250', 'https://brex.com', '$250 crédito'],
        ['perk', 'ia-automatizacion', 'OpenAI', 'OpenAI API — $150 crédito para startups', 'Acceso a GPT-4 y más para tu producto', 'OPENAI-STARTUP', 'https://openai.com/startup', '$150 crédito API'],
        ['perk', 'cloud-infra', 'AWS', 'AWS Activate — hasta $100k créditos', 'Créditos en la nube para startups elegibles', 'AWS-ACTIVATE', 'https://aws.amazon.com/activate', 'Hasta $100k'],
        ['perk', 'rrhh', 'Notion', 'Notion for Startups — 6 meses gratis', 'Wiki + proyectos + docs en un solo lugar', 'NOTION-STARTUP6', 'https://notion.so/startups', '6 meses Plus gratis'],
        ['perk', 'marketing', 'HubSpot', 'HubSpot para Startups — 90% off', 'CRM + marketing + ventas todo en uno', 'HUBSPOT-STARTUP', 'https://hubspot.com/startups', '90% primer año'],
        ['referido', 'imagen-video', 'Descript', 'Descript — 1 mes Creator gratis', 'Edición de video y podcast con IA', 'DESC-CREATOR1', 'https://descript.com', '1 mes Creator'],
      ];
      for (const [type, cat, company, title, desc, code, url, discount] of demoData) {
        await db.query(
          'INSERT INTO codes (user_id, type, category, company, title, description, code, url, discount, approved) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)',
          [uid, type, cat, company, title, desc, code, url, discount]
        );
      }
    }
  }
  console.log('DB ready');
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try { req.user = jwt.verify(header.split(' ')[1], JWT_SECRET); } catch {}
  }
  next();
}

// ── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email.toLowerCase(), hash, name]
    );
    // Asociar códigos subidos como invitado con el mismo email
    await db.query(
      `UPDATE codes SET user_id = $1 WHERE guest_email = $2 AND user_id IS NULL`,
      [rows[0].id, email.toLowerCase()]
    );
    const token = jwt.sign({ id: rows[0].id, email: rows[0].email, name: rows[0].name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email ya registrado' });
    res.status(500).json({ error: 'Error al registrar' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const u = { id: rows[0].id, email: rows[0].email, name: rows[0].name, is_admin: rows[0].is_admin || false };
    const token = jwt.sign(u, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: u });
  } catch {
    res.status(500).json({ error: 'Error al autenticar' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json({ user: req.user }));

function adminOnly(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Acceso denegado' });
  next();
}

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/pending', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, u.name as author, u.email as author_email
       FROM codes c JOIN users u ON c.user_id = u.id
       WHERE c.approved = false ORDER BY c.created_at ASC`
    );
    res.json(rows);
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/admin/codes/:id/approve', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.query('UPDATE codes SET approved = true WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/admin/codes/:id/reject', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM codes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/all-codes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, u.name as author FROM codes c JOIN users u ON c.user_id = u.id ORDER BY c.approved, c.created_at DESC`
    );
    res.json(rows);
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/admin/codes/:id', authMiddleware, adminOnly, async (req, res) => {
  const { company, title, description, code, url, discount, company_image, type, category } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE codes SET
        company = COALESCE($1, company),
        title = COALESCE($2, title),
        description = COALESCE($3, description),
        code = COALESCE($4, code),
        url = COALESCE($5, url),
        discount = COALESCE($6, discount),
        company_image = $7,
        type = COALESCE($8, type),
        category = COALESCE($9, category)
       WHERE id = $10 RETURNING *`,
      [company, title, description, code, url, discount, company_image || null, type, category, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch { res.status(500).json({ error: 'Error al actualizar' }); }
});

// ── Codes ────────────────────────────────────────────────────────────────────
app.get('/api/codes', async (req, res) => {
  const { type, category, search } = req.query;
  let q = 'SELECT c.*, u.name as author FROM codes c JOIN users u ON c.user_id = u.id WHERE c.approved = true';
  const params = [];
  if (type) { params.push(type); q += ` AND c.type = $${params.length}`; }
  if (category && category !== 'all') { params.push(category); q += ` AND c.category = $${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    q += ` AND (c.company ILIKE $${params.length} OR c.title ILIKE $${params.length} OR c.description ILIKE $${params.length})`;
  }
  q += ' ORDER BY c.created_at DESC';
  try {
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener códigos' });
  }
});

app.post('/api/codes', optionalAuth, async (req, res) => {
  const { type, category, company, title, description, code, url, discount, company_image, guest_name, guest_email } = req.body;
  if (!type || !category || !company || !title || !code) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  let userId = null, guestNameVal = null, guestEmailVal = null;
  if (req.user) {
    userId = req.user.id;
  } else {
    if (!guest_name || !guest_email) {
      return res.status(400).json({ error: 'Nombre y email requeridos para envíos sin cuenta' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest_email.trim())) {
      return res.status(400).json({ error: 'Email no válido' });
    }
    guestNameVal = guest_name.trim();
    guestEmailVal = guest_email.trim().toLowerCase();
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO codes (user_id, type, category, company, title, description, code, url, discount, company_image, guest_name, guest_email, approved)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false) RETURNING *`,
      [userId, type, category, company, title, description, code, url, discount, company_image || null, guestNameVal, guestEmailVal]
    );
    res.status(201).json({ ...rows[0], message: 'Código enviado, pendiente de aprobación' });
  } catch {
    res.status(500).json({ error: 'Error al guardar código' });
  }
});

// ── Chat ─────────────────────────────────────────────────────────────────────
const SYSTEM_MESSAGE = {
  role: 'system',
  content: `Eres el asistente de startups.coffee, un portal de códigos de referido y descuentos para emprendedores y startups.
Ayudas a los usuarios a encontrar herramientas, recursos y descuentos útiles para sus proyectos.
Eres amigable, conciso y útil. Puedes hablar sobre herramientas SaaS, recursos para startups,
estrategias de emprendimiento y todo lo relacionado con el ecosistema startup.
Responde siempre en el mismo idioma que el usuario.`
};

function streamOpenAI(messages, onChunk, onDone, onError) {
  const endpoint = new URL(
    `openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-02-01`,
    AZURE_OPENAI_ENDPOINT
  );
  const payload = JSON.stringify({
    messages, max_tokens: 800, temperature: 0.7, stream: true,
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
    let buffer = '', usage = {}, done = false;
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

app.post('/api/chat', (req, res) => {
  const { messages, sessionId } = req.body;
  const userMsg = messages?.[messages.length - 1]?.content || '';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  let fullReply = '';
  streamOpenAI(
    [SYSTEM_MESSAGE, ...messages],
    token => { fullReply += token; res.write(`data: ${JSON.stringify({ token })}\n\n`); },
    usage => {
      res.write('data: [DONE]\n\n');
      res.end();
      db.query(
        `INSERT INTO chat_logs (session_id, user_message, assistant_message, input_tokens, output_tokens, total_tokens)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sessionId || 'anonymous', userMsg, fullReply, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0]
      ).catch(err => console.error('DB log error:', err.message));
    },
    err => { console.error('Stream error:', err); res.end(); }
  );
});

const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' };

// ── Admin page ────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── WebSocket Realtime Relay ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/realtime') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  } else {
    socket.destroy();
  }
});

const REALTIME_SYSTEM = `Eres el asistente de startups.coffee, un portal de códigos de referido y descuentos para emprendedores y startups.
Ayudas a los usuarios a encontrar herramientas, recursos y descuentos útiles para sus proyectos.
Eres amigable, conciso y útil. Responde siempre en español.`;

// ── Debug endpoint ────────────────────────────────────────────────────────────
app.get('/api/debug/realtime', (req, res) => {
  const azureHost = new URL(AZURE_REALTIME_ENDPOINT).hostname;
  const azureUrl = `wss://${azureHost}/openai/realtime?api-version=2024-10-01-preview&deployment=${AZURE_REALTIME_DEPLOYMENT}`;
  res.json({ azureUrl, deployment: AZURE_REALTIME_DEPLOYMENT, endpoint: AZURE_REALTIME_ENDPOINT });
});

wss.on('connection', (clientWs) => {
  const azureHost = new URL(AZURE_REALTIME_ENDPOINT).hostname;
  const azureUrl = `wss://${azureHost}/openai/realtime?api-version=2024-10-01-preview&deployment=${AZURE_REALTIME_DEPLOYMENT}`;
  console.log('[Realtime] Connecting to:', azureUrl);

  const azureWs = new WebSocket(azureUrl, { headers: { 'api-key': AZURE_REALTIME_KEY } });

  azureWs.on('open', () => {
    azureWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: REALTIME_SYSTEM,
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad', silence_duration_ms: 600, threshold: 0.6 }
      }
    }));
    // No enviamos 'ready' aquí — esperamos a session.updated de Azure
  });

  azureWs.on('message', data => {
    const str = data.toString();
    // Notificar al cliente que está listo solo cuando Azure confirme la sesión
    try {
      const msg = JSON.parse(str);
      if (msg.type === 'session.updated' && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'ready' }));
      }
    } catch (_) {}
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(str);
  });

  clientWs.on('message', data => {
    if (azureWs.readyState === WebSocket.OPEN) azureWs.send(data.toString());
  });

  clientWs.on('close', () => { if (azureWs.readyState !== WebSocket.CLOSED) azureWs.close(); });
  azureWs.on('close', () => { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(); });
  azureWs.on('error', err => {
    console.error('[Realtime] Azure WS error:', err.message, err.code, err.statusCode);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
      clientWs.close();
    }
  });
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
  initDB().catch(err => console.error('DB init failed (non-fatal):', err.message));
});
