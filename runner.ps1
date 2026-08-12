# pwsh7 runner - persistent PowerShell 7 session for the omp pwsh tool.
#
# Protocol (line-based, UTF-8, no length prefix needed - base64 is line-safe):
#   [stdin]  base64(JSON { id, code, env?, width?, format? }) + "\n"
#   [stdout] base64(JSON { id, output?, error?, exitCode? }) + "\n"
#
# Critical: code is executed with dot-source (`. $sb`) so variable/module
# assignments persist in THIS process scope across requests. A call operator
# (`& $sb`) runs the script block in a child scope and state would be lost.

$ErrorActionPreference = 'Continue'

# UTF-8 everywhere - Windows console defaults to the ANSI codepage (GBK on zh-CN)
# and would garble non-ASCII output on the wire.
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Strip ANSI escape sequences from streamed output (pwsh 7.2+ colors only the
# host, but be explicit so piped capture never carries escape codes).
try { $PSStyle.OutputRendering = 'PlainText' } catch { }

$DEFAULT_WIDTH = 200

while ($true) {
    $b64Line = [Console]::In.ReadLine()
    if ($null -eq $b64Line) { break }   # parent closed stdin -> exit
    $line = $b64Line.Trim()
    if ($line.Length -eq 0) { continue }

    $req = $null
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
        $req = $json | ConvertFrom-Json
    } catch {
        $resp = @{ id = -1; error = "protocol decode failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($resp)))
        [Console]::Out.Flush()
        continue
    }

    if ($null -eq $req -or $null -eq $req.id) { continue }

    # Apply per-request env vars; remove them afterwards so the session is not polluted.
    $envKeys = @()
    if ($req.env -and $req.env.PSObject.Properties.Count -gt 0) {
        foreach ($prop in $req.env.PSObject.Properties) {
            $envKeys += $prop.Name
            Set-Item -Path ("Env:" + $prop.Name) -Value ([string]$prop.Value)
        }
    }

    $width = $DEFAULT_WIDTH
    if ($req.width -and $req.width -ge 40 -and $req.width -le 4096) { $width = [int]$req.width }

    $output = $null
    $errorText = $null
    try {
        $global:LASTEXITCODE = $null  # clear stale native exit code from prior requests
        $captured = . ([scriptblock]::Create([string]$req.code)) 2>&1
        if ($req.format -eq 'json') {
            $output = ($captured | ConvertTo-Json -Depth 8 -Compress) -join "`n"
        } else {
            $output = $captured | Out-String -Width $width
        }
    } catch {
        $errorText = $_.Exception.Message
    } finally {
        foreach ($k in $envKeys) { Remove-Item -Path ("Env:" + $k) -ErrorAction SilentlyContinue }
    }

    $resp = @{
        id = $req.id
        output = $output
        error = $errorText
        exitCode = $global:LASTEXITCODE
    } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($resp)))
    [Console]::Out.Flush()
}
