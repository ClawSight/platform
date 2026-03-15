const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const argon2 = require('argon2');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Clean URL fallbacks (so /dashboard works without .html)
const frontendDir = path.join(__dirname, '../frontend');
app.get('/dashboard', (req, res) => res.sendFile(path.join(frontendDir, 'dashboard.html')));
app.get('/share', (req, res) => res.sendFile(path.join(frontendDir, 'share.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(frontendDir, 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(frontendDir, 'privacy.html')));

// --- CONFIG ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kfibmwbwdcejrsuahbps.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LEGACY_API_KEY = process.env.CLAWSIGHT_API_KEY || process.env.AGENTWATCH_API_KEY || null;

// Supabase Admin Client (Server Side Only)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['https://app.clawsight.org'];

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] }
});

// --- IN-MEMORY CACHE (write-through to DB) ---
let activeAgents = {};

// Track which socket owns which agent (for disconnect cleanup)
const socketAgentMap = new Map(); // socketId -> Set<agentId>

// Budget rules cache: tenantId -> [{ agent_id, max_cost, action }]
const budgetCache = new Map();

// --- INPUT VALIDATION ---
const MAX_AGENT_NAME_LEN = 200;
const MAX_AGENT_ID_LEN = 100;
const MAX_LOG_MESSAGE_LEN = 2000;
const MAX_AGENTS_PER_TENANT = 50;
const MAX_LOGS_PER_AGENT = 50;

function sanitizeString(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLen);
}

function isValidNumber(val) {
  return typeof val === 'number' && isFinite(val) && val >= 0 && val <= 1e9;
}

function isValidUrl(str) {
  try { const u = new URL(str); return u.protocol === 'https:' || u.protocol === 'http:'; }
  catch { return false; }
}

// --- RATE LIMITING ---
const rateLimitMap = new Map(); // socketId -> { count, resetTime }
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 30;

