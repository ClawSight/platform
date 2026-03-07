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

let activeAgents = {};

console.log("🔓 ClawSight Server Starting (Legacy Mode)...");

io.on('connection', (socket) => {
  console.log('✅ Client Connected:', socket.id);
  
  // Send current state
  socket.emit('init', Object.values(activeAgents));

  socket.on('register-agent', (agent) => {
    activeAgents[agent.id] = { ...agent, lastHeartbeat: Date.now(), logs: [] };
    io.emit('agent-update', activeAgents[agent.id]);
  });

  socket.on('agent-log', (data) => {
    if (!activeAgents[data.id]) return;
    const agent = activeAgents[data.id];
    agent.lastHeartbeat = Date.now();
    
    if (data.message) {
      agent.logs.push({ timestamp: Date.now(), message: data.message });
      if (agent.logs.length > 50) agent.logs.shift();
    }
    if (data.metrics) {
        agent.metrics = { ...agent.metrics, ...data.metrics };
    }
    io.emit('agent-update', agent);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ClawSight Backend running on port ${PORT}`);
});
