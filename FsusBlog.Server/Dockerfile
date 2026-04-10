## =========================================================================
# 阶段 1：.NET 基础运行环境 (Alpine)
# [修复日期 2026-03-01] 物理对齐：必须将 base 阶段置于文件最顶部。
# 逻辑自洽：确保 Visual Studio Fast Mode (Debug) 能正确捕获并挂载 .NET 运行时环境。
# =========================================================================
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS base
WORKDIR /app
EXPOSE 8080

USER root
# 恢复 ICU 依赖库保障 Lucene 智能分词
RUN apk add --no-cache icu-data-full icu-libs

RUN mkdir -p /app/LuceneIndex /app/wwwroot/uploads /app/Dictionaries && \
    chown -R $APP_UID:$APP_UID /app/LuceneIndex /app/wwwroot/uploads /app/Dictionaries

ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
ENV PATH="${PATH}:/usr/bin:/usr/share/dotnet"
USER $APP_UID

# =========================================================================
# 阶段 2：.NET SDK 编译发布
# =========================================================================
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
COPY ["FsusBlog.Server/FsusBlog.Server.csproj", "FsusBlog.Server/"]
COPY ["FsusBlog.Core/FsusBlog.Core.csproj", "FsusBlog.Core/"]
COPY ["FsusBlog.Shared/FsusBlog.Shared.csproj", "FsusBlog.Shared/"]
RUN dotnet restore "./FsusBlog.Server/FsusBlog.Server.csproj"
COPY . .
WORKDIR "/src/FsusBlog.Server"
RUN dotnet build "./FsusBlog.Server.csproj" -c $BUILD_CONFIGURATION -o /app/build

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
RUN dotnet publish "./FsusBlog.Server.csproj" \
    -c $BUILD_CONFIGURATION \
    -o /app/publish \
    /p:UseAppHost=false \
    /p:TieredPGO=true \
    /p:TieredCompilation=true \
    /p:PublishReadyToRun=true \
    /p:ReadyToRunUseCrossgen2=true

# =========================================================================
# 阶段 3：前端 Vue 构建 (注入预编译 WASM)
# =========================================================================
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY FsusBlog.Client/package*.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --no-audit --progress=false

COPY FsusBlog.Client/ ./
# 注入 Wasm 安全产物 (PoW + AEDS 解码)
COPY FsusBlog.Client/public/wasm/ ./public/wasm/
RUN npm run build

# =========================================================================
# 阶段 4：终极生成镜像 (融合前后端)
# =========================================================================
FROM base AS final
WORKDIR /app

# 1. 复制后端 .NET 产物
COPY --from=publish --chown=$APP_UID:$APP_UID /app/publish .

# 2. 复制前端 Vue 产物到 Kestrel 的 wwwroot 根目录
COPY --from=frontend-build --chown=$APP_UID:$APP_UID /app/dist ./wwwroot

ENTRYPOINT ["dotnet", "FsusBlog.Server.dll"]