function checkRateLimit(socketId) {
  const now = Date.now();
  let entry = rateLimitMap.get(socketId);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(socketId, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX_EVENTS;
}

function buildDemoAgent(tenantId) {
  const now = Date.now();
  return {
    id: `demo-${tenantId.slice(0, 8)}`,
    name: 'Demo Revenue Bot',
    tenantId,
    lastHeartbeat: now,
    status: 'working',
    demo: true,
    logs: [
      { timestamp: now - 120000, message: 'Booting up demo agent…' },
      { timestamp: now - 90000, message: 'Monitoring OpenAI spend (45¢)' },
      { timestamp: now - 60000, message: 'Detected loop, auto-paused sequence.' },
      { timestamp: now - 30000, message: 'Restarted after human approval.' },
      { timestamp: now - 5000, message: 'Streaming new trades…' }
    ],
    metrics: {
      cost: 0.2311,
      revenue: 3.45,
      tokens: 1820,
      profitRun: '+$3.22 today'
    }
  };
}

if (!SUPABASE_SERVICE_KEY) {
  console.warn("⚠️  SUPABASE_SERVICE_ROLE_KEY is not set — key provisioning and tenant management will fail.");
  console.warn("   Set it in your environment: https://supabase.com/dashboard → Settings → API → service_role key");
}

console.log("🔒 ClawSight Server Starting...");

// --- HELPERS ---

async function getOrCreateTenant(userId) {
  const { data: existing } = await supabase
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', userId)
    .single();

  if (existing) return existing.tenant_id;

  const tenantId = uuidv4();
  const { error: tenantError } = await supabase
    .from('tenants')
    .insert({ id: tenantId, name: `Tenant for ${userId.slice(0, 8)}` });

  if (tenantError) {
    console.error('Failed to create tenant:', tenantError.message);
    return null;
  }

  const { error: linkError } = await supabase
    .from('user_tenants')
    .insert({ user_id: userId, tenant_id: tenantId });

  if (linkError) {
    console.error('Failed to link user to tenant:', linkError.message);
    return null;
  }

  console.log(`🆕 New tenant created: ${tenantId} for user ${userId}`);
  return tenantId;
}

// --- DB PERSISTENCE LAYER ---

async function dbUpsertAgent(agent) {
  const { error } = await supabase.from('agents').upsert({
    id: agent.id,
    tenant_id: agent.tenantId,
    name: agent.name,
    status: agent.status,
    parent_agent_id: agent.parentAgentId || null,
    last_heartbeat: agent.lastHeartbeat
  }, { onConflict: 'id,tenant_id' });
  if (error) console.error('dbUpsertAgent:', error.message);
}

async function dbUpsertMetrics(agent) {
  const m = agent.metrics || { cost: 0, revenue: 0, tokens: 0 };
  const { error } = await supabase.from('agent_metrics').upsert({
    agent_id: agent.id,
    tenant_id: agent.tenantId,
    cost: m.cost,
    revenue: m.revenue,
    tokens: m.tokens,
    updated_at: new Date().toISOString()
  }, { onConflict: 'agent_id,tenant_id' });
  if (error) console.error('dbUpsertMetrics:', error.message);
}

async function dbInsertLog(agent, message) {
  const { error } = await supabase.from('agent_logs').insert({
    agent_id: agent.id,
    tenant_id: agent.tenantId,
    message
  });
  if (error) console.error('dbInsertLog:', error.message);
}

async function dbUpdateAgentStatus(agentId, tenantId, status) {
  const { error } = await supabase.from('agents')
    .update({ status, last_heartbeat: Date.now() })
    .eq('id', agentId)
    .eq('tenant_id', tenantId);
  if (error) console.error('dbUpdateAgentStatus:', error.message);
}

async function dbLoadTenantAgents(tenantId) {
  const { data: agents, error } = await supabase
    .from('agents')
    .select('id, name, status, parent_agent_id, last_heartbeat, created_at')
    .eq('tenant_id', tenantId);
  if (error) { console.error('dbLoadTenantAgents:', error.message); return []; }

  const result = [];
  for (const a of (agents || [])) {
    const { data: metrics } = await supabase
      .from('agent_metrics')
      .select('cost, revenue, tokens')
      .eq('agent_id', a.id)
      .eq('tenant_id', tenantId)
      .single();

    const { data: logs } = await supabase
      .from('agent_logs')
      .select('message, created_at')
      .eq('agent_id', a.id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(MAX_LOGS_PER_AGENT);

    result.push({
      id: a.id,
      name: a.name,
      tenantId,
      status: a.status,
      parentAgentId: a.parent_agent_id,
      lastHeartbeat: a.last_heartbeat,
      logs: (logs || []).reverse().map(l => ({
        timestamp: new Date(l.created_at).getTime(),
        message: l.message
      })),
      metrics: {
        cost: metrics?.cost || 0,
        revenue: metrics?.revenue || 0,
        tokens: metrics?.tokens || 0
      }
    });
  }
  return result;
}

// --- BUDGET ENFORCEMENT ---

async function loadBudgetRules(tenantId) {
  const { data, error } = await supabase
    .from('budget_rules')
    .select('agent_id, max_cost, action, enabled')
    .eq('tenant_id', tenantId)
    .eq('enabled', true);
  if (error) { console.error('loadBudgetRules:', error.message); return; }
  budgetCache.set(tenantId, data || []);
}

function getBudgetRule(tenantId, agentId) {
  const rules = budgetCache.get(tenantId);
  if (!rules) return null;
  // Agent-specific rule takes precedence, fall back to tenant-wide (agent_id = null)
  return rules.find(r => r.agent_id === agentId) || rules.find(r => r.agent_id === null) || null;
}

async function checkBudget(agent) {
  const rule = getBudgetRule(agent.tenantId, agent.id);
  if (!rule) return false;
  if (agent.metrics.cost < rule.max_cost) return false;

  // Budget exceeded
  console.log(`💰 Budget exceeded: agent ${agent.id} cost $${agent.metrics.cost.toFixed(4)} >= limit $${rule.max_cost.toFixed(2)}`);

  if (rule.action === 'kill' || rule.action === 'pause') {
    agent.status = 'killed';
    const killReason = `Budget ceiling exceeded ($${agent.metrics.cost.toFixed(4)} >= $${rule.max_cost.toFixed(2)})`;
    agent.logs.push({ timestamp: Date.now(), message: `⛔ AUTO-KILL: ${killReason}` });
    if (agent.logs.length > MAX_LOGS_PER_AGENT) agent.logs.shift();

    // Emit kill signal to the agent process
    io.to(`tenant:${agent.tenantId}`).emit('kill-signal', agent.id);

    // Update dashboard
    io.to(`tenant:${agent.tenantId}`).emit('agent-update', agent);
    io.to(`tenant:${agent.tenantId}`).emit('budget-exceeded', {
      agentId: agent.id,
      agentName: agent.name,
      cost: agent.metrics.cost,
      limit: rule.max_cost,
      action: rule.action
    });

    // Persist
    await dbUpdateAgentStatus(agent.id, agent.tenantId, 'killed');
    await dbInsertLog(agent, `⛔ AUTO-KILL: ${killReason}`);

    // Cascade kill children
    const children = Object.values(activeAgents).filter(
      a => a.parentAgentId === agent.id && a.tenantId === agent.tenantId
    );
    for (const child of children) {
      child.status = 'killed';
      child.logs.push({ timestamp: Date.now(), message: `⛔ Parent agent ${agent.id} budget exceeded — cascade kill` });
      io.to(`tenant:${child.tenantId}`).emit('kill-signal', child.id);
      io.to(`tenant:${child.tenantId}`).emit('agent-update', child);
      await dbUpdateAgentStatus(child.id, child.tenantId, 'killed');
    }
  }

  // Fire webhook
  await fireWebhooks(agent.tenantId, 'budget_exceeded', {
    agentId: agent.id,
    agentName: agent.name,
    cost: agent.metrics.cost,
    limit: rule.max_cost,
    action: rule.action
  });

  return true;
}

// --- WEBHOOK SYSTEM ---

async function fireWebhooks(tenantId, event, payload) {
  const { data: hooks } = await supabase
    .from('webhooks')
    .select('url, events')
    .eq('tenant_id', tenantId)
    .eq('enabled', true);

  if (!hooks || hooks.length === 0) return;

  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    data: payload
  });

  for (const hook of hooks) {
    if (!hook.events.includes(event)) continue;
    // Fire-and-forget with timeout
    fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ClawSight-Webhook/1.0' },
      body,
      signal: AbortSignal.timeout(5000)
    }).catch(err => {
      console.error(`Webhook delivery failed (${hook.url}):`, err.message);
    });
  }
}

