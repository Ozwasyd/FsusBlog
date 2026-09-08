# FsusBlog Client

Vue 3 SPA integrating a WebAssembly decoder, Service Worker offline search, and static hydration for public pages.

## Scope

- **SPA + public hydration:** anonymous visits use an AOT-rendered HTML shell; Vue takes over after login.
- **Binary protocol:** application APIs use AEDS v2 frames; TypeScript decodes small payloads on the main thread and a Wasm Web Worker handles large ones.
- **Local search:** the Service Worker caches a static index and Wasm ranks it in-browser; there is no online server search.
- **Type safety:** TypeScript strict mode, Pinia state machines, and typed Vue Router routes.

## Layout

```text
src/frontend/
├── src/
│   ├── api/                # AEDS binary client and domain API functions
│   ├── adapters/           # Binary payload → contract mapping
│   ├── codecs/             # Business-neutral binary readers and request encoders
│   ├── composition/        # Decoder registry and transport composition root
│   ├── contracts/          # Runtime-free API/adapter/worker shared types
│   ├── composables/        # Business composables (for example, passkey login/management)
│   ├── store/              # Pinia state machines (article, comment, auth, ...)
│   ├── views/              # Page components (auth/, user/, public/, ...)
│   ├── components/         # Reusable UI components
│   ├── workers/            # Web Workers (wasmDecode.worker.ts)
│   ├── router/             # Vue Router route definitions
│   ├── layouts/            # Page layout frames
│   ├── helpers/            # Utility functions
│   ├── services/           # Business services
│   ├── public-renderers/   # Public-page hydration renderers
│   └── bootstrap/          # Application startup
├── wasm/                   # C++23 Wasm decoder source
│   ├── aeds/               # AEDS v2 decoder
│   ├── CMakeLists.txt      # CMake build configuration
│   └── build.sh            # Emscripten build script
├── tests/
│   ├── checks/             # Node.js gates (static/security/runtime/wasm/public)
│   ├── e2e/                # Playwright E2E specs
│   ├── fixtures/           # Test fixtures and account setup scripts
│   └── support/            # Shared HTTP/auth/binary/Playwright helpers
├── scripts/                # Build, Wasm, public-page generation, and local tools
├── public/                 # Static public assets
├── package.json
├── vite.config.ts
├── tsconfig.json
└── playwright.config.ts
```

## Requirements

- Node.js 20+ and npm 10+.
- `GITHUB_PACKAGES_TOKEN` for the private FsusUI package.
- Emscripten SDK only when rebuilding Wasm locally.
- Backend at `http://127.0.0.1:7568`; `npm run dev:debug` proxies to it.

## Browser runtime baseline

Browser TypeScript and Vite production output are fixed at ES2022; Node/Vite build tooling keeps an isolated ES2023 configuration. ES2022 is not a full browser/Web Platform support claim: DOM, Service Worker, WebAuthn, Trusted Types, and Wasm remain governed by feature detection and the browser matrix. See [Browser Runtime Baseline](../../docs/frontend/browser-runtime-baseline.md) for constraints and rollback.

## Install

```bash
export GITHUB_PACKAGES_TOKEN=your_github_packages_token
npm ci
```

## Common commands

| Command | Purpose |
| ------ | ------ |
| `npm run dev:debug` | Dev server on port 3000 with HMR and proxy to 7568. |
| `npm run build` | Production release build (`build:release`). |
| `npm run preview` | Preview release output on port 8080. |
| `npm run build:wasm` | Rebuild the C++23 Wasm decoder (Emscripten required). |

## Tests

Run frontend tests through `npm run check:*` and tiered `../tools/test.sh <tier>`.

**Static checks** (no service required):

```bash
npm run check:modern-standards        # Language version and ES2022 baseline
npm run check:result-boundaries       # Result<T> boundaries
npm run check:security-consistency    # Security configuration consistency
npm run check:error-code-alignment    # Error-code alignment
npm run check:binary-import-boundaries # Acyclic binary API/transport/adapter imports
npm run check:views-constraints       # View-layer constraints
npm run check:server-try-catch        # try/catch policy
```

**Wasm checks** (built artifacts required):

```bash
npm run check:aot                     # AOT / Wasm integrity
npm run check:image-codec-wasm        # Image-codec Wasm checks
```

**Runtime checks** (full debug stack on 3000/7568 required):

```bash
npm run check:notification-stream-runtime             # Stream connection resilience
npm run check:notification-stream-live                # Handshake/reconnect smoke
npm run check:api-contracts                           # Unified API response matrix
npm run check:binary-contract-smoke                   # Binary state/frame alignment
npm run check:search-runtime                          # Search smoke test
npm run check:sw-search-runtime                       # Service Worker search
npm run check:public-hydration                        # Public hydration consistency
```

**E2E** (full debug stack required):

```bash
npx playwright test                   # All E2E
npx playwright test tests/e2e/acceptance/
```

See [tests/frontend/README.md](../../tests/frontend/README.md) for test layout.

## Wasm decoder

`wasm/` contains the freestanding C++23 AEDS v2 decoder:

- no STL containers, heap allocation, or exception propagation;
- `alloc_buffer` / `free_buffer` for browser-side allocation;
- `decode_aeds` for 16-byte header validation, CRC16 payload validation, and compact POD decoding;
- decoding in a dedicated `workers/wasmDecode.worker.ts` Web Worker, keeping the main thread unblocked.

Rebuild Wasm locally (with an activated Emscripten SDK):

```bash
npm run build:wasm
```

See the [AEDS v2 protocol specification](../core/Algorithms/AEDS_V2_PROTOCOL.md).
