const io = require('socket.io-client');

/**
 * Connect to ClawSight Dashboard
 * @param {Object} config - Configuration object
 * @param {string} config.server - URL of your dashboard (e.g. 'https://app.clawsight.org')
 * @param {string} config.token - API Key from dashboard settings
 * @param {string} [config.id] - Agent ID
 * @param {string} [config.name] - Agent display name
 * @param {Object} [config.budget] - Budget enforcement settings
 * @param {number} config.budget.maxCost - Maximum cost ceiling before auto-kill
 * @param {string} [config.budget.action] - Action on budget exceeded: 'kill' (default), 'pause', 'alert_only'
 * @param {string} [config.parentAgentId] - ID of the parent/orchestrator agent
 * @param {string} [config.webhookUrl] - Webhook URL for notifications
 * @returns {Object} Watcher instance
 */
module.exports = function ClawSight(config) {
  const { token, server } = config;
  let agentId = config.id;
  let agentName = config.name;

  if (!token || !server) {
    console.error("❌ ClawSight Error: Missing 'token' or 'server' URL in config.");
    return {
      register: async () => null,
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
        status: 'working',
        metrics: { cost: 0, tokens: 0 },
        logs: []
      });
    }
  }

  socket.on('connect', () => {
    console.log(`✅ ClawSight Connected: ${agentName || '(pending init)'}`);
    registerAgent();
  });

  socket.on('connect_error', (err) => {
    console.error(`❌ ClawSight Error: ${agentName || 'agent'} failed to connect. ${err.message}`);
  });

  socket.on('kill-signal', (targetId) => {
    if (targetId === agentId) {
      console.error(`💀 ClawSight: KILL SIGNAL RECEIVED for agent ${agentId}. Terminating process immediately.`);
      process.exit(1);
    }
  });

  return {
    /**
     * Pre-register an agent via the REST API with budget and webhook settings.
     * Call this before init() if you want budget enforcement from the start.
     * @param {Object} [opts] - Override config options
     * @param {string} [opts.agentId] - Agent ID (defaults to config.id)
     * @param {string} [opts.name] - Agent name (defaults to config.name)
     * @param {Object} [opts.budget] - Budget settings { maxCost, action }
     * @param {string} [opts.parentAgentId] - Parent agent ID
     * @param {string} [opts.webhookUrl] - Webhook URL
     * @returns {Promise<Object|null>} Registration result or null on error
     */
    register: async (opts = {}) => {
      const regId = opts.agentId || agentId || config.id;
      const regName = opts.name || agentName || config.name;

      if (!regId) {
        console.error('❌ ClawSight: agentId required for register()');
        return null;
      }

      try {
        const res = await fetch(`${server}/api/agents/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            agentId: regId,
            name: regName,
            budget: opts.budget || config.budget,
            parentAgentId: opts.parentAgentId || config.parentAgentId,
            webhookUrl: opts.webhookUrl || config.webhookUrl
          })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          console.error(`❌ ClawSight register failed: ${err.error || res.statusText}`);
          return null;
        }

        const result = await res.json();
        // Update local state so socket registration uses the same ID
        agentId = result.agentId;
        agentName = result.name;
        return result;
      } catch (err) {
        console.error(`❌ ClawSight register error: ${err.message}`);
        return null;
      }
    },

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
