from pathlib import Path
import json,subprocess,hashlib,shutil,datetime
root=Path('/workspace/FsusBlog-group-property-recheck-3663');e=Path('/workspace/chain-3663-evidence/group-metadata-integration');out=root/'artifacts/article-packages/chain-3663-group-metadata-integration';out.mkdir(parents=True,exist_ok=True)
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();assert sha=='f3928561aec01b728fc5eae09e568f97481f8ed1'
for p in e.rglob('*'):
 if not p.is_file() or any(v in ('obj','bin') for v in p.relative_to(e).parts):continue
 target=out/p.relative_to(e);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,target)
v=Path('/workspace/chain-3663-evidence/group-version-integration')
for p in v.rglob('*'):
 if not p.is_file() or any(x in ('obj','bin') for x in p.relative_to(v).parts):continue
 target=out/'version-integration-011470'/p.relative_to(v);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,target)
checks={p.stem:json.loads(p.read_text()) for p in e.glob('*.json') if isinstance(json.loads(p.read_text()),dict) and 'exitCode' in json.loads(p.read_text())}
checks['current-tests']['commandReference']='approved-tests-command.json'
checks['current-tests'].pop('command')
statuses={3663:'HOLD: original trust31 controls/full matrices/native/provider and independent runtime qualification; no rerun authorized.',2398:'WIP: sole finite codec, version registry, property/metadata/taxonomy/asset components implemented; accepted complete V1 root and legitimate source admission remain.',2408:'WIP: same finite components and selected historical DTO bridge; complete manifests/provenance/privacy/version acceptance remain.',2400:'WIP: finite frozen export writer/property planner; complete canonical source, assets, frozen/permission/runtime gate remain.',2410:'WIP: same finite export source; original frozen plan and accepted schema/export runtime remain.',2402:'HOLD: finite intake/bytes/ZIP source exists; accepted export/schema and formal complete preflight remain.',2411:'HOLD: finite intake exists; original full schema/rights/plan preflight unaccepted.',2404:'HOLD: accepted preflight and real resolution/definition/permission inputs missing.',2413:'HOLD: accepted preflight and canonical resolution/replan authority missing.',2405:'HOLD: accepted plan and canonical atomic executor/rollback/recovery/outbox/audit gates missing.',2415:'HOLD: accepted plan and original execution/recovery/permission authority missing.',2406:'WIP: bounded read-only review module released to parent; no source delivery or UI acceptance yet; execution remains refused.',2418:'WIP: same released read-only review surface; product resolution/results/execution authority and #1853 evidence missing.',2407:'HOLD: accepted replacement and migration acceptance absent; no legacy retirement.',2409:'HOLD: terminal whole-chain/native/mutation/performance/caption acceptance.',2420:'HOLD: terminal whole-chain qualification and independent runtime acceptance.'}
report={'schema':'fsusblog.article-package.component-integration-evidence.v1','capturedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'testedSourceSha':sha,'originalVerifiedMasterBeforeSourceWork':'be7c53d99b64342925ca63d061bacde34d22ba4c','latestFetchedMasterBeforeGroupWork':'537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea','publishedBranch':'codex/chain-3663-group-property-recheck','publishedSourceSha':sha,'sdk':'10.0.302','wholeSourceCount':131,'testCases':795,'failed':0,'skipped':0,'selectedClasses':14,'newAssetCollectionCases':97,'newHistoricalMetadataCases':27,'checks':checks,'supplierBlobEvidence':'supplier-blobs-preserved.json','preflight':'case-preflight.json','testReceipt':'trx-summary.json','qualification':'finite managed component only; not original runtime/product acceptance','restoreBinding':'b3a2c6a71f35f7420136a2e0f0023e5864457140; identical dependency/configuration/lock surface to tested source; later commits change only source/docs','docs':'FAIL: exactly26 prior diagnostics, same locations/messages; no suppression','historicalProvider':'Exact da5 source consumed; provider originally built0errors/323warnings. Its six original tests remain UNRUN, excluded from this component selection. Lifecycle service is outside this131-file compile closure.','wholeBackendAndShared':'UNRUN on combined source. Supplier full-test restore reportedNU1004 and fullShared187 diagnostics; not inherited as a pass. Lock dependency owner remains sole #3568.','heldGates':['original trust31 controls','original full matrices','native/cgroup/provider/DB/HTTP acceptance','mutation/performance/caption round-trip','independent verifier'],'issueStates':{str(k):{'accepted':False,'state':'open','status':v} for k,v in statuses.items()},'trackingIssues':[],'sourceFailuresPreserved':['preliminary-build: missing real dependency files','preliminary-build-2: missing real RegionModerationDecision file','preliminary-build-3/4: dependency closure and fixture IDE0055 formatting','current-strict-build at01184f1: wrong byte verifier method name','current-commit-range: invalid CLI arguments; corrected command passes'],'noOriginalAcceptanceGateChanged':True,'noSharedLockRegeneration':True,'noMergeClosureDeployOrDirectMasterPush':True}
(out/'final-report.json').write_text(json.dumps(report,indent=4)+'\n')
supplier=json.loads((root/'artifacts/article-packages/chain-3663-current-property-source/supplier-input-requirements.json').read_text());supplier['testedComponentCommit']=sha;supplier['publishedComponentBranch']='codex/chain-3663-group-property-recheck';supplier['supersedesOnlyCurrentAvailability']='Historical prior source report remains exact-bound; do not rewrite it.'
for item in supplier.get('observedMissingSourceFields',[]):
 if 'CanonicalUrl' in item.get('field',''):item.update(actualAvailable='Exact original historical DTO/source da5d862 consumed unchanged. Own ArticlePackageHistoricalMetadataMapper binds selected revision/source bytes and snapshot IDs, preserves nullable CanonicalUrl and stored policy/content hashes;27cases pass atf392856.',required='No missing CanonicalUrl source request remains. Original provider six cases and persisted operation authorization/runtime acceptance still required; no historical lifecycle facts inferred.')
# The field lives in a separately named list in the original producer record.
def update_url(value):
 if isinstance(value,dict):
  if value.get('field')=='Historical rights CanonicalUrl':value.update(actualAvailable='Exact original da5d862 DTO/provider source consumed unchanged; selected historical mapper27cases pass atf392856 and preserve URL/null and original hashes.',required='Source field available; original provider six tests remainUNRUN and source/permission/DB runtime acceptance pending. Do not infer historical route/status/schedule.')
  for child in value.values():update_url(child)
 elif isinstance(value,list):
  for child in value:update_url(child)
update_url(supplier)
supplier['deliveredModules']={'versionRegistry':'5fbb78fce4238ebc65f25f9426f1e770be21b695','assetCollection':'901f1f82c492cdd65887e84f8895e0abca42f24f','historicalCanonicalUrl':'da5d862e575674595327b38388fb7417d256cfec'}
(out/'current-supplier-requests.json').write_text(json.dumps(supplier,indent=4)+'\n')
release={'baseSourceSha':sha,'originalPlanBlob':'703501fe781def4f7818bff75fb7943b24ae2406','originalPlanPath':'src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidatePlanner.cs','existingFrontendPackageComponentsOrTsContracts':[],'releasedExclusivePaths':['src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateReviewContracts.cs','src/backend/Services/Authoring/ArticlePackageImportCandidateReviewProjection.cs','tests/backend/Unit/ArticlePackageImportCandidateReviewProjectionTests.cs','src/frontend/src/api/types/articlePackageCandidateReview.ts','src/frontend/src/components/admin/article-packages/ArticlePackageCandidateReview.vue'],'release':'Parent chooses sole UI worker; no independent duplicate implementation here. Dedicated new frontend test files accompany the released module.','sourceFields':['Candidate.Manifest version tuple, article count, SemanticDigest','Candidate.PackageBytesDigest','Actor/request assertions (not permission decisions)','Mode, PolicyDigest, CreatedAtUtc, ExpiresAtUtc, PlanDigest','Targets: PortableArticle, RequiresNewIdentity, RequestedTargetArticleId, ExpectedTargetRevision','RequiredAuthorities','RequireExecutionAuthority(): always false/article_package_import_authority_unavailable'],'constraints':['copy original plan only; no second planner/digest/parser/writer','typed immutable read model; bounded pagination and content-free diagnostics','requested targets remain unresolved hints','unknown asset/unresolved counts stay unknown, not zero','execution always disabled; not-executed is not a zero-write runtime receipt','no browser ZIP parser, content API writes, route authority, registry/DI edits','no source/private title telemetry or fake permission-allowed targets'],'retainedOwnerPaths':['original planner','registry','DI/HTTP routes','historical metadata mapper','original providers/writers'],'notAcceptedIssues':[2406,2418]}
(out/'ui-module-release.json').write_text(json.dumps(release,indent=4)+'\n')
(out/'README.md').write_text('''# Article package component integration receipt

Exact tested source: `f3928561aec01b728fc5eae09e568f97481f8ed1` on
`codex/chain-3663-group-property-recheck`. This is bounded managed component
verification, not original runtime or issue acceptance. All 16 issues remain open.

The selected historical DTO now supplies nullable `CanonicalUrl`; its original
policy/content hashes remain unchanged. The mapper checks exact coordinates,
source bytes and snapshot references, delegates to the sole metadata codec, and
retains refusal of source authority. Historical route/status/schedule are absent.

- Strict compilation: 131 complete actual source files, zero warnings/errors.
- Tests: 795 passed, zero failed/skipped; 14 explicitly selected classes.
- New selected controls: 97 asset-collection and 27 historical metadata cases.
- Preflight: exact case count, positive fully qualified methods, selected hooks
  and repeated exact discovery checked before execution; no empty fallback.
- Restore: audited, locked dependency surface at `b3a2c6a`; unchanged thereafter.
- Style: two new owned files pass. Corrected commit-range command passes.
- Docs: the same 26 prior diagnostics remain; no suppression.
- Ten supplier file blobs match the three supplied commits exactly.

See [final-report.json](final-report.json), [case-preflight.json](case-preflight.json),
[compiled-source-closure.json](compiled-source-closure.json) and the raw TRX.
Historical failed/dirty development attempts are preserved and are not passes.
The earlier 671-case registry integration stays bound to `011470c` in its own folder.

Original trust/full matrices are held. Original provider six tests, full backend,
DB/HTTP/native, product UI, mutation/performance/caption and independent gates are
unrun on this source. No authority, deployment, merge or issue closure is claimed.
The parent alone writes PR content. [draft-pr.md](draft-pr.md) is a full-scope WIP
proposal; narrow component checks do not accept its inherited diff.
''')
old=(root/'artifacts/article-packages/chain-3663-group-property-recheck/draft-pr.md').read_text();prefix=old.split('Complete prospective changed paths, including inherited scope:')[0]
prefix=prefix.replace('fix(backend): recheck property observations before returning group plans','feat(backend): integrate historical metadata and package components').replace('983dd6eef8aab4eab5173d1abea3baf2b972a6b2',sha).replace('strict110whole-file component compile0warnings/0errors,628/628tests0failed/skipped,3changed-file style','strict131whole-file component compile0warnings/0errors,795/795tests0failed/skipped,2new-file style').replace('artifacts/article-packages/chain-3663-group-property-recheck/final-report.json','artifacts/article-packages/chain-3663-group-metadata-integration/final-report.json').replace('actual3changed source/test files','actual2new source/test files')
prefix=prefix.replace('Released asset/version-worker files remain unchanged.','The supplied version registry, asset collection and historical DTO/provider commits are integrated; all10supplier blobs remain identical.').replace('consume actual asset/version-worker commits; original historical rights reader source;','original historical provider6tests;').replace('No released asset/version worker file was edited; task admission is not completion. Historical rights CanonicalUrl stays original-reader-owned.','All released asset/version files match supplied source. Historical CanonicalUrl is now supplied by the original provider and consumed through the finite metadata mapper; it is no longer a missing source field. The provider6tests areUNRUN.')
prefix=prefix.replace('- Summary: recheck property observations before returning group plans','- Summary: integrate original historical rights DTO and reviewed package components')
prefix=prefix.replace('- Direct source delta to `3d177f17fa34bdf322447f1ea917469d2c938869`:', '- Earlier source delta to `3d177f17fa34bdf322447f1ea917469d2c938869`:')
prefix=prefix.replace('## Change Classification','- Current delta to `08787f22f038569e893d6d1a4923aebc5b6bbe0f`: selected historical metadata mapper,27negative/preservation cases and API docs. This consumes the real DTO URL without inventing lifecycle, permission or canonical article facts.\n- Component selector/hook/count preflight passed before795case execution. Original held cases and provider6cases were excluded.\n\n## Change Classification')
prefix=prefix.replace('canonical slug/taxonomy/assets/rights/frozen sources','canonical slug/taxonomy/asset retention/authorized rights/frozen sources')
(out/'draft-pr.md').write_text(prefix+'Complete prospective changed paths are recorded below, including inherited scope.\n')
(out/'publication-inputs.json').write_text(json.dumps({'testedSourceSha':sha,'branch':'codex/chain-3663-group-property-recheck','parentIsSolePrWriter':True,'requestedDraftTitle':'feat(backend): integrate historical metadata and package components','prUrl':None,'existingFrozenPr':'https://github.com/Ozwasyd/FsusBlog/pull/4012','note':'Do not overwrite frozen PR source or imply draft acceptance; parent must verify remote evidence head and full-scope naming gates.'},indent=4)+'\n')
(out/'artifact-sha256.json').write_text('{}\n')
base='537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea'
paths=subprocess.check_output(['git','diff','--name-only',base,sha],cwd=root,text=True).splitlines();paths=sorted(set(paths+[str(p.relative_to(root)) for p in out.rglob('*') if p.is_file()]))
(out/'full-pr-scope.json').write_text(json.dumps({'base':base,'testedSourceSha':sha,'prospectiveChangedPathsIncludingEvidence':paths,'count':len(paths),'sourceTestPaths':[p for p in paths if p.startswith(('src/','tests/','tools/','config/'))]},indent=4)+'\n')
paths=sorted(set(paths+[str((out/'full-pr-scope.json').relative_to(root))]));(out/'draft-pr.md').write_text((out/'draft-pr.md').read_text()+f'\nFull prospective scope: {len(paths)} paths; complete inherited acceptance pending.\n\n'+'\n'.join('- `'+p+'`' for p in paths)+'\n')
hashes={str(p.relative_to(out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.rglob('*')) if p.is_file() and p.name!='artifact-sha256.json'};(out/'artifact-sha256.json').write_text(json.dumps(hashes,indent=4)+'\n')
print(json.dumps({'testedSourceSha':sha,'files':len(hashes)+1,'prospectivePaths':len(paths),'artifact':str(out)}))
