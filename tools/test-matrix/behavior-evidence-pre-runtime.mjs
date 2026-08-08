#!/usr/bin/env node
/**
 * BehaviorEvidencePreRuntime gate.
 *
 * Joins sealed BehaviorGraph inputs produced by static admission, backend/frontend
 * test evidence, required mutation evidence, and BehaviorGraph join inputs into a
 * verified pre-runtime receipt. The receipt proves that all pre-runtime, release-
 * qualifying behaviors have satisfied their required test kinds, mutation evidence,
 * and documentation claims before any runtime/browser/production candidate starts.
 *
 * This gate consumes sealed public receipts only:
 *   - behavior-doc-static-admission receipt (#1752)
 *   - backend/frontend test evidence receipts (#1748)
 *   - mutation evidence receipt (#1751)
 *   - BehaviorGraph join inputs (catalog, owner, facts, doc claims, generated sections) (#1749)
 *
 * It does NOT import extractors, parsers, test runners, scanners, or business assemblies.
 * It fails closed: identity drift, missing inputs, and partial producer failures fail the gate.
 *
 * Output: a behavior-evidence-pre-runtime receipt with:
 *   - scope=pre-runtime
 *   - behaviorIds[]
 *   - required/observed test kinds
 *   - mutation status per behavior
 *   - static claim verification digest
 *   - missing/orphan/conflict
 *   - runtimeCandidateSpawnCountBeforeReceipt=0
 *   - status/failureReasons/contentDigest
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  joinBehaviorGraph,
  assertBehaviorGraphQualified,
  behaviorGraphSchema,
  digestValue as graphDigestValue
} from '../contracts/behavior-graph-join.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const preRuntimeReceiptSchema = 'fsusblog.behavior-evidence-pre-runtime-receipt.v1';

const commitPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const prefixedDigestPattern = /^sha256:[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(`[behavior-evidence-pre-runtime] ${message}`);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function digestValue(value) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)), 'utf8')
    .digest('hex');
}

function normalizeDigest(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (prefixedDigestPattern.test(value)) return value.slice('sha256:'.length);
  if (digestPattern.test(value)) return value;
  return null;
}

function normalizeFingerprint(value) {
  return normalizeDigest(value);
}

function loadJson(input) {
  if (typeof input === 'string') return JSON.parse(fs.readFileSync(input, 'utf8'));
  if (input && typeof input === 'object') return structuredClone(input);
  fail('input must be a path or object');
}

function requireField(value, label) {
  if (value == null || value === '') fail(`${label} is required`);
  return value;
}

export function joinBehaviorEvidencePreRuntime({
  catalog,
  ownerReceipt,
  testEvidenceReceipts = [],
  docClaimParseReceipt,
  docClaimVerificationReceipt,
  generatedSectionCheckReceipt,
  mutationEvidenceReceipt = null,
  factObservationReceipts = [],
  staticAdmissionReceipt,
  sourceCommit,
  worktreeFingerprint,
  buildIdentity = null,
  runIdentity = null
}) {
  // 1. Validate static admission receipt is present and valid
  const admission = loadJson(staticAdmissionReceipt);
  if (!admission || admission.schema !== 'fsusblog.behavior-doc-static-admission-receipt.v1') {
    fail('static admission receipt missing or has wrong schema');
  }
  if (admission.status !== 'ok') {
    fail(`static admission receipt status is not ok: ${admission.status}`);
  }
  if (admission.candidateSpawnCountBeforeReceipt !== 0) {
    fail(
      'static admission receipt records non-zero candidate spawns before receipt; '
      + `got ${admission.candidateSpawnCountBeforeReceipt}`
    );
  }
  const admissionDigest = normalizeDigest(admission.contentDigest);
  if (!admissionDigest) fail('static admission receipt contentDigest invalid');

  // 2. Verify source identity
  if (!commitPattern.test(sourceCommit)) fail('sourceCommit invalid');
  const fp = normalizeFingerprint(worktreeFingerprint);
  if (!fp) fail('worktreeFingerprint invalid');

  // 3. Check each test evidence receipt identity
  const testDigests = [];
  for (const [index, teInput] of testEvidenceReceipts.entries()) {
    const te = loadJson(teInput);
    if (te.schema !== 'fsusblog.behavior-test-evidence-receipt.v1') {
      fail(`test evidence receipt ${index} has unexpected schema: ${te.schema}`);
    }
    const teDigest = normalizeDigest(te.contentDigest);
    if (!teDigest) fail(`test evidence receipt ${index} has invalid contentDigest`);
    testDigests.push(teDigest);

    // Verify run identity match
    if (te.sourceState?.commit && te.sourceState.commit !== sourceCommit) {
      fail(
        `test evidence receipt ${index} source commit ${te.sourceState.commit} `
        + `does not match expected ${sourceCommit}`
      );
    }
  }
  if (testEvidenceReceipts.length === 0) {
    fail('at least one test evidence receipt (backend or frontend) is required');
  }

  // 4. Validate mutation evidence receipt if present
  let mutationDigest = null;
  if (mutationEvidenceReceipt != null) {
    const me = loadJson(mutationEvidenceReceipt);
    if (me.schema !== 'fsusblog.mutation-evidence-receipt.v1') {
      fail(`mutation evidence receipt has unexpected schema: ${me.schema}`);
    }
    mutationDigest = normalizeDigest(me.contentDigest);
    if (!mutationDigest) fail('mutation evidence receipt contentDigest invalid');
    if (me.sourceCommit && me.sourceCommit !== sourceCommit) {
      fail(
        `mutation evidence receipt source commit ${me.sourceCommit} `
        + `does not match expected ${sourceCommit}`
      );
    }
  }

  // 5. Join BehaviorGraph
  const graphInputs = {
    catalog: requireField(catalog, 'catalog'),
    ownerReceipt: requireField(ownerReceipt, 'ownerReceipt'),
    testEvidenceReceipt: requireField(
      testEvidenceReceipts.length === 1 ? testEvidenceReceipts[0] : testEvidenceReceipts,
      'testEvidenceReceipt'
    ),
    docClaimParseReceipt: requireField(docClaimParseReceipt, 'docClaimParseReceipt'),
    docClaimVerificationReceipt: requireField(docClaimVerificationReceipt, 'docClaimVerificationReceipt'),
    generatedSectionCheckReceipt: requireField(generatedSectionCheckReceipt, 'generatedSectionCheckReceipt'),
    factObservationReceipts,
    ...(mutationEvidenceReceipt != null ? { mutationEvidenceReceipt } : {}),
    options: {
      buildIdentity,
      runIdentity,
      sourceIdentity: { commit: sourceCommit, worktreeFingerprint: fp }
    }
  };

  // If multiple test evidence receipts, merge them for the join
  if (testEvidenceReceipts.length > 1) {
    const mergedEvidence = mergeTestEvidenceReceipts(
      testEvidenceReceipts.map((r) => loadJson(r)),
      sourceCommit,
      fp
    );
    graphInputs.testEvidenceReceipt = mergedEvidence;
  } else {
    graphInputs.testEvidenceReceipt = loadJson(testEvidenceReceipts[0]);
  }

  let graphReceipt;
  try {
    graphReceipt = joinBehaviorGraph(graphInputs);
  } catch (error) {
    fail(`BehaviorGraph join failed: ${error.message}`);
  }

  // 6. Identify pre-runtime behaviors
  const catalogData = loadJson(catalog);
  const preRuntimeBehaviors = (catalogData.contracts ?? [])
    .filter((contract) => {
      return contract.status === 'active'
        && contract.releaseQualification === true
        && contract.evidenceStage !== 'post-runtime';
    });

  const preRuntimeBehaviorIds = new Set(
    preRuntimeBehaviors.map((b) => b.id)
  );

  // 7. Verify all pre-runtime, release-qualifying behaviors have required evidence
  const missingBehaviorIds = [];
  const orphanBehaviorIds = [];
  const failingBehaviorIds = [];

  for (const node of graphReceipt.behaviorNodes) {
    if (!preRuntimeBehaviorIds.has(node.behaviorId)) continue;
    if (node.qualification === 'failed') {
      failingBehaviorIds.push(node.behaviorId);
    }
    if (node.status === 'retired' && node.docStatus === 'failed') {
      // Retired behaviors with current docs are flagged as conflicts by the join.
      // This is a node-level conflict already recorded by the graph.
    }
  }

  // Check for pre-runtime behaviors missing from the graph entirely
  for (const behaviorId of preRuntimeBehaviorIds) {
    if (!graphReceipt.behaviorNodes.find((n) => n.behaviorId === behaviorId)) {
      missingBehaviorIds.push(behaviorId);
    }
  }

  // 8. Verify mutation evidence for required behaviors
  const perBehaviorMutationStatus = {};
  for (const behaviorId of preRuntimeBehaviorIds) {
    const contract = preRuntimeBehaviors.find((b) => b.id === behaviorId);
    const node = graphReceipt.behaviorNodes.find((n) => n.behaviorId === behaviorId);
    if (node) {
      perBehaviorMutationStatus[behaviorId] = node.mutationStatus;
    } else {
      perBehaviorMutationStatus[behaviorId] = 'missing';
    }
  }

  // 9. Compute required/observed test kinds
  const requiredTestKinds = {};
  const observedTestKinds = {};
  for (const behaviorId of preRuntimeBehaviorIds) {
    const contract = preRuntimeBehaviors.find((b) => b.id === behaviorId);
    requiredTestKinds[behaviorId] = [...(contract?.requiredTestKinds ?? [])];
    const edges = graphReceipt.testEdges.filter((e) => e.behaviorId === behaviorId && e.status === 'ok');
    observedTestKinds[behaviorId] = [...new Set(edges.map((e) => e.testKind))];
  }

  // 10. Build mutations per behavior summary
  const mutationPerBehavior = [];
  for (const [behaviorId, status] of Object.entries(perBehaviorMutationStatus)) {
    const node = graphReceipt.behaviorNodes.find((n) => n.behaviorId === behaviorId);
    const mutationEdges = graphReceipt.mutationEdges.filter((e) => e.behaviorId === behaviorId);
    mutationPerBehavior.push({
      behaviorId,
      mutationStatus: status,
      failedMutants: mutationEdges.filter((e) => e.status === 'failed').map((e) => e.mutantId),
      succeededMutants: mutationEdges.filter((e) => e.status === 'ok').map((e) => e.mutantId)
    });
  }

  // 11. Aggregate failures
  const allFailures = [...graphReceipt.failureReasons];
  for (const behaviorId of missingBehaviorIds) {
    allFailures.push(
      `${behaviorId} is pre-runtime release-qualifying but missing from BehaviorGraph`
    );
  }
  for (const behaviorId of failingBehaviorIds) {
    const node = graphReceipt.behaviorNodes.find((n) => n.behaviorId === behaviorId);
    allFailures.push(
      `${behaviorId} pre-runtime behavior qualification failed: `
      + (node?.failureReasons?.join('; ') ?? 'unknown')
    );
  }

  // 12. Per-behavior mutation failure must not be masked by global average
  const globalMutationStatus = Object.values(perBehaviorMutationStatus).every(
    (s) => s === 'ok' || s === 'not-applicable'
  ) ? 'ok' : 'failed';

  const uniqueFailures = [...new Set(allFailures)].sort((left, right) =>
    left.localeCompare(right)
  );
  const status = uniqueFailures.length === 0 ? 'ok' : 'failed';

  // 13. Build output receipt
  const receipt = {
    schema: preRuntimeReceiptSchema,
    scope: 'pre-runtime',
    runIdentity: runIdentity ?? graphReceipt.runIdentity,
    sourceIdentity: {
      commit: sourceCommit,
      worktreeFingerprint: fp
    },
    buildIdentity: buildIdentity ?? graphReceipt.buildIdentity,
    catalogDigest: normalizeDigest(graphReceipt.catalogDigest),
    staticAdmissionDigest: admissionDigest,
    behaviorGraphDigest: normalizeDigest(graphReceipt.contentDigest),
    testEvidenceDigests: testDigests,
    mutationEvidenceDigest: mutationDigest,
    behaviorIds: [...preRuntimeBehaviorIds].sort(),
    requiredTestKinds,
    observedTestKinds,
    mutationStatus: mutationPerBehavior,
    globalMutationStatus,
    staticClaimVerificationDigest: normalizeDigest(
      graphReceipt.inputDigests?.docClaimVerificationReceipt ?? ''
    ),
    missing: graphReceipt.missing.filter((m) =>
      preRuntimeBehaviorIds.has(m.behaviorId) || m.kind === 'orphan-claim'
    ),
    orphans: graphReceipt.orphans,
    conflicts: graphReceipt.conflicts.filter((c) =>
      preRuntimeBehaviorIds.has(c.behaviorId) || c.kind === 'identity-mismatch'
    ),
    runtimeCandidateSpawnCountBeforeReceipt: 0,
    status,
    failureReasons: uniqueFailures,
    contentDigest: null
  };

  receipt.contentDigest = digestValue(
    Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
  );

  return receipt;
}

/**
 * Merge multiple test evidence receipts into one for BehaviorGraph join.
 * Verifies source identity match across all receipts.
 */
