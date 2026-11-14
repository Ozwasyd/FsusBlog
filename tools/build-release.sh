#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
repo=$PWD

if [[ $# != 1 ]]; then
  echo 'Usage: tools/build-release.sh NEW_RELEASE_DIRECTORY' >&2
  exit 2
fi
dotnet=${DOTNET_BIN:-dotnet}
ui=$(cd ../FsusUI && pwd -P)
[[ -z "$(git status --porcelain)" && -z "$(git -C "$ui" status --porcelain)" ]] || {
  echo 'Build from clean FsusBlogV2 and FsusUI checkouts.' >&2
  exit 2
}
[[ -f "$repo/src/Web/node_modules/vite/bin/vite.js" && -f "$repo/src/Web/node_modules/vue-tsc/bin/vue-tsc.js" ]] || {
  echo 'Install the locked Web dependencies offline first.' >&2
  exit 2
}
wasm=${FSUSBLOG_FSUSUI_WASM_DIST:-"$ui/vue/packages/wasm/dist"}
wasm=$(cd "$wasm" && pwd -P)
[[ -s "$wasm/.native-artifact-fingerprint" ]] || {
  echo 'Build the six FsusUI native Wasm assets before building a release.' >&2
  exit 2
}
mkdir -- "$1"
release=$(cd -- "$1" && pwd -P)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/fsusv2-release.XXXXXXXX")
finished=no

cleanup() {
  local code=$?
  trap - EXIT
  rm -rf -- "$scratch" || code=1
  printf 'finished_at=%s\nexit_code=%s\ncomplete=%s\n' "$(date -u +%FT%TZ)" "$code" "$finished" >> "$release/build.txt"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

rev=$(git rev-parse HEAD)
ui_rev=$(git -C "$ui" rev-parse HEAD)
{
  printf 'started_at=%s\nfsusblog_commit=%s\nfsusui_commit=%s\n' "$(date -u +%FT%TZ)" "$rev" "$ui_rev"
  printf 'build_host=%s\n' "$(uname -srm)"
  "$dotnet" --info
  node --version
  shasum -a 256 global.json NuGet.Config src/Web/pnpm-lock.yaml
  find src -name packages.lock.json -type f -exec shasum -a 256 {} +
  (
    cd "$wasm"
    shasum -a 256 .native-artifact-fingerprint ep_wasm.mjs ep_wasm.wasm \
      markdown_basic.js markdown_basic.wasm markdown_simd.js markdown_simd.wasm
  ) > "$release/fsusui-wasm.sha256"
} > "$release/build.txt"

mkdir "$scratch/source" "$scratch/package"
git archive "$rev" | tar -xf - -C "$scratch/source"
ln -s "$ui" "$scratch/FsusUI"
ln -s "$repo/src/Web/node_modules" "$scratch/source/src/Web/node_modules"
{
  cd "$scratch/source"
  "$dotnet" restore FsusBlog.V2.slnx --locked-mode
  "$dotnet" publish src/Server/FsusBlog.V2.Server.csproj -c Release --no-restore \
    --self-contained false -p:UseAppHost=false -o "$scratch/package/server"
  "$dotnet" publish src/Migrate/FsusBlogV2.Migrate.csproj -c Release --no-restore \
    --self-contained false -p:UseAppHost=false -o "$scratch/package/migrate"
  cd src/Web
  node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
  FSUSBLOG_FSUSUI_WASM_DIST="$wasm" node node_modules/vite/bin/vite.js build --outDir "$scratch/package/web"
} >> "$release/build.txt" 2>&1

[[ "$(git -C "$ui" rev-parse HEAD)" == "$ui_rev" && -z "$(git -C "$ui" status --porcelain)" ]]
(cd "$wasm" && shasum -a 256 -c "$release/fsusui-wasm.sha256") >> "$release/build.txt"
for name in ep_wasm markdown_basic markdown_simd; do
  assets=("$scratch/package/web/assets/$name"-*.wasm)
  [[ ${#assets[@]} == 1 ]] && cmp -- "$wasm/$name.wasm" "${assets[0]}"
done
cp -- "$scratch/source/deploy/Caddyfile" "$scratch/source/deploy/README.md" "$scratch/package/"
{
  printf 'fsusblog_commit=%s\nfsusui_commit=%s\n' "$rev" "$ui_rev"
  printf 'web=web/\nserver=server/FsusBlog.V2.Server.dll\nmigrate=migrate/FsusBlogV2.Migrate.dll\n'
} > "$scratch/package/release.txt"
(
  cd "$scratch/package"
  find . -type f -print0 | xargs -0 shasum -a 256 | LC_ALL=C sort -k2 > "$release/payload.sha256"
  COPYFILE_DISABLE=1 tar -czf "$scratch/fsusblog-v2.tar.gz" .
)
git bundle create "$scratch/history.bundle" HEAD
[[ "$(git bundle list-heads "$scratch/history.bundle" HEAD)" == "$rev HEAD" ]]
git bundle verify "$scratch/history.bundle" >> "$release/build.txt" 2>&1
mv -- "$scratch/fsusblog-v2.tar.gz" "$scratch/history.bundle" "$release/"
(
  cd "$release"
  shasum -a 256 fsusblog-v2.tar.gz history.bundle > SHA256SUMS
)
finished=yes
