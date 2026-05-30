# GEMINI.md - FsusBlog Project Context

This document provides essential context and instructions for AI agents working on the FsusBlog project.

## Project Overview

FsusBlog is a high-performance, full-stack blog system designed for real-world deployment. It prioritizes SEO, first-paint speed (AOT hydration), and engineering maintainability.

### Key Technologies
- **Backend**: .NET 10, C# 14, ASP.NET Core, SqlSugar (PostgreSQL), Redis.
- **Frontend**: Vue 3.5, Vite 7.3.2, Tailwind CSS 4, Pinia 3.
- **WebAssembly**: C++23 (freestanding) for AEDS decoding, CRC32, and Markdown rendering.
- **Data Transfer**: AEDS v1 (Binary protocol) for high-frequency read paths, JSON for management/auth.
- **Search**: Client-side WASM-based search using static indices.

### Architecture Highlights
- **Single-Tenant Full-Stack**: A monolithic architecture that minimizes deployment complexity.
- **AOT + SPA Hydration**: Public pages are pre-rendered for SEO and speed, then hydrated by the SPA.
- **Security-First**: Integrated PoW, JWT, MFA, Passkey (WebAuthn/FIDO2), and multi-session management.

## Project Structure

- `src/backend/`: ASP.NET Core 10 API and server logic.
- `src/frontend/`: Vue 3 SPA, WASM assets, and Service Workers.
- `src/shared/`: Shared contracts and binary protocol models.
- `src/core/`: Core algorithms, mapping, and POD codec logic.
- `tests/`: Multi-tier testing suite (backend unit/integration tests).
- `docs/`: Comprehensive technical documentation.
- `tools/`: Build, test, and deployment scripts.
- `ops/`: Docker and infrastructure configuration.

## Building and Running

### Prerequisites
- .NET SDK 10.0+
- Node.js 20 LTS+, npm 10+
- Docker & Docker Compose
- `GITHUB_PACKAGES_TOKEN` (required for installing the private `FsusUI` component library)

### Local Development
1.  **Infrastructure**: Start PostgreSQL and Redis via Docker.
    ```bash
    docker compose -f docker-compose.dev.yml up -d
    ```
2.  **Backend**: Run the API server.
    ```bash
    cd src/backend
    dotnet run
    ```
    - API URL: `http://127.0.0.1:5000`
3.  **Frontend**: Install dependencies and start the Vite dev server.
    ```bash
    cd src/frontend
    npm ci
    npm run dev:debug
    ```
    - Frontend URL: `http://127.0.0.1:3000` (HMR enabled)
4.  **WASM**: Ensure WASM binaries are present.
    ```bash
    cd src/frontend
    npm run ensure:wasm
    ```

### Testing
Use the tiered testing script:
```bash
./tools/test.sh <tier>
```
Available tiers: `fast`, `integration`, `ci`, `release`, `acceptance`, `visual`, `security`, `resilience`, `load`, `production`.

## Development Conventions

- **Binary vs JSON**: Use AEDS v1 binary protocol for performance-critical read paths (articles, lists, comments). Use JSON for write operations and administrative tasks.
- **AOT Compatibility**: Ensure shared DTOs and models are compatible with AOT serialization.
- **Error Codes**: Maintain alignment between backend error codes and frontend handling (verified via `npm run check:error-code-alignment`).
- **Testing Requirements**: Any PR must pass the `production` tier of tests, which includes zero compilation warnings and full coverage of critical paths.
- **Styling**: Prefer Tailwind CSS 4 utility classes.
- **State Management**: Use Pinia for client-side state.

## Important Files
- `src/backend/Program.cs`: Backend entry point and service configuration.
- `src/frontend/vite.config.ts`: Frontend build and proxy settings.
- `src/core/Algorithms/AEDS_V1_PROTOCOL.md`: Binary protocol specification.
- `docs/architecture.md`: Detailed system architecture.
- `docs/development.md`: Local setup and development guide.
- `docs/api/contracts.md`: API request/response contracts.