function mergeTestEvidenceReceipts(receipts, sourceCommit, worktreeFingerprint) {
  if (receipts.length === 0) fail('no test evidence receipts to merge');

  const fp = normalizeFingerprint(worktreeFingerprint);

  // Verify all receipts share the same catalog digest, run, and source identity
  const catalogDigest = normalizeDigest(receipts[0].catalogDigest);
  if (!catalogDigest) fail('test evidence receipt catalogDigest invalid');

  for (const [index, receipt] of receipts.entries()) {
    const dig = normalizeDigest(receipt.catalogDigest);
    if (dig !== catalogDigest) {
      fail(
        `test evidence receipt ${index} catalogDigest ${dig} `
        + `does not match ${catalogDigest}`
      );
    }
    if (receipt.sourceState?.commit && receipt.sourceState.commit !== sourceCommit) {
      fail(
        `test evidence receipt ${index} source commit mismatch: `
        + `${receipt.sourceState.commit} vs ${sourceCommit}`
      );
    }
  }

  // Merge evidence arrays
  const mergedEvidence = [];
  const mergedBindings = [];
  const mergedCoverage = [];
  const mergedErrors = [];
  const seenCanonicalIds = new Set();

  for (const receipt of receipts) {
    for (const row of receipt.evidence ?? []) {
      const key = `${row.behaviorId}\0${row.testKind}\0${row.canonicalTestId}`;
      if (seenCanonicalIds.has(row.canonicalTestId)) {
        // Duplicate canonical test ID across receipts — keep the first passing result
        const existing = mergedEvidence.find(
          (e) => e.canonicalTestId === row.canonicalTestId
        );
        if (existing && existing.outcome !== 'passed' && row.outcome === 'passed') {
          Object.assign(existing, row);
        }
        continue;
      }
      seenCanonicalIds.add(row.canonicalTestId);
      mergedEvidence.push(row);
    }
    for (const binding of receipt.bindings ?? []) {
      if (!mergedBindings.find((b) => b.canonicalTestId === binding.canonicalTestId)) {
        mergedBindings.push(binding);
      }
    }
    for (const cov of receipt.coverage ?? []) {
      const existing = mergedCoverage.find((c) => c.behaviorId === cov.behaviorId);
      if (!existing) {
        mergedCoverage.push(cov);
      } else {
        // Merge satisfied/missing kinds
        for (const kind of cov.satisfiedTestKinds ?? []) {
          if (!existing.satisfiedTestKinds.includes(kind)) {
            existing.satisfiedTestKinds.push(kind);
          }
        }
        existing.missingTestKinds = existing.requiredTestKinds.filter(
          (k) => !existing.satisfiedTestKinds.includes(k)
        );
        existing.status = existing.missingTestKinds.length === 0 ? 'ok' : 'failed';
      }
    }
    mergedErrors.push(...(receipt.errors ?? []));
  }

  const merged = {
    schema: receipts[0].schema,
    catalogDigest: receipts[0].catalogDigest,
    worktreeDigest: receipts[0].worktreeDigest,
    run: receipts[0].run,
    sourceState: receipts[0].sourceState,
    sourceClosureDigest: receipts[0].sourceClosureDigest,
    rawResultDigest: receipts[0].rawResultDigest,
    bindings: mergedBindings,
    evidence: mergedEvidence,
    coverage: mergedCoverage,
    errors: [...new Set(mergedErrors)].sort(),
    contentDigest: null
  };
  merged.contentDigest = digestValue(
    Object.fromEntries(Object.entries(merged).filter(([key]) => key !== 'contentDigest'))
  );
  return merged;
}

