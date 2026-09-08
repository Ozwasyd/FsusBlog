# Frontend private runtime governance

Private browser behavior is accepted locally. The gate does not depend on a
real account, public network, production deployment, cloud telemetry, external
scanner or third-party browser platform.

## Required local matrix

The Vitest suite covers the four independent Cookie states: no session,
account only, admin only and both sessions. Each state crosses guest, account
and manage routes with `createMemoryHistory`. Passkey login starts by
invalidating any in-memory Guest result before the ceremony.

Cross-tab `login`, `logout`, `expired`, `user-expired` and `admin-changed`
events contain only an event kind and timestamp. A remote account-generation
change discards the current account snapshot; a remote logout or expiry emits
the route-free session-expiry bridge. The bridge removes the mounted private
view, which runs component request abort and subscription cleanup before the
sanitized login redirect is committed.

The private Storage Registry is the machine-readable inventory for auth
markers, challenge proofs, IndexedDB article recovery, upload sessions and
identity-derived UI preferences. Every exact key, database or prefix has a
table-driven cleanup assertion. The article journal gate covers exact
confirmation cleanup; create/edit and identity scopes; one, two and eight
tab-owned records; quota/unavailable, corrupt/old/unsupported codec, expired and
logical/stored oversize failure; deterministic `gzip-v1` raw representation;
bounded one-in-flight/one-latest scheduling; and 100k CJK/emoji round-trip.
Public theme, image preferences and Public AOT seed state are deliberately not
part of that registry. Compression is not encryption: the compressed payload
retains the same local profile privacy risk as the original private Markdown.

The production article-editor fixture covers the recovery prompt only when an
extra unsynced source hash exists. It verifies explicit candidate selection,
keyboard and touch actions, screen-reader naming, 375/1440 geometry, server
confirmation/discard cleanup and body-free multi-tab coordination. Process
recovery acceptance additionally launches a real browser with one persistent
profile, writes a fixed identity/article/base/client revision/content hash,
kills the browser process, relaunches the same profile and records JSON/PNG
evidence plus SHA-256. Reload, mocked IndexedDB and ordinary Playwright context
recreation do not satisfy that probe. Browser-process restart is not an OS
restart; an acceptance report must list OS restart as unrun unless the host was
actually rebooted.

Binary failure telemetry is categorical. Browser events may include failure
kind, numeric status/category, challenge outcome and frame type. They must not
include URL, query, server details, free-form message, token, trace ID or
business identifier. Private route query/history state follows an explicit
per-route allowlist and strips private fragments.

Run the focused gate from `src/frontend`:

```bash
npx vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/services/articleRecoveryJournal.test.ts \
  ../../tests/frontend/unit/router/index.test.ts \
  ../../tests/frontend/unit/bootstrap/sessionExpiryBridge.test.ts \
  ../../tests/frontend/unit/security/privateNavigationPolicy.test.ts \
  ../../tests/frontend/unit/services/privateStorageRegistry.test.ts \
  ../../tests/frontend/unit/services/authBroadcastRuntime.test.ts \
  ../../tests/frontend/unit/services/binaryTransport.test.ts \
  ../../tests/frontend/unit/services/serviceWorkerRuntime.test.ts
npm run check:private-runtime-governance
npm run check:pwa-offline-policy
node ../../tests/frontend/checks/static/check-article-recovery-journal.mjs
FSUSBLOG_ARTICLE_RECOVERY_PROBE_MODE=boot-identity-contract \
  node ../../tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs
npx playwright test article-editor-production-fixture.spec.ts
```

With this worktree's Vite server already listening on `127.0.0.1:3000`, run the
real process probe into a new evidence directory:

```bash
articleRecoveryEvidenceDir="$(mktemp -d /tmp/fsusblog-article-recovery-evidence.XXXXXX)"
FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR="$articleRecoveryEvidenceDir" \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 \
node ../../tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs
```

A real host reboot must use an explicit two-phase handoff; the browser-process probe
above is not a substitute. OS evidence must be stored in the current checkout's
ignored persistent `.tmp/`, never in `/tmp`, which may be cleared during reboot.
prepare writes immutable coordinates, the exact base URL/origin, the Linux boot
identity SHA-256, the implementation SHA-256, the persistent profile path, the body
hash, the screenshot hash and the subsequent exact commands, but does not claim that
a reboot has occurred. After the user authorizes and completes the host reboot and
the same origin's Vite is restarted in the same worktree, verify can read the same
profile. verify reads the current boot identity before launching the browser; the
same boot, an unreadable boot identity, or an origin or implementation hash mismatch
all fail closed and produce no OS verification:

```bash
mkdir -p ../../.tmp
articleRecoveryOsEvidenceDir="$(mktemp -d ../../.tmp/fsusblog-article-recovery-os-evidence.XXXXXX)"
FSUSBLOG_ARTICLE_RECOVERY_PROBE_MODE=os-restart-prepare \
FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR="$articleRecoveryOsEvidenceDir" \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 \
node ../../tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs

# After the user authorizes and completes a real host reboot, and the same Vite origin has recovered:
FSUSBLOG_ARTICLE_RECOVERY_PROBE_MODE=os-restart-verify \
FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR="$articleRecoveryOsEvidenceDir" \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 \
node ../../tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs

# After evidence collection, explicitly delete the persistent profile containing unpublished body content:
FSUSBLOG_ARTICLE_RECOVERY_PROBE_MODE=os-restart-cleanup \
FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR="$articleRecoveryOsEvidenceDir" \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 \
node ../../tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs
```

After completion, use only the exact cleanup command recorded by the handoff to
delete that task-owned profile. The same worktree, origin and implementation must be
preserved; broad-directory deletion is not a substitute for owner cleanup.

## Risk and rollback

The policy fails closed by dropping undeclared private query fields and
clearing registered private browser state. If a legitimate private filter is
lost, add that field to `PRIVATE_NAVIGATION_ALLOWED_FIELDS` with a focused
history test; do not disable the sanitizer. Operators can degrade without a
server restart by sending the existing privacy-clear control message, signing
out the affected browser session or disabling Service Worker registration in
the existing client runtime switch. Public AOT remains available because its
shell routes and cache inventory are separate from private state.
