const io = require('socket.io-client');

/**
 * Connect to ClawSight Dashboard
 * @param {Object} config - Configuration object
 * @param {string} config.server - URL of your dashboard (e.g. 'https://app.clawsight.org')
 * @param {string} config.token - API Key from dashboard settings
 * @returns {Object} Watcher instance
 */
module.exports = function ClawSight(config) {
  const { token, server } = config;
  let agentId = config.id;
  let agentName = config.name;

  if (!token || !server) {
    console.error("ClawSight Error: Missing 'token' or 'server' URL in config.");
    return {
      init: () => {},
      log: () => {},
      metric: () => {},
      status: () => {}
    };
  }

  // Connect to backend
  const socket = io(server, {
    auth: { token },
    reconnection: true,
    reconnectionAttempts: Infinity
  });

  function registerAgent() {
    if (agentName && agentId) {
      socket.emit('register-agent', {
        id: agentId,
        name: agentName,
        status: 'working'
      });
    }
  }

  socket.on('connect', () => {
    registerAgent();
  });

  socket.on('kill-signal', (targetId) => {
    if (targetId === agentId) {
      process.exit(1);
    }
  });

  return {
    init: ({ id, name }) => {
      agentId = id;
      agentName = name;
      if (socket.connected) registerAgent();
    },

    log: (message, status = 'working') => {
      socket.emit('agent-log', { id: agentId, message, status });
    },

    metric: (key, value) => {
      socket.emit('agent-log', { id: agentId, metrics: { [key]: value } });
    },

    status: (status) => {
      socket.emit('agent-log', { id: agentId, status });
    }
  };
};
