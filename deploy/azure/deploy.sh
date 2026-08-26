#!/usr/bin/env bash
#
# deploy.sh — Reproducibly deploy Router-Maestro to Azure Container Apps.
#
# - Creates a single resource group (easy cleanup).
# - Generates (or accepts) ROUTER_MAESTRO_API_KEY and passes it as a SECURE parameter.
#   The key is never written to Bicep, params files, or git.
# - Deploys main.bicep and prints the public URL.
#
# Requirements: az CLI (logged in), az extension "containerapp", openssl.
#
# Usage:
#   ./deploy.sh
#   RESOURCE_GROUP=rg-router-maestro LOCATION=japaneast ./deploy.sh
#   ROUTER_MAESTRO_API_KEY=sk-my-existing-key ./deploy.sh   # reuse an existing key
#
set -euo pipefail

# ----- Config (override via env) --------------------------------------------
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-router-maestro}"
LOCATION="${LOCATION:-japaneast}"
APP_NAME="${APP_NAME:-router-maestro}"
ENV_NAME="${ENV_NAME:-router-maestro-env}"
FILE_SHARE="${FILE_SHARE:-rmstate}"
IMAGE="${IMAGE:-likanwen/router-maestro:0.7.10}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"
# Storage account name must be globally unique, 3-24 lowercase alphanumerics.
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-rmstate$(openssl rand -hex 4)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----- Pre-flight -----------------------------------------------------------
command -v az >/dev/null || { echo "ERROR: az CLI not found." >&2; exit 1; }
az account show >/dev/null 2>&1 || { echo "ERROR: not logged in. Run: az login" >&2; exit 1; }
az extension show --name containerapp >/dev/null 2>&1 || az extension add --name containerapp --only-show-errors

# ----- API key (secret) -----------------------------------------------------
# Generate a strong key if none supplied. Do NOT echo the value.
if [[ -z "${ROUTER_MAESTRO_API_KEY:-}" ]]; then
  ROUTER_MAESTRO_API_KEY="sk-rm-$(openssl rand -hex 24)"
  GENERATED_KEY=1
else
  GENERATED_KEY=0
fi

echo ">> Subscription: $(az account show --query name -o tsv)"
echo ">> Resource group: $RESOURCE_GROUP  Location: $LOCATION"
echo ">> Storage account: $STORAGE_ACCOUNT  Share: $FILE_SHARE"
echo ">> Image: $IMAGE"

# ----- Register providers (idempotent) --------------------------------------
az provider register -n Microsoft.App --only-show-errors >/dev/null 2>&1 || true
az provider register -n Microsoft.Storage --only-show-errors >/dev/null 2>&1 || true

# ----- Resource group -------------------------------------------------------
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --only-show-errors --output none

# ----- Deploy ---------------------------------------------------------------
echo ">> Deploying (this can take a few minutes)..."
OUTPUTS_JSON="$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name "router-maestro-$(date +%s)" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters \
      location="$LOCATION" \
      appName="$APP_NAME" \
      environmentName="$ENV_NAME" \
      storageAccountName="$STORAGE_ACCOUNT" \
      fileShareName="$FILE_SHARE" \
      image="$IMAGE" \
      logLevel="$LOG_LEVEL" \
      routerMaestroApiKey="$ROUTER_MAESTRO_API_KEY" \
  --query properties.outputs \
  --output json)"

APP_URL="$(echo "$OUTPUTS_JSON" | jq -r '.appUrl.value')"

echo ""
echo "============================================================"
echo " Router-Maestro deployed."
echo "   URL:            $APP_URL"
echo "   Resource group: $RESOURCE_GROUP"
echo "   Storage:        $STORAGE_ACCOUNT / $FILE_SHARE"
echo "   Image:          $IMAGE"
if [[ "$GENERATED_KEY" -eq 1 ]]; then
  echo ""
  echo " A NEW API key was generated. Store it in your password manager:"
  echo "   ROUTER_MAESTRO_API_KEY=$ROUTER_MAESTRO_API_KEY"
  echo " (Retrieve later: az containerapp secret show -g $RESOURCE_GROUP -n $APP_NAME --secret-name router-maestro-api-key --query value -o tsv)"
fi
echo "============================================================"
