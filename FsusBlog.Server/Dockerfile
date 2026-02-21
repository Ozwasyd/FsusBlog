# 请参阅 https://aka.ms/customizecontainer 以了解如何自定义调试容器。

# 阶段 1：基础运行环境 (Alpine 3.21)
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS base
WORKDIR /app
EXPOSE 8080

# 性能最大化：在一个层内完成原生库编译与清理
USER root
RUN apk add --no-cache icu-data-full icu-libs libstdc++ cmake g++ make

# 拷贝原生引擎源码并现场编译 (修订日期: 2026-02-21)
COPY FsusPowEngine/ /tmp/FsusPowEngine/
RUN cd /tmp/FsusPowEngine && \
    mkdir build && cd build && \
    cmake .. && make && \
    cp libFsusPowEngine.so /usr/lib/libFsusPowEngine.so && \
    cd / && rm -rf /tmp/FsusPowEngine

# 安全性保障：编译后立即卸载构建工具
RUN apk del cmake g++ make

# 核心修复(2026-02-21)：在镜像内预设持久化目录并移交所有权
# 逻辑自洽：由于具名卷在初始化时会复制镜像目录权限，此处 chown 是解决权限问题的根本。
RUN mkdir -p /app/LuceneIndex /app/wwwroot/uploads && \
    chown -R $APP_UID:$APP_UID /app/LuceneIndex /app/wwwroot/uploads

ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
ENV PATH="${PATH}:/usr/bin:/usr/share/dotnet"

# 切换到 .NET 10 推荐的非 root 安全用户
USER $APP_UID

# 阶段 2：SDK 编译环境
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
COPY ["FsusBlog.Server/FsusBlog.Server.csproj", "FsusBlog.Server/"]
RUN dotnet restore "./FsusBlog.Server/FsusBlog.Server.csproj"
COPY . .
WORKDIR "/src/FsusBlog.Server"
RUN dotnet build "./FsusBlog.Server.csproj" -c $BUILD_CONFIGURATION -o /app/build

# 阶段 3：发布产物
FROM build AS publish
ARG BUILD_CONFIGURATION=Release
RUN dotnet publish "./FsusBlog.Server.csproj" -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false

# 阶段 4：最终生成镜像
FROM base AS final
WORKDIR /app
# 性能最大化：COPY 时同步指定所有者，避免运行时出现权限抖动
COPY --from=publish --chown=$APP_UID:$APP_UID /app/publish .
ENTRYPOINT ["dotnet", "FsusBlog.Server.dll"]