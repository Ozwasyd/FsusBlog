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

2026-11-14 本地验证：源 `theme-chalk/src/fsus.scss` 由 Sass 编译。Vite 的 worker 使用 ES module，并配置 Vue 与 Vue JSX 插件。最初探针缺少 Wasm；用户确认安装编译套件后，按 FsusUI CI 固定版本安装了 Emscripten `5.0.4`，并在当前 checkout 执行 `pnpm run build:wasm`。六个原生文件和 TypeScript 包装层均从源码生成；Git 跟踪文件未变。运行时检查 `node ./vue/tests/wasm/check-markdown-wasm-runtime.mjs` 通过 basic 和 SIMD 两种产物。

V2 严格 `vue-tsc` 与生产构建均通过，默认 alias 直接打包了本轮从源码构建的资源，没有设置预构建目录覆盖。Chrome 在 1280×800 和 375×850 渲染实际 FsusUI `ElPublicShell`、点击真实 `ElButton`、切换主题，并验证 `ElMarkdownEditor` 编辑后 `ElMarkdownRenderer` 更新标题。两种尺寸均无控制台错误、构建覆盖层或横向溢出。该探针验证组件和资源；数据库闭环单列在 [Web 验证](web-validation.md)。

重建命令，在相邻的 FsusUI 仓库运行（使用其锁定的 pnpm 10.33.0）：

```sh
EMSDK="$HOME/.local/share/fsus-toolchains/emsdk-5.0.4" pnpm run build:wasm
node ./vue/tests/wasm/check-markdown-wasm-runtime.mjs
```

本轮构建的 native 输入指纹为 `d9ab11dbb005141eb3cee174624c0952412c858ab93b84c77d4f1b76e2d46c96`；三份 Wasm 的 SHA-256 分别为 `9f57e7c9d212a9be6c88eb879cd43f5238e357a62730c78c6d03101c5d1c155c`（EP）、`e54010511da2fc888fdd38daf9d7466db544aeccc0e681a40e6fdc8046f10f45`（basic）、`3bfa9681881888c53425717f7f1ed7b279abe4ed96d0a314a39df9fbd6c76d85`（SIMD）。
