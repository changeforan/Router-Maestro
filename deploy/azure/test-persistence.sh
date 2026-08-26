#!/usr/bin/env bash
#
# test-persistence.sh — Helpers for the mandatory persistence + cold-start tests.
#
# Subcommands:
#   check-auth         Assert auth.json exists on the Azure Files share and contains the
#                      "github-copilot" provider key. NEVER prints token contents.
#   list-state         List persisted files on the share (data/ and config/).
#   revision-state     Print current revision + replica state.
#   restart            Force a new revision (recreates the replica).
#   wait-scale-zero    Poll until replicas == 0 (scale-to-zero reached).
#   measure-warm N     N timed requests against a running replica.
#   measure-cold N     N timed cold requests (each preceded by forced scale-to-zero).
#   probe              Single timed request (prints timestamps + curl timing).
#
# Env (override as needed):
#   RESOURCE_GROUP (default rg-router-maestro)
#   APP_NAME       (default router-maestro)
#   STORAGE_ACCOUNT (required for check-auth/list-state)
#   FILE_SHARE     (default rmstate)
#   APP_URL        (https://<fqdn>; auto-derived if unset)
#   API_KEY        (ROUTER_MAESTRO_API_KEY; auto-fetched from secret if unset)
#   PROBE_PATH     (default /health — unauthenticated, good for cold-start timing)
#
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-router-maestro}"
APP_NAME="${APP_NAME:-router-maestro}"
FILE_SHARE="${FILE_SHARE:-rmstate}"
PROBE_PATH="${PROBE_PATH:-/health}"

_fqdn() {
  az containerapp show -g "$RESOURCE_GROUP" -n "$APP_NAME" \
    --query properties.configuration.ingress.fqdn -o tsv
}
APP_URL="${APP_URL:-https://$(_fqdn)}"

_api_key() {
  if [[ -n "${API_KEY:-}" ]]; then echo "$API_KEY"; return; fi
  az containerapp secret show -g "$RESOURCE_GROUP" -n "$APP_NAME" \
    --secret-name router-maestro-api-key --query value -o tsv
}

_storage_key() {
  az storage account keys list -g "$RESOURCE_GROUP" -n "$STORAGE_ACCOUNT" \
    --query "[0].value" -o tsv
}

check-auth() {
  : "${STORAGE_ACCOUNT:?set STORAGE_ACCOUNT}"
  local sk tmp
  sk="$(_storage_key)"
  tmp="$(mktemp)"
  echo ">> Downloading data/auth.json from share '$FILE_SHARE'..."
  az storage file download \
    --account-name "$STORAGE_ACCOUNT" --account-key "$sk" \
    --share-name "$FILE_SHARE" --path "data/auth.json" \
    --dest "$tmp" --only-show-errors --output none
  if jq -e 'has("github-copilot")' "$tmp" >/dev/null 2>&1; then
    echo "PASS: auth.json present and contains provider key 'github-copilot'."
    echo "      (providers stored: $(jq -r 'keys | join(",")' "$tmp"))"
    rm -f "$tmp"
    return 0
  else
    echo "FAIL: auth.json missing 'github-copilot' key." >&2
    rm -f "$tmp"
    return 1
  fi
}

list-state() {
  : "${STORAGE_ACCOUNT:?set STORAGE_ACCOUNT}"
  local sk; sk="$(_storage_key)"
  echo "== data/ =="
  az storage file list --account-name "$STORAGE_ACCOUNT" --account-key "$sk" \
    --share-name "$FILE_SHARE" --path "data" --query "[].name" -o tsv 2>/dev/null || true
  echo "== config/ =="
  az storage file list --account-name "$STORAGE_ACCOUNT" --account-key "$sk" \
    --share-name "$FILE_SHARE" --path "config" --query "[].name" -o tsv 2>/dev/null || true
}

revision-state() {
  echo "== revisions =="
  az containerapp revision list -g "$RESOURCE_GROUP" -n "$APP_NAME" \
    --query "[].{name:name,active:properties.active,replicas:properties.replicas,created:properties.createdTime}" -o table
}

restart() {
  local suffix="r$(date +%s)"
  echo ">> Forcing new revision (suffix $suffix)..."
  az containerapp update -g "$RESOURCE_GROUP" -n "$APP_NAME" \
    --revision-suffix "$suffix" --output none
  echo ">> New revision created."
}

wait-scale-zero() {
  echo ">> Waiting for scale-to-zero (idle cooldown ~5 min)..."
  local i replicas
  for i in $(seq 1 60); do
    replicas="$(az containerapp replica list -g "$RESOURCE_GROUP" -n "$APP_NAME" \
      --query "length(@)" -o tsv 2>/dev/null || echo "?")"
    echo "   [$(date +%T)] active replicas: $replicas"
    [[ "$replicas" == "0" ]] && { echo "PASS: scaled to zero."; return 0; }
    sleep 30
  done
  echo "WARN: still not at zero after timeout." >&2
  return 1
}

# Timed request. Prints: request ts, response ts, TTFB, total.
probe() {
  local key; key="$(_api_key)"
  local start_ts end_ts
  start_ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  # -w timings; %{time_starttransfer}=TTFB, %{time_total}=total
  local timing
  timing="$(curl -sS -o /dev/null \
      -H "Authorization: Bearer ${key}" \
      -w '%{http_code} %{time_starttransfer} %{time_total}' \
      "${APP_URL}${PROBE_PATH}")"
  end_ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "req=${start_ts} resp=${end_ts} http=$(echo "$timing" | awk '{print $1}') ttfb=$(echo "$timing" | awk '{print $2}')s total=$(echo "$timing" | awk '{print $3}')s"
}

_stats() {
  # reads whitespace list of numbers on stdin -> min median max
  sort -n | awk '{a[NR]=$1} END{n=NR; if(n==0){print "n/a"; exit} m=(n%2)?a[(n+1)/2]:(a[n/2]+a[n/2+1])/2; printf "min=%.3f median=%.3f max=%.3f (n=%d)\n", a[1], m, a[n], n}'
}

measure-warm() {
  local n="${1:-5}" i vals=""
  echo ">> Warming up..."; probe >/dev/null || true
  for i in $(seq 1 "$n"); do
    local line; line="$(probe)"; echo "  warm[$i] $line"
    vals+="$(echo "$line" | sed -E 's/.*total=([0-9.]+)s/\1/') "
  done
  echo -n "WARM total: "; echo "$vals" | tr ' ' '\n' | grep -E '^[0-9.]+$' | _stats
}

measure-cold() {
  local n="${1:-5}" i vals=""
  for i in $(seq 1 "$n"); do
    wait-scale-zero >/dev/null || true
    local line; line="$(probe)"; echo "  cold[$i] $line"
    vals+="$(echo "$line" | sed -E 's/.*total=([0-9.]+)s/\1/') "
  done
  echo -n "COLD total: "; echo "$vals" | tr ' ' '\n' | grep -E '^[0-9.]+$' | _stats
}

cmd="${1:-}"; shift || true
case "$cmd" in
  check-auth|list-state|revision-state|restart|wait-scale-zero|probe) "$cmd" "$@" ;;
  measure-warm) measure-warm "$@" ;;
  measure-cold) measure-cold "$@" ;;
  *) echo "Usage: $0 {check-auth|list-state|revision-state|restart|wait-scale-zero|probe|measure-warm N|measure-cold N}"; exit 1 ;;
esac
