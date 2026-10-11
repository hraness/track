#!/bin/sh
# dawg installer, served at https://dawg.sh/install
#
#   curl -fsSL https://dawg.sh/install | sh
#
# What it does, in order:
#   1. Resolves the latest GitHub Release of hraness/dawg (or DAWG_VERSION).
#   2. Finds Bun 1.3.14 or newer, or installs Bun from https://bun.sh/install.
#   3. Downloads hraness-dawg-<version>.tgz and SHA256SUMS from that release.
#   4. Checks the tarball's sha256 against SHA256SUMS and stops on a mismatch.
#   5. Keeps the verified tarball under ~/.local/share/dawg/releases and runs
#      `bun add -g <that absolute path>`.
#
# Settings (all optional):
#   DAWG_VERSION=0.9.0          install this version instead of the latest
#   DAWG_INSTALL_DIR=<dir>      where verified tarballs are kept
#   DAWG_INSTALL_BASE_URL=<url> download from <url>/hraness-dawg-<v>.tgz and
#                               <url>/SHA256SUMS instead of GitHub (testing;
#                               file:// works; requires DAWG_VERSION)
#
# The script is POSIX sh and changes nothing until the download is verified.

set -eu

REPO="hraness/dawg"
MIN_BUN="1.3.14"

say() { printf 'dawg: %s\n' "$*"; }
fail() {
  printf 'dawg: error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found"
}

need curl
need tar
need mktemp

# --- version compare: returns 0 when $1 >= $2 (numeric x.y.z) ----------------
version_ge() {
  # Drop any pre-release or build suffix, then compare field by field.
  a=$(printf '%s' "$1" | sed 's/[-+].*//')
  b=$(printf '%s' "$2" | sed 's/[-+].*//')
  i=1
  while [ "$i" -le 3 ]; do
    x=$(printf '%s' "$a" | cut -d. -f"$i")
    y=$(printf '%s' "$b" | cut -d. -f"$i")
    x=${x:-0}
    y=${y:-0}
    case "$x$y" in *[!0-9]*) return 1 ;; esac
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
    i=$((i + 1))
  done
  return 0
}

# --- sha256 of a file, whichever tool this system has ------------------------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/^.*= *//'
  else
    fail "no sha256 tool found (need sha256sum, shasum or openssl)"
  fi
}

# --- 1. Which release ------------------------------------------------------------
VERSION="${DAWG_VERSION:-}"
VERSION=${VERSION#v}
BASE_URL="${DAWG_INSTALL_BASE_URL:-}"

coming_soon() {
  printf '%s\n' \
    "dawg: the first release of dawg is coming soon." \
    "" \
    "  There is no published release of $REPO yet, so there is nothing to install." \
    "  Watch https://github.com/$REPO/releases, or run it from source today:" \
    "" \
    "    git clone https://github.com/$REPO.git && cd dawg" \
    "    bun install --frozen-lockfile && bun run dawg" >&2
  exit 1
}

if [ -z "$VERSION" ]; then
  [ -z "$BASE_URL" ] || fail "DAWG_INSTALL_BASE_URL needs DAWG_VERSION"
  # GitHub redirects /releases/latest to /releases/tag/<tag> when a release
  # exists, and to /releases when there is none. No API token or rate limit.
  latest_url="${DAWG_INSTALL_LATEST_URL:-https://github.com/$REPO/releases/latest}"
  effective=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$latest_url" 2>/dev/null) ||
    fail "could not reach $latest_url; check your connection and try again"
  case "$effective" in
    */releases/tag/v*) VERSION=${effective##*/releases/tag/v} ;;
    *) coming_soon ;;
  esac
fi

case "$VERSION" in
  "" | *[!0-9A-Za-z.+-]*) fail "unexpected version '$VERSION'" ;;
esac

ASSET="hraness-dawg-$VERSION.tgz"
if [ -z "$BASE_URL" ]; then
  BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
fi
BASE_URL=${BASE_URL%/}

# --- 2. Bun --------------------------------------------------------------------
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
  elif [ -x "$BUN_INSTALL/bin/bun" ]; then
    printf '%s\n' "$BUN_INSTALL/bin/bun"
  fi
}

BUN=$(find_bun || true)
if [ -z "$BUN" ]; then
  say "Bun was not found; installing it from https://bun.sh/install"
  command -v bash >/dev/null 2>&1 || fail "Bun's installer needs bash; install Bun from https://bun.sh and run this again"
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$BUN_INSTALL" bash >/dev/null ||
    fail "the Bun installer failed; install Bun from https://bun.sh and run this again"
  BUN=$(find_bun || true)
  [ -n "$BUN" ] || fail "Bun was installed but could not be found in $BUN_INSTALL/bin"
fi

BUN_VERSION=$("$BUN" --version 2>/dev/null || true)
if ! version_ge "$BUN_VERSION" "$MIN_BUN"; then
  fail "dawg needs Bun $MIN_BUN or newer, and $BUN is ${BUN_VERSION:-unknown}. Run \`bun upgrade\` and try again."
fi
say "using Bun $BUN_VERSION ($BUN)"

# --- 3. Download -----------------------------------------------------------------
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t dawg)
trap 'rm -rf "$TMP"' EXIT INT TERM

say "downloading dawg $VERSION"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE_URL/SHA256SUMS" ||
  fail "could not download $BASE_URL/SHA256SUMS (if v$VERSION was just tagged, its files may still be uploading; try again in a few minutes)"
curl -fsSL -o "$TMP/$ASSET" "$BASE_URL/$ASSET" ||
  fail "could not download $BASE_URL/$ASSET"

# --- 4. Verify -------------------------------------------------------------------
# A SHA256SUMS line is "<64 hex>  <name>" (or "<hex> *<name>" in binary mode).
expected=$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1; exit }' "$TMP/SHA256SUMS")
case "$expected" in
  "") fail "SHA256SUMS has no entry for $ASSET" ;;
  *[!0-9a-fA-F]*) fail "SHA256SUMS entry for $ASSET is malformed" ;;
esac
[ "${#expected}" -eq 64 ] || fail "SHA256SUMS entry for $ASSET is malformed"
actual=$(sha256_of "$TMP/$ASSET")
expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
actual=$(printf '%s' "$actual" | tr 'A-F' 'a-f')
if [ "$expected" != "$actual" ]; then
  fail "checksum mismatch for $ASSET (expected $expected, got $actual); nothing was installed"
fi
say "verified sha256 $actual"

# --- 5. Install ------------------------------------------------------------------
# Bun records the tarball's path in its global manifest, so keep it somewhere
# stable instead of a temp directory.
DEST="${DAWG_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/dawg/releases}"
mkdir -p "$DEST"
DEST=$(cd "$DEST" && pwd -P)
cp "$TMP/$ASSET" "$DEST/$ASSET.partial"
mv -f "$DEST/$ASSET.partial" "$DEST/$ASSET"

say "running bun add -g $DEST/$ASSET"
BUN_INSTALL="$BUN_INSTALL" "$BUN" add -g "$DEST/$ASSET" || fail "bun add -g failed"

BIN_DIR="$BUN_INSTALL/bin"
say "installed dawg $VERSION"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say "add Bun's bin directory to your PATH to run dawg:"
    printf '\n    export PATH="%s:$PATH"\n\n' "$BIN_DIR"
    ;;
esac
say "start with: dawg   (then try \`dawg model key\` to connect a model)"
