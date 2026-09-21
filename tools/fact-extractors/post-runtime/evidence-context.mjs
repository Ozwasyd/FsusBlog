import { validateCurrentRunEvidenceContext } from '../../test/evidence-location-contract.mjs'
import { stable } from '../lib/canonicalize.mjs'
import {
  produceCandidateContext,
  validateCandidateContext,
  verifyCurrentRepositoryIdentity,
  verifyProductionBuildInput
} from './candidate.mjs'
import {
  authority,
  defaultRoot,
  explicitJson,
  fail,
  prefixedDigest,
  seal
} from './common.mjs'

function postRuntimeEvidenceOwnedRoot(repositoryRoot)
{
  const { registry } = authority(repositoryRoot)
  const referenceRoot = registry.receiptSemantics?.acceptedTerminalAuthority?.referenceRoot
  if (typeof referenceRoot !== 'string' || !referenceRoot
    || referenceRoot.startsWith('/')
    || referenceRoot.startsWith('../')
    || referenceRoot.split('/').includes('..'))
  {
    fail('accepted terminal authority reference root is invalid')
  }
  return referenceRoot
}

function currentRunEvidenceContextForCandidate({
  candidateContext,
  buildReceipt,
  repositoryRoot
})
{
  const run = validateCandidateContext(candidateContext, repositoryRoot)
  const buildInput = explicitJson(buildReceipt, 'production build receipt', repositoryRoot)
  const sourceState = {
    commit: run.sourceState.commit,
    worktreeFingerprint: prefixedDigest(run.sourceState.worktreeFingerprint)
  }
  verifyCurrentRepositoryIdentity(sourceState, repositoryRoot)
  const build = verifyProductionBuildInput(buildInput, sourceState, repositoryRoot)
  if (build.sourceState.commit !== sourceState.commit
    || prefixedDigest(build.sourceState.worktreeFingerprint) !== sourceState.worktreeFingerprint)
  {
    fail('current-run evidence context build does not match the candidate source identity')
  }
  const receipt = seal({
    schema: 'fsusblog.current-run-evidence-context.v1',
    schedulerRunId: run.candidate.runId,
    attemptId: run.candidate.attemptId,
    sourceCommit: sourceState.commit,
    worktreeFingerprint: sourceState.worktreeFingerprint,
    candidateIdentity: {
      id: run.candidate.candidateId,
      digest: prefixedDigest(run.contentDigest)
    },
    buildIdentity: {
      id: `${run.candidate.runId}:build`,
      digest: prefixedDigest(build.receiptContentDigest)
    },
    ownedRoots: [postRuntimeEvidenceOwnedRoot(repositoryRoot)]
  })
  validateCurrentRunEvidenceContext(receipt)
  return receipt
}

export function produceCurrentRunEvidenceContext({
  preRuntimeReceipt,
  buildReceipt,
  runId,
  attemptId = 'attempt-0001',
  candidate = {},
  repositoryRoot = defaultRoot
})
{
  const candidateContext = produceCandidateContext({
    preRuntimeReceipt,
    runId,
    attemptId,
    candidate,
    repositoryRoot
  })
  return currentRunEvidenceContextForCandidate({
    candidateContext,
    buildReceipt,
    repositoryRoot
  })
}

export function validatePostRuntimeEvidenceContext({
  evidenceContext,
  candidateContext,
  buildReceipt,
  repositoryRoot = defaultRoot
})
{
  const actual = validateCurrentRunEvidenceContext(
    explicitJson(evidenceContext, 'current-run evidence context', repositoryRoot).value
  )
  const expected = currentRunEvidenceContextForCandidate({
    candidateContext: explicitJson(candidateContext, 'candidate context', repositoryRoot).value,
    buildReceipt,
    repositoryRoot
  })
  if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(expected)))
  {
    fail('current-run evidence context does not exact-match candidate/build authority')
  }
  return actual
}
