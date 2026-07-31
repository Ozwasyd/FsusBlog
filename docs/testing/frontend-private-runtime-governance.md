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

真实 host reboot 必须使用显式两阶段交接，不能用上述 browser-process probe
替代。OS evidence 必须放在当前 checkout 的 ignored persistent `.tmp/`，不得放入
重启时可能清空的 `/tmp`。prepare 写入 immutable coordinates、exact base URL/origin、
Linux boot identity SHA-256、实现 SHA-256、persistent profile path、正文 hash、截图
hash 和后续 exact 命令，但不声称已经重启；用户授权并完成主机重启、在同一 worktree
重新启动同一 origin 的 Vite 后，verify 才能读取同一 profile。verify 在启动浏览器前
读取当前 boot identity；同一 boot、boot identity 不可读、origin 或实现 hash 不一致
都 fail closed，不生成 OS verification：

```bash
mkdir -p ../../.tmp
articleRecoveryOsEvidenceDir="$(mktemp -d ../../.tmp/fsusblog-article-recovery-os-evidence.XXXXXX)"
FSUSBLOG_ARTICLE_RECOVERY_PROBE_MODE=os-restart-prepare \
FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR="$articleRecoveryOsEvidenceDir" \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 \
node ../../tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs

# 用户授权并完成真实主机重启，且同一 Vite origin 已恢复后：
FSUSBLOG_ARTICLE_RECOVERY_PROBE_MODE=os-restart-verify \
FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR="$articleRecoveryOsEvidenceDir" \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 \
node ../../tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs

# 证据收集完成后显式删除含未发布正文的 persistent profile：
FSUSBLOG_ARTICLE_RECOVERY_PROBE_MODE=os-restart-cleanup \
FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR="$articleRecoveryOsEvidenceDir" \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 \
node ../../tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs
```

完成后只用 handoff 记录的 exact cleanup command 删除该 task-owned profile；必须保持
同一 worktree、origin 和 implementation，不能用宽泛目录删除替代 owner cleanup。

## Risk and rollback

The policy fails closed by dropping undeclared private query fields and
clearing registered private browser state. If a legitimate private filter is
lost, add that field to `PRIVATE_NAVIGATION_ALLOWED_FIELDS` with a focused
history test; do not disable the sanitizer. Operators can degrade without a
server restart by sending the existing privacy-clear control message, signing
out the affected browser session or disabling Service Worker registration in
the existing client runtime switch. Public AOT remains available because its
shell routes and cache inventory are separate from private state.
