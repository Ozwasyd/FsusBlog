import { digestValue } from '../fact-extractors/lib/canonicalize.mjs'
import { digestPattern, fail } from './runtime-observation-probe-fact-common.mjs'

function verifyCredentialFacts(facts)
{
  const credentialDigests = [
    facts.credential?.presentedRefreshHashDigest,
    facts.credential?.storedRefreshHashDigest,
    facts.database?.refreshTokenHashDigest,
    facts.database?.projection?.refreshtokenhash,
    facts.storage?.projection?.refreshTokenHashDigest
  ]
  if (credentialDigests.some((value) => !digestPattern.test(String(value ?? ''))
    || value !== credentialDigests[0]))
  {
    fail('session facts do not replay the exact DB/JWT/cookie/service relations: credential projections differ')
  }
}

function verifyExpiryFacts(facts)
{
  const expiry = facts.expiry?.projection
  const database = facts.database?.projection
  const jwt = facts.jwt?.projection
  const finiteNumeric = (value) => (typeof value === 'number'
    || (typeof value === 'string' && value.trim().length > 0)) && Number.isFinite(Number(value))
  const dateTime = (value) => typeof value === 'string' && value.length > 0 ? Date.parse(value) : NaN
  if (!expiry || !database || !jwt
    || !finiteNumeric(expiry.accessTokenExp) || !finiteNumeric(expiry.issuedAt)
    || !Number.isFinite(dateTime(expiry.idleExpiresAt))
    || !Number.isFinite(dateTime(expiry.absoluteExpiresAt))
    || Number(expiry.accessTokenExp) <= Number(expiry.issuedAt)
    || dateTime(expiry.absoluteExpiresAt) < dateTime(expiry.idleExpiresAt)
    || expiry.accessTokenExp !== jwt.exp || expiry.issuedAt !== jwt.iat
    || expiry.idleExpiresAt !== database.idleexpiresat
    || expiry.absoluteExpiresAt !== database.absoluteexpiresat
    || expiry.durationPolicy == null || expiry.durationPolicy !== database.duration_policy
    || facts.expiry.digest !== `sha256:${digestValue({
      accessTokenExp: expiry.accessTokenExp,
      idleExpiresAt: expiry.idleExpiresAt,
      absoluteExpiresAt: expiry.absoluteExpiresAt,
      durationPolicy: expiry.durationPolicy
    })}`)
  {
    fail('session facts do not replay the exact DB/JWT/cookie/service relations: expiry projections differ')
  }
}

export function verifySessionFacts(facts, expectedReleaseId)
{
  verifyCredentialFacts(facts)
  verifyExpiryFacts(facts)
  const relations = [
    facts.credential?.matches,
    facts.authContext?.jwtMatches,
    facts.jwt?.sessionMatches,
    facts.cookie?.sessionMatches,
    facts.expiry?.ordered,
    facts.revision?.current,
    facts.device?.matches,
    facts.service?.currentSessionMatches
  ]
  const digests = [
    facts.database?.sessionDigest,
    facts.database?.sessionIdDigest,
    facts.database?.refreshTokenHashDigest,
    facts.credential?.presentedRefreshHashDigest,
    facts.credential?.storedRefreshHashDigest,
    facts.authContext?.digest,
    facts.jwt?.tokenDigest,
    facts.jwt?.claimsDigest,
    facts.cookie?.digest,
    facts.expiry?.digest,
    facts.revision?.digest,
    facts.device?.digest,
    facts.service?.digest
  ]
  if (facts.schema !== 'fsusblog.session-cookie-runtime-probe-facts.v1'
    || relations.some((value) => value !== true)
    || digests.some((value) => !digestPattern.test(String(value ?? '')))
    || facts.service?.status?.me !== 200 || facts.service?.status?.sessions !== 200
    || facts.service?.releaseIds?.length !== 2
    || facts.service.releaseIds.some((value) => value !== expectedReleaseId)
    || facts.modeOutcomes?.positive?.caseId !== 'current-session-coherence'
    || facts.modeOutcomes.positive.status !== 200
    || facts.modeOutcomes.positive.passed !== true
    || facts.modeOutcomes.positive.releaseId !== expectedReleaseId
    || facts.modeOutcomes?.negative?.caseId !== 'replaced-session-refresh-denied'
    || ![401, 403].includes(facts.modeOutcomes.negative.status)
    || facts.modeOutcomes.negative.passed !== true
    || facts.modeOutcomes.negative.releaseId !== expectedReleaseId
    || facts.modeOutcomes?.failure?.caseId !== 'revoked-session-refresh-denied'
    || facts.modeOutcomes.failure.revokeStatus < 200
    || facts.modeOutcomes.failure.revokeStatus >= 300
    || ![401, 403].includes(facts.modeOutcomes.failure.refreshStatus)
    || facts.modeOutcomes.failure.passed !== true
    || facts.modeOutcomes.failure.releaseIds?.length !== 2
    || facts.modeOutcomes.failure.releaseIds.some((value) => value !== expectedReleaseId))
  {
    fail('session facts do not replay the exact DB/JWT/cookie/service relations')
  }
}
