# ClawSight 🦅 — Mission Control for Autonomous Agents

**Open-source dashboard for real-time agent observability.** See every thought, token, and dollar your bots burn — kill loops instantly, share read-only sessions, and keep multiple tenants safe.

---

## Why ClawSight?
| Problem | ClawSight Answer |
| --- | --- |
| Agents run headless in the cloud — you have zero visibility. | Live-stream every log/status update to a web UI. |
| API/token bills spike before you notice. | Real-time cost + token tracking per agent and globally. |
| Rogue loops require SSH + guesswork. | One-click **KILL** button with confirmation + audit log. |
| Sharing/debugging is painful. | Generate read-only “👀 Share Links” for teammates/customers. |
| Multi-tenant SaaS needs isolation. | Supabase auth + scoped API keys + tenant-aware sockets. |

## Feature Highlights
- **Supabase Magic Link auth** → `/keys` onboarding with per-user `ck_live_…` keys.
- **Multi-tenant sockets** with hashed API keys + rate limits.
- **Demo tenant** auto-seeded so new users see value immediately.
- **Cost / token analytics** across agents + global P&L.
- **Kill + Share controls** on every card.
- **Deploy anywhere** (Render button, Docker, self-host).

---

## Quick Start
```bash
# 1) Install SDK (publish coming — see below)
npm install clawsight

# 2) Import + connect
const clawsight = require('clawsight');
const watcher = clawsight({
  server: 'https://app.clawsight.org',
  token: 'ck_live_...',
  id: 'trader-bot-01',
  name: 'Trader Bot'
});
watcher.log('Starting trade loop', 'working');
watcher.metric('cost', 0.02);
```

### First-run onboarding
1. Visit **https://app.clawsight.org** → redirected to login → enter email → click magic link.
2. Dashboard opens automatically with a session key provisioned — **new users** see the Setup Guide first.
3. Go to `/keys.html` to create agent keys (`ck_live_…`) for your bots.
4. If you have no agents yet, the **Demo Revenue Bot** appears so you can explore immediately.

---

## Deploy Your Own
| Target | One-liner |
| --- | --- |
| Render (free) | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ClawSight/platform) |
| Local dev | `cd agentwatch-app/backend && npm install && CLAWSIGHT_API_KEY=test node server.js` |
| Docker (coming) | `docker compose up` |

Env vars:
```
CLAWSIGHT_API_KEY=master-key-for-bootstrap
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
``` 

---

## Roadmap / Help Wanted
- [ ] LangChain & AutoGPT adapters
- [ ] Slack / Discord alert hooks
- [ ] Token cost auto-detection per provider
- [ ] Docker Compose file
Jump into **Discussions → Show & Tell** or open issues labeled `help wanted`.

---

## Publish checklist (owner action)
We renamed everything to `clawsight`, but the npm package isn’t live yet. To publish:
```bash
cd agentwatch-app/sdk
npm version 1.0.0
npm publish --access public
```
After that, update this README badge + examples if version changes.

---

## Status & Links
- **Dashboard:** https://app.clawsight.org
- **Landing:** https://www.clawsight.org
- **Docs:** https://github.com/ClawSight/platform#readme
- **Issues / Feedback:** https://github.com/ClawSight/platform/issues

Built for the OpenClaw ecosystem. Contributions welcome.
