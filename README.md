# ClawSight 🦅

**Mission Control for Autonomous Agents.**

[Live Demo](https://app.clawsight.org) · [Documentation](https://github.com/ClawSight/platform#readme) · [Report Bug](https://github.com/ClawSight/platform/issues)

---

### **The Problem**
You built an agent. It runs on a loop in the cloud. 
- Is it working? 
- Did it just spend $50 on OpenAI API calls in 10 minutes?
- Is it stuck in a `while(true)` loop apologizing to itself?

You don't know because **`console.log` doesn't work in production.**

### **The Solution**
**ClawSight** is a lightweight dashboard that gives you:
1.  **Real-time Logs:** Stream `stdout` from your agent to the web.
2.  **Cost Tracking:** Watch token burn as it happens.
3.  **Kill Switch:** Remotely terminate a rogue agent instantly.

No complex observability stack. No Datadog. Just 3 lines of code.

---

### **Quick Start**

#### 1. Install the SDK
```bash
npm install clawsight
```

#### 2. Add to your Agent
```javascript
const monitor = require('clawsight');

// Connect to your dashboard
const watcher = monitor({
  server: 'https://app.clawsight.org',
  token: 'YOUR_SECRET_KEY'
});

// Start logging
watcher.log('Agent starting task: Research Uranium', 'working');
watcher.metric('cost', 0.04); // Track spend
```

---

### **Deployment (Self-Hosted)**

ClawSight is open-source. Run your own dashboard on Render, Heroku, or Docker.

**One-Click Deploy (Render):**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ClawSight/platform)

**Manual Deploy:**
```bash
# Clone
git clone https://github.com/ClawSight/platform.git

# Install
cd platform/backend
npm install

# Run
export CLAWSIGHT_API_KEY="secret-key-123"
node server.js
```

---

### **Architecture**
*   **Frontend:** Vanilla JS + Tailwind (No build step, blazing fast).
*   **Backend:** Node.js + Socket.io (Real-time websockets).
*   **Storage:** In-memory (Default) / Redis (Optional).

### **Contributing**
We are open to PRs. If you want to add generic LLM cost tracking or Slack alerts, open an issue.

---

**Built for the [OpenClaw](https://github.com/openclaw) ecosystem.**
 
