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
const LEGACY_API_KEY = process.env.CLAWSIGHT_API_KEY || process.env.AGENTWATCH_API_KEY || "test-key-123";

// Supabase Admin Client (Server Side Only)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- IN-MEMORY STATE (Performance Cache) ---
// We cache agents in memory for speed, but tagged with tenant_id
// Structure: { agentId: { ...agentData, tenantId: 'uuid' } }
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
    metrics: {
      cost: 0.2311,
      revenue: 3.45,
      tokens: 1820,
      profitRun: '+$3.22 today'
    }
  };
}

console.log("🔒 ClawSight Server Starting...");

// --- HELPERS ---

async function getOrCreateTenant(userId) {
  // Check for existing tenant
  const { data: existing } = await supabase
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', userId)
    .single();

  if (existing) return existing.tenant_id;

  // Create a new tenant for this user
  const tenantId = uuidv4();
  const { error: insertError } = await supabase
    .from('user_tenants')
    .insert({ user_id: userId, tenant_id: tenantId });

  if (insertError) {
    console.error('Failed to create tenant:', insertError.message);
    return null;
  }

  console.log(`🆕 New tenant created: ${tenantId} for user ${userId}`);
  return tenantId;
}

// --- API ENDPOINTS ---

// Create API Key (Called by Dashboard)
app.post('/api/keys', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Auth" });

  const token = authHeader.replace('Bearer ', '');
  
  // 1. Verify User via Supabase
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid User" });

  // 2. Get or Create User's Tenant
  const tenantId = await getOrCreateTenant(user.id);
  if (!tenantId) return res.status(500).json({ error: "Failed to resolve tenant" });

  // 3. Generate Key
  const rawKey = 'ck_live_' + uuidv4().replace(/-/g, '');
  const keyHash = await argon2.hash(rawKey);
  const keyPrefix = rawKey.slice(0, 12); // "ck_live_1234"

  // 4. Save to DB
  const { error: dbError } = await supabase.from('api_keys').insert({
    tenant_id: tenantId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: req.body.name || 'Agent Key'
  });

  if (dbError) return res.status(500).json({ error: dbError.message });

  // Return Raw Key ONCE
  res.json({ key: rawKey, name: req.body.name });
});

// List Keys
app.get('/api/keys', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Auth" });
  
  const token = authHeader.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: "Invalid User" });

  const { data: userTenant } = await supabase.from('user_tenants').select('tenant_id').eq('user_id', user.id).single();
  if (!userTenant) return res.json([]);

  const { data: keys } = await supabase.from('api_keys').select('id, name, key_prefix, created_at').eq('tenant_id', userTenant.tenant_id);
  res.json(keys);
});

// Delete Key
app.delete('/api/keys/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: "Invalid User" });

  // RLS handles the rest if we use a user-scoped client, but we are using admin client for speed.
  // We must verify ownership manually or switch client.
  // Manual check:
  const { data: userTenant } = await supabase.from('user_tenants').select('tenant_id').eq('user_id', user.id).single();
  
  await supabase.from('api_keys').delete().eq('id', req.params.id).eq('tenant_id', userTenant.tenant_id);
  res.json({ success: true });
});



// Dashboard Session Key (auto provision after login)
app.post('/api/dashboard-key', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Auth" });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid User" });

  const tenantId = await getOrCreateTenant(user.id);
  if (!tenantId) return res.status(500).json({ error: "Failed to resolve tenant" });

  // Remove prior dashboard keys for cleanliness
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
    name: 'Dashboard Session Key',
    created_by: user.id
  });

  if (insertError) return res.status(500).json({ error: insertError.message });

  res.json({ key: rawKey });
});

// Check if user is new or returning (has agents/keys)
app.get('/api/user/status', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Auth" });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid User" });

  const { data: userTenant } = await supabase.from('user_tenants').select('tenant_id').eq('user_id', user.id).single();

  if (!userTenant) {
    return res.json({ isNew: true, hasKeys: false });
  }

  const { data: keys } = await supabase.from('api_keys')
    .select('id')
    .eq('tenant_id', userTenant.tenant_id)
    .neq('name', 'Dashboard Session Key')
    .limit(1);

  const hasAgentKeys = keys && keys.length > 0;
  return res.json({ isNew: false, hasKeys: hasAgentKeys });
});