// --- REUSABLE API KEY AUTH MIDDLEWARE ---

async function authenticateApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

  const token = authHeader.replace('Bearer ', '');

  // ck_live_ API key
  if (token.startsWith('ck_live_')) {
    const prefix = token.slice(0, 12);
    const { data: candidates, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('key_prefix', prefix);

    if (error) return res.status(500).json({ error: "Database error" });

    if (candidates) {
      for (const keyRecord of candidates) {
        try {
          if (await argon2.verify(keyRecord.key_hash, token)) {
            req.tenantId = keyRecord.tenant_id;
            req.authRole = keyRecord.name === 'Dashboard Session Key' ? 'dashboard' : 'agent';
            return next();
          }
        } catch (e) { /* hash verification failed, try next */ }
      }
    }
    return res.status(401).json({ error: "Invalid API key" });
  }

  // JWT fallback
  if (token.length > 50) {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (user && !error) {
      const { data: userTenant } = await supabase
        .from('user_tenants')
        .select('tenant_id')
        .eq('user_id', user.id)
        .single();
      if (userTenant) {
        req.tenantId = userTenant.tenant_id;
        req.authRole = 'dashboard';
        req.userId = user.id;
        return next();
      }
    }
  }

  return res.status(401).json({ error: "Unauthorized" });
}

