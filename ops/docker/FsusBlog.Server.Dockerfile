# syntax=docker/dockerfile:1.7
ARG VCPKG_COMMIT=eae1680538b86f962455c27abca2aad0dc304a4d
ARG RUNTIME_BASE_FLAVOR=musl
ARG DOTNET_RUNTIME_VERSION=10.0.10
ARG DOTNET_SDK_VERSION=10.0.302
ARG DOTNET_ASPNET_MUSL_DIGEST=sha256:27b6b84beeede74fd16886177d360799c8e4299ceadfbd64eef57bafead7878a
ARG DOTNET_ASPNET_GLIBC_DIGEST=sha256:1fa23fc4872d95fd71c2833ebe65d7e84a43b2d51a31d119516852f13d9505a7
ARG DOTNET_SDK_MUSL_DIGEST=sha256:d8ee39817ca03a3757288e83c37ed73cc969a286c603b827c7cbe33add1c2d1c
ARG DOTNET_SDK_GLIBC_DIGEST=sha256:ed034a8bf0b24ded0cbbac07e17825d8e9ebfe21e308191d0f7421eaf5ad4664
ARG NODE_VERSION=24.17.0
ARG NODE_MUSL_DIGEST=sha256:7c70d1235c0b4c2bc9eeed5393d19f1bbdde6885ba0d58ba62bb385d7b0f3ff1
ARG NODE_GLIBC_DIGEST=sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532

FROM node:${NODE_VERSION}-alpine3.23@${NODE_MUSL_DIGEST} AS node-runtime-musl
FROM node:${NODE_VERSION}-bookworm-slim@${NODE_GLIBC_DIGEST} AS node-runtime-glibc

## =========================================================================
# 阶段 1：.NET 基础运行环境 (Alpine)
# 单容器承载 Kestrel + 静态资源 + Node SSR worker。
## =========================================================================
FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_RUNTIME_VERSION}-alpine3.23@${DOTNET_ASPNET_MUSL_DIGEST} AS base-musl
ARG DOTNET_RUNTIME_VERSION
ARG DOTNET_SDK_VERSION
ARG DOTNET_ASPNET_MUSL_DIGEST
ARG DOTNET_SDK_MUSL_DIGEST
ARG NODE_VERSION
ARG NODE_MUSL_DIGEST
WORKDIR /app
EXPOSE 8080

USER root
RUN apk add --no-cache curl icu-data-full icu-libs krb5-libs libstdc++
COPY --from=node-runtime-musl /usr/local/bin/node /usr/local/bin/node
RUN test "$(node --version)" = "v${NODE_VERSION}" && ! command -v npm
RUN mkdir -p /app/storage/shared/assets /app/storage/instances /app/Dictionaries /app/release-assets /app/release-derived && \
    chown -R $APP_UID:$APP_UID /app/storage /app/Dictionaries /app/release-assets /app/release-derived

ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
ENV PATH="${PATH}:/usr/bin:/usr/share/dotnet"
LABEL io.fsusblog.runtime.dotnet-version="${DOTNET_RUNTIME_VERSION}" \
      io.fsusblog.runtime.base-image="mcr.microsoft.com/dotnet/aspnet:${DOTNET_RUNTIME_VERSION}-alpine3.23@${DOTNET_ASPNET_MUSL_DIGEST}" \
      io.fsusblog.runtime.base-image-digest="${DOTNET_ASPNET_MUSL_DIGEST}" \
      io.fsusblog.build.dotnet-sdk-version="${DOTNET_SDK_VERSION}" \
      io.fsusblog.build.sdk-image="mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK_VERSION}-alpine3.23@${DOTNET_SDK_MUSL_DIGEST}" \
      io.fsusblog.build.sdk-image-digest="${DOTNET_SDK_MUSL_DIGEST}" \
      io.fsusblog.runtime.node-version="${NODE_VERSION}" \
      io.fsusblog.runtime.node-image="node:${NODE_VERSION}-alpine3.23@${NODE_MUSL_DIGEST}" \
      io.fsusblog.runtime.node-image-digest="${NODE_MUSL_DIGEST}"
USER $APP_UID

FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_RUNTIME_VERSION}-noble@${DOTNET_ASPNET_GLIBC_DIGEST} AS base-glibc
ARG DOTNET_RUNTIME_VERSION
ARG DOTNET_SDK_VERSION
ARG DOTNET_ASPNET_GLIBC_DIGEST
ARG DOTNET_SDK_GLIBC_DIGEST
ARG NODE_VERSION
ARG NODE_GLIBC_DIGEST
WORKDIR /app
EXPOSE 8080
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl libatomic1 libicu74 libkrb5-3 libstdc++6 && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /app/storage/shared/assets /app/storage/instances /app/Dictionaries /app/release-assets /app/release-derived && \
    chown -R $APP_UID:$APP_UID /app/storage /app/Dictionaries /app/release-assets /app/release-derived
COPY --from=node-runtime-glibc /usr/local/bin/node /usr/local/bin/node
RUN test "$(node --version)" = "v${NODE_VERSION}" && ! command -v npm
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
ENV PATH="${PATH}:/usr/bin:/usr/share/dotnet"
LABEL io.fsusblog.runtime.dotnet-version="${DOTNET_RUNTIME_VERSION}" \
      io.fsusblog.runtime.base-image="mcr.microsoft.com/dotnet/aspnet:${DOTNET_RUNTIME_VERSION}-noble@${DOTNET_ASPNET_GLIBC_DIGEST}" \
      io.fsusblog.runtime.base-image-digest="${DOTNET_ASPNET_GLIBC_DIGEST}" \
      io.fsusblog.build.dotnet-sdk-version="${DOTNET_SDK_VERSION}" \
      io.fsusblog.build.sdk-image="mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK_VERSION}-noble@${DOTNET_SDK_GLIBC_DIGEST}" \
      io.fsusblog.build.sdk-image-digest="${DOTNET_SDK_GLIBC_DIGEST}" \
      io.fsusblog.runtime.node-version="${NODE_VERSION}" \
      io.fsusblog.runtime.node-image="node:${NODE_VERSION}-bookworm-slim@${NODE_GLIBC_DIGEST}" \
      io.fsusblog.runtime.node-image-digest="${NODE_GLIBC_DIGEST}"
USER $APP_UID

ARG RUNTIME_BASE_FLAVOR
FROM base-${RUNTIME_BASE_FLAVOR} AS base

## =========================================================================
# 阶段 1.5：受控 wasm 工件构建
# 只用于导出受信 wasm artifact，不进入 final build 运行时链路。
## =========================================================================
FROM emscripten/emsdk:6.0.0@sha256:9eed2e47b4206928b22f99d2917013ad5462d777bb24cb546a652729896badd8 AS fsusui-build-tools
ARG NODE_VERSION

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      cmake \
      git \
      libatomic1 \
      libstdc++6 \
      ninja-build \
      pkg-config \
      python3 \
      rsync \
      unzip \
      zip && \
    rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime-glibc /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime-glibc /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
ENV PATH="/usr/local/bin:${PATH}"
RUN ln -sfn ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack && \
    test "$(node --version)" = "v${NODE_VERSION}" && \
    corepack enable && \
    corepack prepare pnpm@10.33.0 --activate && \
    test "$(pnpm --version)" = "10.33.0"

FROM fsusui-build-tools AS wasm-builder
ARG VCPKG_COMMIT
ARG FSUSBLOG_WASM_CACHE_IDENTITY=e47619f7dafc7f6ab823daf36e1bd97c8f6f38db6333154e46d9110068daaa9e
WORKDIR /work

RUN git clone https://github.com/microsoft/vcpkg.git /opt/vcpkg && \
    cd /opt/vcpkg && \
    git -c advice.detachedHead=false checkout --detach "${VCPKG_COMMIT}" && \
    test "$(git rev-parse HEAD)" = "${VCPKG_COMMIT}" && \
    /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics

ENV FSUSBLOG_DEPENDENCY_CACHE_ROOT=/.tmp/dependency-cache \
    FSUSBLOG_EM_CACHE=/.cache/emscripten \
    EM_CACHE=/.cache/emscripten \
    VCPKG_DOWNLOADS=/.cache/vcpkg/downloads \
    VCPKG_DEFAULT_BINARY_CACHE=/.cache/vcpkg/archives

COPY tools/vcpkg-overlays/ /work/tools/vcpkg-overlays/
COPY tools/frontend/install-wasm-codec-deps.sh /work/tools/frontend/install-wasm-codec-deps.sh
COPY tools/frontend/ensure-cmake.sh /work/tools/frontend/ensure-cmake.sh

