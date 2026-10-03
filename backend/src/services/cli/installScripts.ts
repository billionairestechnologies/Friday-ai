/**
 * The one-line installers for Friday X:
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
# Friday X installer — https://__BASE__/x/install.sh
set -euo pipefail

BASE="__API__"
VERSION="\${1:-latest}"
INSTALL_ROOT="\${FRIDAY_X_HOME:-$HOME/.friday}"
BIN_DIR="$INSTALL_ROOT/bin"

say() { printf '%s\n' "$*"; }
die() { printf 'Friday X install failed: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "curl or wget is required."
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }
download() { if command -v curl >/dev/null 2>&1; then curl -fL --progress-bar -o "$2" "$1"; else wget -q --show-progress -O "$2" "$1"; fi; }

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
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

if [ "$VERSION" = "latest" ]; then VERSION="$(fetch "$BASE/x/version" | tr -d '[:space:]')"; fi
[ -n "$VERSION" ] || die "couldn't find the latest version. Try again in a minute."

say "Installing Friday X $VERSION ($platform)…"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
download "$BASE/x/download/$platform?version=$VERSION" "$tmp/friday"
expected="$(fetch "$BASE/x/sha256/$platform?version=$VERSION" | tr -d '[:space:]')"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/friday" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "$tmp/friday" | cut -d' ' -f1)"; fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || die "the download didn't match its checksum, so it was not installed."

mkdir -p "$BIN_DIR"
chmod +x "$tmp/friday"
mv -f "$tmp/friday" "$BIN_DIR/friday"
[ "$os" = "darwin" ] && xattr -d com.apple.quarantine "$BIN_DIR/friday" 2>/dev/null || true

# Put it on PATH once, in the shell the user actually uses.
line="export PATH=\"$BIN_DIR:\$PATH\""
add_path() { [ -f "$1" ] || [ "$2" = "create" ] || return 0; grep -qs "# friday-x" "$1" 2>/dev/null || printf '\n# friday-x\n%s\n' "$line" >> "$1"; }
case "\${SHELL:-}" in
  */zsh) add_path "$HOME/.zshrc" create ;;
  */fish) mkdir -p "$HOME/.config/fish"; grep -qs "# friday-x" "$HOME/.config/fish/config.fish" 2>/dev/null || printf '\n# friday-x\nfish_add_path %s\n' "$BIN_DIR" >> "$HOME/.config/fish/config.fish" ;;
  *) add_path "$HOME/.bashrc" create; add_path "$HOME/.bash_profile" skip; add_path "$HOME/.zshrc" skip ;;
esac

say ""
say "Friday X $VERSION is installed. Open a new terminal, then run:"
say "    friday"
say "The first run opens your browser to sign in with your Friday account."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "(To use it in this window now: export PATH=\"$BIN_DIR:\$PATH\")" ;; esac
`;

const PS1 = String.raw`# Friday X installer — https://__BASE__/x/install.ps1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Base = '__API__'
$Root = if ($env:FRIDAY_X_HOME) { $env:FRIDAY_X_HOME } else { Join-Path $env:USERPROFILE '.friday' }
$BinDir = Join-Path $Root 'bin'

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$platform = if ($arch -eq 'ARM64') { 'windows-arm64' } else { 'windows-x64' }
$version = if ($args.Count -gt 0) { $args[0] } else { 'latest' }
if ($version -eq 'latest') { $version = (Invoke-RestMethod "$Base/x/version").ToString().Trim() }
if (-not $version) { throw "Couldn't find the latest version. Try again in a minute." }

Write-Host "Installing Friday X $version ($platform)..."
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("friday-x-" + [Guid]::NewGuid().ToString('N') + '.exe')
try {
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest "$Base/x/download/$platform?version=$version" -OutFile $tmp -UseBasicParsing
  $expected = (Invoke-RestMethod "$Base/x/sha256/$platform?version=$version").ToString().Trim().ToLower()
  $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw 'The download did not match its checksum, so it was not installed.' }
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Move-Item -Force $tmp (Join-Path $BinDir 'friday.exe')
} finally { if (Test-Path $tmp) { Remove-Item -Force $tmp } }

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $BinDir), 'User')
  $env:Path += ";$BinDir"
}
Write-Host ''
Write-Host "Friday X $version is installed. Open a new terminal, then run:"
Write-Host '    friday'
Write-Host 'The first run opens your browser to sign in with your Friday account.'
`;

const CMD = String.raw`@echo off
rem Friday X installer for Windows CMD — runs the PowerShell installer.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm __API__/x/install.ps1 | iex"
if errorlevel 1 (
  echo Friday X install failed. See the message above.
  exit /b 1
)
`;

function fill(template: string, apiBase: string): string {
  const api = apiBase.replace(/\/+$/, "");
  return template.replaceAll("__API__", api).replaceAll("__BASE__", api.replace(/^https?:\/\//, "")).replaceAll("\\${", "${");
}

export const installShell = (apiBase: string) => fill(SH, apiBase);
export const installPowerShell = (apiBase: string) => fill(PS1, apiBase);
export const installCmd = (apiBase: string) => fill(CMD, apiBase).replace(/\n/g, "\r\n");