// Helper for endpoints that only need JWT (dashboard user) auth
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Auth" });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid User" });

  req.userId = user.id;

  const { data: userTenant } = await supabase
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', user.id)
    .single();

  req.tenantId = userTenant?.tenant_id || null;
  next();
}

// --- API ENDPOINTS ---

// Create API Key (Called by Dashboard)
app.post('/api/keys', authenticateUser, async (req, res) => {
  const tenantId = req.tenantId || await getOrCreateTenant(req.userId);
  if (!tenantId) return res.status(500).json({ error: "Failed to resolve tenant" });

  const rawKey = 'ck_live_' + uuidv4().replace(/-/g, '');
  const keyHash = await argon2.hash(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const { error: dbError } = await supabase.from('api_keys').insert({
    tenant_id: tenantId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: req.body.name || 'Agent Key'
  });

  if (dbError) return res.status(500).json({ error: dbError.message });
  res.json({ key: rawKey, name: req.body.name });
});

// List Keys
app.get('/api/keys', authenticateUser, async (req, res) => {
  if (!req.tenantId) return res.json([]);

  const { data: keys } = await supabase.from('api_keys')
    .select('id, name, key_prefix, created_at')
    .eq('tenant_id', req.tenantId)
    .neq('name', 'Dashboard Session Key');
  res.json(keys || []);
});

// Delete Key
app.delete('/api/keys/:id', authenticateUser, async (req, res) => {
  if (!req.tenantId) return res.status(403).json({ error: "No tenant" });
  await supabase.from('api_keys').delete().eq('id', req.params.id).eq('tenant_id', req.tenantId);
  res.json({ success: true });
});

// Dashboard Session Key (auto provision after login)
app.post('/api/dashboard-key', authenticateUser, async (req, res) => {
  const tenantId = req.tenantId || await getOrCreateTenant(req.userId);
  if (!tenantId) return res.status(500).json({ error: "Failed to resolve tenant" });

  await supabase.from('api_keys')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('name', 'Dashboard Session Key');

  const rawKey = 'ck_live_' + uuidv4().replace(/-/g, '');
  const keyHash = await argon2.hash(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const { error: insertError } = await supabase.from('api_keys').insert({
    tenant_id: tenantId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: 'Dashboard Session Key'
  });

  if (insertError) return res.status(500).json({ error: insertError.message });
  res.json({ key: rawKey });
});

// Share Agent Snapshot (now reads from DB if not in cache)
app.post('/api/share', async (req, res) => {
  const { agentId } = req.body;
  if (!agentId || typeof agentId !== 'string') return res.status(400).json({ error: 'Missing agentId' });

  const agent = activeAgents[agentId];
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const shareId = uuidv4();
  const snapshot = {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    metrics: { ...agent.metrics },
    logs: [...agent.logs],
    timestamp: Date.now()
  };

  // Store snapshot in DB for durability
  await supabase.from('agents').select('id').eq('id', agent.id).single(); // verify exists

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  // Still use in-memory for 24h expiry snapshots (simple, sufficient)
  const shareSnapshots = app.locals.shareSnapshots || (app.locals.shareSnapshots = new Map());
  shareSnapshots.set(shareId, snapshot);
  setTimeout(() => shareSnapshots.delete(shareId), 24 * 60 * 60 * 1000);

  res.json({ url: `${baseUrl}/share.html?id=${shareId}` });
});

// Get Shared Snapshot
app.get('/api/share/:id', (req, res) => {
  const shareSnapshots = app.locals.shareSnapshots || new Map();
  const snapshot = shareSnapshots.get(req.params.id);
  if (!snapshot) return res.status(404).json({ error: 'Share link expired or not found' });
  res.json(snapshot);
});

// Check if user is new or returning
app.get('/api/user/status', authenticateUser, async (req, res) => {
  if (!req.tenantId) return res.json({ isNew: true, hasKeys: false });

  const { data: keys } = await supabase.from('api_keys')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .neq('name', 'Dashboard Session Key')
    .limit(1);

  const hasAgentKeys = keys && keys.length > 0;
  return res.json({ isNew: false, hasKeys: hasAgentKeys });
});

// --- BUDGET ENDPOINTS ---

app.get('/api/budgets', authenticateUser, async (req, res) => {
  if (!req.tenantId) return res.json([]);

  const { data, error } = await supabase.from('budget_rules')
    .select('id, agent_id, max_cost, action, enabled, created_at')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/budgets', authenticateUser, async (req, res) => {
  const tenantId = req.tenantId || await getOrCreateTenant(req.userId);
  if (!tenantId) return res.status(500).json({ error: "Failed to resolve tenant" });

  const { agentId, maxCost, action } = req.body;
  if (typeof maxCost !== 'number' || maxCost <= 0) {
    return res.status(400).json({ error: "maxCost must be a positive number" });
  }
  const validActions = ['kill', 'pause', 'alert_only'];
  const safeAction = validActions.includes(action) ? action : 'kill';

  // Delete existing rule for this tenant+agent combo, then insert new one
  const deleteQuery = supabase.from('budget_rules')
    .delete()
    .eq('tenant_id', tenantId);
  if (agentId) deleteQuery.eq('agent_id', agentId);
  else deleteQuery.is('agent_id', null);
  await deleteQuery;

  const { data, error } = await supabase.from('budget_rules')
    .insert({
      tenant_id: tenantId,
      agent_id: agentId || null,
      max_cost: maxCost,
      action: safeAction,
      enabled: true
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Refresh cache
  await loadBudgetRules(tenantId);

  res.json(data);
});

app.delete('/api/budgets/:id', authenticateUser, async (req, res) => {
  if (!req.tenantId) return res.status(403).json({ error: "No tenant" });

  await supabase.from('budget_rules')
    .delete()
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenantId);

  // Refresh cache
  await loadBudgetRules(req.tenantId);

  res.json({ success: true });
});

// --- WEBHOOK ENDPOINTS ---

app.get('/api/webhooks', authenticateUser, async (req, res) => {
  if (!req.tenantId) return res.json([]);

  const { data, error } = await supabase.from('webhooks')
    .select('id, url, events, enabled, created_at')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/webhooks', authenticateUser, async (req, res) => {
  const tenantId = req.tenantId || await getOrCreateTenant(req.userId);
  if (!tenantId) return res.status(500).json({ error: "Failed to resolve tenant" });

  const { url, events } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Valid HTTPS/HTTP URL required" });

  const validEvents = ['budget_exceeded', 'agent_killed', 'agent_error'];
  const safeEvents = Array.isArray(events) ? events.filter(e => validEvents.includes(e)) : validEvents;
  if (safeEvents.length === 0) return res.status(400).json({ error: "At least one valid event required" });

  const { data, error } = await supabase.from('webhooks')
    .insert({ tenant_id: tenantId, url, events: safeEvents })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/webhooks/:id', authenticateUser, async (req, res) => {
  if (!req.tenantId) return res.status(403).json({ error: "No tenant" });
  await supabase.from('webhooks').delete().eq('id', req.params.id).eq('tenant_id', req.tenantId);
  res.json({ success: true });
});

app.post('/api/webhooks/:id/test', authenticateUser, async (req, res) => {
  if (!req.tenantId) return res.status(403).json({ error: "No tenant" });

  const { data: hook } = await supabase.from('webhooks')
    .select('url')
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenantId)
    .single();

  if (!hook) return res.status(404).json({ error: "Webhook not found" });

  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ClawSight-Webhook/1.0' },
      body: JSON.stringify({
        event: 'test',
        timestamp: new Date().toISOString(),
        data: { message: 'This is a test webhook from ClawSight' }
      }),
      signal: AbortSignal.timeout(5000)
    });
    res.json({ success: true, status: response.status });
  } catch (err) {
    res.status(502).json({ error: `Webhook delivery failed: ${err.message}` });
  }
});

