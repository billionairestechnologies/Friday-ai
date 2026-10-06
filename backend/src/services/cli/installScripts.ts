/**
 * The one-line installers for FridayX:
 *
 *   curl -fsSL https://<host>/x/install.sh | bash        (macOS, Linux, WSL)
 *   irm https://<host>/x/install.ps1 | iex                (Windows PowerShell)
 *   curl -fsSL https://<host>/x/install.cmd -o install.cmd && install.cmd && del install.cmd   (Windows CMD)
 *
 * They talk only to this server: /x/version (plain text), /x/download/<platform> (redirect to the release
 * binary) and /x/sha256/<platform> (plain text). Plain text on purpose — no JSON parser (jq) is assumed on
 * the user's machine — and the checksum is verified before anything is installed or put on PATH.
 */

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "windows-x64", "windows-arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export function isVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(value);
}

const SH = String.raw`#!/usr/bin/env bash
# FridayX installer — https://__BASE__/x/install.sh
set -euo pipefail

BASE="__API__"
VERSION="\${1:-latest}"
INSTALL_ROOT="\${FRIDAY_X_HOME:-$HOME/.friday}"
BIN_DIR="$INSTALL_ROOT/bin"

# Colour only when talking to a person.
if [ -t 1 ] && [ -z "\${NO_COLOR:-}" ]; then
  B=$'\x1b[1m'; D=$'\x1b[2m'; G=$'\x1b[32m'; R=$'\x1b[31m'; Y=$'\x1b[33m'; C=$'\x1b[36m'; Z=$'\x1b[0m'
else
  B=""; D=""; G=""; R=""; Y=""; C=""; Z=""
fi
ok()   { printf '  %s✓%s %s\n' "$G" "$Z" "$*"; }
note() { printf '  %s·%s %s%s%s\n' "$D" "$Z" "$D" "$*" "$Z"; }
die()  { printf '\n  %s✗ FridayX install failed:%s %s\n\n' "$R" "$Z" "$*" >&2; exit 1; }

printf '\n%s' "$B"
printf '  ┏━╸┏━┓╻┏━┓┏━┓╻ ╻╻ ╻\n'
printf '  ┣╸ ┣┳┛┃┃ ┃┣━┫┗┳┛┏╋┛\n'
printf '  ╹  ╹┗╸╹┗━┛╹ ╹ ╹ ╹ ╹\n'
printf '%s\n  %sFriday%s%s coding agent for your terminal and editor%s\n\n' "$Z" "$B" "$Z" "$D" "$Z"

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "curl or wget is required."
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }
# One progress bar, not two: resolve the download redirect first, then fetch the file itself.
resolve() {
  if command -v curl >/dev/null 2>&1; then
    loc="$(curl -fsS -o /dev/null -w '%{redirect_url}' "$1" || true)"; printf '%s' "\${loc:-$1}"
  else printf '%s' "$1"; fi
}
download() { if command -v curl >/dev/null 2>&1; then curl -fL -# -o "$2" "$1"; else wget -q --show-progress -O "$2" "$1"; fi; }

case "$(uname -s)" in
  Darwin) os="darwin"; os_name="macOS" ;;
  Linux) os="linux"; os_name="Linux" ;;
  *) die "unsupported system $(uname -s). On Windows use PowerShell: irm $BASE/x/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) die "unsupported CPU $(uname -m)." ;;
esac
# A Mac running under Rosetta reports x86_64 — prefer the native build.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then arch="arm64"; fi
platform="$os-$arch"
if [ "$os" = "linux" ] && { ldd --version 2>&1 | grep -qi musl || [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; }; then platform="$platform-musl"; fi
ok "Detected $os_name ($arch)"

if [ "$VERSION" = "latest" ]; then VERSION="$(fetch "$BASE/x/version" | tr -d '[:space:]')"; fi
[ -n "$VERSION" ] || die "couldn't find the latest version. Try again in a minute."
ok "Latest version is $B$VERSION$Z"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
note "Downloading…"
download "$(resolve "$BASE/x/download/$platform?version=$VERSION")" "$tmp/friday"
ok "Downloaded"
expected="$(fetch "$BASE/x/sha256/$platform?version=$VERSION" | tr -d '[:space:]')"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/friday" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "$tmp/friday" | cut -d' ' -f1)"; fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || die "the download didn't match its checksum, so it was not installed."
ok "Verified checksum ($D\${actual:0:12}…$Z)"

mkdir -p "$BIN_DIR"
chmod +x "$tmp/friday"
mv -f "$tmp/friday" "$BIN_DIR/friday"
[ "$os" = "darwin" ] && xattr -d com.apple.quarantine "$BIN_DIR/friday" 2>/dev/null || true
ok "Installed to $D$BIN_DIR/friday$Z"

# Make "friday" work in THIS terminal right away: link it into a writable folder that is already on PATH.
# (A piped script can't change its parent shell's PATH, so this is what avoids "command not found".)
linked=""
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) continue ;; esac
  [ -d "$d" ] && [ -w "$d" ] || continue
  # never replace a different program that happens to be called friday
  if [ -e "$d/friday" ] || [ -L "$d/friday" ]; then
    [ "$(readlink "$d/friday" 2>/dev/null || true)" = "$BIN_DIR/friday" ] || continue
  fi
  ln -sf "$BIN_DIR/friday" "$d/friday" && linked="$d" && break
done
if [ -n "$linked" ]; then
  ok "Linked into $D$linked$Z — just type "$B"friday"$Z" from now on"
else
  line="export PATH=\"$BIN_DIR:\$PATH\""
  add_path() { [ -f "$1" ] || [ "$2" = "create" ] || return 0; grep -qs "# friday-x" "$1" 2>/dev/null || printf '\n# friday-x\n%s\n' "$line" >> "$1"; }
  case "\${SHELL:-}" in
    */zsh) add_path "$HOME/.zshrc" create ;;
    */fish) mkdir -p "$HOME/.config/fish"; grep -qs "# friday-x" "$HOME/.config/fish/config.fish" 2>/dev/null || printf '\n# friday-x\nfish_add_path %s\n' "$BIN_DIR" >> "$HOME/.config/fish/config.fish" ;;
    *) add_path "$HOME/.bashrc" create; add_path "$HOME/.bash_profile" skip; add_path "$HOME/.zshrc" skip ;;
  esac
  ok "Added to your PATH — new terminals can run "$B"friday"$Z""
fi

printf '\n  %s%sFridayX %s is ready.%s\n' "$B" "$G" "$VERSION" "$Z"
printf '  %sSign in once with your Friday account, then it remembers you.%s\n\n' "$D" "$Z"

# Start it now when a person is at the keyboard (skip with FRIDAY_X_NO_LAUNCH=1).
if [ -z "\${FRIDAY_X_NO_LAUNCH:-}" ] && ( : </dev/tty ) 2>/dev/null; then
  printf '  %sStarting FridayX…%s\n\n' "$C" "$Z"
  exec "$BIN_DIR/friday" </dev/tty
fi
printf '  Run:  %sfriday%s\n' "$B" "$Z"
[ -n "$linked" ] || case ":$PATH:" in *":$BIN_DIR:"*) ;; *) printf '  %s(In this window first: export PATH="%s:$PATH")%s\n' "$D" "$BIN_DIR" "$Z" ;; esac
printf '\n'
`;

