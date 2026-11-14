-- Retained publications in a disposable database, owned by a site account.
BEGIN;
INSERT INTO public.article (owner_id, revision, title, body, published_revision, publication_count, deleted)
SELECT id,2,'Rollback fixture current title','The current public Markdown',2,2,false
FROM public.blog_user WHERE name='tls-site-fixture';
INSERT INTO public.article_revision(article_id,revision,title,body,happened_at) VALUES
    (1,1,'Rollback fixture source title','Historical Markdown ready for restoration',now()-interval '2 days'),
    (1,2,'Rollback fixture current title','The current public Markdown',now()-interval '1 day');
INSERT INTO public.article_publication (article_id,publication_id,revision,publication_no,published_at)
VALUES (1,DEFAULT,2,2,now()-interval '1 day');
-- The first release has been superseded. Renumber the current row through its
-- sequence so the next real publication can only acquire a fresh coordinate.
UPDATE public.article_publication
SET publication_id=nextval(pg_get_serial_sequence('public.article_publication','publication_id'))
WHERE article_id=1;
INSERT INTO public.article_publication_history
    (article_id,event_no,revision,publication_no,publication_id,supersedes_id,kind,reason,happened_at,actor_id,command_id)
VALUES
    (1,1,1,1,1,NULL,'retained-active','pre-history',now()-interval '2 days',NULL,NULL);
INSERT INTO public.article_command(actor_id,command_id,fingerprint,article_id,revision,title,body,published)
SELECT owner_id,'d568cdae-0ba2-4653-81da-b0c61254d819',sha256(convert_to('fixture author publication','UTF8')),
       id,revision,title,body,true
FROM public.article WHERE id=1;
INSERT INTO public.article_publication_history
    (article_id,event_no,revision,publication_no,publication_id,supersedes_id,kind,reason,happened_at,actor_id,command_id)
SELECT p.article_id,2,p.revision,p.publication_no,p.publication_id,1,'replace','author-replaced',
       p.published_at,a.owner_id,'d568cdae-0ba2-4653-81da-b0c61254d819'
FROM public.article_publication p JOIN public.article a on a.id=p.article_id WHERE p.article_id=1;
INSERT INTO public.blog_outbox(article_id,revision,kind,processed_at) VALUES (1,2,'publish',now());
INSERT INTO public.article_revision_rights (
    article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,
    copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled)
VALUES
    (1,1,true,'all-rights-reserved','Historical fixture rights',2024,'Retained rights policy','','append-attribution',60,false,true,true),
    (1,2,true,'all-rights-reserved','Current fixture rights',2026,'Current rights policy','','append-attribution',120,true,true,true);
INSERT INTO public.article_publication_rights (article_id,publication_id,revision) VALUES (1,1,1),(1,2,2);
COMMIT;