RUN --mount=type=cache,id=fsusblog-vcpkg-downloads-${FSUSBLOG_WASM_CACHE_IDENTITY}-${VCPKG_COMMIT},target=/.cache/vcpkg/downloads,sharing=locked \
    --mount=type=cache,id=fsusblog-vcpkg-archives-${FSUSBLOG_WASM_CACHE_IDENTITY}-${VCPKG_COMMIT},target=/.cache/vcpkg/archives,sharing=locked \
    --mount=type=cache,id=fsusblog-emscripten-${FSUSBLOG_WASM_CACHE_IDENTITY}-${VCPKG_COMMIT},target=/.cache/emscripten,sharing=locked \
    bash -lc 'set -euo pipefail; \
  export PATH="/opt/vcpkg:${PATH}"; \
  export VCPKG_ROOT="/opt/vcpkg"; \
  bash /work/tools/frontend/install-wasm-codec-deps.sh'

# Align wasm-builder CMake with the pinned release toolchain contract
# (tools/frontend/ensure-cmake.sh -> CMAKE_VERSION=4.3.3) instead of the
# distro apt cmake shipped by the emsdk base image.
RUN --mount=type=cache,id=fsusblog-wasm-dependency-${FSUSBLOG_WASM_CACHE_IDENTITY}-${VCPKG_COMMIT},target=/.tmp/dependency-cache,sharing=locked \
    bash /work/tools/frontend/ensure-cmake.sh
ENV FSUSBLOG_WASM_CMAKE=/.tmp/dependency-cache/cmake/4.3.3/bin/cmake

ARG FSUSBLOG_ZK_PRODUCTION_ENABLED=0
ARG FSUSBLOG_WASM_IMAGE_CODEC_ENABLE=ON
COPY ops/docker/wasm-producer-inputs.json /work/ops/docker/wasm-producer-inputs.json
COPY tools/frontend/wasm-producer-inputs.mjs /work/tools/frontend/wasm-producer-inputs.mjs
COPY tools/frontend/ensure-binaryen.sh /work/tools/frontend/ensure-binaryen.sh
COPY tools/frontend/ensure-wasm.mjs /work/tools/frontend/ensure-wasm.mjs
COPY tools/frontend/wasm-build-receipt.mjs /work/tools/frontend/wasm-build-receipt.mjs
COPY tools/frontend/write-comment-privacy-prover-manifest.mjs /work/tools/frontend/write-comment-privacy-prover-manifest.mjs
COPY security/zk/contracts/comment-v5-circuit.manifest.json /work/security/zk/contracts/comment-v5-circuit.manifest.json
COPY security/zk/provenance/comment-v5-trusted-setup.manifest.json /work/security/zk/provenance/comment-v5-trusted-setup.manifest.json
COPY config/zk/anonymous-comment-v5-verifying-key.manifest.json /work/config/zk/anonymous-comment-v5-verifying-key.manifest.json
COPY tools/security/comment-privacy-build-contract.mjs /work/tools/security/comment-privacy-build-contract.mjs
COPY src/frontend/wasm/ /work/src/frontend/wasm/
ENV FSUSBLOG_FRONTEND_WASM_ROOT=/work/src/frontend/public/wasm
ENV FSUSBLOG_REPOSITORY_ROOT=/work
ENV FSUSBLOG_ZK_PRODUCTION_ENABLED=${FSUSBLOG_ZK_PRODUCTION_ENABLED}
ENV FSUSBLOG_WASM_IMAGE_CODEC_ENABLE=${FSUSBLOG_WASM_IMAGE_CODEC_ENABLE}

RUN --mount=type=cache,id=fsusblog-wasm-dependency-${FSUSBLOG_WASM_CACHE_IDENTITY}-${VCPKG_COMMIT},target=/.tmp/dependency-cache,sharing=locked \
    --mount=type=cache,id=fsusblog-emscripten-${FSUSBLOG_WASM_CACHE_IDENTITY}-${VCPKG_COMMIT},target=/.cache/emscripten,sharing=locked \
    --mount=type=cache,id=fsusblog-vcpkg-downloads-${FSUSBLOG_WASM_CACHE_IDENTITY}-${VCPKG_COMMIT},target=/.cache/vcpkg/downloads,sharing=locked \
    --mount=type=cache,id=fsusblog-vcpkg-archives-${FSUSBLOG_WASM_CACHE_IDENTITY}-${VCPKG_COMMIT},target=/.cache/vcpkg/archives,sharing=locked \
    bash -lc 'set -euo pipefail; \
  export PATH="/opt/vcpkg:${PATH}"; \
  export VCPKG_ROOT="/opt/vcpkg"; \
  export FSUSBLOG_WASM_SKIP_RECEIPT=1; \
  cd /work/src/frontend; \
  bash ./wasm/build.sh'

