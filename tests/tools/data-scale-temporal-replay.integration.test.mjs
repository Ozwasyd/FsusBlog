import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const seedScript = path.join(repositoryRoot, 'tools/data-scale/seed.sh')
const cleanupScript = path.join(repositoryRoot, 'tools/data-scale/cleanup.sh')
const enabled = process.env.FSUSBLOG_RUN_DATA_SCALE_TEMPORAL_INTEGRATION === '1'
const postgresContainer = process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME
  ?? process.env.FSUSBLOG_PG_CONTAINER
  ?? 'fsusblog-dev-postgres'
const businessEpochUtc = '2024-02-29T23:59:59.000Z'

function run(command, args, { env = process.env, input, timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
    input,
    maxBuffer: 16 * 1024 * 1024,
    timeout
  })
  assert.equal(
    result.status,
    0,
    [
      `${command} ${args.join(' ')} failed`,
      result.error?.message,
      result.stdout,
      result.stderr
    ].filter(Boolean).join('\n')
  )
  return result.stdout
}

function postgresJson(prefix, sql) {
  const stdout = run('docker', [
    'exec',
    '-i',
    postgresContainer,
    'psql',
    '-X',
    '-q',
    '-t',
    '-A',
    '-U',
    'fsusblog',
    '-d',
    'fsusblog',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    `prefix=${prefix}`
  ], { input: sql })
  return JSON.parse(stdout.trim())
}

