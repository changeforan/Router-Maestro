// main.bicep — Router-Maestro on Azure Container Apps (cheapest, persistent Copilot OAuth)
//
// Resource-group scoped. Creates:
//   - Storage account (Standard_LRS) + Azure Files SMB share (persistent state)
//   - Container Apps managed environment (Consumption profile, logs=none for lowest cost)
//   - Env-level Azure Files (SMB) storage link
//   - Container App: minReplicas 0 / maxReplicas 1, 0.25 vCPU / 0.5 GiB, HTTPS ingress
//
// The GitHub Copilot OAuth credentials live in the app's data dir (auth.json). We mount a
// single Azure Files share into BOTH native state dirs via subPath, so the app needs no
// code changes and no XDG_* overrides.
//
// NO secrets are hardcoded: ROUTER_MAESTRO_API_KEY is a @secure() param -> Container Apps secret.

@description('Azure region. Default Japan East (Japan West lacks full Container Apps support).')
param location string = 'japaneast'

@description('Container App name.')
param appName string = 'router-maestro'

@description('Container Apps managed environment name.')
param environmentName string = 'router-maestro-env'

@description('Globally-unique storage account name (3-24 lowercase alphanumerics).')
param storageAccountName string

@description('Azure Files share name for Router-Maestro persistent state.')
param fileShareName string = 'rmstate'

@description('Container image (public Docker Hub). Pin a tag for reproducibility.')
param image string = 'likanwen/router-maestro:0.7.10'

@description('Router-Maestro server API key. Clients must present it as Bearer. Passed securely; never committed.')
@secure()
param routerMaestroApiKey string

@description('Log level for Router-Maestro.')
param logLevel string = 'INFO'

@description('File share quota in GiB (Standard file shares).')
param fileShareQuotaGiB int = 1

// Base64-encoded Python `sitecustomize.py` startup shim. Azure Files SMB (CIFS) has no
// Unix extensions, so os.fchmod/os.chmod raise PermissionError(EPERM) on the mounted share,
// and Router-Maestro's write_json_owner_only() (os.fchmod 0o600) crashes at startup. This is
// a container-config layer only (command override) — NOT a Router-Maestro app-code change.
// The share is private to the storage account, so owner-only bits are moot. The shim makes
// chmod/fchmod tolerant of EPERM. See README "Known limitations" and deploy/azure/sitecustomize.py.
@description('Base64 of the sitecustomize.py startup shim (see deploy/azure/sitecustomize.py).')
param startupShimB64 string = 'IyBJbmplY3RlZCBzaGltIChjb250YWluZXItY29uZmlnIGxheWVyLCBOT1QgYSBSb3V0ZXItTWFlc3RybyBhcHAtY29kZSBjaGFuZ2UpLgojIEF6dXJlIEZpbGVzIFNNQiAoQ0lGUykgaGFzIG5vIFVuaXggZXh0ZW5zaW9ucywgc28gb3MuZmNobW9kL29zLmNobW9kIHJhaXNlCiMgUGVybWlzc2lvbkVycm9yKEVQRVJNKSBvbiB0aGUgbW91bnRlZCBzaGFyZS4gUm91dGVyLU1hZXN0cm8ncwojIHdyaXRlX2pzb25fb3duZXJfb25seSgpIGNhbGxzIG9zLmZjaG1vZChmZCwgMG82MDApLCB3aGljaCBpcyBmYXRhbCBhdCBzdGFydHVwLgojIFRoZSBzaGFyZSBpcyBwcml2YXRlIHRvIHRoZSBzdG9yYWdlIGFjY291bnQgKG5vdCBwdWJsaWNseSByZWFjaGFibGUpLCBzbwojIG93bmVyLW9ubHkgcGVybWlzc2lvbiBiaXRzIGFyZSBtb290LiBXZSBtYWtlIGNobW9kL2ZjaG1vZCB0b2xlcmFudCBvZiBFUEVSTS4KaW1wb3J0IG9zCgoKZGVmIF90b2xlcmFudChvcmlnKToKICAgIGRlZiB3cmFwcGVyKCphcmdzLCAqKmt3YXJncyk6CiAgICAgICAgdHJ5OgogICAgICAgICAgICByZXR1cm4gb3JpZygqYXJncywgKiprd2FyZ3MpCiAgICAgICAgZXhjZXB0IFBlcm1pc3Npb25FcnJvcjoKICAgICAgICAgICAgcmV0dXJuIE5vbmUKICAgIHJldHVybiB3cmFwcGVyCgoKZm9yIF9uYW1lIGluICgiZmNobW9kIiwgImNobW9kIiwgImxjaG1vZCIpOgogICAgX29yaWcgPSBnZXRhdHRyKG9zLCBfbmFtZSwgTm9uZSkKICAgIGlmIF9vcmlnIGlzIG5vdCBOb25lOgogICAgICAgIHNldGF0dHIob3MsIF9uYW1lLCBfdG9sZXJhbnQoX29yaWcpKQo='

var storageLinkName = 'rmfiles'
// Decode the shim to /tmp (writable, non-mounted), put it on PYTHONPATH so CPython auto-imports
// sitecustomize before the app runs, then exec the image's normal start command.
var startupArgs = 'set -e; mkdir -p /tmp/pyshim; printf %s "${startupShimB64}" | base64 -d > /tmp/pyshim/sitecustomize.py; export PYTHONPATH=/tmp/pyshim; exec router-maestro server start --host 0.0.0.0 --port 8080'

// ---------------------------------------------------------------------------
// Storage account + Azure Files share (Standard_LRS, SMB)
// ---------------------------------------------------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource fileServices 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileServices
  name: fileShareName
  properties: {
    accessTier: 'TransactionOptimized'
    shareQuota: fileShareQuotaGiB
    enabledProtocols: 'SMB'
  }
}

// ---------------------------------------------------------------------------
// Container Apps managed environment (Consumption workload profile, logs = none)
// ---------------------------------------------------------------------------
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    // destination omitted => no Log Analytics workspace => lowest idle cost.
    appLogsConfiguration: {
      destination: null
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

// Env-level SMB storage link to the Azure Files share
resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: storageLinkName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: fileShareName
      accessMode: 'ReadWrite'
    }
  }
}

// ---------------------------------------------------------------------------
// Container App
// ---------------------------------------------------------------------------
resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  properties: {
    managedEnvironmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      secrets: [
        {
          name: 'router-maestro-api-key'
          value: routerMaestroApiKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: image
          command: [
            '/bin/sh'
            '-c'
          ]
          args: [
            startupArgs
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'ROUTER_MAESTRO_API_KEY'
              secretRef: 'router-maestro-api-key'
            }
            {
              name: 'ROUTER_MAESTRO_LOG_LEVEL'
              value: logLevel
            }
          ]
          volumeMounts: [
            {
              // Data dir: auth.json (GitHub Copilot OAuth), server.json, logs
              volumeName: 'state'
              mountPath: '/home/maestro/.local/share/router-maestro'
              subPath: 'data'
            }
            {
              // Config dir: contexts.json, providers.json, priorities.json
              volumeName: 'state'
              mountPath: '/home/maestro/.config/router-maestro'
              subPath: 'config'
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'state'
          storageType: 'AzureFile'
          storageName: storageLinkName
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http-scale'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    envStorage
  ]
}

output fqdn string = app.properties.configuration.ingress.fqdn
output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output resourceGroup string = resourceGroup().name
output storageAccount string = storage.name
output fileShare string = fileShareName
output image string = image
