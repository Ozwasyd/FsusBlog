# syntax=docker/dockerfile:1.7
ARG VCPKG_COMMIT=eae1680538b86f962455c27abca2aad0dc304a4d
## =========================================================================
# 阶段 1：.NET 基础运行环境 (Alpine)
# 单容器承载 Kestrel + 静态资源 + Node SSR worker。
## =========================================================================
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS base
WORKDIR /app
EXPOSE 8080

USER root
RUN apk add --no-cache icu-data-full icu-libs krb5-libs nodejs
RUN mkdir -p /app/wwwroot/uploads /app/Dictionaries /app/release-assets /app/release-derived && \
    chown -R $APP_UID:$APP_UID /app/wwwroot/uploads /app/Dictionaries /app/release-assets /app/release-derived

ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
ENV PATH="${PATH}:/usr/bin:/usr/share/dotnet"
USER $APP_UID

## =========================================================================
# 阶段 1.5：受控 wasm 工件构建
# 只用于导出受信 wasm artifact，不进入 final build 运行时链路。
## =========================================================================
FROM emscripten/emsdk:latest@sha256:e1b3e665245524ac6b62b180f9ccf9bd22308e6bb034f5fd9090df54fdbdfba6 AS wasm-builder
ARG VCPKG_COMMIT
WORKDIR /work

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      cmake \
      git \
      ninja-build \
      nodejs \
      npm \
      pkg-config \
      python3 \
      rsync \
      unzip \
      zip && \
    rm -rf /var/lib/apt/lists/*

COPY tools/vcpkg-overlays/ /work/tools/vcpkg-overlays/
COPY tools/frontend/ /work/tools/frontend/
COPY tools/frontend/ /tools/frontend/
COPY src/frontend/ /work/FsusBlog.Client/

RUN git clone https://github.com/microsoft/vcpkg.git /opt/vcpkg && \
    cd /opt/vcpkg && \
    git checkout "${VCPKG_COMMIT}" && \
    test "$(git rev-parse HEAD)" = "${VCPKG_COMMIT}" && \
    /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics

RUN bash -lc 'set -euo pipefail; \
  export PATH="/opt/vcpkg:${PATH}"; \
  export VCPKG_ROOT="/opt/vcpkg"; \
  cd /work/FsusBlog.Client; \
  bash /work/tools/frontend/install-wasm-codec-deps.sh; \
  bash ./wasm/build.sh; \
  node /work/tools/frontend/ensure-wasm.mjs write-manifest; \
  node /work/tools/frontend/ensure-wasm.mjs status'

FROM scratch AS wasm-artifact
COPY --from=wasm-builder /work/FsusBlog.Client/public/wasm/ /

## =========================================================================
# 阶段 2：.NET SDK 编译发布
## =========================================================================
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
ARG BUILD_CONFIGURATION=Release
ARG TARGET_RUNTIME=linux-musl-x64
WORKDIR /src

RUN apk add --no-cache nodejs npm

COPY ["src/backend/FsusBlog.Server.csproj", "src/backend/"]
COPY ["src/core/FsusBlog.Core.csproj", "src/core/"]
COPY ["src/shared/FsusBlog.Shared.csproj", "src/shared/"]

RUN sh -lc 'for i in 1 2 3; do dotnet restore "./src/backend/FsusBlog.Server.csproj" --runtime "$TARGET_RUNTIME" && exit 0; echo "dotnet restore retry $i failed"; sleep 5; done; exit 1'

COPY . .
WORKDIR "/src/src/backend"

RUN sh -lc 'for i in 1 2 3; do dotnet build "./FsusBlog.Server.csproj" -c "$BUILD_CONFIGURATION" -r "$TARGET_RUNTIME" -o /app/build --no-restore && exit 0; echo "dotnet build retry $i failed"; sleep 5; done; exit 1'

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
ARG TARGET_RUNTIME=linux-musl-x64
RUN sh -lc 'for i in 1 2 3; do dotnet publish "./FsusBlog.Server.csproj" \
    -c "$BUILD_CONFIGURATION" \
    -r "$TARGET_RUNTIME" \
    -o /app/publish \
    --no-restore \
    --self-contained true \
    /p:SkipClientDependenciesForPublish=true \
    /p:SkipClientReleaseBuild=true \
    /p:SkipClientReleaseArtifactCopy=true \
    /p:PublishSingleFile=true \
    /p:UseAppHost=true \
    /p:PublishTrimmed=false \
    /p:TieredPGO=true \
    /p:TieredCompilation=true \
    /p:PublishReadyToRun=false && exit 0; echo "dotnet publish retry $i failed"; sleep 5; done; exit 1'

ARG ZK_NATIVE_ARTIFACT_DIR=build/artifacts/native-zk
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
RUN sh -lc 'for i in 1 2 3; do dotnet publish "./FsusBlog.Server.csproj" \
    -c "$BUILD_CONFIGURATION" \
    -r "$TARGET_RUNTIME" \
    -o /app/publish \
    --no-restore \
    --self-contained false \
    /p:UseAppHost=false \
    /p:TieredPGO=false \
    /p:TieredCompilation=true \
    /p:PublishReadyToRun=false && exit 0; echo "dotnet publish debug retry $i failed"; sleep 5; done; exit 1'

## =========================================================================
# 阶段 3：前端 Vue 构建
# Release 镜像只消费外部准备好的 wasm 工件包。
## =========================================================================
FROM node:20-alpine AS frontend-build
ARG FSUSBLOG_RELEASE_ID=local-unversioned
ENV VITE_FSUSBLOG_BUILD_ID=${FSUSBLOG_RELEASE_ID}
WORKDIR /app

COPY src/frontend/package*.json ./
COPY tools/frontend/ /tools/frontend/

RUN --mount=type=secret,id=github_packages_token \
    /bin/sh -lc 'set -eu; \
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
        --progress=false \
        --fetch-retries=5 \
        --fetch-retry-mintimeout=2000 \
        --fetch-retry-maxtimeout=20000'

COPY src/frontend/ ./
COPY src/shared/ /src/shared/
RUN mkdir -p /src && ln -sfn /app /src/frontend
COPY build/artifacts/wasm-release/ ./public/wasm/

RUN test -f public/wasm/SHA256SUMS && sha256sum -c public/wasm/SHA256SUMS
RUN node ../../tools/frontend/ensure-wasm.mjs status

RUN npm run build:release

## =========================================================================
# 阶段 4：终极生成镜像 (融合前后端)
## =========================================================================
FROM base AS final
ARG FSUSBLOG_RELEASE_ID=local-unversioned
ARG FSUSBLOG_COMMIT_SHA=0000000000000000000000000000000000000000
ARG VCPKG_COMMIT
WORKDIR /app
ENV FSUSBLOG_ZK_GROTH16_NATIVE_LIBRARY=/app/native/zk/libfsus_zk_groth16.so
LABEL org.opencontainers.image.version="${FSUSBLOG_RELEASE_ID}" \
      org.opencontainers.image.revision="${FSUSBLOG_COMMIT_SHA}" \
      io.fsusblog.release.manifest-schema="fsusblog.release-manifest.v1" \
      io.fsusblog.build.vcpkg-commit="${VCPKG_COMMIT}" \
      io.fsusblog.runtime.node="required" \
      io.fsusblog.runtime.npm="forbidden" \
      io.fsusblog.runtime.publish-ready-to-run="false"

COPY --from=publish --chown=$APP_UID:$APP_UID /app/publish .
COPY --from=frontend-build --chown=$APP_UID:$APP_UID /app/dist ./wwwroot
COPY --from=frontend-build --chown=$APP_UID:$APP_UID /app ./FsusBlog.ClientRuntime

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health/live >/dev/null || exit 1

ENTRYPOINT ["./FsusBlog.Server"]

## =========================================================================
# 阶段 5：Debug 最终镜像（仅后端，不含前端 release 构建产物）
## =========================================================================
FROM base AS debug-final
WORKDIR /app
COPY --from=publish-debug --chown=$APP_UID:$APP_UID /app/publish .
ENTRYPOINT ["dotnet", "FsusBlog.Server.dll"]
