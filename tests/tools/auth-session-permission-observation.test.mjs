import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  loadRegistry,
  validateOwnershipAgainstBehaviorCatalog,
  root
} from '../../tools/fact-extractors/registry.mjs'
import { loadCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import { extract as extractAuthSession } from '../../tools/fact-extractors/auth-session-permission/extract.mjs'
import { produceAuthSessionObservation } from '../../tools/contracts/lib/auth-session-observation.mjs'

const observationRelative = '.tmp/contracts/auth-session/auth-session-permission-observation.json'

function sha256(buffer)
{
  return createHash('sha256').update(buffer).digest('hex')
}

function writeObservation(repositoryRoot, observation)
{
  const absolute = path.join(repositoryRoot, observationRelative)
  mkdirSync(path.dirname(absolute), { recursive: true })
  const text = `${JSON.stringify(observation, null, 2)}\n`
  writeFileSync(absolute, text)
  return {
    absolute,
    artifactDigest: sha256(Buffer.from(text, 'utf8')),
    text
  }
}

function sampleObservation(overrides = {})
{
  const { facts: factOverrides, ...rest } = overrides
  return {
    schema: 'fsusblog.auth-session-permission-observation.v1',
    source: 'compiled-production-constants',
    status: 'ok',
    failureReasons: [],
    observationDigest: 'a'.repeat(64),
    facts: {
      'auth.authentication-methods': {
        active: ['enrollment', 'other', 'passkey', 'recovery_key']
      },
      'auth.authentication-strengths': {
        active: ['mfa', 'recovery', 'webauthn_uv'],
        legacy: {
          values: ['legacy_unverified', 'legacy_verified'],
          writeAllowed: false,
          readMigrationOnly: true
        }
      },
      'auth.session.duration-modes': {
        modes: ['browser_session', 'persistent_30d'],
        cookieProjection: {
          browser_session: { persistentCookie: false },
          persistent_30d: { persistentCookie: true }
        }
      },
      'auth.session.idle-expiry-policy': {
        browser_session: { value: 7, unit: 'days' },
        persistent_30d: { value: 30, unit: 'days' },
        admin: { value: 8, unit: 'hours' }
      },
      'auth.session.absolute-expiry-policy': {
        browser_session: { value: 30, unit: 'days' },
        persistent_30d: { value: 90, unit: 'days' },
        admin: { value: 12, unit: 'hours' }
      },
      'auth.refresh.context-preservation': {
        preserves: [
          'auth_method',
          'auth_strength',
          'auth_time',
          'authenticated_credential_row_id',
          'duration_policy'
        ],
        doesNotPreserve: [
          'access_token',
          'last_step_up_at',
          'last_step_up_method',
          'refresh_token',
          'step_up_proof'
        ],
        mayUpdate: [
          'idle_expires_at',
          'last_seen_at',
          'refresh_generation',
          'refresh_token_hash',
          'session_mode'
        ]
      },
      'auth.step-up.freshness': {
        configurationKey: 'Security:StepUp:FreshnessMinutes',
        default: { value: 5, unit: 'minutes' },
        minimum: { value: 1, unit: 'minutes' },
        maximum: { value: 15, unit: 'minutes' }
      },
      'auth.step-up.binding': {
        fields: ['account', 'account_subject', 'action', 'expiry', 'session', 'token']
      },
      'auth.step-up.consume-once': true,
      'auth.passkey.states': {
        enrollment: ['cancelled', 'completed', 'completing', 'expired', 'pending'],
        credentialPresence: ['absent', 'present']
      },
      'auth.mfa.states': ['disabled', 'enabled', 'pending_enrollment'],
      'auth.recovery.states': ['active', 'revoked', 'used'],
      'auth.credential-session-revocation': {
        transitions: [
          {
            id: 'passkey_delete',
            from: 'credential_present',
            to: 'credential_absent',
            effect: 'revoke_sessions_bound_to_credential'
          }
        ],
        failureModes: [
          'admin_principal_disabled',
          'authentication_context_mismatch',
          'refresh_token_replay',
          'session_absolute_expired',
          'session_idle_expired',
          'session_mismatch',
          'session_revoked',
          'step_up_proof_consumed',
          'step_up_proof_invalid'
        ]
      },
      'admin.permissions.all': [
        'admin.manage',
        'anonymous.comment.configure',
        'anonymous.credential.revoke',
        'anonymous.nullifier.block',
        'article.publish',
        'article.write',
        'audit.investigate',
        'audit.read',
        'comment.moderate',
        'system.config'
      ],
      'admin.permissions.read-only': ['audit.read'],
      'admin.permissions.partial-policy': {
        claimType: 'admin_permission',
        storage: 'newline-separated-subset-of-catalog',
        catalogAuthority: 'AdminPermissions.All',
        authorization: 'require-exact-claim-at-endpoint',
        rootBootstrap: 'full-catalog',
        unknownCatalogPermission: 'no-endpoint-grant'
      },
      'admin.disabled-access': {
        status: 'disabled',
        activeStatus: 'active',
        loginAllowed: false,
        stepUpAllowed: false
      },
      coherence: {
        loginRefreshIdleTtl: 'consistent',
        durationPolicyCookieProjection: 'consistent',
        jwtSessionValidationClaims: 'consistent',
        layers: {
          sessionDb: 'UserSession.AuthenticationMethod/Strength/AuthenticatedAtUtc/DurationPolicy',
          jwt: 'auth_method/auth_strength/auth_time/session_mode',
          cookie: 'AccessToken/RefreshToken/SessionId with DurationPolicy-driven persistence'
        }
      },
      ...(factOverrides ?? {})
    },
    ...rest
  }
}

function runExtract(repositoryRoot, observation, buildIdentityOverrides = {})
{
  const written = writeObservation(repositoryRoot, observation)
  return extractAuthSession({
    repositoryRoot,
    buildIdentity: {
      artifactId: 'auth-session-permission-observation',
      artifactDigest: written.artifactDigest,
      receiptDigest: 'b'.repeat(64),
      ...buildIdentityOverrides
    }
  })
}

test('registry owns authentication-session-permission via auth-session-permission-fact-extractor', () =>
{
  const registry = loadRegistry()
  const result = validateOwnershipAgainstBehaviorCatalog(registry, loadCatalog(), root)
  assert.equal(result.behaviorOwners.get('authentication-session-permission'), 'auth-session-permission-fact-extractor')
  const extractor = registry.extractors.find((entry) => entry.id === 'auth-session-permission-fact-extractor')
  assert.equal(extractor.kind, 'compiled-assembly')
  assert.equal(extractor.hermeticPolicy, 'exact-build-receipt')
  assert.equal(extractor.requiredBuildArtifact, 'auth-session-permission-observation')
  assert.ok(!extractor.consumedInputs.some((input) => input.includes('docs/')))
  assert.ok(!extractor.consumedInputs.some((input) => input.includes('session-fixtures')))
  assert.ok(!extractor.consumedInputs.some((input) => input.includes('defaultAdminPermissions')))
})

test('positive sample observation extracts typed auth/session/admin facts', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const result = runExtract(directory, sampleObservation())
    assert.equal(result.status, 'ok', result.failureReasons?.join('\n'))
    assert.ok(result.observations['admin.permissions.all'].includes('audit.investigate'))
    assert.equal(result.observations['auth.step-up.freshness'].default.unit, 'minutes')
    assert.equal(result.observations['auth.step-up.consume-once'], true)
    assert.equal(result.observations['auth.authentication-strengths'].legacy.writeAllowed, false)
    assert.equal(result.observations['auth.authentication-strengths'].legacy.readMigrationOnly, true)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('1) new audit.investigate must appear in admin.permissions.all observation', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const observation = sampleObservation({
      facts: {
        'admin.permissions.all': [
          'admin.manage',
          'article.write',
          'audit.read',
          'system.config'
        ]
      }
    })
    const result = runExtract(directory, observation)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => reason.includes('audit.investigate')))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('2) freshness minutes change alters observation digest surface', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const five = runExtract(directory, sampleObservation())
    assert.equal(five.status, 'ok')
    const tenObservation = sampleObservation({
      facts: {
        'auth.step-up.freshness': {
          configurationKey: 'Security:StepUp:FreshnessMinutes',
          default: { value: 10, unit: 'minutes' },
          minimum: { value: 1, unit: 'minutes' },
          maximum: { value: 15, unit: 'minutes' }
        }
      }
    })
    const ten = runExtract(directory, tenObservation)
    assert.equal(ten.status, 'ok')
    assert.notEqual(
      JSON.stringify(five.observations['auth.step-up.freshness']),
      JSON.stringify(ten.observations['auth.step-up.freshness'])
    )
    assert.equal(ten.observations['auth.step-up.freshness'].default.value, 10)
    assert.equal(ten.observations['auth.step-up.freshness'].default.unit, 'minutes')
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('3) multi-layer JWT/DB coherence inconsistency fails closed', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const observation = sampleObservation({
      facts: {
        coherence: {
          loginRefreshIdleTtl: 'consistent',
          durationPolicyCookieProjection: 'consistent',
          jwtSessionValidationClaims: 'inconsistent',
          layers: {
            sessionDb: 'UserSession',
            jwt: 'claims',
            cookie: 'cookies'
          }
        }
      }
    })
    const result = runExtract(directory, observation)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /coherence|jwtSessionValidationClaims/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('4) legacy_unverified must not enter active authentication strengths', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const observation = sampleObservation({
      facts: {
        'auth.authentication-strengths': {
          active: ['legacy_unverified', 'mfa', 'webauthn_uv'],
          legacy: {
            values: ['legacy_unverified', 'legacy_verified'],
            writeAllowed: false,
            readMigrationOnly: true
          }
        }
      }
    })
    const result = runExtract(directory, observation)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /legacy/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('5) refresh facts that drop auth_time preservation fail', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const observation = sampleObservation({
      facts: {
        'auth.refresh.context-preservation': {
          preserves: ['auth_method', 'auth_strength', 'duration_policy'],
          doesNotPreserve: ['step_up_proof'],
          mayUpdate: ['idle_expires_at']
        }
      }
    })
    const result = runExtract(directory, observation)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /auth_time/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('6) browser_session extracted as persistent cookie fails', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const observation = sampleObservation({
      facts: {
        'auth.session.duration-modes': {
          modes: ['browser_session', 'persistent_30d'],
          cookieProjection: {
            browser_session: { persistentCookie: true },
            persistent_30d: { persistentCookie: true }
          }
        }
      }
    })
    const result = runExtract(directory, observation)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /browser_session/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('7) step-up missing action binding field fails', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const observation = sampleObservation({
      facts: {
        'auth.step-up.binding': {
          fields: ['account', 'expiry', 'session', 'token']
        }
      }
    })
    const result = runExtract(directory, observation)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /action/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('8) observation sourced from defaultAdminPermissions is rejected', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const observation = sampleObservation({
      source: 'defaultAdminPermissions'
    })
    const result = runExtract(directory, observation)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /defaultAdminPermissions|fixture|docs/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ambient bin/Debug build identity is refused', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const observation = sampleObservation()
    const written = writeObservation(directory, observation)
    const result = extractAuthSession({
      repositoryRoot: directory,
      buildIdentity: {
        artifactId: 'auth-session-permission-observation',
        artifactDigest: written.artifactDigest,
        path: 'bin/Debug/net10.0/FsusBlog.AuthSessionObservation.dll'
      }
    })
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /bin\/Debug|ambient/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('naked duration without unit fails', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auth-session-obs-'))
  try
  {
    const observation = sampleObservation({
      facts: {
        'auth.step-up.freshness': {
          configurationKey: 'Security:StepUp:FreshnessMinutes',
          default: 5,
          minimum: { value: 1, unit: 'minutes' },
          maximum: { value: 15, unit: 'minutes' }
        }
      }
    })
    const result = runExtract(directory, observation)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /typed duration/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('compiled observation host produces sealed production facts (live)', { timeout: 600_000 }, () =>
{
  const produced = produceAuthSessionObservation({ repositoryRoot: root, rebuild: true })
  assert.equal(produced.observation.schema, 'fsusblog.auth-session-permission-observation.v1')
  assert.equal(produced.observation.status, 'ok')
  assert.ok(produced.observation.facts['admin.permissions.all'].includes('audit.investigate'))
  assert.equal(produced.observation.facts['auth.step-up.freshness'].default.value, 5)
  assert.equal(produced.observation.facts['auth.step-up.freshness'].default.unit, 'minutes')
  assert.equal(
    produced.observation.facts['auth.session.duration-modes'].cookieProjection.browser_session.persistentCookie,
    false
  )
  assert.ok(
    !produced.observation.facts['auth.authentication-strengths'].active.some((value) => value.startsWith('legacy_'))
  )
  assert.equal(produced.observation.facts['auth.authentication-strengths'].legacy.writeAllowed, false)
  assert.equal(produced.buildIdentity.artifactId, 'auth-session-permission-observation')

  const extracted = extractAuthSession({
    repositoryRoot: root,
    buildIdentity: produced.buildIdentity
  })
  assert.equal(extracted.status, 'ok', extracted.failureReasons?.join('\n'))
  assert.deepEqual(
    extracted.observations['admin.permissions.all'],
    produced.observation.facts['admin.permissions.all']
  )
})
