const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(express.json()); 
app.use(express.static(path.join(__dirname, '../frontend')));

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- LEGACY SINGLE-TENANT STATE ---
let activeAgents = {};
// Optional master key for simple protection, or empty to allow all
const MASTER_KEY = process.env.CLAWSIGHT_API_KEY || "default-key"; 

console.log("🔓 ClawSight Server Starting (Legacy Mode - No Auth)");

// --- SOCKETS ---
io.use((socket, next) => {
  // Simple check: if server has a key, client must match it.
  // If we want "no auth", we can skip this or use a default.
  const token = socket.handshake.auth.token;
  if (!MASTER_KEY || token === MASTER_KEY) {
    return next();
  }
  // Allow dashboard to connect without key for viewing? 
  // Original logic required the key. We'll stick to simple key match.
  next(new Error("Unauthorized: Invalid Master Key"));
});

io.on('connection', (socket) => {
  console.log('✅ Client Connected:', socket.id);
  
  // Send current state immediately
  socket.emit('init', Object.values(activeAgents));

  socket.on('register-agent', (agent) => {
    activeAgents[agent.id] = { 
      ...agent, 
      lastHeartbeat: Date.now(),
      status: agent.status || 'idle',
      logs: [],
      metrics: { cost: 0, tokens: 0, revenue: 0 }
    };
    io.emit('agent-update', activeAgents[agent.id]);
  });

  socket.on('agent-log', (data) => {
    if (!activeAgents[data.id]) return;
    const agent = activeAgents[data.id];
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
    
    // Broadcast to everyone (Global Room)
    io.emit('agent-update', agent);
  });

  socket.on('kill-agent', (agentId) => {
    console.log(`💀 Kill Command: ${agentId}`);
    io.emit('kill-signal', agentId);
    if (activeAgents[agentId]) {
      activeAgents[agentId].status = 'killed';
      io.emit('agent-update', activeAgents[agentId]);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ClawSight Backend running on port ${PORT}`);
});
