# 阶段 1: 编译 Vue 3 + TypeScript
FROM node:20-alpine AS build-stage
WORKDIR /app
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --no-audit --progress=false
COPY . .
RUN npm run build

# 阶段 2: 纯净静态服务
FROM nginx:stable-alpine
# 移除所有冗余配置，仅保留最简内核
RUN rm /etc/nginx/conf.d/default.conf

# 拷贝构建产物
COPY --from=build-stage /app/dist /usr/share/nginx/html

# 仅拷贝最简化的前端路由配置文件（见下文）
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]