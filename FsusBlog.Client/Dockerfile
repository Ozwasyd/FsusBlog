# FsusBlog 前端多阶段构建 (修复日期: 2026-02-20)
# 修正说明：将 Node 阶段置顶以确保 VS 调试模式下 npm 工具链可用，补充缺失的启动进程，并对齐 3000 端口

# 阶段 1: 前端构建与开发环境 (逻辑自洽：VS 调试的目标阶段)
FROM node:20-alpine AS build-stage
WORKDIR /app
# 对齐 Vite 日志显示的 3000 端口
EXPOSE 3000

# 性能最大化：利用层缓存优化依赖安装
COPY FsusBlog.Client/package*.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --no-audit --progress=false

# 核心修复 1：为开发调试阶段补充默认的启动命令。
# 必须存在前台进程，否则目标锁定在 build-stage 时容器会瞬间闪退！
CMD ["npm", "run", "dev"]

# 阶段 2: 编译 WASM 引擎 (并行独立阶段)
FROM emscripten/emsdk:latest AS wasm-build
WORKDIR /engine
COPY FsusPowEngine/ ./
RUN mkdir build && cd build && \
    emcmake cmake .. -DWASM_SIMD=ON && \
    make

# 阶段 3: 源码注入与生产构建
FROM build-stage AS builder
COPY FsusBlog.Client/ ./

# 安全性保障：从 wasm-build 注入算力盾核心产物
COPY --from=wasm-build /engine/build/fsus_pow_simd.js ./public/wasm/
COPY --from=wasm-build /engine/build/fsus_pow_simd.wasm ./public/wasm/

# 逻辑自洽：执行生产级打包
RUN npm run build

# 阶段 4: 生产环境静态文件托管
FROM nginx:alpine AS production-stage
# 逻辑自洽：复制静态构建产物到 Nginx 默认工作目录
COPY --from=builder /app/dist /usr/share/nginx/html

# 逻辑自洽：将同目录下的客户端 Nginx 配置文件覆盖到容器内部
COPY FsusBlog.Client/nginx.conf /etc/nginx/conf.d/default.conf

# 核心修复 2：暴露 3000 端口以彻底对齐外层 OpenResty 网关的目标端点
EXPOSE 3000

# 安全性保障：使用守护进程关闭模式在前台运行 Nginx，防止容器退出
CMD ["nginx", "-g", "daemon off;"]