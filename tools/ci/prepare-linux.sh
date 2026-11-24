#!/usr/bin/env bash
# Online acquisition is confined to runner preparation, not offline restore.
set -euo pipefail
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Requires Linux x64.' >&2; exit 2; }
: "${GITHUB_PATH:?Run this preparation step in GitHub Actions}"
: "${GITHUB_ENV:?Run this preparation step in GitHub Actions}"
: "${RUNNER_TEMP:?Missing runner temporary directory}"
# PGDG packages are authenticated by this pre-reviewed signing-key fingerprint.
if [[ ! -x /usr/lib/postgresql/18/bin/postgres ]] &&
   ! grep -Rqs 'apt.postgresql.org/pub/repos/apt' /etc/apt/sources.list.d /etc/apt/sources.list; then
  key="$RUNNER_TEMP/pgdg.asc"
  curl --fail --silent --show-error --location --retry 3 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$key"
  fingerprint=$(gpg --batch --show-keys --with-colons "$key" | awk -F: '$1 == "fpr" { print $10; exit }')
  [[ "$fingerprint" == B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 ]]
  sudo install -d /etc/apt/keyrings
  sudo install -m 0644 "$key" /etc/apt/keyrings/fsus-pgdg.asc
  printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/fsus-pgdg.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' | sudo tee /etc/apt/sources.list.d/fsus-pgdg.list >/dev/null
fi
sudo apt-get update
sudo apt-get install -y --no-install-recommends postgresql-18 postgresql-client-18 \
  clang lld g++ libfontconfig1 openssl uuid-runtime ripgrep xxd lsof
# Verify the release's checksum manifest against the digest reviewed in GitHub
# release metadata, then verify the archive against that authenticated manifest.
version=2.11.9
checksum=e4e1e43b78299733b19b8aeab8abebcf57aef4f5dae617be125016f9e4e0299f
work=$(mktemp -d "$RUNNER_TEMP/fsus-caddy.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
url="https://github.com/caddyserver/caddy/releases/download/v$version"
curl --fail --silent --show-error --location --retry 3 "$url/caddy_${version}_checksums.txt" -o "$work/checksums.txt"
printf '%s  %s\n' "$checksum" "$work/checksums.txt" | sha256sum --check --strict
archive="caddy_${version}_linux_amd64.tar.gz"
curl --fail --silent --show-error --location --retry 3 "$url/$archive" -o "$work/$archive"
(cd "$work"; grep -F " $archive" checksums.txt | sha256sum --check --strict)
mkdir -p "$RUNNER_TEMP/fsus-tools"
tar -xzf "$work/$archive" -C "$RUNNER_TEMP/fsus-tools" caddy
printf '%s\n' "$RUNNER_TEMP/fsus-tools" /usr/lib/postgresql/18/bin >> "$GITHUB_PATH"
printf 'PG_TOOLS_DIR=/usr/lib/postgresql/18/bin\nCADDY_BIN=%s/fsus-tools/caddy\nFSUSBLOG_TEST_CADDY_BIN=%s/fsus-tools/caddy\n' "$RUNNER_TEMP" "$RUNNER_TEMP" >> "$GITHUB_ENV"
"$RUNNER_TEMP/fsus-tools/caddy" version
/usr/lib/postgresql/18/bin/postgres --version
