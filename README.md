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
| `AVATAR_KIND` | `photo` (vasa-1 talking head), `video` (full-body Lisa, Harry, Meg… with an `AVATAR_STYLE`), or `none` for voice only. |
| `AVATAR_CHARACTER` | For `photo`: adrian, amara, amira, anika, bianca, camila, carlos, clara, darius, diego, elise, farhan, faris, gabrielle, hyejin, imran, isabella, layla, liwei, ling, marcus, matteo, rahul, rana, ren, riya, sakura, simone, zayd, zoe. Preview images are in the [standard avatars list](https://learn.microsoft.com/azure/ai-services/speech-service/text-to-speech-avatar/standard-avatars). |
| `AVATAR_OUTPUT` | `webrtc` (default) sends avatar media browser-to-Azure over a TURN relay — lowest latency, but requires outbound UDP 3478 / TCP 443 to `relay.communication.microsoft.com` from every client network. `websocket` muxes it into this app's WebSocket as fragmented MP4 instead: no firewall changes, media stays inside your VNet, ~200–400 ms more latency, and no iOS Safari support. |
| `AVATAR_BACKGROUND_COLOR` | `#RRGGBBAA` behind the avatar. Real-time avatar [ignores the alpha byte](https://learn.microsoft.com/azure/ai-services/speech-service/text-to-speech-avatar/real-time-synthesis-avatar#edit-background), so there is no transparent background. On additive displays — spinning LED fan, Pepper's ghost — set `#000000FF`: unlit pixels emit nothing, so black reads as invisible. To composite over arbitrary content instead, use `#00FF00FF` and chroma-key the frames onto a canvas in the browser. Ignored when `AVATAR_BACKGROUND_IMAGE_URL` is set. |
| `TURN_DETECTION_TYPE` | `azure_semantic_vad` (default) or `server_vad`. |
| `VAD_SILENCE_MS` | Silence needed to end a caller's turn, default `300`. Dead air on every turn and the one latency term you control — the rest is model and service round trip. Raise towards `500` if callers get cut off mid-sentence. |
| `GREETING_TEXT` | Exact opening line. Left blank, the agent composes its own greeting and the wording differs every session — set this for a scripted event. Requires `GREET_ON_CONNECT=true`. |
| `INTERIM_RESPONSE` | `off` (default), `static` or `llm`. Speaks a filler phrase once the agent has been thinking for `INTERIM_RESPONSE_THRESHOLD_MS`. Latency is unchanged; the silence is what disappears. |
| `DISPLAY_TITLE` / `DISPLAY_SUBTITLE` | What the browser shows in the header. Defaults to the agent name; set it so an audience never sees the Foundry agent or project name. |
| `ALLOWED_ORIGINS` | Extra origins permitted to open the proxied WebSocket. The app's own origin is always allowed. |

The stage is avatar-first: the video fills it, the agent's latest words appear as
a two-line caption over the bottom, and a chip in the corner shows whether the
session is **Listening**, **Thinking** or **Speaking**. The full transcript is
behind the *Transcript* button and opens by itself if anything errors. Captions
and transcript are stripped of markdown and of the `【6:0†source】` citation
markers a Foundry agent emits, since neither reads well on screen.

Acronyms are pronounced by writing them hyphenated in the agent's own
instructions — `F-R-A` rather than `FRA` — because the text the agent emits is
what gets spoken. The hyphens are removed again before display, so the audience
hears "F-R-A" and reads "FRA".

`instructions` is intentionally not sent in `session.update`: it is not supported
when the session targets a custom agent. Prompt changes belong in the agent
definition in the Foundry portal.
