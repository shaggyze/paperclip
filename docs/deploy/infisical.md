---
title: Infisical Agent & Proxy
summary: Pull deployment secrets from Infisical and give agents a cached Infisical API
---

Run Paperclip with secrets kept in [Infisical](https://infisical.com) instead of
`.env` files. The overlay `docker/docker-compose.infisical.yml` adds two sidecars:

| Service | What it does |
| --- | --- |
| `infisical-agent` | Logs in with a Universal Auth machine identity, keeps the access token fresh, and renders secrets to `/run/infisical/paperclip.env` (every 5 minutes). |
| `infisical-proxy` | Caching proxy for the Infisical API on the compose network. Keeps serving cached secrets if Infisical is briefly unreachable. |

The server loads `/run/infisical/paperclip.env` at start (`PAPERCLIP_ENV_FILE`), and
gets `INFISICAL_API_URL` / `INFISICAL_TOKEN_FILE` so agents and tools can read
other secrets on demand through the proxy.

This covers deployment/bootstrap secrets (the same trust boundary as
[AWS provider bootstrap](../../doc/SECRETS-AWS-PROVIDER.md#bootstrap-trust-model)).
Company secrets you manage in the board UI still use Paperclip's own secret
provider.

## Setup

1. **Create a machine identity** in Infisical (Organization → Access Control →
   Identities) with **Universal Auth**, and give it read access to your project.
2. **Save its credentials** where the agent can read them (never commit them):

   ```sh
   printf '%s' '<client-id>'     > docker/infisical/credentials/client-id
   printf '%s' '<client-secret>' > docker/infisical/credentials/client-secret
   chmod 600 docker/infisical/credentials/*
   ```

   Or point `INFISICAL_CREDENTIALS_DIR` at a directory elsewhere on the host.
3. **Pick what to render.** Edit `docker/infisical/paperclip.env.tmpl`: set the
   project slug, environment and path. Every secret there becomes `KEY=VALUE`.
   Put `BETTER_AUTH_SECRET`, `DATABASE_URL`, model API keys, `GITHUB_TOKEN`, etc. in
   that Infisical folder.
4. **Self-hosted Infisical?** Set `infisical.address` in
   `docker/infisical/agent.yaml` and `INFISICAL_DOMAIN` for the proxy.
5. **Start it:**

   ```sh
   # The base compose file requires BETTER_AUTH_SECRET at parse time; the real
   # value from Infisical overrides this placeholder when the server starts.
   export BETTER_AUTH_SECRET=from-infisical
   docker compose -f docker/docker-compose.yml -f docker/docker-compose.infisical.yml up -d
   docker compose -f docker/docker-compose.yml -f docker/docker-compose.infisical.yml logs infisical-agent
   ```

   The server log shows `loaded environment from /run/infisical/paperclip.env`.

## Using Infisical from agents

Inside the server container (and the agent processes it starts):

```sh
export INFISICAL_TOKEN="$(cat "$INFISICAL_TOKEN_FILE")"
curl -s -H "Authorization: Bearer $INFISICAL_TOKEN" \
  "$INFISICAL_API_URL/api/v3/secrets/raw?workspaceSlug=paperclip&environment=prod&secretPath=/agents"
```

SDKs work the same way: use `INFISICAL_API_URL` as the site URL.

## Notes

- **Rotation.** The agent re-renders every 5 minutes, but the server reads the env file
  only at start. Restart `server` to pick up rotated deployment secrets. Agents that
  read through the proxy see new values after the proxy refresh (1h by default).
- **Exposure.** The proxy listens on plain HTTP inside the compose network only (no
  published port). Turn TLS on (`--tls-cert-file`/`--tls-key-file`) before exposing it
  anywhere else.
- **Format.** Rendered values must be single-line. The entrypoint reads them literally,
  with no shell expansion.
- **Without the overlay**, `PAPERCLIP_ENV_FILE` also works with any other file you mount.
