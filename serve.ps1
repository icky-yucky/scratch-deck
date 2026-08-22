$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$loopDir = Join-Path $root "loops"
$port = 8000
if (-not (Test-Path $loopDir)) { New-Item -ItemType Directory -Path $loopDir | Out-Null }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$port/"
Write-Host "Saving loops to $loopDir"

$mime = @{
  ".html" = "text/html"
  ".js"   = "application/javascript"
  ".css"  = "text/css"
  ".mp3"  = "audio/mpeg"
  ".wav"  = "audio/wav"
}

function Write-Text($res, $text, $type) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $res.ContentType = $type
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $req = $context.Request
  $res = $context.Response
  try {
    $path = $req.Url.LocalPath

    # --- API: list saved loops ---
    if ($path -eq "/api/loops" -and $req.HttpMethod -eq "GET") {
      $files = @(Get-ChildItem $loopDir -Filter *.wav -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending |
                 ForEach-Object { $_.Name })
      Write-Text $res (ConvertTo-Json $files -Compress) "application/json"
      $res.OutputStream.Close()
      continue
    }

    # --- API: delete a saved loop (?name=x.wav) ---
    if ($path -eq "/api/loops/delete" -and $req.HttpMethod -eq "POST") {
      $name = [System.IO.Path]::GetFileName($req.QueryString["name"])
      $target = Join-Path $loopDir $name
      if ($name -and (Test-Path $target -PathType Leaf)) {
        Remove-Item -LiteralPath $target -Force
        Write-Host "Deleted $name"
        Write-Text $res (ConvertTo-Json @{ ok = $true; name = $name } -Compress) "application/json"
      } else {
        $res.StatusCode = 404
        Write-Text $res (ConvertTo-Json @{ ok = $false; error = "not found" } -Compress) "application/json"
      }
      $res.OutputStream.Close()
      continue
    }

    # --- API: rename a saved loop (?from=old.wav&to=new.wav) ---
    if ($path -eq "/api/loops/rename" -and $req.HttpMethod -eq "POST") {
      $from = [System.IO.Path]::GetFileName($req.QueryString["from"])
      $to   = [System.IO.Path]::GetFileName($req.QueryString["to"])
      $to   = ($to -replace '[^A-Za-z0-9._-]', '_')
      if (-not $to.ToLower().EndsWith(".wav")) { $to = "$to.wav" }
      $src = Join-Path $loopDir $from
      $dst = Join-Path $loopDir $to
      if (-not (Test-Path $src -PathType Leaf)) {
        $res.StatusCode = 404
        Write-Text $res (ConvertTo-Json @{ ok = $false; error = "not found" } -Compress) "application/json"
      } elseif (Test-Path $dst -PathType Leaf) {
        # refuse rather than silently clobber an existing loop
        $res.StatusCode = 409
        Write-Text $res (ConvertTo-Json @{ ok = $false; error = "name already exists" } -Compress) "application/json"
      } else {
        Rename-Item -LiteralPath $src -NewName $to
        Write-Host "Renamed $from -> $to"
        Write-Text $res (ConvertTo-Json @{ ok = $true; name = $to } -Compress) "application/json"
      }
      $res.OutputStream.Close()
      continue
    }

    # --- API: save a loop (raw body = wav bytes, ?name= filename) ---
    if ($path -eq "/api/loops" -and $req.HttpMethod -eq "POST") {
      $name = $req.QueryString["name"]
      if (-not $name) { $name = "loop.wav" }
      # keep the filename inside the loops folder: strip any path, allow a safe charset only
      $name = [System.IO.Path]::GetFileName($name)
      $name = ($name -replace '[^A-Za-z0-9._-]', '_')
      if (-not $name.ToLower().EndsWith(".wav")) { $name = "$name.wav" }
      $target = Join-Path $loopDir $name
      $ms = New-Object System.IO.MemoryStream
      $req.InputStream.CopyTo($ms)
      [System.IO.File]::WriteAllBytes($target, $ms.ToArray())
      $ms.Dispose()
      Write-Host "Saved $target ($($ms.Length) bytes)"
      Write-Text $res (ConvertTo-Json @{ ok = $true; name = $name } -Compress) "application/json"
      $res.OutputStream.Close()
      continue
    }

    # --- static files ---
    if ($path -eq "/") { $path = "/index.html" }
    $filePath = Join-Path $root ($path.TrimStart("/"))
    $fullPath = [System.IO.Path]::GetFullPath($filePath)
    # don't serve anything outside the project folder
    if (-not $fullPath.StartsWith([System.IO.Path]::GetFullPath($root))) {
      $res.StatusCode = 403
      $res.OutputStream.Close()
      continue
    }
    if (Test-Path $fullPath -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($fullPath)
      $contentType = $mime[$ext]
      if (-not $contentType) { $contentType = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($fullPath)
      $res.ContentType = $contentType
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
  } catch {
    Write-Host "ERR $($_.Exception.Message)"
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}