const PS1 = String.raw`# FridayX installer — https://__BASE__/x/install.ps1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Base = '__API__'
$Root = if ($env:FRIDAY_X_HOME) { $env:FRIDAY_X_HOME } else { Join-Path $env:USERPROFILE '.friday' }
$BinDir = Join-Path $Root 'bin'
function Ok($m) { Write-Host '  ' -NoNewline; Write-Host ([char]0x2713) -NoNewline -ForegroundColor Green; Write-Host " $m" }
function Note($m) { Write-Host "  - $m" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '  FridayX' -ForegroundColor White
Write-Host '  Friday coding agent for your terminal and editor' -ForegroundColor DarkGray
Write-Host ''

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$platform = if ($arch -eq 'ARM64') { 'windows-arm64' } else { 'windows-x64' }
Ok "Detected Windows ($platform)"
$version = if ($args.Count -gt 0) { $args[0] } else { 'latest' }
if ($version -eq 'latest') { $version = (Invoke-RestMethod "$Base/x/version").ToString().Trim() }
if (-not $version) { throw "Couldn't find the latest version. Try again in a minute." }
Ok "Latest version is $version"

Note 'Downloading...'
# Download beside the install folder, not into %TEMP%: an unsigned .exe written to Temp and moved out is a
# dropper pattern Defender watches for. The extension stays off until the checksum passes.
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$exe = Join-Path $BinDir 'friday.exe'
$tmp = Join-Path $BinDir 'friday.exe.download'
try {
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest "$Base/x/download/$platform?version=$version" -OutFile $tmp -UseBasicParsing
  Ok 'Downloaded'
  $expected = (Invoke-RestMethod "$Base/x/sha256/$platform?version=$version").ToString().Trim().ToLower()
  $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw 'The download did not match its checksum, so it was not installed.' }
  Ok "Verified checksum ($($actual.Substring(0,12))...)"
  # A running friday.exe can't be overwritten but can be renamed, so updating never fails with "access denied".
  if (Test-Path "$exe.old") { Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue }
  if (Test-Path $exe) { Rename-Item -Force $exe 'friday.exe.old' }
  Move-Item -Force $tmp $exe
} finally { if (Test-Path $tmp) { Remove-Item -Force $tmp } }
Ok "Installed to $BinDir"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $BinDir), 'User')
}
# This window too, so "friday" works straight away.
if (($env:Path -split ';') -notcontains $BinDir) { $env:Path += ";$BinDir" }
Ok 'Added to your PATH - just type friday from now on'

Write-Host ''
Write-Host "  FridayX $version is ready." -ForegroundColor Green
Write-Host '  Sign in once with your Friday account, then it remembers you.' -ForegroundColor DarkGray
Write-Host ''
if ([Environment]::UserInteractive -and -not $env:FRIDAY_X_NO_LAUNCH) {
  Write-Host '  Starting FridayX...' -ForegroundColor Cyan
  Write-Host ''
  & (Join-Path $BinDir 'friday.exe')
} else {
  Write-Host '  Run:  friday'
}
`;

