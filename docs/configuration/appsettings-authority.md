# Appsettings and production input authority

FsusBlog has one shared application configuration base and one runtime production overlay. Environment examples are overlays or operator inputs; they are not complete copies of the configuration tree.

## Owned files

| Purpose | Authority |
| --- | --- |
| Shared non-secret defaults and configuration shape | `src/backend/appsettings.json` |
| Production policy, production-safe defaults and fail-closed empty values | `src/backend/appsettings.Production.json` |
| Local development-only differences | `src/backend/appsettings.Development.example.json` |
| Production operator input example | `config/examples/.env.production.example` |
| Real production secrets and cryptographic material | Environment variables or mounted files outside Git |

The retired full JSON examples are not replaced. A resolved configuration may be generated as temporary CI evidence, but must not become another hand-maintained authority.

## Runtime precedence

ASP.NET Core and the deployment tooling apply configuration in this order, with each later layer overriding earlier values:

```text
src/backend/appsettings.json
< src/backend/appsettings.Production.json
< environment variables loaded from .env.production / Compose
< explicit command-line overrides
```

The Git-tracked production environment example is never loaded directly. Operators create the private input and replace every placeholder:

```bash
cp config/examples/.env.production.example .env.production
$EDITOR .env.production
```

Deployment commands continue to consume `.env.production`; renaming the example does not change the runtime input name.

## Overlay constraints

The development example contains only local differences such as loopback PostgreSQL/Redis, the local auth fixture, insecure local cookies, synthetic release-fence settings, and localhost browser origins. A value already inherited unchanged from the base does not belong in the overlay.

The production overlay may repeat an empty value when doing so makes a fail-closed production boundary explicit. It must not contain database credentials, usable signing material, peppers, tokens or other real secrets. Those values come from the private environment input or mounted files and are still validated by production startup.

## Governance

Run:

```bash
node tools/configuration/check-appsettings-authority.mjs
node --test tests/tools/appsettings-authority.test.mjs
```

The checker rejects another full `appsettings*.example.json`, redundant or undeclared development leaves, unexpected production sections, non-empty fail-closed values, production examples containing non-placeholder secrets, and consumers that use a non-canonical operator template name.

This ownership cleanup does not weaken startup validation or change security, privacy, ZK, database, rollout, frontend, or backend runtime semantics.

## Current allowed configuration values

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.allowed-values
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: configuration.allowed-values
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN configuration.allowed-values -->
| Key | Value |
| --- | --- |
| key_416e7469437261776c65723a4d6f6465 | {"identity":"AntiCrawler:Mode","value":&#91;"disabled","observe","enforce","strict","lockdown"&#93;} |
| key_53656375726974793a416e7469437261776c65723a4d6f6465 | {"identity":"Security:AntiCrawler:Mode","value":&#91;"disabled","observe","enforce","strict","lockdown"&#93;} |
<!-- FSUSBLOG-GENERATED:END configuration.allowed-values -->
