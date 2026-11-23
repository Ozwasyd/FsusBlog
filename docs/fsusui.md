# FsusUI 接入与原生组件契约

> **角色**：前端与原生 Markdown 解析器集成契约
> **适用对象**：前后端维护者与发布构建人员
> **权威依据**：前端依赖版本与注册表配置以 [`src/Web/package.json`](../src/Web/package.json)、[`src/Web/pnpm-lock.yaml`](../src/Web/pnpm-lock.yaml)、[`src/Web/.npmrc`](../src/Web/.npmrc) 与 [`src/Web/vite.config.ts`](../src/Web/vite.config.ts) 为准；后端内嵌 C++ 标题解析器以 [`src/Server/Authoring/FsusMarkdown/UPSTREAM.json`](../src/Server/Authoring/FsusMarkdown/UPSTREAM.json) 与 [`src/Server/FsusBlog.V2.Server.csproj`](../src/Server/FsusBlog.V2.Server.csproj) 为准。

## 1. 前端 npm 包接入（GitHub Packages）

FsusBlog v2 前端通过锁定版本的 GitHub Packages npm 包 `@ozwasyd/element-plus`（当前锁定 `1.6.0-preview.10`）消费 FsusUI 组件、主题与原生 Markdown Wasm 运行时，不再依赖相邻 `../FsusUI` 本地源码检出；业务代码仅从以下公开入口导入，**不得复制 FsusUI token 或以私有选择器掩盖上游缺陷**：

| 公开消费入口 | 用途 |
| --- | --- |
| `@ozwasyd/element-plus` | Vue 组件与全局类型 |
| `@ozwasyd/element-plus/theme` | 主题读写与视图过渡同步 |
| `@ozwasyd/element-plus/icons-vue` | 公开图标组件 |
| `@ozwasyd/element-plus/markdown-runtime` | 原生 Markdown 渲染与坐标映射运行时 |
| `@ozwasyd/element-plus/dist/fsus.css` | 预编译 FsusUI 主题样式表 |
| `@ozwasyd/element-plus/es/locale/lang/{en,zh-cn}` | 公开语言包 |

- [`src/Web/.npmrc`](../src/Web/.npmrc) 将 `@ozwasyd` 作用域路由至 `https://npm.pkg.github.com/`，仓库内不存放任何明文 Token。
- 首次联机安装或升级版本时，需提供具备 `read:packages` 权限的 GitHub Token（例如在 `~/.npmrc` 配置 `//npm.pkg.github.com/:_authToken=<TOKEN>`，或临时执行）：

```sh
cd src/Web
pnpm --config.//npm.pkg.github.com/:_authToken="$(gh auth token)" install --frozen-lockfile --ignore-scripts
```

- 本地离线恢复、类型检查与构建无需 Token：

```sh
cd src/Web
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run build
```

- 说明：`@ozwasyd/element-plus@1.6.0-preview.10` 发布包在运行时已完整导出 `ElSelect`、`ElOption` 与 `icons-vue/ArrowDown`，但其 `.d.ts` 产物遗漏了 `es/components/select/index.d.ts`、`es/components/select/src/select.vue.d.ts` 与 `es/icons-vue/**/*.d.ts`；[`src/Web/src/fsusui-published-types.d.ts`](../src/Web/src/fsusui-published-types.d.ts) 仅针对这两处缺失声明做最小补齐，待上游补全声明产物后移除。

## 2. 内置原生 Markdown Wasm 校验

`@ozwasyd/element-plus` 发布包已在 `es/wasm/dist/` 内置全部 6 个原生 Wasm 产物（`ep_wasm.mjs/.wasm`、`markdown_basic.js/.wasm`、`markdown_simd.js/.wasm`），完整性由 `src/Web/pnpm-lock.yaml` 的 SHA-512 摘要锁定：

- [`src/Web/vite.config.ts`](../src/Web/vite.config.ts) 在构建与开发启动前 fail-closed 核验全部 6 个内置 Wasm 文件存在，缺失时拒绝启动。
- [`tools/build-release.sh`](../tools/build-release.sh) 与 [`tools/verify-release.py`](../tools/verify-release.py) 记录 `@ozwasyd/element-plus@<version>` 并对打包产出的 3 个 `.wasm` 资产与包内源文件逐字节比对 SHA-256。

## 3. 后端内嵌 C++ Markdown 标题解析器

作者章节标题搜索依赖的 C++23 原生动态库 `libfsus_author_heading`（macOS `.dylib` / Linux `.so`）由 [`src/Server/FsusBlog.V2.Server.csproj`](../src/Server/FsusBlog.V2.Server.csproj) 直接编译本仓内嵌目录 [`src/Server/Authoring/FsusMarkdown/`](../src/Server/Authoring/FsusMarkdown/) 下的 7 个源码/头文件，随发布产物输出 MIT 许可 `licenses/FsusUI-MIT.txt`。

- 来源版本、精确提交 SHA 与逐文件 SHA-256 记录于 [`src/Server/Authoring/FsusMarkdown/UPSTREAM.json`](../src/Server/Authoring/FsusMarkdown/UPSTREAM.json)（当前与 `@ozwasyd/element-plus@1.6.0-preview.10` 同源）。
- 升级 `@ozwasyd/element-plus` 版本时，若上游 `vue/packages/wasm/markdown/` C++ 语法解析源码有变更，须同步更新 `src/Server/Authoring/FsusMarkdown/` 与 `UPSTREAM.json`，并运行 `dotnet build` 与作者搜索集成测试核验一致性。

前端构建与浏览器验收入口见 [Web 构建与端到端验证](web-validation.md)。