FROM scratch AS wasm-artifact
COPY --from=wasm-builder /work/src/frontend/public/wasm/ /

## =========================================================================
# 阶段 2：.NET SDK 编译发布
## =========================================================================
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK_VERSION}-alpine3.23@${DOTNET_SDK_MUSL_DIGEST} AS build-musl
ARG NODE_VERSION
RUN apk add --no-cache libstdc++
COPY --from=node-runtime-musl /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime-musl /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sfn ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sfn ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    test "$(node --version)" = "v${NODE_VERSION}" && \
    test "$(npm --version)" = "11.13.0" && \
    test "$(npx --version)" = "11.13.0"

FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK_VERSION}-noble@${DOTNET_SDK_GLIBC_DIGEST} AS build-glibc
ARG NODE_VERSION
RUN apt-get update && \
    apt-get install -y --no-install-recommends libatomic1 libstdc++6 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime-glibc /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime-glibc /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sfn ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sfn ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    test "$(node --version)" = "v${NODE_VERSION}" && \
    test "$(npm --version)" = "11.13.0" && \
    test "$(npx --version)" = "11.13.0"

ARG RUNTIME_BASE_FLAVOR
FROM build-${RUNTIME_BASE_FLAVOR} AS build
ARG BUILD_CONFIGURATION=Release
ARG TARGET_RUNTIME=linux-musl-x64
ARG PUBLISH_READY_TO_RUN=false
WORKDIR /src

RUN for input in /.editorconfig /.globalconfig /Directory.Build.props /Directory.Build.targets /Directory.Packages.props /NuGet.Config /NuGet.config /nuget.config /global.json; do test ! -e "$input" && test ! -L "$input" || exit 1; done

COPY --from=backend-inputs /restore/ /src/

RUN test "$(cat /src/.backend-input-profile)" = "$(printf '%s\n%s\n%s\n' "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" "$PUBLISH_READY_TO_RUN")"
RUN dotnet restore "./src/backend/FsusBlog.Server.csproj" --configfile /src/config/build/backend-restore.xml --runtime "$TARGET_RUNTIME" /p:Configuration="$BUILD_CONFIGURATION" /p:PublishReadyToRun="$PUBLISH_READY_TO_RUN" /p:ReadyToRunUseCrossgen2="$PUBLISH_READY_TO_RUN"

COPY --from=backend-inputs /compile/ /src/
WORKDIR "/src/src/backend"

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
ARG FSUSBLOG_RELEASE_ID=local-unversioned
ARG FSUSBLOG_COMMIT_SHA=0000000000000000000000000000000000000000
ARG TARGET_RUNTIME=linux-musl-x64
ARG PUBLISH_SINGLE_FILE=true
ARG PUBLISH_READY_TO_RUN=false
ARG TIERED_PGO=true
ARG QUICK_JIT_FOR_LOOPS=true
ARG SERVER_GC=true
ARG NATIVE_AOT=false
RUN test "$(cat /src/.backend-input-profile)" = "$(printf '%s\n%s\n%s\n' "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" "$PUBLISH_READY_TO_RUN")"
RUN test "$(cat /src/.backend-publish-profile)" = "$(printf '%s\n' publish "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" "$PUBLISH_READY_TO_RUN" "$PUBLISH_SINGLE_FILE" "$TIERED_PGO" "$QUICK_JIT_FOR_LOOPS" "$SERVER_GC" "$FSUSBLOG_RELEASE_ID" "$FSUSBLOG_COMMIT_SHA")"
RUN dotnet publish "./FsusBlog.Server.csproj" \
    -c "$BUILD_CONFIGURATION" \
    -r "$TARGET_RUNTIME" \
    -o /app/publish \
    --no-restore \
    --self-contained true \
    /p:RestoreConfigFile=/src/config/build/backend-restore.xml \
    /p:SkipClientDependenciesForPublish=true \
    /p:SkipClientReleaseBuild=true \
    /p:SkipClientReleaseArtifactCopy=true \
    /p:FsusBlogReleaseId="$FSUSBLOG_RELEASE_ID" \
    /p:FsusBlogCommitSha="$FSUSBLOG_COMMIT_SHA" \
    /p:PublishSingleFile="$PUBLISH_SINGLE_FILE" \
    /p:UseAppHost=true \
    /p:PublishTrimmed=false \
    /p:TieredPGO="$TIERED_PGO" \
    /p:TieredCompilation=true \
    /p:TieredCompilationQuickJitForLoops="$QUICK_JIT_FOR_LOOPS" \
    /p:ServerGarbageCollection="$SERVER_GC" \
    /p:PublishReadyToRun="$PUBLISH_READY_TO_RUN" \
    /p:ReadyToRunUseCrossgen2="$PUBLISH_READY_TO_RUN"

