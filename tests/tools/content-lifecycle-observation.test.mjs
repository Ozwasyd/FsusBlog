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
import { extract as extractContentLifecycle } from '../../tools/fact-extractors/content-lifecycle/extract.mjs'
import { validateObservations } from '../../tools/fact-extractors/receipt.mjs'
import { produceContentLifecycleObservation } from '../../tools/contracts/lib/content-lifecycle-observation.mjs'

const observationRelative = '.tmp/contracts/content-lifecycle/content-lifecycle-observation.json'

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
    schema: 'fsusblog.content-lifecycle-observation.v1',
    source: 'compiled-production-constants',
    status: 'ok',
    failureReasons: [],
    observationDigest: 'a'.repeat(64),
    facts: {
      'article.lifecycle.states': ['Archived', 'Deleted', 'Draft', 'Published', 'Scheduled'],
      'article.lifecycle.allowed-transitions': [
        'Create:Draft->Draft',
        'Restore:Deleted->Published',
        'Rollback:Published->Archived',
        'Rollback:Published->Draft',
        'Rollback:Published->Published',
        'Update:Draft->Published',
        'Update:Published->Archived'
      ],
      'article.lifecycle.forbidden-transitions': [
        'Restore:Draft->Published:article_status_transition_invalid',
        'Rollback:Published->Scheduled:article_status_transition_invalid',
        'Update:Draft->Deleted:article_deleted_requires_delete_flow'
      ],
      'article.publication.required-coordinates': [
        'publicationId',
        'publicationNo',
        'responsibilitySnapshotId',
        'responsibilityVersion',
        'revisionId',
        'revisionNo',
        'rightsSnapshotId'
      ],
      'article.scheduled.boundary': {
        status: 'Scheduled',
        scheduledPublishAt: {
          required: true,
          relationToUtcNow: 'strictly-after',
          boundary: 'exclusive',
          unit: 'utc-instant'
        },
        nonScheduledScheduledAt: 'forbidden'
      },
      'article.rollback.semantics': {
        operation: 'Rollback',
        allowedTargets: ['Archived', 'Draft', 'Published'],
        forbiddenTargets: ['Deleted', 'Scheduled'],
        createsPublication: true,
        clonesResponsibilityFromSourceRevision: true
      },
      'article.restore.semantics': {
        operation: 'Restore',
        source: 'Deleted',
        target: 'Published',
        createsPublication: true,
        revivesOldPublicationPointer: false
      },
      'article.delete.semantics': {
        enterVia: 'dedicated-delete-flow',
        ordinaryTransitionTarget: 'forbidden',
        status: 'Deleted',
        softDelete: true,
        outboxEventType: 'deleted',
        permanentDeleteEventType: 'permanently-deleted'
      },
      'article.public-visibility.states': {
        Draft: false,
        Scheduled: false,
        Published: true,
        Archived: false,
        Deleted: false
      },
      'article.admin-visibility.states': ['Archived', 'Deleted', 'Draft', 'Published', 'Scheduled'],
      'article.outbox.required-edges': [
        'article-detail-aeds',
        'http-cache-invalidation',
        'public-aot-invalidation',
        'public-artifact-revocation',
        'public-hot-read',
        'search-projection',
        'taxonomy-projection'
      ],
      'article.outbox.optional-edges': ['integrity-proof', 'notification'],
      'article.outbox.terminal-states': ['completed', 'failed', 'skipped'],
      'article.outbox.event-types': [
        'category-updated',
        'created',
        'deleted',
        'permanently-deleted',
        'responsibility-updated',
        'restored',
        'rights-proof-updated',
        'scheduled-published',
        'tag-updated',
        'trash-cleared',
        'updated'
      ],
      'article.rights.required-fields': ['copyPolicy', 'enabled', 'licenseType', 'rightsSnapshotId'],
      'article.responsibility.requirement': {
        snapshotOptionalOnNonPublish: true,
        requiredCoordinateWhenPresent: 'responsibilitySnapshotId',
        versionField: 'responsibilityVersion',
        publicProjection: 'article_responsibility_snapshot without admin-actor fields'
      },
      'comment.moderation.states': ['Approved', 'Hidden', 'Pending', 'Rejected'],
      'comment.moderation.allowed-transitions': [
        'Approved->Hidden',
        'Approved->Rejected',
        'Hidden->Approved',
        'Hidden->Rejected',
        'Pending->Approved',
        'Pending->Hidden',
        'Pending->Rejected',
        'Rejected->Approved',
        'Rejected->Hidden'
      ],
      'comment.moderation.forbidden-transitions': [
        'Approved->Approved',
        'Approved->Pending',
        'Hidden->Hidden',
        'Hidden->Pending',
        'Pending->Pending',
        'Rejected->Pending',
        'Rejected->Rejected'
      ],
      'comment.public-visibility.states': {
        Pending: false,
        Approved: true,
        Rejected: false,
        Hidden: false
      },
      'comment.admin-visibility.states': ['Approved', 'Hidden', 'Pending', 'Rejected'],
      'comment.thread.max-depth': {
        configurationKey: 'CommentThreads:MaxDepth',
        default: { value: 32, unit: 'levels' },
        minimum: { value: 2, unit: 'levels', boundary: 'inclusive' },
        maximum: { value: 256, unit: 'levels', boundary: 'inclusive' },
        compare: 'parent.depth + 1 <= maxDepth',
        enforcement: 'reject-new-write'
      },
      'comment.thread.child-limit': {
        configurationKey: 'CommentThreads:MaxChildrenPerNode',
        default: { value: 500, unit: 'children' },
        minimum: { value: 1, unit: 'children', boundary: 'inclusive' },
        maximum: { value: 10000, unit: 'children', boundary: 'inclusive' },
        compare: 'childCount < maxChildren',
        boundary: 'exclusive-upper-on-count',
        enforcement: 'reject-new-write'
      },
      'comment.thread.root-parent-invariants': {
        rootRequiresParent: true,
        rootId: 'parent.RootId ?? parent.Id',
        requestedRootMustMatchComputed: true,
        replyToCommentIdDefaultsToParent: true,
        depth: 'max(1, parent.Depth + 1)',
        parentMustBePubliclyApprovedVisible: true
      },
      'comment.edit-delete.version-semantics': {
        expectedVersionCas: true,
        nextVersion: 'currentVersion + 1',
        operations: ['created', 'deleted', 'edited'],
        softDeleteProjectsAsHiddenNextStatus: true,
        editWindow: {
          configurationKey: 'Comments:AuthorEditWindowMinutes',
          default: { value: 30, unit: 'minutes' }
        }
      },
      'comment.region.visibility-states': {
        publicSurface: {
          requires: 'Approved',
          blockedRegionFilter: 'viewer-region-aware',
          unknownViewer: 'apply-all-blocked-regions'
        },
        states: ['deleted', 'hidden', 'limited', 'pending', 'public', 'rejected'],
        adminSurface: 'full-moderation-states'
      },
      'comment.outbox.required-edges': {
        CommentCreated: ['audit-projection', 'cache-version', 'model-moderation', 'realtime-stream'],
        CommentDeleted: ['audit-projection', 'cache-version', 'realtime-stream', 'site-notification'],
        CommentEdited: ['audit-projection', 'cache-version', 'realtime-stream'],
        CommentModerationChanged: ['audit-projection', 'cache-version', 'realtime-stream', 'site-notification'],
        CommentReplyNotificationRequested: ['site-notification'],
        CommentVisibilityChanged: ['audit-projection', 'cache-version', 'realtime-stream']
      },
      'comment.outbox.consumer-registry': [
        'audit-projection',
        'cache-version',
        'model-moderation',
        'realtime-stream',
        'site-notification'
      ],
      'comment.outbox.terminal-states': ['completed', 'poison', 'processed', 'terminal-failed'],
      'comment.notification.conditions': {
        replyNotificationEvent: 'CommentReplyNotificationRequested',
        publishAdded: 'transition-into-Approved',
        publishRemoved: 'transition-out-of-Approved-or-delete',
        requiresPublicRecipientAccount: true,
        anonymousReplyDoesNotMapIdentity: true
      },
      'comment.privacy.persisted-fields': [
        'account_age_bucket',
        'anonymous_display_language',
        'anonymous_display_name',
        'anonymous_handle',
        'anonymous_nullifier_hash',
        'anonymous_rate_class',
        'anonymous_scope',
        'anonymous_ticket_hash',
        'author_mode',
        'credential_level',
        'moderation_subject_hash',
        'public_handle',
        'reputation_bucket'
      ],
      'comment.privacy.forbidden-exact-fields': [
        'accountId',
        'account_id',
        'authorId',
        'author_id',
        'email',
        'ip',
        'lastIp',
        'last_ip',
        'publicHandle',
        'public_handle',
        'replyToUserId',
        'reply_to_user_id',
        'userId',
        'userName',
        'user_id',
        'user_name',
        'userid',
        'username'
      ],
      'comment.appeal.allowed-source-states': ['Hidden', 'Rejected'],
      coherence: {
        articleEntityCoreProjection: 'consistent',
        articleOutboxRequiredOptional: 'consistent',
        commentOutboxProducerDispatcher: 'consistent',
        commentPublicAdminVisibilitySeparated: true,
        layers: {
          articlePolicy: 'ArticleStatusTransitionPolicy',
          articleOutbox: 'ArticleMutationReplayEdges',
          commentOutbox: 'CommentMutationOutboxConsumers'
        }
      },
      ...factOverrides
    },
    ...rest
  }
}

