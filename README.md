# Voice + Avatar front end for a Microsoft Foundry agent

A small Node/Express app that lets a browser hold a spoken conversation with a
Microsoft Foundry agent, rendered as a photorealistic talking avatar.

```
browser  ──WebSocket──►  App Service (Node)  ──WebSocket + Entra token──►  Voice Live API ──► Foundry agent
   ▲                                                                              │
   └──────────────────────── WebRTC (avatar video + audio) ───────────────────────┘
```

The browser never receives an Entra token or API key. The App Service acquires a
token with its managed identity and proxies the Voice Live WebSocket; only the
avatar media path is direct (WebRTC).

## Prerequisites

- A **Microsoft Foundry resource** (`*.services.ai.azure.com`) in a region that
  supports Voice Live *and* the text-to-speech avatar (for example `eastus2` or
  `westus2` — check the Speech service region table for `ttsavatar`).
- The agent published in a Foundry project (as shown in the portal).
- Node.js 20+.

Agent mode requires **Microsoft Entra ID** auth — API keys are not supported.

## Run locally

```powershell
git clone <this-repo>
cd Voicechat
npm install
Copy-Item .env.example .env
# edit .env: VOICELIVE_ENDPOINT, AGENT_PROJECT_NAME, AGENT_NAME, AVATAR_CHARACTER
az login
npm start
```

Open <http://localhost:3000>, press **Start**, and allow the microphone.

Your signed-in user needs **Cognitive Services User** and **Foundry User**
(formerly Azure AI User) on the Foundry resource.

## Deploy to Azure App Service

Use `deploy.ps1` for a scripted end-to-end deployment, or follow the steps below.

```powershell
$rg       = "rg-voicedemo"
$plan     = "asp-voicedemo"
$app      = "<globally-unique-app-name>"
$location = "centralus"
$foundry  = "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<foundry-account>"

az group create -n $rg -l $location
az appservice plan create -g $rg -n $plan --is-linux --sku B1
az webapp create -g $rg -p $plan -n $app --runtime "NODE:22-lts"

# WebSockets are off by default and are required by this app.
# The portal only renders this toggle for Windows plans, so set it from the CLI.
az webapp config set -g $rg -n $app --web-sockets-enabled true --always-on true
az webapp update -g $rg -n $app --https-only true

az webapp config appsettings set -g $rg -n $app --settings `
  SCM_DO_BUILD_DURING_DEPLOYMENT=true `
  VOICELIVE_ENDPOINT="https://<foundry-account>.services.ai.azure.com" `
  VOICELIVE_API_VERSION="2025-10-01" `
  AGENT_PROJECT_NAME="<project-name>" `
  AGENT_NAME="<agent-name>" `
  AGENT_PARAM_STYLE="new" `
  AVATAR_KIND="photo" `
  AVATAR_CHARACTER="camila" `
  VOICE_NAME="en-US-Ava:DragonHDLatestNeural"

# Managed identity + RBAC on the Foundry resource. Role display names are being
# renamed (Azure AI User -> Foundry User), so the IDs are the safer choice.
az webapp identity assign -g $rg -n $app
$principal = az webapp identity show -g $rg -n $app --query principalId -o tsv
az role assignment create --assignee $principal --role a97b65f3-24c7-4388-baec-2e87135dc908 --scope $foundry  # Cognitive Services User
az role assignment create --assignee $principal --role 53ca6127-db72-4b80-b1b0-d745d6d5456d --scope $foundry  # Foundry User
```

Redeploy after code changes:

```powershell
# Do not use Compress-Archive on Windows PowerShell 5.1: it writes ZIP entries
# with backslashes, so Linux App Service silently drops the public/ folder.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = (Get-Location).Path
Remove-Item "$root\app.zip" -Force -ErrorAction SilentlyContinue
$zip = [IO.Compression.ZipFile]::Open("$root\app.zip", 'Create')
$files = @('package.json','package-lock.json','server.js','README.md') +
         (Get-ChildItem public -Recurse -File | ForEach-Object { $_.FullName.Substring($root.Length + 1) })
foreach ($f in $files) {
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $f), ($f -replace '\\','/')) | Out-Null
}
$zip.Dispose()

az webapp deploy -g $rg -n $app --src-path app.zip --type zip
```

`deploy.ps1` does this for you.

Then browse to `https://<app>.azurewebsites.net`.

### Lock it down before sharing

The app has **no user authentication of its own** — anyone with the URL can talk
to your agent and spend your Foundry quota. Add App Service **Authentication**
(Easy Auth) with Entra ID so only your tenant can reach it:

```powershell
az webapp auth microsoft update -g $rg -n $app `
  --client-id <app-registration-client-id> `
  --tenant-id <tenant-id> `
  --yes
az webapp auth update -g $rg -n $app --enabled true --action RedirectToLoginPage
```

## Configuration notes

| Setting | Purpose |
| --- | --- |
| `AGENT_PARAM_STYLE` | `new` sends `agent-name` / `agent-project-name`. Switch to `classic` (with `AGENT_ID`) if your project still uses Agent Service classic. |
| `AVATAR_KIND` | `photo` (vasa-1 talking head — Camila, Anika, Gabrielle, Matteo…), `video` (Lisa, Harry, Meg… with a `AVATAR_STYLE`), or `none` for voice only. |
| `TURN_DETECTION_TYPE` | `azure_semantic_vad` (default) or `server_vad`. |
| `ALLOWED_ORIGINS` | Extra origins permitted to open the proxied WebSocket. The app's own origin is always allowed. |

`instructions` is intentionally not sent in `session.update`: it is not supported
when the session targets a custom agent. Prompt changes belong in the agent
definition in the Foundry portal.
