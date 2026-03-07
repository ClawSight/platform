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

// --- CONFIG ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kfibmwbwdcejrsuahbps.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabase Admin Client (Server Side Only)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- IN-MEMORY STATE ---
let activeAgents = {};

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
    metrics: { cost: 0.2311, revenue: 3.45, tokens: 1820 }
  };
}

console.log("🔒 ClawSight Server Starting (Secure Mode)...");

// --- API ENDPOINTS ---

// Auto-Provision Dashboard Key (Called by Frontend on Login)
app.post('/api/dashboard-key', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Auth" });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid User" });

  // Get Tenant ID
  const { data: userTenant } = await supabase.from('user_tenants').select('tenant_id').eq('user_id', user.id).single();
  if (!userTenant) return res.status(400).json({ error: "No Tenant Found" });

  // Clean up old session keys to keep DB tidy
  await supabase.from('api_keys').delete().eq('tenant_id', userTenant.tenant_id).eq('name', 'Dashboard Session');

  // Create New Key
  const rawKey = 'ck_live_' + uuidv4().replace(/-/g, '');
  const keyHash = await argon2.hash(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const { error: insertError } = await supabase.from('api_keys').insert({
    tenant_id: userTenant.tenant_id,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: 'Dashboard Session',
    created_by: user.id
  });

  if (insertError) return res.status(500).json({ error: insertError.message });
  res.json({ key: rawKey });
});

// Create Manual API Key
app.post('/api/keys', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Auth" });
  
  const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!user) return res.status(401).json({ error: "Invalid User" });

  const { data: userTenant } = await supabase.from('user_tenants').select('tenant_id').eq('user_id', user.id).single();
  
  const rawKey = 'ck_live_' + uuidv4().replace(/-/g, '');
  const keyHash = await argon2.hash(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  await supabase.from('api_keys').insert({
    tenant_id: userTenant.tenant_id,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: req.body.name || 'Agent Key'
  });

  res.json({ key: rawKey, name: req.body.name });
});

// List Keys
app.get('/api/keys', async (req, res) => {
  const authHeader = req.headers.authorization;
  const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!user) return res.status(401).json({ error: "Invalid User" });

  const { data: userTenant } = await supabase.from('user_tenants').select('tenant_id').eq('user_id', user.id).single();
  const { data: keys } = await supabase.from('api_keys').select('id, name, key_prefix, created_at').eq('tenant_id', userTenant.tenant_id);
  res.json(keys);
});

// Delete Key
app.delete('/api/keys/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!user) return res.status(401).json({ error: "Invalid User" });

  const { data: userTenant } = await supabase.from('user_tenants').select('tenant_id').eq('user_id', user.id).single();
  await supabase.from('api_keys').delete().eq('id', req.params.id).eq('tenant_id', userTenant.tenant_id);
  res.json({ success: true });
});

// --- SOCKET AUTH & ISOLATION ---

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  
  // 1. Validate Token Format
  if (!token || !token.startsWith('ck_live_')) return next(new Error("Unauthorized: Invalid Key Format"));

  // 2. Lookup by Prefix (Performance)
  const prefix = token.slice(0, 12);
  const { data: candidates } = await supabase.from('api_keys').select('*').eq('key_prefix', prefix);
  
  if (candidates && candidates.length > 0) {
    for (const keyRecord of candidates) {
      if (await argon2.verify(keyRecord.key_hash, token)) {
        // Success: Bind socket to Tenant
        socket.user = { role: 'agent', tenantId: keyRecord.tenant_id };
        return next();
      }
    }
  }
  
  next(new Error("Unauthorized: Invalid Key"));
});

io.on('connection', (socket) => {
  const { tenantId } = socket.user;
  socket.join(`tenant:${tenantId}`); // THE WALL

  // Send Initial State (Filtered by Tenant)
  let tenantAgents = Object.values(activeAgents).filter(a => a.tenantId === tenantId);
  
  // Inject Demo if Empty (User Experience)
  if (tenantAgents.length === 0) {
    tenantAgents = [buildDemoAgent(tenantId)];
  }
  socket.emit('init', tenantAgents);

  socket.on('register-agent', (agent) => {
    activeAgents[agent.id] = { 
      ...agent, 
      tenantId, // Force Tenant ID from Token
      lastHeartbeat: Date.now(),
      logs: [],
      metrics: { cost: 0, tokens: 0, revenue: 0 }
    };
    io.to(`tenant:${tenantId}`).emit('agent-update', activeAgents[agent.id]);
  });

  socket.on('agent-log', (data) => {
    if (!activeAgents[data.id]) return;
    const agent = activeAgents[data.id];
    
    // Security Check: Agent must belong to this Tenant
    if (agent.tenantId !== tenantId) return;

    agent.lastHeartbeat = Date.now();
    agent.status = data.status || agent.status;
    
    if (data.message) {
      agent.logs.push({ timestamp: Date.now(), message: data.message });
      if (agent.logs.length > 50) agent.logs.shift();
    }
    if (data.metrics) {
      if (!agent.metrics) agent.metrics = { cost: 0, tokens: 0, revenue: 0 };
      if (data.metrics.cost) agent.metrics.cost += Number(data.metrics.cost);
      if (data.metrics.revenue) agent.metrics.revenue += Number(data.metrics.revenue);
      if (data.metrics.tokens) agent.metrics.tokens += Number(data.metrics.tokens);
    }
    
    io.to(`tenant:${tenantId}`).emit('agent-update', agent);
  });

  socket.on('kill-agent', (agentId) => {
    const agent = activeAgents[agentId];
    if (agent && agent.tenantId === tenantId) {
      io.to(`tenant:${tenantId}`).emit('kill-signal', agentId);
      agent.status = 'killed';
      io.to(`tenant:${tenantId}`).emit('agent-update', agent);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ClawSight Backend running on port ${PORT}`);
});
