#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname -- "$0")/.."

if [[ $# != 2 || "$(uname -s):$(uname -m)" != Linux:aarch64 || "$(id -u)" == 0 ]]; then
    printf '%s\n' 'Usage on Linux ARM64 as a non-root user: tools/stage-linux-plugin-worker.sh VERIFIED_DOTNET_ROOT NEW_DIRECTORY' >&2
    exit 2
fi
runtime="$(cd -- "$1" && pwd -P)"
mkdir -- "$2"
stage="$(cd -- "$2" && pwd -P)"
export DOTNET_NOLOGO=1
if [[ "$("$runtime/dotnet" --version)" != 10.0.404 ]] ||
    [[ ! -f "$runtime/host/fxr/10.0.15/libhostfxr.so" ]] ||
    [[ ! -f "$runtime/shared/Microsoft.NETCore.App/10.0.15/libcoreclr.so" ]]; then
    printf '%s\n' 'The pinned .NET 10.0.404 SDK and 10.0.15 runtime are required.' >&2
    exit 2
fi

mkdir -p "$stage/rootfs"/{app,dotnet/host/fxr,dotnet/shared/Microsoft.NETCore.App,proc}
"$runtime/dotnet" publish src/PluginWorker -c Release --self-contained false -p:RestoreLockedMode=true -o "$stage/rootfs/app"
cc -std=c11 -O2 -Wall -Wextra -Werror -static src/PluginWorker/launcher-linux-arm64.c -o "$stage/launcher"
cp -p -- "$runtime/dotnet" "$stage/rootfs/dotnet/"
cp -aL -- "$runtime/host/fxr/10.0.15" "$stage/rootfs/dotnet/host/fxr/"
cp -aL -- "$runtime/shared/Microsoft.NETCore.App/10.0.15" "$stage/rootfs/dotnet/shared/Microsoft.NETCore.App/"
libraries=(ld-linux-aarch64.so.1 aarch64-linux-gnu/libc.so.6 aarch64-linux-gnu/libdl.so.2
    aarch64-linux-gnu/libgcc_s.so.1 aarch64-linux-gnu/libm.so.6 aarch64-linux-gnu/libpthread.so.0
    aarch64-linux-gnu/librt.so.1 aarch64-linux-gnu/libstdc++.so.6)
for name in "${libraries[@]}"; do install -D -m 0555 "/lib/$name" "$stage/rootfs/lib/$name"; done
chmod -R a+rX,a-w "$stage/rootfs"
chmod 0555 "$stage/launcher"
(
    cd "$stage"
    export LC_ALL=C
    find launcher rootfs -type f -print0 | sort -z | xargs -0 sha256sum > payload.sha256
    sha256sum -c payload.sha256 >/dev/null
    chmod 0444 payload.sha256
    sha256sum payload.sha256
)
chmod 0755 "$stage"