// --- REALTIME SOCKETS ---

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  
  // 1. Legacy Master Key Check
  if (token === LEGACY_API_KEY) {
    socket.user = { role: 'admin', tenantId: 'legacy_admin' };
    return next();
  }

  // 2. Tenant API Key Check (ck_live_...)
  if (token.startsWith('ck_live_')) {
    // This is an Agent connecting
    // Find key by prefix to avoid scanning all hashes
    // Optimization: In real prod, use Redis. Here, we query DB.
    // Since we can't query by hash, we need to iterate or store lookup.
    // WAIT: We stored `key_prefix`. Let's use that to narrow down.
    const prefix = token.slice(0, 12);
    
    // Fetch candidates
    const { data: candidates } = await supabase.from('api_keys').select('*').eq('key_prefix', prefix);
    
    if (candidates) {
      for (const keyRecord of candidates) {
        if (await argon2.verify(keyRecord.key_hash, token)) {
          const role = keyRecord.name === 'Dashboard Session Key' ? 'dashboard' : 'agent';
          socket.user = { role, tenantId: keyRecord.tenant_id };
          return next();
        }
      }
    }
  }

  // 3. Dashboard User Check (JWT)
  // If token is a JWT, verify with Supabase
  if (token.length > 50) { // JWTs are long
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (user && !error) {
      // Get Tenant
      const { data: userTenant } = await supabase.from('user_tenants').select('tenant_id').eq('user_id', user.id).single();
      if (userTenant) {
        socket.user = { role: 'dashboard', tenantId: userTenant.tenant_id };
        return next();
      }
    }
  }

  next(new Error("Unauthorized"));
});

io.on('connection', (socket) => {
  const { tenantId, role } = socket.user;
  console.log(`✅ Connected: ${socket.id} (Role: ${role}, Tenant: ${tenantId})`);

  // Join Tenant Room
  socket.join(`tenant:${tenantId}`);

  // If Dashboard, send initial state (Filtered by Tenant)
  if (role === 'dashboard' || role === 'admin') {
    let tenantAgents = Object.values(activeAgents).filter(a => a.tenantId === tenantId || tenantId === 'legacy_admin');
    if (tenantAgents.length === 0 && role === 'dashboard') {
      tenantAgents = [buildDemoAgent(tenantId)];
    }
    socket.emit('init', tenantAgents);
  }

  // Agent Register
  socket.on('register-agent', (agent) => {
    // Enforce Tenant ID
    const safeAgent = {
      ...agent,
      tenantId: tenantId, // Server-assigned
      lastHeartbeat: Date.now(),
      status: 'idle',
      logs: [],
      metrics: { cost: 0, tokens: 0, revenue: 0 }
    };

    activeAgents[agent.id] = safeAgent;
    
    // Broadcast to this Tenant Only
    io.to(`tenant:${tenantId}`).emit('agent-update', safeAgent);
    
    // Also to Admin
    io.to('tenant:legacy_admin').emit('agent-update', safeAgent);
  });

  // Agent Log
  socket.on('agent-log', (data) => {
    if (!activeAgents[data.id]) return;
    const agent = activeAgents[data.id];

    // Security: Ensure Agent belongs to this socket's tenant
    if (agent.tenantId !== tenantId && tenantId !== 'legacy_admin') return;

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

    io.to(`tenant:${agent.tenantId}`).emit('agent-update', agent);
    io.to('tenant:legacy_admin').emit('agent-update', agent);
  });

  socket.on('kill-agent', (agentId) => {
    // Only Dashboard/Admin can kill
    if (role === 'agent') return;

    const agent = activeAgents[agentId];
    if (!agent) return;
    
    if (agent.tenantId !== tenantId && tenantId !== 'legacy_admin') {
      return console.log("Unauthorized Kill Attempt");
    }

    console.log(`💀 Kill Command: ${agentId}`);
    // Broadcast to Tenant Room (The agent SDK listens to this)
    io.to(`tenant:${agent.tenantId}`).emit('kill-signal', agentId);
    
    agent.status = 'killed';
    io.to(`tenant:${agent.tenantId}`).emit('agent-update', agent);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ClawSight Backend running on port ${PORT}`);
});
