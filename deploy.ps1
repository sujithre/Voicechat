<#
.SYNOPSIS
    Provisions and deploys the Voice Live avatar web app into a new environment.

.EXAMPLE
    ./deploy.ps1 -EnvName prod `
                 -Location centralus `
                 -FoundryAccount my-foundry `
                 -FoundryResourceGroup rg-ai `
                 -ProjectName my-project `
                 -AgentName my-agent
#>
[CmdletBinding()]
param(
    # Short environment name; used to build resource names.
    [Parameter(Mandatory)][string] $EnvName,

    # Globally unique web app name. Defaults to voicedemo-<EnvName>.
    [string] $WebAppName,

    # App Service region. Must have App Service VM quota in the subscription.
    [string] $Location = 'centralus',

    # Existing Microsoft Foundry (AIServices) account that hosts the agent.
    [Parameter(Mandatory)][string] $FoundryAccount,
    [Parameter(Mandatory)][string] $FoundryResourceGroup,

    # Foundry project and agent to talk to.
    [Parameter(Mandatory)][string] $ProjectName,
    [Parameter(Mandatory)][string] $AgentName,
    [string] $AgentVersion = '',

    # Scope role assignments to the project instead of the whole account.
    [switch] $ScopeRolesToProject,

    [string] $VoiceName = 'en-US-Ava:DragonHDLatestNeural',
    [ValidateSet('photo', 'video', 'none')][string] $AvatarKind = 'photo',
    [string] $AvatarCharacter = 'camila',
    [string] $AvatarStyle = '',
    [string] $ApiVersion = '2025-10-01',
    [string] $Sku = 'B1'
)

$ErrorActionPreference = 'Stop'

if (-not $WebAppName) { $WebAppName = "voicedemo-$EnvName" }
$rg   = "rg-voicedemo-$EnvName"
$plan = "asp-voicedemo-$EnvName"

# Role definition IDs are stable; the display names are being renamed
# (Azure AI User -> Foundry User), so pin the IDs.
$roleIds = @{
    'Cognitive Services User' = 'a97b65f3-24c7-4388-baec-2e87135dc908'
    'Foundry User'            = '53ca6127-db72-4b80-b1b0-d745d6d5456d'
}

Write-Host "==> Resolving Foundry resource" -ForegroundColor Cyan
$accountId = az cognitiveservices account show -n $FoundryAccount -g $FoundryResourceGroup --query id -o tsv
if (-not $accountId) { throw "Foundry account '$FoundryAccount' not found in '$FoundryResourceGroup'." }

$endpoint = "https://$FoundryAccount.services.ai.azure.com"
$scope = if ($ScopeRolesToProject) { "$accountId/projects/$ProjectName" } else { $accountId }
Write-Host "    endpoint   : $endpoint"
Write-Host "    role scope : $scope"

Write-Host "==> Checking web app name availability" -ForegroundColor Cyan
$subId = az account show --query id -o tsv
$body  = '{\"name\":\"' + $WebAppName + '\",\"type\":\"Microsoft.Web/sites\"}'
$check = az rest --method post `
    --url "https://management.azure.com/subscriptions/$subId/providers/Microsoft.Web/checknameavailability?api-version=2023-12-01" `
    --headers "Content-Type=application/json" --body $body | ConvertFrom-Json
if (-not $check.nameAvailable) { throw "Web app name '$WebAppName' is unavailable: $($check.message)" }

Write-Host "==> Creating App Service ($Sku, $Location)" -ForegroundColor Cyan
az group create -n $rg -l $Location -o none
az appservice plan create -g $rg -n $plan --is-linux --sku $Sku -l $Location -o none
az webapp create -g $rg -p $plan -n $WebAppName --runtime 'NODE:22-lts' -o none

# WebSockets are OFF by default and are mandatory: the browser talks to this app
# over a WebSocket, which is proxied to Voice Live.
Write-Host "==> Enabling WebSockets / Always On / HTTPS-only" -ForegroundColor Cyan
az webapp config set -g $rg -n $WebAppName `
    --web-sockets-enabled true --always-on true --min-tls-version 1.2 --http20-enabled true -o none
az webapp update -g $rg -n $WebAppName --https-only true -o none

Write-Host "==> Applying app settings" -ForegroundColor Cyan
az webapp config appsettings set -g $rg -n $WebAppName -o none --settings `
    SCM_DO_BUILD_DURING_DEPLOYMENT=true `
    VOICELIVE_ENDPOINT="$endpoint" `
    VOICELIVE_API_VERSION="$ApiVersion" `
    AGENT_PROJECT_NAME="$ProjectName" `
    AGENT_NAME="$AgentName" `
    AGENT_VERSION="$AgentVersion" `
    AGENT_PARAM_STYLE='new' `
    VOICE_NAME="$VoiceName" `
    VOICE_TYPE='azure-standard' `
    VOICE_TEMPERATURE='0.8' `
    AVATAR_KIND="$AvatarKind" `
    AVATAR_CHARACTER="$AvatarCharacter" `
    AVATAR_STYLE="$AvatarStyle" `
    TURN_DETECTION_TYPE='azure_semantic_vad' `
    GREET_ON_CONNECT='true'

Write-Host "==> Granting the managed identity access to Foundry" -ForegroundColor Cyan
$principalId = az webapp identity assign -g $rg -n $WebAppName --query principalId -o tsv
foreach ($name in $roleIds.Keys) {
    az role assignment create `
        --assignee-object-id $principalId --assignee-principal-type ServicePrincipal `
        --role $roleIds[$name] --scope $scope -o none
    Write-Host "    granted $name"
}

Write-Host "==> Deploying code" -ForegroundColor Cyan
$zip = Join-Path ([System.IO.Path]::GetTempPath()) "voicedemo-$EnvName.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path package.json, package-lock.json, server.js, public, README.md -DestinationPath $zip
az webapp deploy -g $rg -n $WebAppName --src-path $zip --type zip -o none
Remove-Item $zip -ErrorAction SilentlyContinue

$url = "https://$WebAppName.azurewebsites.net"
Write-Host ""
Write-Host "Deployed: $url" -ForegroundColor Green
Write-Host "Role assignments can take a few minutes to take effect." -ForegroundColor Yellow
Write-Host "This app has no sign-in of its own. Enable Easy Auth before sharing the URL:" -ForegroundColor Yellow
Write-Host "  az webapp auth microsoft update -g $rg -n $WebAppName --client-id <app-id> --tenant-id <tenant> --yes"
Write-Host "  az webapp auth update -g $rg -n $WebAppName --enabled true --action RedirectToLoginPage"
