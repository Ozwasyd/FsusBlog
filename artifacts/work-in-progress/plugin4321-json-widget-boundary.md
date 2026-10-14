# Plugin4321 JSON/widget source investigation

Ordinary WIP, not an authority, test, receipt or runtime acceptance. The source
investigation below describes fixed #4321 and the preserved documentary
checkpoint `39bafb645a1a98d0e0358e37854d1752b6b45bc9`. The later, explicitly
authorized source repair is recorded at the end; its new consumer review and
all runtime/UI qualification remain pending.

## Historical fixed-source investigation and actual checks

- Fixed product base: `759383052ff0865d464782e2587d48bfc5ce8920` (#4321).
- Source-only investigation branch: `codex/plugin4321-json-widget-boundary`.
- Genuine clean local UI957: `903db034a14254fb162f51b9c25d3703ea20ccb5`,
  `/workspace/FsusUI-main4311-ui957`.
- Original full application baseline actually completed exit2/FAIL,
  **34 diagnostics /22 files (Blog9/UI25)**. Command:
  `FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI-main4311-ui957 node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application`.
- Original scoped strict-full style attempt exit1/BLOCKED: configured ESLint
  and Stylelint executables absent. No current lint PASS or any removal claim.
- Product sources/config/manifest/lock are unchanged. No after-source compiler
  run is claimed for a documentation-only increment.
- All product imports/runtime/render/picker/widgets/tests/discovery/native/
  security/privacy/qualification remain HOLD/UNRUN. No combination task request,
  package publication, merge or issue closure.

## Schema validation does not validate the current value

The #4320 recursive schema fact remains correct. PluginPackageReader admits an
object-root schema and recursively checks its supported type/metadata nodes.
It allows `default` (line38), supports array/boolean/integer/null/number/object/
string (41–49), and its node validator (368–467) does not validate a default
instance against the declared type. This investigation does not weaken or
replace that validator.

PluginAdminService.cs establishes a different instance-value chain:

1. `PluginAdminConfigStore.GetOrCreate`,19–30, calls CreateDefault.
2. `CreateDefault`,101–125, returns `schema.default.Clone()` immediately when
   present. Otherwise it copies individual property defaults into an object;
   those values are not instance-validated either.
3. `GetAsync`,300–305 and336–341, passes `config.Value` into the success DTO.
4. Shared PluginAdminConfigDto (ServerResponseContracts.cs1692–1697) carries a
   JsonElement, not an object-only dictionary.
5. Frontend frame233 uses mapAuthoringJsonFromPayload
   (binaryDecoderRegistry.ts348), whose JSON.parse is a generic decode, not
   a schema/value check. `getPlugin` (authoring.ts1764–1773) is generic request
   plumbing, not another value validator.
6. `selectPlugin`, PluginAdmin.vue617–633, assigns the result and performs
   `structuredClone(detail.value.config.value)` without a root-shape guard.
   `runAction` similarly resets the draft from the actual response.

Consequently authoring.ts146's `value: Record<string, unknown>` and the page's
`ref<Record<string, any>>` cannot be treated as unconditional producer facts.
This is not a reason to change the decoder or the global request layer.

## Historical source counterexamples (not executed tests)

Assume an otherwise valid plugin package. This is an admitted schema document:

```json
{"type":"object","properties":{"enabled":{"type":"boolean"}},"default":null}
```

By the source chain above, CreateDefault returns null and the successful detail
can carry it to the draft. The boolean branch's `configDraft[field.name]`
(PluginAdmin.vue269–271) dereferences null. With an enum field, Object.hasOwn
and selectedEnumOption (564–575) also require a usable receiver. Replacing
null with `{}` or rejecting the load would change output/error behavior, not
provide a type-only repair. Arrays/primitive roots also cannot simply be
asserted to dictionaries: existing spreads and save submission have different
observable behavior for them.

An object root alone is still insufficient. A schema can provide a boolean
property default array or a numeric property default string:

```json
{"type":"object","properties":{"enabled":{"type":"boolean","default":[]},"count":{"type":"number","default":"7"}}}
```

The property-default copy preserves those exact JSON values. UI957 Switch
switch.vue201–205 emits inactiveValue on setup when the current value is neither
active nor inactive; the page's v-model writes that emission into the draft.
InputNumber327–332 calls Number(modelValue) on mounting a nonnumber, non-null
value and emits the conversion. Its immediate verifyValue path also enforces
bounds and can emit changes (208–238,294–304). Therefore supplying a invented
false/0/empty model or copying those normalizers into an adapter would conceal
real draft mutation. This is a source-path deduction, not observed mounting.

There is also a valid-value case beyond malformed defaults: a non-enum object,
array or null field is a supported schema kind. It falls into the page's text
ElInput branch (279–283). That public prop declares string/number/null/undefined
(input.ts35–41); input.vue298–300 displays String(value) or empty for nil.
Nested JSON is not a typed text model. Editing returns a string rather than
the original object/array, after which the backend can reject the mismatch.

## Save and rejection authority must remain intact

saveConfig (PluginAdmin.vue795–826) obtains ensureAdminSensitiveProof, submits
the actual draft with the original plugin ID and expectedConfigVersion, and
preserves original success/catch/finally behavior. authoring.ts1798–1818 builds
the existing mutation request. Endpoint655–660 passes a JsonElement and the
expected version into UpdateConfigAsync. The config store Update34–58 first
validates against the schema, then checks the version and clones the accepted
value. Type rejection, enum rejection, MFA/version and reload failures remain
with their original owners.

Do not wrap raw rejects, reject all non-object responses at the load boundary,
normalize the entire configuration, replace unsupported fields/defaults, or
reinterpret schema type as proof of a value type merely to satisfy TypeScript.
Decoder overprecision and unrelated Main upload/Facts work are outside scope.

## Historical implementation blocker and minimum decision

There is no honest behavior-preserving replacement for the remaining any
under the current constraints: unknown is a truthful receiver type, but cannot
be passed to all declared widget model domains, and schema validation does not
prove a current value belongs to those domains. A partial type-only widening
would introduce compiler errors while leaving the real boundary unresolved.

Before a safe complete implementation, the product/source owner must define:

1. How a non-object root default is presented and explicitly repaired without
   silently changing it or moving existing server rejection into the loader.
2. How supported non-enum nested object/array/null fields are edited, and how
   scalar mismatches remain visible without automatic widget coercion.

Minimum prospective repair: retain raw configuration as unknown; construct
field view models only after real root/value guards; pass real supported values
through without defaults; preserve own-property/unset/null distinctions and
original enum identity/stale-option checks; require deliberate repair for
unsupported values. This needs explicit behavior decisions. It is not yet
implemented and is not permission to redesign the whole configuration editor.

## Exact source fingerprints

| Repository/path | Pinned blob |
| --- | --- |
| Blog views/admin/PluginAdmin.vue | `4e318bc00768c52d388a6e07c669242e4e0f6f90` |
| Blog api/authoring.ts | `edb96315255a815d36c593de8da6794d1cbdd988` |
| Blog backend/Infrastructure/Plugins/PluginAdminService.cs | `b78a83f533961b457c3895040a920c003a8a558b` |
| Blog backend/Infrastructure/Plugins/PluginPackageReader.cs | `263ee6b6133a042af4bf4077f313c357c36d540c` |
| UI957 switch/src/switch.vue | `5ed6989873d2e5c1c41365baca578376e0b5a6be` |
| UI957 input-number/src/input-number.vue | `4f4065dcb05dacddb157704a31cedeeccd7c4649` |
| UI957 input/src/input.vue | `2f4a613e4036e2aaa0d9f2dcf95d98682ee6be65` |
| UI957 input/src/input.ts | `81d2886a99c0a7e61a7256b53354266d797eafe8` |

Raw original commands/logs/exits remain in
`/tmp/plugin4321-widget-baseline-*`; summary
`/tmp/plugin4321-widget-source-investigation-summary.json`.

## Authorized JSON/widget source repair

The caller subsequently authorized preserving non-object roots and mismatched
fields with visible errors, plus explicit type-preserving JSON editing/application.
The source now implements that behavior within this page, without changing the
package reader, decoder, config store, upload/Facts paths or frozen authorities.

- API config response and mutation value are unknown, matching actual JsonElement
  and default semantics. Only those two type declarations change; complete
  original-options API JS24539 bytes is byte-identical.
- The draft begins unset, not as an invented object. Loaded values still use the
  original structuredClone calls. Non-object roots are retained/displayed with
  an error and an explicit root JSON repair action; fields are not dereferenced.
- Each field's real current value is inspected. Boolean/string controls receive
  only actual matching values or a genuinely absent input. Numbers must be finite,
  satisfy integer/range requirements and valid bounds before the original number
  control is mounted. No invalid value reaches a control's automatic coercion or
  clamp path. Mismatches and non-enum structured/null values retain their value
  and receive explicit JSON editing. Unset and own null remain distinct.
- Number clear preserves the actual null/undefined payload, never zero. All widget
  writes retain the actual emitted value and refuse stale field/view records.
- The existing enum JSON predicate is exported/reused, not copied. Original enum
  predicate/equality bodies and canonical value choices remain unchanged; guards
  now require the real root object before own-property access or assignment.
- JSON text is separate from configuration. Only an explicit Apply invokes the
  native parser and changes the targeted local root/field. Syntax/unsupported
  numeric parse failure retains both old value and text, displaying its error.
  Non-finite or unsafe integral edited numbers are rejected instead of silently
  accepting their lossy representation. Original decoded number-precision gaps
  remain unresolved; there is no raw-decimal/E2E precision claim.
- Editor capture binds the current detail, draft identity and actual schema field;
  replacing any of them refuses an old application without losing its text.
  Applying JSON does not call save or move schema validation into the loader.
- Original ten functions (loadOverview, selectPlugin, handleInstall, runAction,
  runDangerousAction, togglePermission, saveConfig and three display helpers) are
  source-text byte-identical. MFA, expected version, server schema validation,
  success/failed save and reload rejection retain the original chain. The only
  new catch handles this local parser; it does not wrap existing raw rejections.

Actual same original UI957/full project before34/22FAIL and final34/22FAIL;
all complete diagnostic blocks byte-identical, zero added/removed. Source AST/SFC
parse0, page/new model AnyKeyword0 and added cast/non-null assertions0. Original
configured style attempts remain exit1/BLOCKED with missing tools; no lint PASS.
No helper/parser/widget/product/test function was executed. Template/runtime
behavior intentionally changes; no whole-page JS/render identity claim.

Final ordinary static records: `/tmp/plugin4325-source-static-result.json`,
`/tmp/plugin4325-final-current-type-delta.json` and
`/tmp/plugin4325-final-current-full-types.log`/`.exit`. These are source observations,
not frozen qualification receipts. No package publication, merge, issue closure,
runtime/render/keyboard/security/privacy/native or other qualification.

## Independent P2 review: own-property editor reads

The independent review identified a concrete discrepancy at the preceding head
`2d39aba1539f1869e6e8ab7c76a7d678c03613f0`: widget presentation used
`Object.hasOwn(object, field.name)`, but beginJsonEdit read
`object?.[field.name]`. For the legal schema
`{"type":"object","properties":{"__proto__":{"type":"object"}}}`
and a loaded empty object without a default, presentation showed unset while
the editor could read the inherited Object.prototype and display its JSON
representation. An explicit Apply could then introduce an own field that had
no original value. This is a source-derived counterexample, not a runtime test.

The editor now reads a field only when the root is an object and
`Object.hasOwn(object, field.name)` is true; otherwise its value is undefined.
Missing fields therefore retain the existing empty text / explicit-input message,
instead of serializing an inherited value as an apparent current value. Actual
own values, including null or an own __proto__ field, still reach the existing
representation path. Root editing still reads sourceDraft. No legal key is
forbidden; successful explicit Apply still uses the unchanged safe computed
property spread, and opening the editor never changes configDraft.

Only this initializer changes in product source. Tooling-only TS/SFC AST and
exact source comparison against the preceding head establish the root/own/missing
branches and preserve every other page statement/template/style and all other
product files. The original ten load/action/save/MFA/version functions, parser
catch boundaries, enum predicate/equality, and complete API emitted JS remain
unchanged. Page/new model AnyKeyword0 and added cast/non-null assertions0.

The original complete static command was rerun with the same genuine clean
UI957 `903db034a14254fb162f51b9c25d3703ea20ccb5`:

```sh
FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI-main4311-ui957 node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
```

Actual exit2/FAIL34/22 remains. Every complete diagnostic block is byte-identical
to both the preceding implementation and the original fixed-source baseline;
zero added/removed. The original strict-full style command was retried for the
four product paths: exit1/BLOCKED because the configured ESLint/Stylelint tools
are absent. No install, alternate rules, or lint PASS claim. Diff check passes.

Ordinary source evidence is in `/tmp/plugin4325-own-property-source-static.cjs`,
`/tmp/plugin4325-own-property-source-static-result.json`,
`/tmp/plugin4325-own-property-type-delta.json`,
`/tmp/plugin4325-own-property-full-types.log`/`.exit` and
`/tmp/plugin4325-own-property-style.log`/`.exit`. These records are source-only;
no product import/helper/parser/widget/test or rendered interaction was executed.
All runtime/tests/discovery/native/security/privacy/receipt/backuprestore/IME/
frozen qualification remain HOLD/UNRUN. Draft/source review continues; no merge,
close, Ready transition, or package publication.

## Independent P2 review: selection and async request ownership

The first own-property correction at
`f01ada8eebb92e0f5fe8505a5ebbb183521700b4` was independently reviewed. A second
source review found that detail/draft/schema identity alone did not cover time
spent awaiting MFA, save responses, or a new selection's detail load. Apply could
consume editor text during an outstanding save, then the old save response could
replace the newly applied draft. A changed selectedId also left the previous
detail/editor eligible until getPlugin completed. The caller explicitly authorized
fixing the actual selection/save/load ownership, including their original bugs.

Every selectPlugin call now creates a fresh selection record and request identity,
even for the same plugin ID. The loaded detail is associated with that selection
only after its current getPlugin request completes. Configuration edits require
that actual association, matching selectedId/pluginId and a finished current load.
The editor captures selection, request and draft revision alongside the existing
detail/draft/schema field. Tokens are local ownership records, not auth grants,
server versions, cancellation receipts or transport cancellation.

saveConfig captures the actual plugin, detail/version, draft and draft revision
before awaiting MFA. A current pending-save record prevents duplicate Save entry.
The original MFA call and proof token still precede mutatePlugin; current source
ownership is checked both after MFA and after the mutation response. Only a still
current response can replace the captured detail/draft or show the success toast.
Scalar/enum writes may update the current local draft while a save awaits; they
create a fresh draft revision, so an earlier response cannot overwrite that edit.
JSON Apply instead refuses any current pending save before parsing, and keeps the
editor's exact text. A later Apply also requires the captured request/revision and
selection. There is no automatic rebinding/application or repair of a stale editor.

loadOverview has its own latest-request identity and captures the selection,
config request and draft revision. A stale list response cannot trigger a new
selection or overwrite local ownership after a newer selection/request/edit.
The empty-list transition invalidates detail/request/save ownership without
inventing a configuration object. Selection/load/save finally blocks release only
their own still-current loading/pending records. Old save completion cannot clear
a newer save's pending record; it never closes or updates a JSON editor.

The following are source-derived schedules, not executed test cases:

| Schedule | Source disposition |
| --- | --- |
| Save starts, then Apply | Pending-save guard returns before parsing; config and editor text retained |
| MFA awaits, then selection or draft changes | Source guards return before mutatePlugin; no token or version substitution |
| Save sent, then a scalar/enum draft changes | Response source/revision guard returns before replacing detail/draft |
| Select A, B, A; first A responds last | Fresh selection identity rejects first A despite matching plugin ID |
| Two same-ID loads complete out of order | Only current selection/request can install detail or clear detailLoading |
| Repeated Save while pending | Early return avoids another MFA/mutation request |
| Close/reopen editor while a request awaits | Explicit close/reopen owns editor replacement; async handlers never mutate editor text or clear it |
| Parse failure or stale Apply | Existing parser catch / stale guard retains text and original draft |
| Earlier overview responds after selection/save/edit | Captured selection/request/revision mismatch prevents its reload transition |

An already dispatched server mutation may still complete. Ignoring its stale
local response does not undo that server write or invent a new version; subsequent
server version/schema/reload rejection retains the original authority. This change
does not qualify unrelated install/action/permission concurrency or server behavior.
Their original methods remain byte-identical. loadOverview, selectPlugin and
saveConfig intentionally change; their raw catch bodies are byte-identical, with
the same error object passed to the original showErrorToast calls. Existing parser
catch, safe computed-key spread and own-property correction remain intact. No
config coercion/default, key ban, auth grant or backend/API/decoder/UI change.

Static TS/SFC AST/source comparison verifies the pre-write guards, current-request
finally ownership, captured MFA/version payload, own-property read and unchanged
template/styles. The other thirteen page functions are text-byte-identical to the
first P2 source, including the original seven install/action/permission/display
functions. Other product files and complete emitted API JS remain unchanged;
page/new model AnyKeyword0 and added cast/non-null assertions0.

The same original full command above was rerun against real clean UI957
`903db034a14254fb162f51b9c25d3703ea20ccb5`. Final actual exit2/FAIL34/22;
all complete diagnostic blocks byte-identical to both the first P2 source and the
fixed baseline, zero added/removed. An initial candidate produced two additional
type errors from Vue's generic shallowRef<object | null> overload. The pending
record is used only by script ownership checks, so it was changed to an ordinary
nullable variable and the final complete command rerun. The initial 36/23 log is
retained separately; it is not the final result. No assertion or compiler/config
weakening. The original scoped strict-full style attempt on final source remains
exit1/BLOCKED because configured ESLint/Stylelint are absent. Diff check passes.

Ordinary source evidence: `/tmp/plugin4325-lifecycle-source-static.cjs`,
`/tmp/plugin4325-lifecycle-source-static-result.json`,
`/tmp/plugin4325-lifecycle-type-delta.json`,
`/tmp/plugin4325-lifecycle-full-types.log`/`.exit` and
`/tmp/plugin4325-lifecycle-style.log`/`.exit`. Initial failed compiler evidence is
`/tmp/plugin4325-lifecycle-initial-full-types.log`/`.exit` and
`/tmp/plugin4325-lifecycle-initial-type-delta.json`. No product helper, parser,
widget, MFA/server flow, rendered interaction or test was executed. All runtime/
tests/discovery/native/security/privacy/receipt/backuprestore/IME/frozen
qualification remains HOLD/UNRUN. Independent reviewer 01a12c4a is to review the
new exact source commit; no merge, close, Ready transition or package publication.