ARG ZK_NATIVE_ARTIFACT_DIR=build/artifacts/native-zk
COPY --from=backend-inputs /publish/ /src/
RUN sh -lc 'set -eu; \
  artifact_dir="/src/${ZK_NATIVE_ARTIFACT_DIR}/${TARGET_RUNTIME}"; \
  if [ -d "$artifact_dir" ]; then \
    mkdir -p /app/publish/native/zk; \
    cp -a "$artifact_dir"/. /app/publish/native/zk/; \
  else \
    echo "ZK native artifacts not found; native Groth16 verifier remains fail-closed"; \
  fi'

## =========================================================================
# 阶段 2.5：Debug 发布 (后端专用，不构建前端)
## =========================================================================
FROM build AS publish-debug
ARG BUILD_CONFIGURATION=Debug
ARG TARGET_RUNTIME=linux-musl-x64
RUN test "$(cat /src/.backend-input-profile)" = "$(printf '%s\n%s\n%s\n' "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" false)"
RUN test "$(cat /src/.backend-publish-profile)" = "$(printf '%s\n' publish-debug "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" false)"
RUN dotnet publish "./FsusBlog.Server.csproj" \
    -c "$BUILD_CONFIGURATION" \
    -r "$TARGET_RUNTIME" \
    -o /app/publish \
    --no-restore \
    --self-contained false \
    /p:RestoreConfigFile=/src/config/build/backend-restore.xml \
    /p:UseAppHost=false \
    /p:TieredPGO=false \
    /p:TieredCompilation=true \
    /p:PublishReadyToRun=false

## =========================================================================
# Independent offline tool; never part of the Server publish directory/graph.
## =========================================================================
FROM build-${RUNTIME_BASE_FLAVOR} AS migration-build
ARG BUILD_CONFIGURATION=Release
ARG TARGET_RUNTIME=linux-musl-x64
ARG FSUSBLOG_COMMIT_SHA=0000000000000000000000000000000000000000
WORKDIR /src
RUN for input in /.editorconfig /.globalconfig /Directory.Build.props /Directory.Build.targets /Directory.Packages.props /NuGet.Config /NuGet.config /nuget.config /global.json; do test ! -e "$input" && test ! -L "$input" || exit 1; done
COPY --from=backend-inputs /migration/restore/ /src/
RUN test "$(cat /src/.migration-input-profile)" = "$(printf '%s\n%s\n%s\n' "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" "$FSUSBLOG_COMMIT_SHA")"
RUN dotnet restore "./src/migration/FsusBlog.Migration.csproj" --configfile /src/config/build/backend-restore.xml --runtime "$TARGET_RUNTIME" /p:Configuration="$BUILD_CONFIGURATION" /p:SelfContained=true /p:UseAppHost=false /p:PublishSingleFile=false /p:PublishTrimmed=false /p:PublishReadyToRun=false /p:ReadyToRunUseCrossgen2=false /p:FsusBlogCommitSha="$FSUSBLOG_COMMIT_SHA"

FROM migration-build AS migration-publish
COPY --from=backend-inputs /migration/compile/ /src/
RUN test "$(cat /src/.migration-input-profile)" = "$(printf '%s\n%s\n%s\n' "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" "$FSUSBLOG_COMMIT_SHA")"
RUN dotnet publish "./src/migration/FsusBlog.Migration.csproj" -c "$BUILD_CONFIGURATION" -r "$TARGET_RUNTIME" -o /app/migration-publish --no-restore --self-contained true /p:RestoreConfigFile=/src/config/build/backend-restore.xml /p:UseAppHost=false /p:PublishSingleFile=false /p:PublishTrimmed=false /p:PublishReadyToRun=false /p:ReadyToRunUseCrossgen2=false /p:FsusBlogCommitSha="$FSUSBLOG_COMMIT_SHA"

