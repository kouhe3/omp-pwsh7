# pwsh7 runner - persistent PowerShell 7 session for the omp pwsh tool.
#
# Protocol (line-based, UTF-8, no length prefix needed - base64 is line-safe):
#   [stdin]  base64(JSON { id, code, env?, width?, format? }) + "\n"
#   [stdout] base64(JSON { type = 'chunk', id, text }) + "\n" (text format only, repeated)
#   [stdout] base64(JSON { type = 'result', id, output?, error?, exitCode? }) + "\n"
#
# Request code runs in a dedicated persistent runspace.  This is a security
# boundary: runner protocol state and environment restoration state stay in the
# protocol runspace, while user variables persist in the user runspace.

$ErrorActionPreference = 'Continue'

# UTF-8 everywhere - Windows console defaults to the ANSI codepage (GBK on zh-CN)
# and would garble non-ASCII output on the wire.
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Strip ANSI escape sequences from streamed output (pwsh 7.2+ colors only the
# host, but be explicit so piped capture never carries escape codes).
try { $PSStyle.OutputRendering = 'PlainText' } catch { }

$DEFAULT_WIDTH = 200

function Send-ProtocolFrame {
    param([hashtable]$Frame)

    $json = $Frame | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    [Console]::Out.WriteLine([Convert]::ToBase64String($bytes))
    [Console]::Out.Flush()
}

# The user runspace is intentionally not exposed to request code.  Unlike a
# child PowerShell scope, it retains variables, functions, and imported modules
# between invocations while leaving this protocol scope inaccessible.
$userRunspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
$userRunspace.Open()

try {
    while ($true) {
        $b64Line = [Console]::In.ReadLine()
        if ($null -eq $b64Line) { break }   # parent closed stdin -> exit
        $line = $b64Line.Trim()
        if ($line.Length -eq 0) { continue }

        $req = $null
        try {
            $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
            $req = $json | ConvertFrom-Json -AsHashtable
        } catch {
            Send-ProtocolFrame @{ type = 'result'; id = -1; error = "protocol decode failed: $($_.Exception.Message)" }
            continue
        }

        if ($null -eq $req -or $null -eq $req.id) { continue }

        # Keep every request's restoration state inside a fresh private dynamic
        # module.  The module is invoked inline and never assigned in this
        # shared protocol scope, so request code cannot discover or replace its
        # snapshot/dispatcher/setter variables.
$result = & (New-Module -ScriptBlock {}) {
            param($request, $persistentRunspace, $defaultWidth, $sendFrame)
            $envState = @()
            $seenEnvKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            $width = $defaultWidth
            if ($null -ne $request.width) {
                try {
                    $requestedWidth = [int]$request.width
                    if ($requestedWidth -ge 40 -and $requestedWidth -le 4096) {
                        $width = $requestedWidth
                    }
                } catch {
                    # Keep the safe default when a malformed width reaches the runner.
                }
            }

            $output = $null
            $errorText = $null
            $ps = [System.Management.Automation.PowerShell]::Create()
            $ps.Runspace = $persistentRunspace
            $outputBuffer = [System.Management.Automation.PSDataCollection[psobject]]::new()
            $persistentRunspace.SessionStateProxy.PSVariable.Set('LASTEXITCODE', $null)
            try {
                if ($request.env -and $request.env.Count -gt 0) {
                    # ConvertFrom-Json's default PSCustomObject rejects properties that
                    # differ only by case. -AsHashtable keeps both entries so the
                    # case-insensitive environment path below can apply them in order.
                    foreach ($entry in $request.env.GetEnumerator()) {
                        $name = [string]$entry.Key
                        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
                            throw "invalid env key: $name"
                        }
                    }
                    foreach ($entry in $request.env.GetEnumerator()) {
                        $name = [string]$entry.Key
                        # Env: is case-insensitive on Windows; snapshot each variable
                        # once even when JSON contains both (for example) Path and PATH.
                        if (-not $seenEnvKeys.Add($name)) {
                            Set-Item -Path ("Env:" + $name) -Value ([string]$entry.Value)
                            continue
                        }
                        $original = Get-Item -Path ("Env:" + $name) -ErrorAction SilentlyContinue
                        $envState += [pscustomobject]@{
                            Name = $name
                            Exists = $null -ne $original
                            Value = if ($null -ne $original) { [string]$original.Value } else { $null }
                        }
                        Set-Item -Path ("Env:" + $name) -Value ([string]$entry.Value)
                    }
                }

                # Pass request code as a pipeline argument instead of embedding it in
                # the generated script.  Embedding JSON in a double-quoted PowerShell
                # string performs a second interpolation pass, so user variables such
                # as `$v`/`$_` disappear and `=` can become a command token.
                $executionScript = @'
param($requestCode, $requestFormat, $requestWidth)
if ($requestFormat -eq 'json') {
    $captured = . ([scriptblock]::Create($requestCode)) 2>&1
    $output = ($captured | ConvertTo-Json -Depth 100 -Compress) -join [Environment]::NewLine
} else {
    . ([scriptblock]::Create($requestCode)) 2>&1 | Out-String -Width $requestWidth -Stream
    $output = $null
}
$runnerResult = [pscustomobject]@{
    Output = $output
    ExitCode = $LASTEXITCODE
}
$runnerResult.PSObject.TypeNames.Insert(0, 'Omp.Pwsh.RunnerResult')
$runnerResult
'@
                $null = $ps.AddScript($executionScript).AddArgument([string]$request.code).AddArgument($request.format).AddArgument($width)
                $asyncResult = $ps.BeginInvoke[psobject, psobject]($null, $outputBuffer)

                # Output collection events fire while the pipeline is running, so
                # text requests retain streaming behavior. JSON requests deliberately
                # wait for one final document.
                $textLines = [System.Collections.Generic.List[string]]::new()
                $exitCode = $null
                if ($request.format -ne 'json') {
                    while (-not $asyncResult.IsCompleted) {
                        while ($outputBuffer.Count -gt 0) {
                            $item = $outputBuffer[0]
                            $outputBuffer.RemoveAt(0)
                            if ($item.PSObject.TypeNames -contains 'Omp.Pwsh.RunnerResult') {
                                $exitCode = $item.ExitCode
                                continue
                            }
                            $text = [string]$item
                            $textLines.Add($text)
                            & $sendFrame @{ type = 'chunk'; id = $request.id; text = ($text + "`n") }
                        }
                        Start-Sleep -Milliseconds 10
                    }
                }
                $ps.EndInvoke($asyncResult)

                if ($request.format -eq 'json') {
                    foreach ($item in $outputBuffer) {
                        if ($item.PSObject.TypeNames -contains 'Omp.Pwsh.RunnerResult') {
                            $output = $item.Output
                            $exitCode = $item.ExitCode
                            break
                        }
                    }
                } else {
                    while ($outputBuffer.Count -gt 0) {
                        $item = $outputBuffer[0]
                        $outputBuffer.RemoveAt(0)
                        if ($item.PSObject.TypeNames -contains 'Omp.Pwsh.RunnerResult') {
                            $exitCode = $item.ExitCode
                            continue
                        }
                        $text = [string]$item
                        $textLines.Add($text)
                        & $sendFrame @{ type = 'chunk'; id = $request.id; text = ($text + "`n") }
                    }
                    # Reconstruct the same final text exposed by streamed chunks.
                    $output = if ($textLines.Count -gt 0) { ($textLines -join "`n") + "`n" } else { $null }
                }
                if ($ps.HadErrors) {
                    $errorText = (($ps.Streams.Error | ForEach-Object { $_.ToString() }) -join "`n")
                }
            } catch {
                $errorText = $_.Exception.Message
            } finally {
                if ($null -ne $ps) { $ps.Dispose() }
                # Restore in this private module scope before it is discarded.
                foreach ($state in $envState) {
                    if ($state.Exists) {
                        Set-Item -Path ("Env:" + $state.Name) -Value $state.Value
                    } else {
                        Remove-Item -Path ("Env:" + $state.Name) -ErrorAction SilentlyContinue
                    }
                }
            }

            [pscustomobject]@{
                Output = $output
                ErrorText = $errorText
                ExitCode = $exitCode
            }
        } $req $userRunspace $DEFAULT_WIDTH ${function:Send-ProtocolFrame}

        Send-ProtocolFrame @{
            type = 'result'
            id = $req.id
            output = $result.Output
            error = $result.ErrorText
            exitCode = $result.ExitCode
        }
    }
} finally {
    $userRunspace.Dispose()
}
