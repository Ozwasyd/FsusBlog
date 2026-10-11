# Rail locale type-import correction

Source f27a1c5eb0191134b48780e58b60dfd1473000eb changes only
src/frontend/src/contracts/binaryApi.ts: one normal import type of actual
SupportedLocale and replacement of original inline import types at177/184.
Preimage is exactly original c08ace9061492fbfab1dea8d57928a998938dcc8, also current
before-head d020d72cd16885471b7168c9e41c49c285707d4e. No DTO, alias target, runtime
value, generated frame/operation, frozen catalog, cast, suppression or shim changed.

Original strict entry:
node tools/frontend/check-frontend-style.mjs --mode strict-full --file src/frontend/src/contracts/binaryApi.ts
Actual before exit1/two consistent-type-imports findings at177:18 and184:18;
actual frozen sourcef27 after exit0/zero findings. TS6.0.3 official transpile
emits identical runtime JS (hash in equivalence.json), diagnostics0/0. ASTs are
identical after normalizing only the two exact original import-type nodes to the
same actual named type binding and removing that one added type-only import.
Actual locale module resolution and real export source are recorded; all other
nodes/comments and actual Preview/Facts declarations are unchanged.

rail-minimal.patch.gz is the lossless one-file patch. pre-binaryApi.ts.gz and
post-binaryApi.ts.gz are complete bytes. source-binding.json gives both Git blob
IDs, SHA256, source commit and patch digest. Actual forward apply-check/application
on the exactc08 preimage and postimage equality passed; reverse-check passed.
Integrated Rail exact head was not supplied, so no guessed Rail execution is claimed.

First original-checker attempt failed EISDIR before lint: a root dependency
symlink was treated as an untracked source path. Preserved lint-before records
are setup failure, not rule results. A task-owned ignored node_modules directory
with locked-cache entries fixed layout without editing checker/config/rules.
Original package/lock bytes matched caches.201 owned links were removed; shared
caches preserved. Lint helper temporary local alias project is not a protocol
or frozen-authority producer. No install or full generator ran.

No full typecheck, runtime/product tests, backend/native/security/receipt
qualification or frozen-authority refresh. Four generated frame symbols, AEDS
frozen catalog and all existing holds are unchanged. Original API/source offers
remain source-bound historical records; this local lint fix does not clear their
producer or acceptance blockers.