## =========================================================================
# 阶段 3：前端 Vue 构建
# Release 镜像只消费外部准备好的 wasm 工件包。
## =========================================================================
FROM node-runtime-musl AS frontend-build
ARG FSUSBLOG_USE_LOCAL_FSUSUI=0
ARG FSUSBLOG_RELEASE_CREATED_AT_UTC=local-unversioned
ARG FSUSBLOG_COMMIT_SHA=0000000000000000000000000000000000000000
ENV FSUSBLOG_USE_LOCAL_FSUSUI=${FSUSBLOG_USE_LOCAL_FSUSUI} \
    FSUSBLOG_LOCAL_FSUSUI_ROOT=/opt/fsusui \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

COPY src/frontend/package*.json ./
COPY src/frontend/scripts/fsusui-root.mjs src/frontend/scripts/prepare-local-fsusui-install.mjs ./scripts/
COPY --from=fsusui /vue/packages /opt/fsusui/vue/packages
COPY tools/frontend/ /tools/frontend/
COPY tools/security/comment-privacy-build-contract.mjs /tools/security/comment-privacy-build-contract.mjs
COPY tools/test-matrix/ /tools/test-matrix/

RUN --mount=type=secret,id=github_packages_token \
    /bin/sh -lc 'set -eu; \
      case "$FSUSBLOG_USE_LOCAL_FSUSUI" in \
      1) \
        tmp_install="$(mktemp -d)"; \
        cleanup() { rm -rf "${tmp_install}"; }; \
        trap cleanup EXIT; \
        node scripts/prepare-local-fsusui-install.mjs prepare --frontend-root /app --fsusui-root /opt/fsusui --output "${tmp_install}/input"; \
        : > "${tmp_install}/user.npmrc"; : > "${tmp_install}/global.npmrc"; \
        NPM_CONFIG_USERCONFIG="${tmp_install}/user.npmrc" NPM_CONFIG_GLOBALCONFIG="${tmp_install}/global.npmrc" \
          npm ci --prefix "${tmp_install}/input" --registry=https://registry.npmjs.org/ \
            --no-audit --no-fund --no-update-notifier --progress=false --fetch-retries=0; \
        mv "${tmp_install}/input/node_modules" /app/node_modules; \
        node scripts/prepare-local-fsusui-install.mjs verify --frontend-root /app --fsusui-root /opt/fsusui; \
        ;; \
      0) \
      token="$(cat /run/secrets/github_packages_token)"; \
      if [ -z "${token}" ]; then echo "github_packages_token is required for npm ci" >&2; exit 1; fi; \
      tmp_npmrc="$(mktemp)"; \
      cleanup() { rm -f "${tmp_npmrc}"; }; \
      trap cleanup EXIT; \
      printf "%s\n%s\n" \
        "@ozwasyd:registry=https://npm.pkg.github.com" \
        "//npm.pkg.github.com/:_authToken=${token}" > "${tmp_npmrc}"; \
      export NPM_CONFIG_USERCONFIG="${tmp_npmrc}"; \
      npm ci \
        --no-audit \
        --no-fund \
        --no-update-notifier \
        --progress=false \
        --fetch-retries=0; \
        ;; \
      *) echo "unsupported FSUSBLOG_USE_LOCAL_FSUSUI" >&2; exit 1 ;; \
      esac'

ARG FSUSBLOG_RELEASE_ID=local-unversioned
ENV VITE_FSUSBLOG_BUILD_ID=${FSUSBLOG_RELEASE_ID} \
    FSUSBLOG_RELEASE_CREATED_AT_UTC=${FSUSBLOG_RELEASE_CREATED_AT_UTC} \
    FSUSBLOG_COMMIT_SHA=${FSUSBLOG_COMMIT_SHA}
COPY tools/release/release-id.mjs /tools/release/release-id.mjs
COPY tools/test/run-command-manifest.mjs /tools/test/run-command-manifest.mjs
COPY tools/test/command-manifest-runtime.mjs /tools/test/command-manifest-runtime.mjs
COPY tools/test/bundles/bundle-steps.mjs /tools/test/bundles/bundle-steps.mjs
COPY tests/matrix.yml /tests/matrix.yml
COPY tools/yaml/parse-document.mjs /tools/yaml/parse-document.mjs
RUN ln -s /app/node_modules /opt/fsusui/node_modules
COPY src/frontend/ ./
COPY src/shared/ /src/shared/
RUN mkdir -p /src && ln -s /app /src/frontend && test "$(readlink /src/frontend)" = /app
COPY build/artifacts/wasm-release/ ./public/wasm/

