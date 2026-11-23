# FsusUI 本地源码接入

> **角色**：前端集成契约
> **适用对象**：前端维护者与发布构建人员
> **权威依据**：路径映射与指纹校验以 [`src/Web/vite.config.ts`](../src/Web/vite.config.ts) 与 [`src/Web/tsconfig.json`](../src/Web/tsconfig.json) 为准。

## 1. 消费入口与仓库边界

FsusBlog v2 业务代码仅从 `@ozwasyd/element-plus` 及其公开子路径导入组件与主题。Vite 与 `vue-tsc` 均将这些入口解析到相邻的 `../FsusUI` 仓库源码（相对 `src/Web/` 为 `../../../FsusUI`）；**不得静默回退至 npm 发布包**，也不得在 FsusBlog 仓库中复制 FsusUI token 或覆写组件私有选择器。

| 公开消费入口 | 本地 FsusUI 源码路径 |
| --- | --- |
| `@ozwasyd/element-plus` | `vue/packages/element-plus/index.ts` |
| `@ozwasyd/element-plus/theme` | `vue/packages/element-plus/theme.ts` |
| `@ozwasyd/element-plus/icons-vue` | `vue/packages/element-plus/icons-vue.ts` |
| `@ozwasyd/element-plus/markdown-runtime` | `vue/packages/element-plus/markdown-runtime.ts` |

- 构建配置同时解析 FsusUI 内部依赖 `@element-plus/*`（图标位于 `icons-vue/src/index.ts`，Wasm 包装位于 `wasm/index.ts`）以支持源码直编；Blog 业务代码不得直接导入这些内部路径。
- Vite 将主题入口解析至 `theme-chalk/src/fsus.scss` 由 Sass 实时编译，并去除重复 Vue 副本；开发时 `./tools/dev.sh` 支持联动修改 `../FsusUI` 源码热更新。
- 当前对齐的相邻 FsusUI 源码基线为 `v1.6.0-preview.10`（包含 `#1123` 语法高亮代码块片段 ID 保留、`#1125` 窄屏 `ElThreadPanel` 页头换行、`#1126` 窄屏 `ElCheckbox` 标签换行及 `#1127` 设置/站内信原语具名插槽响应式更新）。

## 2. 原生 Markdown Wasm 构建与指纹校验

完整 Markdown 编辑器与渲染器依赖相邻 FsusUI 检出构建出的 6 个原生 Wasm 产物；可通过环境变量 `FSUSBLOG_FSUSUI_WASM_DIST` 显式指向预构建产物目录。Vite 与 `tools/build-release.sh` 会调用 FsusUI 工具重新计算 native 源指纹并与 `.native-artifact-fingerprint` 逐字节比对：

- 显式指定目录缺文件或指纹不匹配时，构建立即 fail-closed 拒绝；
- 未指定预构建目录且本地 checkout 尚未产出 Wasm 时，写作区域退回原始 Markdown 编辑并明确提示富编辑不可用，公开详情以转义文本展示。

在相邻 `../FsusUI` 仓库重建原生 Wasm 并核验运行时的命令（使用其锁定的 Emscripten `5.0.4` 与 pnpm）：

```sh
EMSDK="$HOME/.local/share/fsus-toolchains/emsdk-5.0.4" pnpm run build:wasm
node ./vue/tests/wasm/check-markdown-wasm-runtime.mjs
```

前端构建与浏览器验收入口见 [Web 构建与端到端验证](web-validation.md)。
