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
[[ -z "$(git status --porcelain)" ]] || {
  echo 'Build from a clean FsusBlog checkout.' >&2
  exit 2
}
ui_pkg="$repo/src/Web/node_modules/@ozwasyd/element-plus"
[[ -f "$repo/src/Web/node_modules/vite/bin/vite.js" && -f "$repo/src/Web/node_modules/vue-tsc/bin/vue-tsc.js" && -f "$ui_pkg/package.json" ]] || {
  echo 'Install the locked Web dependencies (including @ozwasyd/element-plus) first.' >&2
  exit 2
}
wasm="$ui_pkg/es/wasm/dist"
for f in ep_wasm.mjs ep_wasm.wasm markdown_basic.js markdown_basic.wasm markdown_simd.js markdown_simd.wasm; do
  [[ -s "$wasm/$f" ]] || {
    printf 'Missing bundled @ozwasyd/element-plus Wasm asset: %s\n' "$f" >&2
    exit 2
  }
done
wasm=$(cd "$wasm" && pwd -P)
server_rid=$("$dotnet" msbuild src/Server/FsusBlog.V2.Server.csproj -getProperty:NETCoreSdkRuntimeIdentifier -nologo)
case "$server_rid" in
  osx-arm64|osx-x64) heading_parser=server/libfsus_author_heading.dylib ;;
  linux-arm64|linux-x64) heading_parser=server/libfsus_author_heading.so ;;
  *) printf 'Unsupported release host RID: %s\n' "$server_rid" >&2; exit 2 ;;
esac
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
ui_pkg_id=$(node -p "const p = require('$ui_pkg/package.json'); p.name + '@' + p.version")
{
  printf 'started_at=%s\nfsusblog_commit=%s\nfsusui_package=%s\n' "$(date -u +%FT%TZ)" "$rev" "$ui_pkg_id"
  printf 'build_host=%s\n' "$(uname -srm)"
  "$dotnet" --info
  node --version
  shasum -a 256 global.json NuGet.Config src/Web/pnpm-lock.yaml
  find src -name packages.lock.json -type f -exec shasum -a 256 {} +
  (
    cd "$wasm"
    shasum -a 256 ep_wasm.mjs ep_wasm.wasm \
      markdown_basic.js markdown_basic.wasm markdown_simd.js markdown_simd.wasm
  ) > "$release/fsusui-wasm.sha256"
} > "$release/build.txt"

mkdir "$scratch/source" "$scratch/package"
export COPYFILE_DISABLE=1
git archive "$rev" | tar -xf - -C "$scratch/source"
ln -s "$repo/src/Web/node_modules" "$scratch/source/src/Web/node_modules"
(
  cd "$scratch/source"
  python3 -B tools/fsdl-dictionary.py export "$scratch/package/search-lexicon.fsdl"
  python3 -B tools/fsdl-dictionary.py verify "$scratch/package/search-lexicon.fsdl"
  "$dotnet" restore FsusBlog.V2.slnx --locked-mode
  "$dotnet" publish src/Server/FsusBlog.V2.Server.csproj -c Release --no-restore \
    --self-contained false -p:UseAppHost=false -o "$scratch/package/server"
  "$dotnet" publish src/Cli/FsusBlog.V2.Cli.csproj -c Release --no-restore \
    --self-contained false -p:UseAppHost=false -o "$scratch/package/cli"
  cd src/Web
  node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
  node node_modules/vite/bin/vite.js build --outDir "$scratch/package/web"
) >> "$release/build.txt" 2>&1

[[ -s "$scratch/package/$heading_parser" ]]
(cd "$wasm" && shasum -a 256 -c "$release/fsusui-wasm.sha256") >> "$release/build.txt"
for name in ep_wasm markdown_basic markdown_simd; do
  assets=("$scratch/package/web/assets/$name"-*.wasm)
  if [[ ${#assets[@]} != 1 ]] || ! cmp -- "$wasm/$name.wasm" "${assets[0]}"; then
    printf 'Bundled Wasm differs from the checked FsusUI input: %s\n' "$name" >&2
    exit 1
  fi
done
cp -- "$scratch/source/deploy/nginx.conf.example" "$scratch/source/deploy/Caddyfile" "$scratch/source/deploy/Caddyfile.admin" "$scratch/source/deploy/README.md" "$scratch/package/"
cp -- "$scratch/source/deploy/fsusblog-daily-checkpoint.service" "$scratch/source/deploy/fsusblog-daily-checkpoint.timer" "$scratch/package/"
{
  printf 'fsusblog_commit=%s\nfsusui_package=%s\n' "$rev" "$ui_pkg_id"
  printf 'server_rid=%s\nheading_parser=%s\n' "$server_rid" "$heading_parser"
  printf 'web=web/\nserver=server/FsusBlog.V2.Server.dll\ncli=cli/FsusBlog.V2.Cli.dll\ndictionary=search-lexicon.fsdl\n'
} > "$scratch/package/release.txt"
(
  cd "$scratch/package"
  find . -type f -print0 | xargs -0 shasum -a 256 | LC_ALL=C sort -k2 > "$release/payload.sha256"
  # Distribute file contents and modes without host-specific extended metadata.
  case $(tar --version) in
    *bsdtar*) tar --no-mac-metadata --no-xattrs --no-acls --no-fflags -czf "$scratch/fsusblog-v2.tar.gz" . ;;
    *) tar -czf "$scratch/fsusblog-v2.tar.gz" . ;;
  esac
)
git -C "$repo" bundle create "$scratch/history.bundle" HEAD
[[ "$(git -C "$repo" bundle list-heads "$scratch/history.bundle" HEAD)" == "$rev HEAD" ]]
git -C "$repo" bundle verify "$scratch/history.bundle" >> "$release/build.txt" 2>&1
mv -- "$scratch/fsusblog-v2.tar.gz" "$scratch/history.bundle" "$release/"
(
  cd "$release"
  shasum -a 256 fsusblog-v2.tar.gz history.bundle > SHA256SUMS
)
finished=yes
