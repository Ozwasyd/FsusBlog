# 请参阅 https://aka.ms/customizecontainer 以了解如何自定义调试容器，以及 Visual Studio 如何使用此 Dockerfile 生成映像以更快地进行调试。

# 此阶段用于在快速模式(默认为调试配置)下从 VS 运行时
# 优化：使用 alpine 版本以最大化性能并减小镜像体积
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS base
USER $APP_UID
WORKDIR /app
EXPOSE 8080

# 此阶段用于生成服务项目
# 优化：SDK 阶段同步使用 alpine 版本，保持构建环境与运行环境逻辑自洽
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
COPY ["FsusBlog.Server/FsusBlog.Server.csproj", "FsusBlog.Server/"]
RUN dotnet restore "./FsusBlog.Server/FsusBlog.Server.csproj"
COPY . .
WORKDIR "/src/FsusBlog.Server"
RUN dotnet build "./FsusBlog.Server.csproj" -c $BUILD_CONFIGURATION -o /app/build

# 此阶段用于发布要复制到最终阶段的服务项目
FROM build AS publish
ARG BUILD_CONFIGURATION=Release
# 确保在发布阶段包含所有内容，UseAppHost=false 减小产物大小
RUN dotnet publish "./FsusBlog.Server.csproj" -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false

# 此阶段在生产中使用，或在常规模式下从 VS 运行时使用(在不使用调试配置时为默认值)
FROM base AS final
WORKDIR /app

USER root
# 安装 ICU 库（Lucene 中文分词必须）
RUN apk add --no-cache icu-data-full icu-libs

# 关闭全球化不变模式
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false

# 逻辑自洽：从 publish 阶段拷贝完整的应用程序产物（包含 wwwroot 及其下的资源文件）
COPY --from=publish /app/publish .

# 性能与安全性提醒：此处的 ENTRYPOINT 确保了程序以最优化的 dotnet 托管模式运行
ENTRYPOINT ["dotnet", "FsusBlog.Server.dll"]