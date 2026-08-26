# Deploy Router-Maestro to Azure Container Apps (cheapest, persistent Copilot OAuth)

Deploy the current Router-Maestro (`v0.7.10`) to **Azure Container Apps** on the
**Consumption** profile with **scale-to-zero**, backed by **Azure Files (SMB, Standard_LRS)**
so GitHub Copilot OAuth credentials survive container restarts and scale-to-zero.

```
Resource group: rg-router-maestro
├── Storage account (Standard_LRS) ── Azure Files share "rmstate" (SMB)
├── Container Apps Environment (Consumption profile, logs = none)
└── Container App "router-maestro"
    ├── minReplicas 0 / maxReplicas 1 · 0.25 vCPU / 0.5 GiB
    ├── public HTTPS ingress (targetPort 8080)
    ├── secret ROUTER_MAESTRO_API_KEY (Container Apps secret)
    └── Azure Files mounted (single share, two subPaths):
        ├── /home/maestro/.local/share/router-maestro  (subPath data)   → auth.json (Copilot OAuth)
        └── /home/maestro/.config/router-maestro        (subPath config) → contexts/providers/priorities.json
```

No VNet, NAT Gateway, Firewall, Private Endpoint, Application Gateway, or container registry.
The public Docker Hub image `likanwen/router-maestro:0.7.10` is pulled directly.

## Files

| File | Purpose |
|---|---|
| `main.bicep` | All Azure resources (RG-scoped) |
| `parameters.example.json` | Non-secret parameter values (copy + edit) |
| `deploy.sh` | Create RG, generate/accept API key, deploy |
| `destroy.sh` | Delete the entire resource group |
| `test-persistence.sh` | Persistence + cold-start test harness |
| `sitecustomize.py` | Startup shim source (see *Known limitations*) |

## 1. Azure prerequisites

- An Azure subscription.
- Azure CLI (`az`) installed and logged in: `az login`.
- The `containerapp` CLI extension (auto-installed by `deploy.sh`): `az extension add --name containerapp`.
- `openssl`, `jq`, `curl` (used by the scripts).
- Resource providers `Microsoft.App` and `Microsoft.Storage` registered (auto-registered by `deploy.sh`).
- A local Router-Maestro CLI for the client side (any host with Python ≥3.14):
  `pip install .` from the repo root, or `uv run router-maestro`.

## 2. Required CLI commands (quick reference)

```bash
az login
az account set --subscription "<your-subscription>"
az extension add --name containerapp
```

## 3. How to deploy

```bash
cd deploy/azure
./deploy.sh
```

Defaults: resource group `rg-router-maestro`, region `japaneast`, image `likanwen/router-maestro:0.7.10`.
Override via env vars:

```bash
RESOURCE_GROUP=rg-router-maestro LOCATION=japaneast \
STORAGE_ACCOUNT=rmstate$(openssl rand -hex 4) \
./deploy.sh
```

- If `ROUTER_MAESTRO_API_KEY` is **not** set, `deploy.sh` generates a strong key and prints it
  once — **store it in a password manager**. To reuse an existing key:
  `ROUTER_MAESTRO_API_KEY=sk-rm-... ./deploy.sh`.
- The key is passed to Bicep as a `@secure()` parameter and materialized as a Container Apps
  secret. It is never written to Bicep, params files, git, or logs.

## 4. Retrieve the public URL

```bash
az containerapp show -g rg-router-maestro -n router-maestro \
  --query properties.configuration.ingress.fqdn -o tsv
# → https://<fqdn>
```

## 5. Configure the local Router-Maestro CLI to use the remote server

Router-Maestro has no `--server` flag; you select a remote server via a **context**.

```bash
URL="https://$(az containerapp show -g rg-router-maestro -n router-maestro --query properties.configuration.ingress.fqdn -o tsv)"
KEY="$(az containerapp secret show -g rg-router-maestro -n router-maestro --secret-name router-maestro-api-key --query value -o tsv)"

router-maestro context add azure -e "$URL" -k "$KEY"
router-maestro context set azure
router-maestro context test        # → ✓ Connection successful!
```

## 6. Authenticate GitHub Copilot remotely

The OAuth device flow is hosted by the **server**, so the credential lands on the server's
mounted Azure Files share (not your laptop).

```bash
router-maestro auth login github-copilot
# Visit https://github.com/login/device and enter the printed code.
# → "Successfully authenticated!"
```

Send a request:

```bash
curl -sS -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"github-copilot/claude-haiku-4.5","messages":[{"role":"user","content":"hi"}],"max_tokens":20}' \
  "$URL/api/openai/v1/chat/completions"
```

Endpoints: OpenAI `/api/openai/v1/chat/completions` + `/api/openai/v1/models`; Anthropic
`/api/anthropic/v1/messages` and `/v1/messages`; Gemini `/api/gemini/...`. Streaming (`"stream":true`)
works through ingress (SSE with `X-Accel-Buffering: no` + 5s keepalive).

## 7. Where persistent state is stored

Single Azure Files share `rmstate`, mounted into the two native state dirs via `subPath`:

