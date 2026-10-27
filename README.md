# opencode-copilot-multi-proxy

HTTP proxy for routing OpenCode requests to multiple GitHub Copilot accounts.

## Why

OpenCode v2 Plugin API does not support custom `auth.loader` with custom `fetch`.
This proxy sits between OpenCode and `api.githubcopilot.com` and routes each
request to the correct account based on the URL path.

## Setup

```bash
cd opencode-copilot-multi-proxy

# 1. Copy env and set your GitHub OAuth Client ID
cp .env.example .env
# Edit .env: COPILOT_MULTI_CLIENT_ID=your_client_id

# 2. Copy accounts and add your tokens
cp accounts.json.example accounts.json
# Edit accounts.json: replace access/refresh tokens

# 3. Start with Docker (auto-restart)
docker compose up -d

# 4. Verify
curl http://localhost:3001/health
```

## OpenCode Configuration

In `~/.config/opencode/opencode.json`, add a provider per account:

```json
{
  "provider": {
    "github-copilot": { "hidden": true },
    "github-copilot-giocampeti": {
      "url": "http://localhost:3001/proxy/giocampeti",
      "models": {
        "claude-sonnet-4.5": {
          "name": "giocampeti: Claude Sonnet 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        },
        "gpt-4o": {
          "name": "giocampeti: GPT-4o",
          "limit": { "context": 128000, "output": 16000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    },
    "github-copilot-VF004_rina": {
      "url": "http://localhost:3001/proxy/VF004_rina",
      "models": {
        "claude-sonnet-4": {
          "name": "VF004_rina: Claude Sonnet 4",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  }
}
```

Then restart OpenCode and select models:
- `github-copilot-giocampeti/claude-sonnet-4.5`
- `github-copilot-VF004_rina/claude-sonnet-4`

## Docker Auto-start

`docker compose up -d` with `restart: always` ensures the proxy restarts
on reboot if Docker daemon is started automatically.

On macOS, enable Docker Desktop to start on login.

## Tokens

Get tokens via `opencode-copilot-multi login` (Device Flow) or from
`~/.local/share/opencode/auth.json` (entry `github-copilot`).
