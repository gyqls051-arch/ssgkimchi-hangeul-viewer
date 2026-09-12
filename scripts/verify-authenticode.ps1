[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$PolicyPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ApplicationPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-Condition {
  param(
    [Parameter(Mandatory = $true)]
    [bool]$Condition,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Get-NormalizedThumbprint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Thumbprint
  )

  return ($Thumbprint -replace '[\s:-]', '').ToUpperInvariant()
}

function Resolve-RegularFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,

    [Parameter(Mandatory = $true)]
    [string]$Description,

    [string]$ExpectedExtension
  )

  $resolved = Resolve-Path -LiteralPath $LiteralPath
  $item = Get-Item -LiteralPath $resolved.Path -Force
  Assert-Condition (-not $item.PSIsContainer) "$Description must be a regular file"
  Assert-Condition (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) "$Description must not be a symlink or reparse point"
  if (-not [string]::IsNullOrEmpty($ExpectedExtension)) {
    Assert-Condition ($item.Extension -ceq $ExpectedExtension) "$Description must have the $ExpectedExtension extension"
  }
  return $item.FullName
}

function Find-SignTool {
  $command = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Source
  }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path -LiteralPath $kitsRoot) {
    $candidates = @(
      Get-ChildItem -Path (Join-Path $kitsRoot '*\x64\signtool.exe') -File -ErrorAction SilentlyContinue |
        Sort-Object -Property FullName -Descending
    )
    if ($candidates.Count -gt 0) {
      return $candidates[0].FullName
    }
  }

  throw 'signtool.exe was not found in PATH or the Windows SDK'
}

function Test-CodeSigningEku {
  param(
    [Parameter(Mandatory = $true)]
    [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate
  )

  foreach ($extension in $Certificate.Extensions) {
    if ($extension.Oid.Value -eq '2.5.29.37') {
      $enhancedKeyUsage = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$extension
      foreach ($usage in $enhancedKeyUsage.EnhancedKeyUsages) {
        if ($usage.Value -eq '1.3.6.1.5.5.7.3.3') {
          return $true
        }
      }
    }
  }

  return $false
}

function Test-SignedExecutable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Role,

    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$SignToolPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedPublisherName,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedSubject,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedThumbprint,

    [Parameter(Mandatory = $true)]
    [bool]$RequireTimestamp
  )

  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  Assert-Condition ($signature.Status.ToString() -ceq 'Valid') "$Role Authenticode status is $($signature.Status), expected Valid"
  Assert-Condition ($null -ne $signature.SignerCertificate) "$Role has no signer certificate"

  $certificate = $signature.SignerCertificate
  $publisherName = $certificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  $thumbprint = Get-NormalizedThumbprint $certificate.Thumbprint

  Assert-Condition ($publisherName -ceq $ExpectedPublisherName) "$Role certificate simple name does not exactly match policy"
  Assert-Condition ($certificate.Subject -ceq $ExpectedSubject) "$Role certificate full subject does not exactly match policy"
  Assert-Condition ($thumbprint -ceq $ExpectedThumbprint) "$Role certificate thumbprint does not match policy"
  Assert-Condition (Test-CodeSigningEku $certificate) "$Role certificate does not contain the Code Signing enhanced key usage"
  Assert-Condition ($certificate.NotBefore -lt $certificate.NotAfter) "$Role certificate has an invalid validity interval"

  $signToolOutput = (& $SignToolPath verify /pa /all /v $Path 2>&1 | Out-String)
  Assert-Condition ($LASTEXITCODE -eq 0) "$Role failed signtool trust verification"
  Assert-Condition ($signToolOutput -match 'Successfully verified') "$Role signtool output did not confirm successful verification"

  $timestampCertificate = $null
  if ($signature.PSObject.Properties.Name -contains 'TimeStamperCertificate') {
    $timestampCertificate = $signature.TimeStamperCertificate
  }
  $timestamped = $null -ne $timestampCertificate
  if ($RequireTimestamp) {
    Assert-Condition $timestamped "$Role signature does not contain a trusted Authenticode timestamp"
  }

  $timestampSubject = $null
  $timestampThumbprint = $null
  if ($timestamped) {
    $timestampSubject = $timestampCertificate.Subject
    $timestampThumbprint = Get-NormalizedThumbprint $timestampCertificate.Thumbprint
  }

  return [ordered]@{
    role = $Role
    file = [System.IO.Path]::GetFileName($Path)
    status = 'Valid'
    publisherName = $publisherName
    subject = $certificate.Subject
    thumbprint = $thumbprint
    timestamped = $timestamped
    timestampSubject = $timestampSubject
    timestampThumbprint = $timestampThumbprint
  }
}

$resolvedPolicyPath = Resolve-RegularFile -LiteralPath $PolicyPath -Description 'Release policy'
$policy = Get-Content -LiteralPath $resolvedPolicyPath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 32
Assert-Condition ($policy.schemaVersion -eq 1) 'Unsupported release policy schemaVersion'
Assert-Condition ($policy.windows.requireTimestamp -eq $true) 'Release policy must require Authenticode timestamps'

$publisherName = [string]$policy.windows.publisherName
$certificateSubject = [string]$policy.windows.certificateSubject
$certificateThumbprint = Get-NormalizedThumbprint ([string]$policy.windows.certificateThumbprint)
Assert-Condition (-not ($publisherName -match '^(REPLACE|CONFIGURE|CHANGEME|TODO|__)')) 'Publisher name is still a placeholder'
Assert-Condition (-not ($certificateSubject -match '^(REPLACE|CONFIGURE|CHANGEME|TODO|__)')) 'Certificate subject is still a placeholder'
Assert-Condition ($certificateSubject.Contains('=')) 'Certificate subject must be the exact full distinguished name'
Assert-Condition ($certificateThumbprint -match '^[0-9A-F]{40}$') 'Certificate thumbprint must normalize to 40 hexadecimal characters'

$installer = Resolve-RegularFile -LiteralPath $InstallerPath -Description 'Installer' -ExpectedExtension '.exe'
$application = Resolve-RegularFile -LiteralPath $ApplicationPath -Description 'Unpacked application' -ExpectedExtension '.exe'
Assert-Condition ($installer -cne $application) 'Installer and unpacked application paths must be different'
Assert-Condition ([System.IO.Path]::GetFileName($application) -ceq [string]$policy.windows.productExecutable) 'Unpacked application filename does not match policy'

$signTool = Find-SignTool
$signatures = @(
  Test-SignedExecutable -Role 'installer' -Path $installer -SignToolPath $signTool -ExpectedPublisherName $publisherName -ExpectedSubject $certificateSubject -ExpectedThumbprint $certificateThumbprint -RequireTimestamp $true
  Test-SignedExecutable -Role 'application' -Path $application -SignToolPath $signTool -ExpectedPublisherName $publisherName -ExpectedSubject $certificateSubject -ExpectedThumbprint $certificateThumbprint -RequireTimestamp $true
)

$report = [ordered]@{
  schemaVersion = 1
  signatures = $signatures
}
$json = $report | ConvertTo-Json -Depth 16
$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [System.IO.Path]::GetDirectoryName($outputFullPath)
Assert-Condition ([System.IO.Directory]::Exists($outputDirectory)) 'Signature report output directory must already exist'
[System.IO.File]::WriteAllText($outputFullPath, ($json + "`n"), [System.Text.UTF8Encoding]::new($false))

Write-Host "Verified Authenticode signatures for installer and unpacked application."