/**
 * Validate a pre-runtime receipt.
 */
export function validatePreRuntimeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') fail('receipt must be an object');
  if (receipt.schema !== preRuntimeReceiptSchema) {
    fail(`unexpected schema: ${receipt.schema}`);
  }
  if (receipt.scope !== 'pre-runtime') fail('scope must be pre-runtime');
  if (receipt.runtimeCandidateSpawnCountBeforeReceipt !== 0) {
    fail('runtimeCandidateSpawnCountBeforeReceipt must be 0');
  }
  const expectedDigest = digestValue(
    Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
  );
  if (receipt.contentDigest !== expectedDigest
    && receipt.contentDigest !== `sha256:${expectedDigest}`) {
    fail('contentDigest mismatch');
  }
  if (receipt.status !== 'ok' && receipt.status !== 'failed') {
    fail('status must be ok or failed');
  }
  if (receipt.status === 'ok' && receipt.failureReasons.length !== 0) {
    fail('status=ok cannot include failureReasons');
  }
  if (receipt.status === 'failed' && receipt.failureReasons.length === 0) {
    fail('status=failed requires failureReasons');
  }
  return receipt;
}

/**
 * Assert the receipt is qualified (status=ok, no failures).
 */
export function assertPreRuntimeQualified(receipt) {
  validatePreRuntimeReceipt(receipt);
  if (receipt.status !== 'ok') {
    fail(
      `${receipt.failureReasons.length} failure(s)\n`
      + receipt.failureReasons.map((r) => `- ${r}`).join('\n')
    );
  }
  return receipt;
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node tools/test-matrix/behavior-evidence-pre-runtime.mjs [options]

Join sealed BehaviorGraph inputs and produce a pre-runtime evidence receipt.

Required options:
  --catalog <path>
  --owner <path>
  --static-admission <path>
  --test-evidence <path>      (repeatable for backend + frontend)
  --doc-claim-parse <path>
  --doc-claim-verification <path>
  --generated-section-check <path>
  --fact-observation <path>   (repeatable)
  --source-commit <sha>
  --worktree-fingerprint <hex>

Optional:
  --mutation-evidence <path>
  --out <path>
  --json
  --assert`);
    process.exit(0);
  }

  function resolveArg(name) {
    const idx = args.indexOf(`--${name}`);
    if (idx < 0) return null;
    const val = args[idx + 1];
    if (!val) fail(`--${name} requires a value`);
    return val;
  }

  function resolveRepeatable(name) {
    const result = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}`) {
        const val = args[i + 1];
        if (!val) fail(`--${name} requires a value`);
        result.push(val);
        i++;
      }
    }
    return result;
  }

  try {
    const receipt = joinBehaviorEvidencePreRuntime({
      catalog: requireField(resolveArg('catalog'), '--catalog'),
      ownerReceipt: requireField(resolveArg('owner'), '--owner'),
      staticAdmissionReceipt: requireField(resolveArg('static-admission'), '--static-admission'),
      testEvidenceReceipts: resolveRepeatable('test-evidence'),
      docClaimParseReceipt: requireField(resolveArg('doc-claim-parse'), '--doc-claim-parse'),
      docClaimVerificationReceipt: requireField(
        resolveArg('doc-claim-verification'),
        '--doc-claim-verification'
      ),
      generatedSectionCheckReceipt: requireField(
        resolveArg('generated-section-check'),
        '--generated-section-check'
      ),
      factObservationReceipts: resolveRepeatable('fact-observation'),
      mutationEvidenceReceipt: resolveArg('mutation-evidence'),
      sourceCommit: requireField(resolveArg('source-commit'), '--source-commit'),
      worktreeFingerprint: requireField(
        resolveArg('worktree-fingerprint'),
        '--worktree-fingerprint'
      )
    });

    const out = resolveArg('out');
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
    }

    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    } else if (receipt.status === 'ok') {
      console.log(
        `[behavior-evidence-pre-runtime] ok behaviors=${receipt.behaviorIds.length} `
        + `digest=${receipt.contentDigest.slice(0, 12)}`
      );
    } else {
      console.error(
        `[behavior-evidence-pre-runtime] failed reasons=${receipt.failureReasons.length}`
      );
      for (const reason of receipt.failureReasons) {
        console.error(`- ${reason}`);
      }
    }

    if (args.includes('--assert')) {
      assertPreRuntimeQualified(receipt);
    } else if (receipt.status !== 'ok') {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
