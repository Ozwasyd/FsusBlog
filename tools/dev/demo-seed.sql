\set ON_ERROR_STOP on

begin;

insert into sys_user (public_handle, identity_kind, passkey_enabled, recovery_enabled, privacy_initialized_at, anonymous_credential_level, anonymous_credential_status, createtime, status)
values
  ('demo-reader', 'anonymous_account', false, false, '2026-06-01 09:05:00+00', 'basic', 'active', '2026-06-01 09:05:00+00', 0)
on conflict (public_handle) where public_handle is not null do update set
  identity_kind = excluded.identity_kind,
  passkey_enabled = excluded.passkey_enabled,
  recovery_enabled = excluded.recovery_enabled,
  privacy_initialized_at = excluded.privacy_initialized_at,
  anonymous_credential_level = excluded.anonymous_credential_level,
  anonymous_credential_status = excluded.anonymous_credential_status,
  status = excluded.status;

insert into admin_principal (handle, displayname, status, isroot, permissions, createdatutc)
values
  ('demo-admin', 'Demo Admin Principal', 'disabled', false, '', '2026-06-01 09:00:00+00')
on conflict (handle) do nothing;

insert into category (name)
values ('Public Preview'), ('Operations Notes')
on conflict (name) do nothing;

insert into tag (name)
values ('demo'), ('aeds'), ('public-aot'), ('moderation')
on conflict (name) do nothing;

delete from comment where id in (9100001, 9100002, 9100003);
delete from article_tag where articleid in (910001, 910002);
delete from article_body where article_id in (910001, 910002);
delete from article where id in (910001, 910002);
delete from sys_audit_log where source = 'demo-seed';

with category as (
  select id from category where name = 'Public Preview'
)
insert into article (id, title, summary, coverimageurl, categoryid, views, createtime, status, published_at, isdeleted)
select
  910001,
  'Public Preview Walkthrough',
  'A fictional article that explains the local demo surface.',
  null,
  category.id,
  42,
  '2026-06-01 10:00:00+00',
  2,
  '2026-06-01 10:00:00+00',
  false
from category;

with category as (
  select id from category where name = 'Operations Notes'
)
insert into article (id, title, summary, coverimageurl, categoryid, views, createtime, status, published_at, isdeleted)
select
  910002,
  'AEDS And Public AOT Notes',
  'A fictional operations note for testing public reading paths.',
  null,
  category.id,
  18,
  '2026-06-02 10:00:00+00',
  2,
  '2026-06-02 10:00:00+00',
  false
from category;

insert into article_body (article_id, markdown_content, updated_at)
values
  (910001, '# Public Preview Walkthrough

This is deterministic fictional demo content for local development.

- It does not describe a real deployment.
- It does not contain real user data.
- It is safe to reset and reseed.', '2026-06-01 10:05:00+00'),
  (910002, '# AEDS And Public AOT Notes

This article gives the local UI enough content to render lists, details, search metadata, and moderation examples.', '2026-06-02 10:05:00+00');

insert into article_tag (articleid, tagid)
select 910001, id from tag where name in ('demo', 'public-aot')
on conflict do nothing;

insert into article_tag (articleid, tagid)
select 910002, id from tag where name in ('demo', 'aeds')
on conflict do nothing;

insert into comment (
  id, article_id, content, create_time, author_mode,
  public_handle, anonymous_handle, anonymous_display_name, anonymous_display_language,
  anonymous_nullifier_hash, anonymous_scope, moderation_subject_hash,
  credential_level, reputation_bucket, account_age_bucket,
  parent_id, root_id, reply_to_comment_id, depth, is_deleted,
  moderation_status, moderation_reason, moderated_at
)
values
  (
    9100001,
    910001,
    '[demo] This approved comment is fictional and safe for screenshots.',
    '2026-06-01 11:00:00+00',
    'anonymous',
    null,
    'demo-reader-scope',
    'Demo Reader',
    'en',
    'demo-nullifier-approved',
    'demo:article:910001',
    'demo-subject-approved',
    'basic',
    'seed',
    'seed',
    null,
    null,
    null,
    0,
    false,
    1,
    'demo-approved',
    '2026-06-01 11:05:00+00'
  ),
  (
    9100002,
    910002,
    '[demo] This pending moderation item is fictional and repeatable.',
    '2026-06-02 11:00:00+00',
    'anonymous',
    null,
    'demo-reader-scope',
    'Demo Reader',
    'en',
    'demo-nullifier-pending',
    'demo:article:910002',
    'demo-subject-pending',
    'basic',
    'seed',
    'seed',
    null,
    null,
    null,
    0,
    false,
    0,
    'demo-pending-review',
    null
  );

insert into sys_audit_log
  (source, type, occurred_at_utc, actor_type, actor_id, actor_role, action, target_type, target_id, outcome, severity, is_high_value, trace_id, request_path, request_method, ip_hash, user_agent_hash, session_id_hash, device_fingerprint_hash, reason_code, event_info, context_json)
values
  ('demo-seed', 'security', '2026-06-01 12:00:00+00', 'system', 'demo-seed', null, 'anti-crawler.demo-signal', 'public-read', '910001', 'observed', 'info', false, 'demo-trace-0001', '/articles/public-preview-walkthrough', 'GET', 'demo-ip-hash', 'demo-ua-hash', null, null, 'demo-security-event', 'Fictional anti-crawler demo event', '{"demo":true,"source":"demo-seed"}'),
  ('demo-seed', 'audit', '2026-06-02 12:00:00+00', 'admin_principal', 'demo-admin', null, 'comment.moderation.demo-pending', 'comment', '9100002', 'pending', 'info', false, 'demo-trace-0002', '/user/manage/comments', 'POST', 'demo-ip-hash', 'demo-ua-hash', null, null, 'demo-moderation-event', 'Fictional moderation queue demo event', '{"demo":true,"source":"demo-seed"}');

commit;
