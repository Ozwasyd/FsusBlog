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
# The npm payload has no gitHead. Bind the installed identity and frozen lock
# entry to the source receipt shared with the vendored FsusUI Markdown code.
ui_coordinates=$(node - "$ui_pkg/package.json" <<'NODE'
const fs = require('node:fs');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const installed = readJson(process.argv[2]);
const upstream = readJson('src/Server/Authoring/FsusMarkdown/UPSTREAM.json');
const web = readJson('src/Web/package.json');
const id = `${installed.name}@${installed.version}`;
const lock = fs.readFileSync('src/Web/pnpm-lock.yaml', 'utf8');
const packageResolution = lock.split('\n').findIndex((line) => line === `  '${id}':`);
const integrity = packageResolution < 0 ? undefined
  : /^    resolution: \{integrity: (sha512-[A-Za-z0-9+/]{86}==)(?:[,}])/.exec(lock.split('\n')[packageResolution + 1])?.[1];
if (installed.name !== '@ozwasyd/element-plus' || installed.name !== upstream.package ||
    installed.version !== upstream.version || installed.version !== web.dependencies?.[installed.name] ||
    !integrity || integrity !== upstream.packageIntegrity ||
    upstream.repository !== 'https://github.com/Ozwasyd/FsusUI' ||
    !/^[0-9a-f]{40}$/.test(upstream.commit) ||
    (installed.gitHead != null && installed.gitHead !== upstream.commit)) {
  console.error(`FsusUI release source receipt does not match the installed and locked package: ${id}`);
  process.exit(2);
}
console.log(`${id} ${upstream.commit}`);
NODE
)
read -r ui_pkg_id ui_commit <<< "$ui_coordinates"
wasm="$ui_pkg/es/wasm/dist"
wasm_stems=(ep_wasm markdown_basic markdown_simd)
wasm_files=(ep_wasm.mjs ep_wasm.wasm markdown_basic.js markdown_basic.wasm markdown_simd.js markdown_simd.wasm)
for f in "${wasm_files[@]}"; do
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
{
  printf 'started_at=%s\nfsusblog_commit=%s\nfsusui_package=%s\nfsusui_commit=%s\n' "$(date -u +%FT%TZ)" "$rev" "$ui_pkg_id" "$ui_commit"
  printf 'build_host=%s\n' "$(uname -srm)"
  "$dotnet" --info
  node --version
  shasum -a 256 global.json NuGet.Config src/Web/pnpm-lock.yaml
  find src -name packages.lock.json -type f -exec shasum -a 256 {} +
  (cd "$wasm" && shasum -a 256 "${wasm_files[@]}") > "$release/fsusui-wasm.sha256"
} > "$release/build.txt"

mkdir "$scratch/source" "$scratch/package"
export COPYFILE_DISABLE=1
git archive "$rev" | tar -xf - -C "$scratch/source"
ln -s "$repo/src/Web/node_modules" "$scratch/source/src/Web/node_modules"
(
  cd "$scratch/source"
  for action in export verify; do
    python3 -B tools/fsdl-dictionary.py "$action" "$scratch/package/search-lexicon.fsdl"
  done
  "$dotnet" restore FsusBlog.V2.slnx --locked-mode
  for pair in Server:server Cli:cli; do
    "$dotnet" publish "src/${pair%%:*}/FsusBlog.V2.${pair%%:*}.csproj" -c Release --no-restore \
      --self-contained false -p:UseAppHost=false -o "$scratch/package/${pair##*:}"
  done
  cd src/Web
  node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
  node node_modules/vite/bin/vite.js build --outDir "$scratch/package/web"
) >> "$release/build.txt" 2>&1

[[ -s "$scratch/package/$heading_parser" ]]
(cd "$wasm" && shasum -a 256 -c "$release/fsusui-wasm.sha256") >> "$release/build.txt"
for name in "${wasm_stems[@]}"; do
  assets=("$scratch/package/web/assets/$name"-*.wasm)
  if [[ ${#assets[@]} != 1 ]] || ! cmp -- "$wasm/$name.wasm" "${assets[0]}"; then
    printf 'Bundled Wasm differs from the checked FsusUI input: %s\n' "$name" >&2
    exit 1
  fi
done
cp -- "$scratch/source/deploy"/{nginx.conf.example,Caddyfile,Caddyfile.admin,README.md,fsusblog-daily-checkpoint.service,fsusblog-daily-checkpoint.timer} "$scratch/package/"
{
  printf 'fsusblog_commit=%s\nfsusui_package=%s\nfsusui_commit=%s\n' "$rev" "$ui_pkg_id" "$ui_commit"
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
