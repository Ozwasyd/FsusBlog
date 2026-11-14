# FsusUI 本地源码接入

FsusBlog v2 沿用 v1 的 Vue 组件接口，业务代码继续从 `@ozwasyd/element-plus` 及公开子路径导入。Vite 与 `vue-tsc` 都将这些入口解析到相邻的 `../FsusUI` 仓库；不得静默转向 npm 发布包，也不发布或复制 FsusUI。路径是相对 **FsusBlogV2 仓库根目录** 的，从 `src/Web` 则是 `../../../FsusUI`。

| 消费入口 | 本地源码 |
| --- | --- |
| `@ozwasyd/element-plus` | `vue/packages/element-plus/index.ts` |
| `@ozwasyd/element-plus/theme` | `vue/packages/element-plus/theme.ts` |
| `@ozwasyd/element-plus/icons-vue` | `vue/packages/element-plus/icons-vue.ts` |
| `@ozwasyd/element-plus/markdown-runtime` | `vue/packages/element-plus/markdown-runtime.ts` |

构建配置需要解析 FsusUI 内部使用的 `@element-plus/*`，其中图标入口在 `icons-vue/src/index.ts`，Wasm 的 TypeScript 入口在 `wasm/index.ts`。这些内部别名仅用于构建 FsusUI，Blog 的业务代码使用公开入口。Vite 需指定开发服务器的源码访问范围，并去除重复 Vue 副本；TypeScript 需使用同一 checkout 的真实组件类型与公开消费者测试契约。主题使用该 checkout 的 `theme-chalk` 基础样式和 Fsus 主题；Blog 不复制其 token，不修改组件私有选择器。

对照依据：v1 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 的 `src/frontend/scripts/fsusui-local.ts`、`src/frontend/tsconfig.fsusui-local.json` 和 `src/frontend/vite.config.ts`。当前 FsusUI 基线为干净 checkout `f2d929a5d045439c35e93b4771f912ce50ec2337`。该 checkout 有源码和本地 `node_modules`，检查时没有 `theme-chalk/dist` 和 `wasm/dist`。完整编辑器和 Markdown 渲染须核验匹配的离线 Wasm 产物；组件 alias 能解析不等于 Wasm 已可运行。