// --- AGENT REGISTRATION ENDPOINT (for orchestrator agents) ---

app.post('/api/agents/register', authenticateApiKey, async (req, res) => {
  const tenantId = req.tenantId;
  const { agentId, name, budget, webhookUrl, parentAgentId } = req.body;

  if (!agentId || typeof agentId !== 'string') {
    return res.status(400).json({ error: "agentId is required" });
  }

  const safeId = sanitizeString(agentId, MAX_AGENT_ID_LEN);
  const safeName = sanitizeString(name || agentId, MAX_AGENT_NAME_LEN);

  // Check agent limit
  const tenantAgentCount = Object.values(activeAgents).filter(a => a.tenantId === tenantId).length;
  if (tenantAgentCount >= MAX_AGENTS_PER_TENANT && !activeAgents[safeId]) {
    return res.status(429).json({ error: `Agent limit reached (${MAX_AGENTS_PER_TENANT})` });
  }

  // Create agent in memory + DB
  const agent = {
    id: safeId,
    name: safeName,
    tenantId,
    lastHeartbeat: Date.now(),
    status: 'idle',
    parentAgentId: parentAgentId ? sanitizeString(parentAgentId, MAX_AGENT_ID_LEN) : null,
    logs: [],
    metrics: { cost: 0, tokens: 0, revenue: 0 }
  };

  activeAgents[safeId] = agent;
  await dbUpsertAgent(agent);
  await dbUpsertMetrics(agent);

  // Set budget rule if provided
  let budgetRule = null;
  if (budget && typeof budget.maxCost === 'number' && budget.maxCost > 0) {
    const validActions = ['kill', 'pause', 'alert_only'];
    const action = validActions.includes(budget.action) ? budget.action : 'kill';

    // Delete existing rule for this agent, then insert
    await supabase.from('budget_rules')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('agent_id', safeId);

    const { data } = await supabase.from('budget_rules')
      .insert({
        tenant_id: tenantId,
        agent_id: safeId,
        max_cost: budget.maxCost,
        action,
        enabled: true
      })
      .select()
      .single();

    budgetRule = data;
    await loadBudgetRules(tenantId);
  }

  // Register webhook if provided
  if (webhookUrl && isValidUrl(webhookUrl)) {
    await supabase.from('webhooks').insert({
      tenant_id: tenantId,
      url: webhookUrl,
      events: ['budget_exceeded', 'agent_killed', 'agent_error']
    });
  }

  // Notify dashboards
  io.to(`tenant:${tenantId}`).emit('agent-update', agent);

  res.json({
    agentId: safeId,
    name: safeName,
    tenantId,
    budgetRule: budgetRule ? { maxCost: budgetRule.max_cost, action: budgetRule.action } : null,
    status: 'registered'
  });
});