function runExtract(repositoryRoot, observation, buildIdentityOverrides = {})
{
  const written = writeObservation(repositoryRoot, observation)
  return extractContentLifecycle({
    repositoryRoot,
    buildIdentity: {
      artifactId: 'content-lifecycle-observation',
      artifactDigest: written.artifactDigest,
      ...buildIdentityOverrides
    }
  })
}

test('content-lifecycle extractor is registered and owns article-comment-lifecycle-outbox', () =>
{
  const registry = loadRegistry()
  const catalog = loadCatalog()
  validateOwnershipAgainstBehaviorCatalog(registry, catalog, root)
  const extractor = registry.extractors.find((item) => item.id === 'content-lifecycle-fact-extractor')
  assert.ok(extractor)
  assert.equal(extractor.kind, 'compiled-assembly')
  assert.equal(extractor.requiredBuildArtifact, 'content-lifecycle-observation')
  assert.deepEqual(extractor.ownedBehaviorIds, ['article-comment-lifecycle-outbox'])
  assert.ok(!extractor.consumedInputs.some((input) => input.includes('docs/')))
  assert.ok(!extractor.consumedInputs.some((input) => input.includes('tests/')))
  assert.ok(!extractor.consumedInputs.some((input) => input.includes('comment-moderation-state-machine.yaml')))
})