RUN test -f public/wasm/SHA256SUMS && (cd public/wasm && sha256sum -c SHA256SUMS)
RUN node ../../tools/frontend/wasm-build-receipt.mjs verify-envelope \
    --root / \
    --client-root /app \
    --artifact-dir /app/public/wasm

RUN FSUSBLOG_SKIP_ENSURE_WASM=1 FSUSBLOG_FRONTEND_DIST_ROOT=/app/dist npm run build:release

COPY tools/docker/ssr-runtime-closure.mjs /tools/docker/ssr-runtime-closure.mjs
COPY config/build/ssr-runtime-inputs.json /config/build/ssr-runtime-inputs.json
RUN node /tools/docker/ssr-runtime-closure.mjs materialize \
    --client-root /app \
    --dist /app/dist \
    --inventory /config/build/ssr-runtime-inputs.json \
    --output /ssr-runtime

## =========================================================================
# 阶段 4：终极生成镜像 (融合前后端)
## =========================================================================
FROM base AS final
ARG FSUSBLOG_RELEASE_ID=local-unversioned
ARG FSUSBLOG_RELEASE_CREATED_AT_UTC=local-unversioned
ARG FSUSBLOG_COMMIT_SHA=0000000000000000000000000000000000000000
ARG FSUSBLOG_FSUSUI_SOURCE=published-package
ARG FSUSBLOG_FSUSUI_COMMIT_SHA=0000000000000000000000000000000000000000
ARG VCPKG_COMMIT
ARG RUNTIME_PROFILE_ID=throughput-musl
ARG RUNTIME_PROFILE_MANIFEST_DIGEST=sha256:0000000000000000000000000000000000000000000000000000000000000000
ARG RUNTIME_PROFILE_DIGEST=sha256:0000000000000000000000000000000000000000000000000000000000000000
ARG RUNTIME_BASE_FLAVOR=musl
ARG TARGET_RUNTIME=linux-musl-x64
ARG PUBLISH_SINGLE_FILE=true
ARG PUBLISH_READY_TO_RUN=false
ARG TIERED_PGO=true
ARG QUICK_JIT_FOR_LOOPS=true
ARG SERVER_GC=true
ARG NATIVE_AOT=false
ARG GC_HEAP_COUNT_MODE=container-default
ARG GC_HEAP_HARD_LIMIT_MODE=container-limit
ARG GC_HEAP_HARD_LIMIT_PERCENT=0
ARG THREAD_POOL_MODE=runtime-default
ARG THREAD_POOL_MIN_THREADS_PER_CPU=0
ARG TOPOLOGY_MODE=smt-visible
WORKDIR /app
ENV FSUSBLOG_ZK_GROTH16_NATIVE_LIBRARY=/app/native/zk/libfsus_zk_groth16.so
ENV FSUSBLOG_RUNTIME_PROFILE_ID=${RUNTIME_PROFILE_ID} \
    FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST=${RUNTIME_PROFILE_MANIFEST_DIGEST} \
    FSUSBLOG_RUNTIME_PROFILE_DIGEST=${RUNTIME_PROFILE_DIGEST} \
    FSUSBLOG_RUNTIME_GC_HEAP_COUNT_MODE=${GC_HEAP_COUNT_MODE} \
    FSUSBLOG_RUNTIME_GC_HEAP_HARD_LIMIT_MODE=${GC_HEAP_HARD_LIMIT_MODE} \
    FSUSBLOG_RUNTIME_GC_HEAP_HARD_LIMIT_PERCENT=${GC_HEAP_HARD_LIMIT_PERCENT} \
    FSUSBLOG_RUNTIME_THREAD_POOL_MODE=${THREAD_POOL_MODE} \
    FSUSBLOG_RUNTIME_THREAD_POOL_MIN_THREADS_PER_CPU=${THREAD_POOL_MIN_THREADS_PER_CPU} \
    FSUSBLOG_RUNTIME_TOPOLOGY_MODE=${TOPOLOGY_MODE} \
    DOTNET_ReadyToRun=${PUBLISH_READY_TO_RUN} \
    DOTNET_TieredPGO=${TIERED_PGO} \
    DOTNET_TC_QuickJitForLoops=${QUICK_JIT_FOR_LOOPS} \
    DOTNET_gcServer=${SERVER_GC}
