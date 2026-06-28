param(
  [string]$OutPath,
  [switch]$NoNetwork
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutPath) {
  $OutPath = Join-Path $Root "data\signatures.json"
}

$Sources = @(
  [ordered]@{
    name = "Flock-You Wi-Fi OUI research"
    url = "https://raw.githubusercontent.com/colonelpanichacks/flock-you/HEAD/datasets/NitekryDPaul_wifi_ouis.md"
    kind = "wifi"
  },
  [ordered]@{
    name = "OUI-Spy Unified Blue README"
    url = "https://raw.githubusercontent.com/colonelpanichacks/oui-spy-unified-blue/HEAD/README.md"
    kind = "ble-notes"
  },
  [ordered]@{
    name = "OUI-Spy Unified Blue Flock-You source"
    url = "https://raw.githubusercontent.com/colonelpanichacks/oui-spy-unified-blue/HEAD/src/raw/flockyou.cpp"
    kind = "ble-source"
  },
  [ordered]@{
    name = "WiFiMothership Flock detector confidence notes"
    url = "https://wifimothership.com/flock"
    kind = "detector-confidence"
  }
)

$BaselinePrefixes = @(
  "70:c9:4e", "3c:91:80", "d8:f3:bc", "80:30:49", "b8:35:32",
  "14:5a:fc", "74:4c:a1", "08:3a:88", "9c:2f:9d", "c0:35:32",
  "94:08:53", "e4:aa:ea", "f4:6a:dd", "24:b2:b9", "00:f4:8d",
  "d0:39:57", "e8:d0:fc", "e0:4f:43", "b8:1e:a4", "70:08:94",
  "58:8e:81", "ec:1b:bd", "3c:71:bf", "58:00:e3", "90:35:ea",
  "5c:93:a2", "64:6e:69", "48:27:ea", "a4:cf:12", "04:0d:84",
  "f0:82:c0", "1c:34:f1", "38:5b:44", "94:34:69", "b4:e3:f9",
  "b4:1e:52", "14:b5:cd", "94:2a:6f", "f4:e2:c6", "d4:11:d6",
  "e0:0a:f6", "82:6b:f2"
)

$BaselineNames = @("FS Ext Battery", "Penguin", "Flock", "Pigvision")
$BaselineWifiSsidPatterns = @(
  [ordered]@{ pattern = "^Flock-[A-Z0-9]+$"; label = "flock-wifi-ssid"; confidence = 88; match = "regex" },
  [ordered]@{ pattern = "FS Ext Battery"; label = "flock-wifi-battery-ssid"; confidence = 86; match = "contains" },
  [ordered]@{ pattern = "Penguin"; label = "flock-wifi-penguin-ssid"; confidence = 84; match = "contains" },
  [ordered]@{ pattern = "Pigvision"; label = "flock-wifi-pigvision-ssid"; confidence = 84; match = "contains" }
)
$BaselineManufacturerIds = @(0x09C8)
$BaselineRavenServiceUuids = @(
  "0000180a-0000-1000-8000-00805f9b34fb",
  "00003100-0000-1000-8000-00805f9b34fb",
  "00003200-0000-1000-8000-00805f9b34fb",
  "00003300-0000-1000-8000-00805f9b34fb",
  "00003400-0000-1000-8000-00805f9b34fb",
  "00003500-0000-1000-8000-00805f9b34fb",
  "00001809-0000-1000-8000-00805f9b34fb",
  "00001819-0000-1000-8000-00805f9b34fb"
)

$RemovedPrefixes = New-Object "System.Collections.Generic.HashSet[string]"
foreach ($prefix in @("f8:a2:d6", "cc:cc:cc", "00:0c:e7")) {
  [void]$RemovedPrefixes.Add($prefix)
}

$PrefixSeen = New-Object "System.Collections.Generic.HashSet[string]"
$Prefixes = New-Object "System.Collections.Generic.List[string]"
$NameSeen = New-Object "System.Collections.Generic.HashSet[string]"
$Names = New-Object "System.Collections.Generic.List[string]"
$ManufacturerSeen = New-Object "System.Collections.Generic.HashSet[int]"
$ManufacturerIds = New-Object "System.Collections.Generic.List[int]"
$RavenSeen = New-Object "System.Collections.Generic.HashSet[string]"
$RavenServiceUuids = New-Object "System.Collections.Generic.List[string]"

function Add-Prefix {
  param([string]$Prefix)
  $normalized = $Prefix.ToLowerInvariant()
  if ($RemovedPrefixes.Contains($normalized)) {
    return
  }
  if ($PrefixSeen.Add($normalized)) {
    $Prefixes.Add($normalized)
  }
}

function Add-Name {
  param([string]$Name)
  $clean = $Name.Trim()
  if ($clean.Length -eq 0) {
    return
  }
  if ($NameSeen.Add($clean.ToLowerInvariant())) {
    $Names.Add($clean)
  }
}

function Add-ManufacturerId {
  param([int]$Id)
  if ($ManufacturerSeen.Add($Id)) {
    $ManufacturerIds.Add($Id)
  }
}

function Add-RavenUuid {
  param([string]$Uuid)
  $normalized = $Uuid.ToLowerInvariant()
  if ($RavenSeen.Add($normalized)) {
    $RavenServiceUuids.Add($normalized)
  }
}