test('positive sample observation extracts typed lifecycle/visibility/outbox facts', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const result = runExtract(directory, sampleObservation())
    assert.equal(result.status, 'ok', result.failureReasons?.join('\n'))
    validateObservations(result.observations)
    assert.ok(result.observations.facts['article.outbox.required-edges'].includes('public-hot-read'))
    assert.equal(result.observations.facts['comment.public-visibility.states'].Approved, true)
    assert.equal(result.observations.facts['comment.public-visibility.states'].Hidden, false)
    assert.equal(result.observations.facts['comment.thread.max-depth'].default.unit, 'levels')
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('1) adding article outbox required edge changes observation', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const base = runExtract(directory, sampleObservation())
    assert.equal(base.status, 'ok')
    const withEdge = runExtract(directory, sampleObservation({
      facts: {
        'article.outbox.required-edges': [
          'article-detail-aeds',
          'http-cache-invalidation',
          'new-required-edge',
          'public-aot-invalidation',
          'public-artifact-revocation',
          'public-hot-read',
          'search-projection',
          'taxonomy-projection'
        ]
      }
    }))
    assert.equal(withEdge.status, 'ok')
    assert.notEqual(
      JSON.stringify(base.observations.facts['article.outbox.required-edges']),
      JSON.stringify(withEdge.observations.facts['article.outbox.required-edges'])
    )
    assert.ok(withEdge.observations.facts['article.outbox.required-edges'].includes('new-required-edge'))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('2) removing Published→Archived transition from allowed set is reflected', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const base = runExtract(directory, sampleObservation())
    assert.equal(base.status, 'ok')
    const without = runExtract(directory, sampleObservation({
      facts: {
        'article.lifecycle.allowed-transitions': base.observations.facts['article.lifecycle.allowed-transitions']
          .filter((edge) => edge !== 'Update:Published->Archived')
      }
    }))
    assert.equal(without.status, 'ok')
    assert.ok(base.observations.facts['article.lifecycle.allowed-transitions'].includes('Update:Published->Archived'))
    assert.ok(!without.observations.facts['article.lifecycle.allowed-transitions'].includes('Update:Published->Archived'))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('3) public reader admitting Hidden comment fails closed', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const result = runExtract(directory, sampleObservation({
      facts: {
        'comment.public-visibility.states': {
          Pending: false,
          Approved: true,
          Rejected: false,
          Hidden: true
        }
      }
    }))
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /Hidden|public visibility/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('4) max-depth default change from 32 to 16 alters observation', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const thirtyTwo = runExtract(directory, sampleObservation())
    assert.equal(thirtyTwo.status, 'ok')
    const sixteen = runExtract(directory, sampleObservation({
      facts: {
        'comment.thread.max-depth': {
          configurationKey: 'CommentThreads:MaxDepth',
          default: { value: 16, unit: 'levels' },
          minimum: { value: 2, unit: 'levels', boundary: 'inclusive' },
          maximum: { value: 256, unit: 'levels', boundary: 'inclusive' },
          compare: 'parent.depth + 1 <= maxDepth',
          enforcement: 'reject-new-write'
        }
      }
    }))
    assert.equal(sixteen.status, 'ok')
    assert.notEqual(
      JSON.stringify(thirtyTwo.observations.facts['comment.thread.max-depth']),
      JSON.stringify(sixteen.observations.facts['comment.thread.max-depth'])
    )
    assert.equal(sixteen.observations.facts['comment.thread.max-depth'].default.value, 16)
    assert.equal(sixteen.observations.facts['comment.thread.max-depth'].default.unit, 'levels')
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('5) privacy forbidden field addition is mechanical', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const base = runExtract(directory, sampleObservation())
    assert.equal(base.status, 'ok')
    const extended = [
      ...base.observations.facts['comment.privacy.forbidden-exact-fields'],
      'raw_ip_address'
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const updated = runExtract(directory, sampleObservation({
      facts: {
        'comment.privacy.forbidden-exact-fields': extended
      }
    }))
    assert.equal(updated.status, 'ok')
    assert.ok(updated.observations.facts['comment.privacy.forbidden-exact-fields'].includes('raw_ip_address'))
    assert.notEqual(
      JSON.stringify(base.observations.facts['comment.privacy.forbidden-exact-fields']),
      JSON.stringify(updated.observations.facts['comment.privacy.forbidden-exact-fields'])
    )
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('6) restore reviving old publication pointer fails closed', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const result = runExtract(directory, sampleObservation({
      facts: {
        'article.restore.semantics': {
          operation: 'Restore',
          source: 'Deleted',
          target: 'Published',
          createsPublication: false,
          revivesOldPublicationPointer: true
        }
      }
    }))
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /restore|publication/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('7) required/optional article outbox edge overlap fails', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const result = runExtract(directory, sampleObservation({
      facts: {
        'article.outbox.optional-edges': ['integrity-proof', 'notification', 'public-hot-read']
      }
    }))
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /disjoint|optional|required/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('8) observation sourced from expected transition table is rejected', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const result = runExtract(directory, sampleObservation({
      source: 'expected-transition-table'
    }))
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /expected transition|fixture|docs/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('public/admin visibility collapse fails when separation flag is false', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const result = runExtract(directory, sampleObservation({
      facts: {
        coherence: {
          articleEntityCoreProjection: 'consistent',
          articleOutboxRequiredOptional: 'consistent',
          commentOutboxProducerDispatcher: 'consistent',
          commentPublicAdminVisibilitySeparated: false,
          layers: {}
        }
      }
    }))
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /public and admin/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('max-depth without unit fails', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const result = runExtract(directory, sampleObservation({
      facts: {
        'comment.thread.max-depth': {
          configurationKey: 'CommentThreads:MaxDepth',
          default: 32,
          minimum: { value: 2, unit: 'levels', boundary: 'inclusive' },
          maximum: { value: 256, unit: 'levels', boundary: 'inclusive' }
        }
      }
    }))
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /max-depth|typed/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ambient bin/Debug build identity is refused', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'content-lifecycle-obs-'))
  try
  {
    const observation = sampleObservation()
    const written = writeObservation(directory, observation)
    const result = extractContentLifecycle({
      repositoryRoot: directory,
      buildIdentity: {
        artifactId: 'content-lifecycle-observation',
        artifactDigest: written.artifactDigest,
        path: 'bin/Debug/net10.0/FsusBlog.ContentLifecycleObservation.dll'
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

test('compiled observation host produces sealed production facts (live)', { timeout: 600_000 }, () =>
{
  const produced = produceContentLifecycleObservation({ repositoryRoot: root, rebuild: true })
  assert.equal(produced.observation.schema, 'fsusblog.content-lifecycle-observation.v1')
  assert.equal(produced.observation.status, 'ok')
  assert.ok(produced.observation.facts['article.lifecycle.states'].includes('Published'))
  assert.ok(produced.observation.facts['article.outbox.required-edges'].includes('public-hot-read'))
  assert.ok(produced.observation.facts['article.outbox.optional-edges'].includes('integrity-proof'))
  assert.equal(produced.observation.facts['article.public-visibility.states'].Published, true)
  assert.equal(produced.observation.facts['article.public-visibility.states'].Draft, false)
  assert.equal(produced.observation.facts['comment.public-visibility.states'].Approved, true)
  assert.equal(produced.observation.facts['comment.public-visibility.states'].Hidden, false)
  assert.equal(produced.observation.facts['comment.thread.max-depth'].default.value, 32)
  assert.equal(produced.observation.facts['comment.thread.max-depth'].default.unit, 'levels')
  assert.ok(produced.observation.facts['comment.privacy.forbidden-exact-fields'].includes('userId'))
  assert.ok(produced.observation.facts['comment.appeal.allowed-source-states'].includes('Hidden'))
  assert.equal(produced.observation.facts['article.restore.semantics'].revivesOldPublicationPointer, false)
  assert.equal(produced.buildIdentity.artifactId, 'content-lifecycle-observation')

  const extracted = extractContentLifecycle({
    repositoryRoot: root,
    buildIdentity: produced.buildIdentity
  })
  assert.equal(extracted.status, 'ok', extracted.failureReasons?.join('\n'))
  validateObservations(extracted.observations)
  assert.deepEqual(
    extracted.observations.facts['article.outbox.required-edges'],
    produced.observation.facts['article.outbox.required-edges']
  )
  assert.deepEqual(
    extracted.observations.facts['comment.moderation.allowed-transitions'],
    produced.observation.facts['comment.moderation.allowed-transitions']
  )
})