LABEL org.opencontainers.image.version="${FSUSBLOG_RELEASE_ID}" \
      org.opencontainers.image.created="${FSUSBLOG_RELEASE_CREATED_AT_UTC}" \
      org.opencontainers.image.revision="${FSUSBLOG_COMMIT_SHA}" \
      io.fsusblog.release.manifest-schema="fsusblog.release-manifest.v3" \
      io.fsusblog.build.vcpkg-commit="${VCPKG_COMMIT}" \
      io.fsusblog.build.fsusui-source="${FSUSBLOG_FSUSUI_SOURCE}" \
      io.fsusblog.build.fsusui-commit="${FSUSBLOG_FSUSUI_COMMIT_SHA}" \
      io.fsusblog.runtime.node="required" \
      io.fsusblog.runtime.npm="forbidden" \
      io.fsusblog.runtime.profile-id="${RUNTIME_PROFILE_ID}" \
      io.fsusblog.runtime.profile-manifest-digest="${RUNTIME_PROFILE_MANIFEST_DIGEST}" \
      io.fsusblog.runtime.profile-digest="${RUNTIME_PROFILE_DIGEST}" \
      io.fsusblog.runtime.base-family="${RUNTIME_BASE_FLAVOR}" \
      io.fsusblog.runtime.target-runtime="${TARGET_RUNTIME}" \
      io.fsusblog.runtime.publish-single-file="${PUBLISH_SINGLE_FILE}" \
      io.fsusblog.runtime.publish-ready-to-run="${PUBLISH_READY_TO_RUN}" \
      io.fsusblog.runtime.tiered-pgo="${TIERED_PGO}" \
      io.fsusblog.runtime.quick-jit-for-loops="${QUICK_JIT_FOR_LOOPS}" \
      io.fsusblog.runtime.server-gc="${SERVER_GC}" \
      io.fsusblog.runtime.native-aot="${NATIVE_AOT}" \
      io.fsusblog.runtime.gc-heap-count-mode="${GC_HEAP_COUNT_MODE}" \
      io.fsusblog.runtime.gc-heap-hard-limit-mode="${GC_HEAP_HARD_LIMIT_MODE}" \
      io.fsusblog.runtime.gc-heap-hard-limit-percent="${GC_HEAP_HARD_LIMIT_PERCENT}" \
      io.fsusblog.runtime.thread-pool-mode="${THREAD_POOL_MODE}" \
      io.fsusblog.runtime.thread-pool-min-threads-per-cpu="${THREAD_POOL_MIN_THREADS_PER_CPU}" \
      io.fsusblog.runtime.topology-mode="${TOPOLOGY_MODE}"

COPY --from=publish --chown=$APP_UID:$APP_UID /app/publish .
COPY --chown=$APP_UID:$APP_UID security/zk/contracts/ ./security/zk/contracts/
COPY --from=frontend-build --chown=$APP_UID:$APP_UID /app/dist ./wwwroot
COPY --from=frontend-build --chown=$APP_UID:$APP_UID /ssr-runtime ./FsusBlog.ClientRuntime

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD host="${AllowedHosts%%;*}"; host="${host%%,*}"; \
      test -n "$host" && test "$host" != "*" && \
      curl -fsS -H "Host: $host" http://127.0.0.1:8080/health/live >/dev/null || exit 1

ENTRYPOINT ["./FsusBlog.Server"]

## =========================================================================
# Task-only image. Inherits the unchanged Server entrypoint, not an auto-migrate command.
## =========================================================================
FROM final AS current-native-task
COPY --from=migration-publish --chown=$APP_UID:$APP_UID /app/migration-publish /app/tools/migration
LABEL io.fsusblog.task.tool-contract="fsusblog.current-native-task-tool-image.v1"

## =========================================================================
# 阶段 5：Debug 最终镜像（仅后端，不含前端 release 构建产物）
## =========================================================================
FROM base AS debug-final
WORKDIR /app
COPY --from=publish-debug --chown=$APP_UID:$APP_UID /app/publish .
COPY --chown=$APP_UID:$APP_UID security/zk/contracts/ ./security/zk/contracts/
ENTRYPOINT ["dotnet", "FsusBlog.Server.dll"]
