#!/usr/bin/env bash
#
# destroy.sh — Delete ALL Azure resources created by deploy.sh.
# Removes the entire resource group (storage, Container Apps env, container app, secrets).
#
# Usage:
#   ./destroy.sh
#   RESOURCE_GROUP=rg-router-maestro ./destroy.sh
#
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-router-maestro}"

command -v az >/dev/null || { echo "ERROR: az CLI not found." >&2; exit 1; }
az account show >/dev/null 2>&1 || { echo "ERROR: not logged in. Run: az login" >&2; exit 1; }

if ! az group show --name "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Resource group '$RESOURCE_GROUP' does not exist. Nothing to do."
  exit 0
fi

echo ">> Deleting resource group '$RESOURCE_GROUP' and ALL its resources..."
az group delete --name "$RESOURCE_GROUP" --yes --no-wait
echo ">> Deletion started (running in background). Verify with:"
echo "   az group exists --name $RESOURCE_GROUP"