foreach ($prefix in $BaselinePrefixes) {
  Add-Prefix -Prefix $prefix
}
foreach ($name in $BaselineNames) {
  Add-Name -Name $name
}
foreach ($id in $BaselineManufacturerIds) {
  Add-ManufacturerId -Id $id
}
foreach ($uuid in $BaselineRavenServiceUuids) {
  Add-RavenUuid -Uuid $uuid
}

$sourceResults = @()
$headers = @{ "User-Agent" = "RoadLens Scout signature updater" }
$macRegex = [regex]"(?i)\b[0-9a-f]{2}(?::[0-9a-f]{2}){2}\b"
$uuidRegex = [regex]"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"

foreach ($source in $Sources) {
  $result = [ordered]@{
    name = $source.name
    url = $source.url
    kind = $source.kind
    retrievedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    ok = $false
    prefixes = 0
    names = 0
    manufacturerIds = 0
    ravenServiceUuids = 0
    wifiSsidPatterns = 0
  }

  try {
    if ($NoNetwork) {
      throw "Network fetch disabled"
    }

    $content = (Invoke-WebRequest -Uri $source.url -UseBasicParsing -Headers $headers -TimeoutSec 35).Content

    $matchedPrefixes = New-Object "System.Collections.Generic.HashSet[string]"
    foreach ($match in $macRegex.Matches($content)) {
      $normalizedPrefix = $match.Value.ToLowerInvariant()
      if (-not $RemovedPrefixes.Contains($normalizedPrefix)) {
        [void]$matchedPrefixes.Add($normalizedPrefix)
      }
      Add-Prefix -Prefix $match.Value
    }
    $result.prefixes = $matchedPrefixes.Count

    $matchedNames = 0
    foreach ($name in $BaselineNames) {
      if ($content.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $matchedNames++
        Add-Name -Name $name
      }
    }
    $result.names = $matchedNames

    if ($content.IndexOf("0x09C8", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $content.IndexOf("XUNTONG", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Add-ManufacturerId -Id 0x09C8
      $result.manufacturerIds = 1
    }

    foreach ($pattern in $BaselineWifiSsidPatterns) {
      if ($content.IndexOf([string]$pattern.pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          $content.IndexOf([string]$pattern.label, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $result.wifiSsidPatterns++
      }
    }

    $matchedRaven = New-Object "System.Collections.Generic.HashSet[string]"
    foreach ($match in $uuidRegex.Matches($content)) {
      [void]$matchedRaven.Add($match.Value.ToLowerInvariant())
      Add-RavenUuid -Uuid $match.Value
    }
    $result.ravenServiceUuids = $matchedRaven.Count
    $result.ok = $true
  } catch {
    $result.error = $_.Exception.Message
  }

  $sourceResults += $result
}

if ($Prefixes.Count -lt 30) {
  throw "Signature update produced only $($Prefixes.Count) Wi-Fi prefixes."
}

$wifiPrefixes = @()
foreach ($prefix in $Prefixes) {
  $firstByte = [Convert]::ToInt32($prefix.Substring(0, 2), 16)
  $allowLocalAdministered = (($firstByte -band 0x02) -ne 0)
  $wifiPrefixes += [ordered]@{
    prefix = $prefix
    label = if ($prefix -eq "82:6b:f2") { "flock-wifi-wildcard" } else { "flock-wifi" }
    allowLocalAdministered = $allowLocalAdministered
    wildcardProbe = ($prefix -eq "82:6b:f2")
  }
}

$ssidHashInput = ($BaselineWifiSsidPatterns | ForEach-Object {
  "{0}:{1}:{2}:{3}" -f $_.pattern, $_.label, $_.confidence, $_.match
}) -join ","
$hashInput = (($Prefixes -join ",") + "|" + ($Names -join ",") + "|" + ($ManufacturerIds -join ",") + "|" + ($RavenServiceUuids -join ",") + "|" + $ssidHashInput)
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($hashInput))
} finally {
  $sha.Dispose()
}
$hashHex = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
$version = "{0}.{1}" -f (Get-Date).ToUniversalTime().ToString("yyyy.MM.dd"), $hashHex.Substring(0, 8)

$feed = [ordered]@{
  schema = 1
  name = "RoadLens Scout Detection Signatures"
  version = $version
  generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  sources = $sourceResults
  wifiPrefixes = $wifiPrefixes
  blePrefixes = @($Prefixes)
  bleNamePatterns = @($Names)
  bleManufacturerIds = @($ManufacturerIds)
  ravenServiceUuids = @($RavenServiceUuids)
  wifiSsidPatterns = @($BaselineWifiSsidPatterns)
  removedPrefixes = @($RemovedPrefixes | Sort-Object)
}

$json = $feed | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$outDir = Split-Path -Parent $OutPath
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
[System.IO.File]::WriteAllText($OutPath, $json + "`n", $utf8NoBom)

$appPublic = Join-Path $Root "app\public"
New-Item -ItemType Directory -Force -Path $appPublic | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appPublic "signatures.json"), $json + "`n", $utf8NoBom)

"Signature feed updated:"
"  $OutPath"
"  $(Join-Path $appPublic "signatures.json")"
"  version: $version"
"  Wi-Fi prefixes: $($Prefixes.Count)"
"  BLE names: $($Names.Count)"
"  BLE manufacturer IDs: $($ManufacturerIds.Count)"
"  Raven service UUIDs: $($RavenServiceUuids.Count)"
"  Wi-Fi SSID patterns: $($BaselineWifiSsidPatterns.Count)"