| Container path | subPath | Files |
|---|---|---|
| `/home/maestro/.local/share/router-maestro` | `data` | **`auth.json`** (GitHub Copilot OAuth under key `github-copilot`), `logs/`, `server.json` |
| `/home/maestro/.config/router-maestro` | `config` | `contexts.json`, `providers.json`, `priorities.json` |

The server API key is pinned via the `ROUTER_MAESTRO_API_KEY` secret, independent of `contexts.json`.

## 8. How to test persistence

```bash
cd deploy/azure
export RESOURCE_GROUP=rg-router-maestro STORAGE_ACCOUNT=<your-storage-account>

./test-persistence.sh list-state        # list files on the share
./test-persistence.sh check-auth         # assert auth.json has 'github-copilot' (never prints tokens)
./test-persistence.sh revision-state     # current revision/replica state
./test-persistence.sh restart            # force a new revision (recreate replica)
./test-persistence.sh wait-scale-zero    # poll until replicas == 0
./test-persistence.sh measure-warm 5     # warm latency min/median/max
./test-persistence.sh measure-cold 3     # cold latency (waits for scale-to-zero each time)
```

Full flow: `check-auth` → `restart` → `check-auth` (still present) → send request → `wait-scale-zero`
→ send request (cold) → confirm success without re-login.

## 9. Inspect logs

```bash
az containerapp logs show -g rg-router-maestro -n router-maestro --type console --follow
az containerapp logs show -g rg-router-maestro -n router-maestro --type system  --tail 30
```

Note: the environment is created with **no Log Analytics workspace** (lowest cost), so only the
live stream above is available — there is no historical log query. To enable history, add an
`appLogsConfiguration` with a Log Analytics `logAnalyticsConfiguration` in `main.bicep`
(adds cost).

## 10. Force / reproduce a restart

```bash
az containerapp update -g rg-router-maestro -n router-maestro --revision-suffix r$(date +%s)
# or: ./test-persistence.sh restart
```

## 11. Verify scale-to-zero

```bash
az containerapp replica list -g rg-router-maestro -n router-maestro --query "length(@)" -o tsv
# 0 after ~5-6 min idle. Then any request triggers a cold start.
./test-persistence.sh wait-scale-zero
```

## 12. Destroy all Azure resources

```bash
cd deploy/azure
./destroy.sh        # az group delete --name rg-router-maestro --yes --no-wait
az group exists --name rg-router-maestro   # → false when done
```

## 13. Expected monthly cost (Japan East, light personal use)

| Component | Cost |
|---|---|
| Container Apps compute (Consumption, scale-to-zero) | ~$0 idle; a few cents/month at light active use (0.25 vCPU / 0.5 GiB billed per-second only while running) |
| Azure Files (Standard_LRS, ~1 GiB used) | ~$0.05–0.10/month + negligible transactions |
| Log Analytics | $0 (disabled) |
| Egress | negligible for personal use |
| **Total** | **well under ~$1/month** for light use |

Cost scales with active request time; heavy sustained traffic keeps a replica warm and costs more.

## 14. Known limitations

- **Azure Files SMB + `fchmod`:** CIFS has no Unix extensions, so `os.fchmod`/`os.chmod` raise
  `PermissionError(EPERM)` on the mounted share. Router-Maestro's `write_json_owner_only()` calls
  `os.fchmod(fd, 0o600)`, which crashes the app at startup on the share. We inject a tiny startup
  shim (`sitecustomize.py`, base64-embedded in `main.bicep`, applied via a **container command
  override** — *not* an app-code change) that makes `chmod`/`fchmod` tolerant of `EPERM`. Files
  persist normally; owner-only bits are moot because the share is private to the storage account.
  If a future Router-Maestro release wraps `fchmod` in `try/except`, the shim can be removed.
- **Cold start:** after scale-to-zero the first request waits ~24–29s for the replica to start
  (measured, Japan East). Warm requests are sub-second. Set `minReplicas: 1` to eliminate cold
  starts (loses the scale-to-zero cost savings).
- **Docker Hub pulls:** the public image is pulled anonymously; Docker Hub rate limits could
  affect frequent cold pulls. Mitigation: mirror the pinned tag to your own registry (adds cost).
- **Single shared API key:** `ROUTER_MAESTRO_API_KEY` guards both inference and admin/config
  endpoints (`/api/admin/*`); there is no separate management credential in this version. CORS is
  `*` on the server. `/metrics` can be gated separately with `ROUTER_MAESTRO_METRICS_TOKEN`.
- **Japan West:** use **Japan East** — Container Apps Consumption support is not available in
  Japan West.

## Security notes

- Public endpoint requires the Router-Maestro API key: unauthenticated calls to protected routes
  return **401** (verified). Only `/`, `/health`, `/docs`, `/openapi.json`, `/redoc` are public.
- HTTPS only (`allowInsecure: false`).
- Secrets are never committed: the API key is a `@secure()` param → Container Apps secret; storage
  keys are read at deploy time via `listKeys()` and not stored in files.
- `test-persistence.sh check-auth` asserts credential presence only — it never prints token values.
- Do not paste OAuth tokens or `Authorization` headers into logs.