function businessState(prefix) {
  return postgresJson(prefix, String.raw`
SET TIME ZONE 'UTC';
WITH
target_articles AS (
  SELECT *
  FROM article
  WHERE title LIKE :'prefix' || ':article:%'
),
target_comments AS (
  SELECT comment.*
  FROM comment
  JOIN target_articles article ON article.id = comment.article_id
),
articles AS (
  SELECT COALESCE(
    jsonb_agg(to_jsonb(row) ORDER BY row.title),
    '[]'::jsonb
  ) AS rows
  FROM (
    SELECT
      article.title,
      article.summary,
      article.coverimageurl,
      category.name AS category,
      article.views,
      article.createtime,
      article.metadata_updated_at,
      article.status,
      article.scheduled_publish_at,
      article.published_at,
      article.archived_at,
      article.deleted_at,
      article.isdeleted
    FROM target_articles article
    JOIN category ON category.id = article.categoryid
  ) row
),
article_bodies AS (
  SELECT COALESCE(
    jsonb_agg(to_jsonb(row) ORDER BY row.article),
    '[]'::jsonb
  ) AS rows
  FROM (
    SELECT
      article.title AS article,
      body.markdown_content,
      body.updated_at
    FROM article_body body
    JOIN target_articles article ON article.id = body.article_id
  ) row
),
article_tags AS (
  SELECT COALESCE(
    jsonb_agg(to_jsonb(row) ORDER BY row.article, row.tag),
    '[]'::jsonb
  ) AS rows
  FROM (
    SELECT article.title AS article, tag.name AS tag
    FROM article_tag relation
    JOIN target_articles article ON article.id = relation.articleid
    JOIN tag ON tag.id = relation.tagid
  ) row
),
comments AS (
  SELECT COALESCE(
    jsonb_agg(to_jsonb(row) ORDER BY row.content),
    '[]'::jsonb
  ) AS rows
  FROM (
    SELECT
      comment.content,
      article.title AS article,
      comment.create_time,
      comment.current_version,
      comment.edited_at_utc,
      comment.management_capability_hash,
      comment.client_mutation_account_id,
      comment.client_mutation_id,
      comment.anonymous_ticket_hash,
      comment.mutation_request_hash,
      comment.mutation_expires_at_utc,
      comment.user_id,
      comment.author_mode,
      comment.public_handle,
      comment.anonymous_handle,
      comment.anonymous_display_name,
      comment.anonymous_display_language,
      comment.anonymous_nullifier_hash,
      comment.anonymous_scope,
      comment.moderation_subject_hash,
      comment.credential_level,
      comment.reputation_bucket,
      comment.account_age_bucket,
      comment.anonymous_rate_class,
      comment.anonymous_requires_moderation,
      parent.content AS parent,
      root.content AS root,
      comment.reply_to_user_id,
      reply.content AS reply_to,
      comment.depth,
      comment.is_deleted,
      comment.delete_reason,
      comment.delete_time,
      comment.moderation_status,
      comment.moderation_reason,
      comment.moderated_by_admin_principal_id,
      comment.moderated_at
    FROM target_comments comment
    JOIN target_articles article ON article.id = comment.article_id
    LEFT JOIN target_comments parent ON parent.id = comment.parent_id
    LEFT JOIN target_comments root ON root.id = comment.root_id
    LEFT JOIN target_comments reply ON reply.id = comment.reply_to_comment_id
  ) row
),
categories AS (
  SELECT COALESCE(jsonb_agg(name ORDER BY name), '[]'::jsonb) AS rows
  FROM category
  WHERE name LIKE :'prefix' || ':category:%'
),
tags AS (
  SELECT COALESCE(jsonb_agg(name ORDER BY name), '[]'::jsonb) AS rows
  FROM tag
  WHERE name LIKE :'prefix' || ':tag:%'
)
SELECT jsonb_build_object(
  'articles', articles.rows,
  'articleBodies', article_bodies.rows,
  'articleTags', article_tags.rows,
  'comments', comments.rows,
  'categories', categories.rows,
  'tags', tags.rows
)
FROM articles, article_bodies, article_tags, comments, categories, tags;
`)
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

test('real data-scale PostgreSQL seed replays identical business state', {
  skip: enabled ? false : 'set FSUSBLOG_RUN_DATA_SCALE_TEMPORAL_INTEGRATION=1',
  timeout: 300_000
}, () => {
  const tier = 'scale-s'
  const namespace = `temporal-replay-${process.pid}`
  const prefix = `data-scale:${namespace}:${tier}`
  const outputDirectory = path.join(
    repositoryRoot,
    '.tmp/data-scale-temporal-replay',
    namespace
  )
  const cleanupRoot = path.join(outputDirectory, 'cleanup')
  const env = {
    ...process.env,
    FSUSBLOG_DATA_SCALE_OUT_DIR: outputDirectory,
    FSUSBLOG_DATA_SCALE_ROOT: cleanupRoot,
    FSUSBLOG_POSTGRES_CONTAINER_NAME: postgresContainer,
    FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: businessEpochUtc,
    FSUSBLOG_TEST_NAMESPACE: namespace,
    FSUSBLOG_TEST_POSTGRES_TIMEZONE: 'UTC'
  }

  try {
    run('bash', [seedScript, tier], { env })
    const firstSummary = JSON.parse(readFileSync(
      path.join(outputDirectory, 'seed.json'),
      'utf8'
    ))
    const firstState = businessState(prefix)

    run('bash', [seedScript, tier], { env })
    const secondSummary = JSON.parse(readFileSync(
      path.join(outputDirectory, 'seed.json'),
      'utf8'
    ))
    const secondState = businessState(prefix)

    assert.equal(firstSummary.temporal.businessEpochUtc, businessEpochUtc)
    assert.equal(firstSummary.temporal.postgresTimezone, 'UTC')
    assert.equal(secondSummary.temporal.businessEpochUtc, businessEpochUtc)
    assert.equal(secondSummary.temporal.postgresTimezone, 'UTC')
    assert.equal(digest(secondState), digest(firstState))

    postgresJson(prefix, String.raw`
SET TIME ZONE 'UTC';
WITH changed AS (
  UPDATE article
  SET scheduled_publish_at = scheduled_publish_at + interval '1 second'
  WHERE id = (
    SELECT id
    FROM article
    WHERE title LIKE :'prefix' || ':article:%'
      AND scheduled_publish_at IS NOT NULL
    ORDER BY title
    LIMIT 1
  )
  RETURNING id
)
SELECT jsonb_build_object('changed', count(*)) FROM changed;
`)
    assert.notEqual(
      digest(businessState(prefix)),
      digest(secondState),
      'business timestamps must remain inside the database state digest'
    )
  } finally {
    run('bash', [cleanupScript, tier], { env })
    const cleanup = JSON.parse(readFileSync(
      path.join(
        cleanupRoot,
        tier,
        'cleanup.json'
      ),
      'utf8'
    ))
    assert.deepEqual(cleanup.remaining, {
      articles: 0,
      categories: 0,
      comments: 0,
      tags: 0
    })
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})
