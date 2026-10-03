# Cloudflare AI Gateway, Ollama and Infisical

The `opencode_local` adapter has two built-in OpenAI-compatible providers. The server can load their keys from Infisical at start.

| Provider id | Model id example | Turns on when |
| --- | --- | --- |
| `cf-aig` | `cf-aig/dynamic/free-agents` | `CLOUDFLARE_AI_GATEWAY_URL` is set, or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID` are both set |
| `ollama` | `ollama/qwen3:8b` | `OLLAMA_BASE_URL` is set, or the agent's model starts with `ollama/` |

A provider with the same id in `~/.config/opencode/opencode.json` or `PAPERCLIP_OPENCODE_PROVIDERS` replaces the built-in one. Both providers are injected for local runs only. Remote targets keep using `PAPERCLIP_OPENCODE_PROVIDERS`.

## 1. Infisical first

The server reads these variables before it loads its config. A value already in the environment wins over Infisical.

| Variable | Purpose |
| --- | --- |
| `INFISICAL_PROJECT_ID` | Project that holds the keys (required) |
| `INFISICAL_TOKEN` | Access token, checked first |
| `INFISICAL_TOKEN_FILE` | Token sink file written by the Infisical Agent, checked second |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | Machine identity login, checked third |
| `INFISICAL_ENVIRONMENT` | Environment slug, default `prod` |
| `INFISICAL_SECRET_PATH` | Folder, default `/` |
| `INFISICAL_API_URL` or `INFISICAL_DOMAIN` | Self-hosted URL or local proxy, default `https://app.infisical.com` |
| `INFISICAL_SECRET_KEYS` | Comma list of keys to import, `*` for all |

The default import list covers `OPENROUTER_API_KEY`, every `CLOUDFLARE_*` and `OLLAMA_*` variable on this page, plus `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY` and `FIRECRAWL_API_KEY`. The log lists imported key names and never values. A failed login logs one warning and the server keeps starting.

### Infisical Agent (keeps the token fresh)

Save as `infisical-agent.yaml` and run `infisical agent --config infisical-agent.yaml`. The client id and secret files hold the `johnny5` machine identity.

```yaml
infisical:
  address: "https://app.infisical.com"
auth:
  type: "universal-auth"
  config:
    client-id: "./client-id"
    client-secret: "./client-secret"
    remove_client_secret_on_read: false
sinks:
  - type: "file"
    config:
      path: "/var/run/infisical/token"
```

Then start Paperclip with `INFISICAL_PROJECT_ID=<id>` and `INFISICAL_TOKEN_FILE=/var/run/infisical/token`. A restart picks up rotated keys.

### Infisical MCP server

Agents that need secrets at run time can use the official MCP server. It reads the same machine identity variables.

```json
{
  "mcpServers": {
    "infisical": {
      "command": "npx",
      "args": ["-y", "@infisical/mcp"],
      "env": {
        "INFISICAL_HOST_URL": "https://app.infisical.com",
        "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID": "<from Infisical>",
        "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET": "<from Infisical>"
      }
    }
  }
}
```

## 2. Cloudflare AI Gateway with fallbacks

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID` | Build `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat` |
| `CLOUDFLARE_AI_GATEWAY_URL` | Full compat URL, replaces the two ids |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | Sent as `cf-aig-authorization: Bearer <token>` |
| `CLOUDFLARE_AI_GATEWAY_PROVIDER_KEY` | Upstream key; leave unset when keys are stored in the gateway (BYOK) |
| `CLOUDFLARE_AI_GATEWAY_MODELS` | Model ids shown in the hire flow, default `dynamic/free-agents` |

Fallback order lives in a gateway dynamic route. Create route `free-agents` under the gateway's **Dynamic Routes**:

1. Node A: Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
2. Node B: custom provider `openrouter` (base URL `https://openrouter.ai/api/v1`, key stored with BYOK), model `openrouter/free`.
3. Node C: Google AI Studio, `gemini-2.5-flash`.

Each node falls through to the next on error or rate limit. Hire the agent with model `cf-aig/dynamic/free-agents`. The response headers `cf-aig-model` and `cf-aig-provider` name the backend that answered.

## 3. Ollama

| Variable | Purpose |
| --- | --- |
| `OLLAMA_BASE_URL` | Daemon URL; `/v1` is appended when missing. `OLLAMA_HOST` also works |
| `OLLAMA_MODELS` | Extra model ids to show when the daemon is offline |
| `OLLAMA_API_KEY` | Only for a proxy that checks keys |

The hire flow's model list asks `<OLLAMA_BASE_URL>/models` for installed models, with a 2 second timeout. Pick `ollama/<model>` for an `opencode_local` agent.