// Pure CMD on purpose. The first version shelled out to `powershell -ExecutionPolicy Bypass -Command "irm … | iex"`;
// a .cmd that downloads and pipes a script into PowerShell with the execution policy bypassed is the textbook
// malware "download cradle", so Microsoft Defender flagged it ("Threats found") and Windows refused to start it
// ("Access is denied.") on a real install on 2026-10-06. This one uses only curl.exe and certutil -hashfile, both
// built into Windows 10 1803+ / 11, never touches PowerShell, never writes an .exe to %TEMP%, and verifies the
// checksum before the binary is put in place. Labels + goto instead of ( ) blocks so a PATH containing
// "Program Files (x86)" can't break the parser. No backticks: this file is a JS template literal.
const CMD = String.raw`@echo off
rem FridayX installer for Windows CMD - https://__BASE__/x/install.cmd
setlocal EnableExtensions DisableDelayedExpansion
set "BASE=__API__"
set "VERSION=%~1"
if "%VERSION%"=="" set "VERSION=latest"
set "ROOT=%USERPROFILE%\.friday"
if defined FRIDAY_X_HOME set "ROOT=%FRIDAY_X_HOME%"
set "BIN=%ROOT%\bin"
set "EXE=%BIN%\friday.exe"
set "PART=%BIN%\friday.exe.download"

echo.
echo   FridayX
echo   Friday coding agent for your terminal and editor
echo.

where curl.exe >nul 2>&1 || goto :nocurl
set "PLATFORM=windows-x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PLATFORM=windows-arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "PLATFORM=windows-arm64"
echo   + Detected Windows (%PLATFORM%)

if /i not "%VERSION%"=="latest" goto :haveversion
set "VERSION="
for /f "delims=" %%v in ('curl.exe -fsSL "%BASE%/x/version"') do set "VERSION=%%v"
:haveversion
if "%VERSION%"=="" goto :noversion
echo   + Latest version is %VERSION%

if not exist "%BIN%" mkdir "%BIN%" || goto :nodir
if exist "%PART%" del /f /q "%PART%" >nul 2>&1
echo   - Downloading...
curl.exe -fL --progress-bar -o "%PART%" "%BASE%/x/download/%PLATFORM%?version=%VERSION%" || goto :nodownload
echo   + Downloaded

set "EXPECTED="
for /f "delims=" %%h in ('curl.exe -fsSL "%BASE%/x/sha256/%PLATFORM%?version=%VERSION%"') do set "EXPECTED=%%h"
set "ACTUAL="
for /f "delims=" %%h in ('certutil -hashfile "%PART%" SHA256 ^| findstr /v ":"') do set "ACTUAL=%%h"
set "ACTUAL=%ACTUAL: =%"
if "%EXPECTED%"=="" goto :badsum
if /i not "%EXPECTED%"=="%ACTUAL%" goto :badsum
echo   + Verified checksum (%ACTUAL:~0,12%...)

rem A running friday.exe can't be overwritten but it can be renamed, so an update never fails on "in use".
if exist "%EXE%.old" del /f /q "%EXE%.old" >nul 2>&1
if exist "%EXE%" move /y "%EXE%" "%EXE%.old" >nul 2>&1
move /y "%PART%" "%EXE%" >nul || goto :nomove
echo   + Installed to %BIN%

rem User PATH via the registry (setx would cut a long PATH at 1024 characters).
set "UPATH="
for /f "skip=2 tokens=2,*" %%a in ('reg query HKCU\Environment /v Path 2^>nul') do set "UPATH=%%b"
echo ";%UPATH%;" | find /i ";%BIN%;" >nul && goto :pathdone
if "%UPATH%"=="" goto :pathnew
reg add HKCU\Environment /v Path /t REG_EXPAND_SZ /d "%UPATH%;%BIN%" /f >nul
goto :pathbroadcast
:pathnew
reg add HKCU\Environment /v Path /t REG_EXPAND_SZ /d "%BIN%" /f >nul
:pathbroadcast
rem setx on a harmless variable makes Windows tell new terminals that the environment changed.
setx FRIDAY_X_HOME "%ROOT%" >nul 2>&1
:pathdone
echo   + Added to your PATH - just type friday from now on

echo.
echo   FridayX %VERSION% is ready.
echo   Sign in once with your Friday account, then it remembers you.
echo.
rem Keep PATH for THIS window after endlocal so "friday" works straight away.
endlocal & set "PATH=%PATH%;%BIN%" & set "FRIDAY_X_EXE=%EXE%"
if defined FRIDAY_X_NO_LAUNCH goto :eof
echo   Starting FridayX...
echo.
"%FRIDAY_X_EXE%"
goto :eof

:nocurl
echo   FridayX install failed: curl.exe was not found (it ships with Windows 10 1803 and later).
exit /b 1
:noversion
echo   FridayX install failed: couldn't find the latest version. Check your internet and try again in a minute.
exit /b 1
:nodir
echo   FridayX install failed: couldn't create %BIN%.
exit /b 1
:nodownload
if exist "%PART%" del /f /q "%PART%" >nul 2>&1
echo   FridayX install failed: the download didn't finish. Check your internet and try again.
exit /b 1
:badsum
if exist "%PART%" del /f /q "%PART%" >nul 2>&1
echo   FridayX install failed: the download didn't match its checksum, so it was not installed.
exit /b 1
:nomove
if exist "%EXE%.old" if not exist "%EXE%" move /y "%EXE%.old" "%EXE%" >nul 2>&1
echo   FridayX install failed: Windows wouldn't let us write %EXE%.
echo   If Windows Security just showed "Threats found", open Windows Security - Protection history,
echo   and send the details to Friday support so we can clear it with Microsoft.
exit /b 1
`;

function fill(template: string, apiBase: string): string {
  const api = apiBase.replace(/\/+$/, "");
  return template.replaceAll("__API__", api).replaceAll("__BASE__", api.replace(/^https?:\/\//, "")).replaceAll("\\${", "${");
}

export const installShell = (apiBase: string) => fill(SH, apiBase);
export const installPowerShell = (apiBase: string) => fill(PS1, apiBase);
export const installCmd = (apiBase: string) => fill(CMD, apiBase).replace(/\n/g, "\r\n");