// Catch-all: serve landing page for any unmatched GET route
app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) {
    return res.sendFile(path.join(frontendDir, 'index.html'));
  }
  next();
});

// --- REALTIME SOCKETS ---

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("No token provided"));

  // 1. Legacy Master Key Check
  if (LEGACY_API_KEY && token === LEGACY_API_KEY) {
    socket.user = { role: 'admin', tenantId: 'legacy_admin' };
    return next();
  }

  // 2. Tenant API Key Check (ck_live_...)
  if (token.startsWith('ck_live_')) {
    const prefix = token.slice(0, 12);

    const { data: candidates, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('key_prefix', prefix);

    if (error) {
      console.error('DB lookup error:', error.message);
      return next(new Error("Database error"));
    }

    if (candidates) {
      for (const keyRecord of candidates) {
        try {
          if (await argon2.verify(keyRecord.key_hash, token)) {
            const role = keyRecord.name === 'Dashboard Session Key' ? 'dashboard' : 'agent';
            socket.user = { role, tenantId: keyRecord.tenant_id };
            return next();
          }
        } catch (e) {
          // Hash verification failed, try next candidate
        }
      }
    }
    return next(new Error("Invalid API key"));
  }

  // 3. Dashboard User Check (JWT)
  if (token.length > 50) {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (user && !error) {
      const { data: userTenant } = await supabase.from('user_tenants').select('tenant_id').eq('user_id', user.id).single();
      if (userTenant) {
        socket.user = { role: 'dashboard', tenantId: userTenant.tenant_id };
        return next();
      }
    }
  }

  next(new Error("Unauthorized"));
});

