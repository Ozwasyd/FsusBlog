\set ON_ERROR_STOP on

begin;

insert into sys_user ("Username", "Password", "Role", "CreateTime", "Status", "LastLoginIp", "LastLoginTime")
values
  ('demo-admin', '$2b$10$h6HrDB9mpbTVbqAKpeWwQODajJVoQS0z7ITrV7QA1a/IgSOAiRuK6', 'admin', '2026-06-01 09:00:00+00', 0, 'example-local', '2026-06-01 09:30:00+00'),
  ('demo-reader', '$2b$10$h6HrDB9mpbTVbqAKpeWwQODajJVoQS0z7ITrV7QA1a/IgSOAiRuK6', 'guest', '2026-06-01 09:05:00+00', 0, 'example-local', '2026-06-01 09:35:00+00')
on conflict ("Username") do update set
  "Password" = excluded."Password",
  "Role" = excluded."Role",
  "Status" = excluded."Status",
  "LastLoginIp" = excluded."LastLoginIp",
  "LastLoginTime" = excluded."LastLoginTime";

insert into "Category" ("Name")
values ('Public Preview'), ('Operations Notes')
on conflict ("Name") do nothing;

insert into "Tag" ("Name")
values ('demo'), ('aeds'), ('public-aot'), ('moderation')
on conflict ("Name") do nothing;

delete from comment where id in (9100001, 9100002, 9100003);
delete from article_tag where "ArticleId" in (910001, 910002);
delete from article_body where article_id in (910001, 910002);
delete from article where id in (910001, 910002);
delete from sys_audit_log where source = 'demo-seed';

with category as (
  select "Id" as id from "Category" where "Name" = 'Public Preview'
)
insert into article (id, "Title", "Summary", "CoverImageUrl", "CategoryId", "Views", "CreateTime", status, published_at, "IsDeleted")
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
  select "Id" as id from "Category" where "Name" = 'Operations Notes'
)
insert into article (id, "Title", "Summary", "CoverImageUrl", "CategoryId", "Views", "CreateTime", status, published_at, "IsDeleted")
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

insert into article_tag ("ArticleId", "TagId")
select 910001, "Id" from "Tag" where "Name" in ('demo', 'public-aot')
on conflict do nothing;

insert into article_tag ("ArticleId", "TagId")
select 910002, "Id" from "Tag" where "Name" in ('demo', 'aeds')
on conflict do nothing;

insert into comment (id, article_id, content, create_time, user_id, parent_id, root_id, reply_to_user_id, reply_to_comment_id, depth, is_deleted, moderation_status, moderation_reason, moderated_by_user_id, moderated_at)
select
  9100001,
  910001,
  '[demo] This approved comment is fictional and safe for screenshots.',
  '2026-06-01 11:00:00+00',
  u."Id",
  null,
  null,
  null,
  null,
  0,
  false,
  1,
  'demo-approved',
  a."Id",
  '2026-06-01 11:05:00+00'
from sys_user u cross join sys_user a
where u."Username" = 'demo-reader' and a."Username" = 'demo-admin';

insert into comment (id, article_id, content, create_time, user_id, parent_id, root_id, reply_to_user_id, reply_to_comment_id, depth, is_deleted, moderation_status, moderation_reason, moderated_by_user_id, moderated_at)
select
  9100002,
  910002,
  '[demo] This pending moderation item is fictional and repeatable.',
  '2026-06-02 11:00:00+00',
  u."Id",
  null,
  null,
  null,
  null,
  0,
  false,
  0,
  'demo-pending-review',
  null,
  null
from sys_user u
where u."Username" = 'demo-reader';

insert into sys_audit_log
  (source, type, occurred_at_utc, actor_type, actor_id, actor_role, action, target_type, target_id, outcome, severity, is_high_value, trace_id, request_path, request_method, ip_hash, user_agent_hash, session_id_hash, device_fingerprint_hash, reason_code, event_info, context_json)
values
  ('demo-seed', 'security', '2026-06-01 12:00:00+00', 'system', 'demo-seed', 'admin', 'anti-crawler.demo-signal', 'public-read', '910001', 'observed', 'info', false, 'demo-trace-0001', '/articles/public-preview-walkthrough', 'GET', 'demo-ip-hash', 'demo-ua-hash', null, null, 'demo-security-event', 'Fictional anti-crawler demo event', '{"demo":true,"source":"demo-seed"}'),
  ('demo-seed', 'audit', '2026-06-02 12:00:00+00', 'user', 'demo-admin', 'admin', 'comment.moderation.demo-pending', 'comment', '9100002', 'pending', 'info', false, 'demo-trace-0002', '/user/manage/comments', 'POST', 'demo-ip-hash', 'demo-ua-hash', null, null, 'demo-moderation-event', 'Fictional moderation queue demo event', '{"demo":true,"source":"demo-seed"}');

commit;