io.on('connection', async (socket) => {
  const { tenantId, role } = socket.user;
  console.log(`✅ Connected: ${socket.id} (Role: ${role}, Tenant: ${tenantId})`);

  // Join Tenant Room
  socket.join(`tenant:${tenantId}`);

  // Load budget rules into cache for this tenant
  if (!budgetCache.has(tenantId)) {
    await loadBudgetRules(tenantId);
  }

  // If Dashboard, send initial state from DB + in-memory merge
  if (role === 'dashboard' || role === 'admin') {
    // Load persisted agents from DB
    const dbAgents = await dbLoadTenantAgents(tenantId);

    // Merge: in-memory cache takes precedence (more current), DB fills gaps
    const merged = {};
    for (const a of dbAgents) merged[a.id] = a;
    for (const a of Object.values(activeAgents)) {
      if (a.tenantId === tenantId || tenantId === 'legacy_admin') {
        merged[a.id] = a; // in-memory overrides DB (more recent)
      }
    }

    let tenantAgents = Object.values(merged);
    if (tenantAgents.length === 0 && role === 'dashboard') {
      tenantAgents = [buildDemoAgent(tenantId)];
    }
    socket.emit('init', tenantAgents);
  }

  // Agent Register
  socket.on('register-agent', async (agent) => {
    if (!agent || !agent.id) return;
    if (!checkRateLimit(socket.id)) return;

    const tenantAgentCount = Object.values(activeAgents).filter(a => a.tenantId === tenantId).length;
    if (tenantAgentCount >= MAX_AGENTS_PER_TENANT && !activeAgents[agent.id]) return;

    const safeAgent = {
      id: sanitizeString(agent.id, MAX_AGENT_ID_LEN),
      name: sanitizeString(agent.name || agent.id, MAX_AGENT_NAME_LEN),
      tenantId: tenantId,
      lastHeartbeat: Date.now(),
      status: agent.status || 'idle',
      parentAgentId: activeAgents[agent.id]?.parentAgentId || null,
      logs: [],
      metrics: { cost: 0, tokens: 0, revenue: 0 }
    };

    activeAgents[safeAgent.id] = safeAgent;

    // Track which agents this socket owns
    if (!socketAgentMap.has(socket.id)) socketAgentMap.set(socket.id, new Set());
    socketAgentMap.get(socket.id).add(safeAgent.id);

    // Persist to DB
    await dbUpsertAgent(safeAgent);
    await dbUpsertMetrics(safeAgent);

    // Broadcast to this Tenant Only
    io.to(`tenant:${tenantId}`).emit('agent-update', safeAgent);
    io.to('tenant:legacy_admin').emit('agent-update', safeAgent);
  });

  // Agent Log
  socket.on('agent-log', async (data) => {
    if (!data || !data.id || !activeAgents[data.id]) return;
    if (!checkRateLimit(socket.id)) return;

    const agent = activeAgents[data.id];

    // Security: Ensure Agent belongs to this socket's tenant
    if (agent.tenantId !== tenantId && tenantId !== 'legacy_admin') return;

    // Don't allow updates to killed agents
    if (agent.status === 'killed') return;

    agent.lastHeartbeat = Date.now();

    const allowedStatuses = ['idle', 'working', 'error', 'killed', 'offline', 'complete'];
    if (data.status && allowedStatuses.includes(data.status)) {
      const prevStatus = agent.status;
      agent.status = data.status;

      // Fire webhook on error status
      if (data.status === 'error' && prevStatus !== 'error') {
        fireWebhooks(agent.tenantId, 'agent_error', {
          agentId: agent.id,
          agentName: agent.name,
          previousStatus: prevStatus
        });
      }
    }

    if (data.message) {
      const msg = sanitizeString(data.message, MAX_LOG_MESSAGE_LEN);
      agent.logs.push({ timestamp: Date.now(), message: msg });
      if (agent.logs.length > MAX_LOGS_PER_AGENT) agent.logs.shift();
      // Persist log to DB (fire-and-forget)
      dbInsertLog(agent, msg);
    }

    if (data.metrics) {
      if (!agent.metrics) agent.metrics = { cost: 0, tokens: 0, revenue: 0 };
      const costVal = Number(data.metrics.cost);
      const revenueVal = Number(data.metrics.revenue);
      const tokensVal = Number(data.metrics.tokens);
      if (isValidNumber(costVal)) agent.metrics.cost += costVal;
      if (isValidNumber(revenueVal)) agent.metrics.revenue += revenueVal;
      if (isValidNumber(tokensVal)) agent.metrics.tokens += tokensVal;

      // Check budget after cost update
      if (isValidNumber(costVal) && costVal > 0) {
        await checkBudget(agent);
      }
    }

    // Persist metrics (debounced via write-through)
    dbUpsertMetrics(agent);

    io.to(`tenant:${agent.tenantId}`).emit('agent-update', agent);
    io.to('tenant:legacy_admin').emit('agent-update', agent);
  });

  socket.on('kill-agent', async (agentId) => {
    if (role === 'agent') return;

    const agent = activeAgents[agentId];
    if (!agent) return;

    if (agent.tenantId !== tenantId && tenantId !== 'legacy_admin') {
      return console.log("Unauthorized Kill Attempt");
    }

    console.log(`💀 Kill Command: ${agentId}`);
    io.to(`tenant:${agent.tenantId}`).emit('kill-signal', agentId);

    agent.status = 'killed';
    io.to(`tenant:${agent.tenantId}`).emit('agent-update', agent);

    // Persist status
    await dbUpdateAgentStatus(agentId, agent.tenantId, 'killed');

    // Cascade kill children
    const children = Object.values(activeAgents).filter(
      a => a.parentAgentId === agentId && a.tenantId === agent.tenantId
    );
    for (const child of children) {
      child.status = 'killed';
      child.logs.push({ timestamp: Date.now(), message: `⛔ Parent agent ${agentId} killed — cascade kill` });
      io.to(`tenant:${child.tenantId}`).emit('kill-signal', child.id);
      io.to(`tenant:${child.tenantId}`).emit('agent-update', child);
      await dbUpdateAgentStatus(child.id, child.tenantId, 'killed');
    }

    // Fire webhook
    fireWebhooks(agent.tenantId, 'agent_killed', {
      agentId: agent.id,
      agentName: agent.name,
      killedBy: 'manual',
      childrenKilled: children.map(c => c.id)
    });
  });

  // Cleanup on disconnect
  socket.on('disconnect', async () => {
    console.log(`Disconnected: ${socket.id} (Role: ${role})`);

    rateLimitMap.delete(socket.id);

    const ownedAgents = socketAgentMap.get(socket.id);
    if (ownedAgents) {
      for (const agentId of ownedAgents) {
        const agent = activeAgents[agentId];
        if (agent && agent.status !== 'killed') {
          agent.status = 'offline';
          io.to(`tenant:${agent.tenantId}`).emit('agent-update', agent);
          dbUpdateAgentStatus(agentId, agent.tenantId, 'offline');
        }
      }
      socketAgentMap.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ClawSight Backend running on port ${PORT}`);
});
