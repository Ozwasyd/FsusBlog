-- Retained publications in a disposable database, owned by an administrator distinct from the recovery operator.
BEGIN;
INSERT INTO public.article (owner_id, revision, title, body, published_revision, publication_count, deleted)
SELECT id,2,'Rollback fixture current title','The current public Markdown',2,2,false
FROM public.admin_principal WHERE handle='tls-archive-article-owner';
INSERT INTO public.article_revision(article_id,revision,title,body,happened_at) VALUES
    (1,1,'Rollback fixture source title',E'Historical Markdown ready for restoration\n\n![Never fetched in source preview](https://archive-preview.invalid/from-source.png)\n',now()-interval '2 days'),
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
INSERT INTO public.admin_principal (id,handle,user_handle,enabled,generation)
VALUES ('a8e91b13-7706-4c71-8ead-61b201df1f7b','tls-other-inventory-author',decode(repeat('11',32),'hex'),true,1);
WITH added AS (
    INSERT INTO public.article (owner_id,revision,title,body,deleted)
    SELECT CASE WHEN n=1 THEN u.id ELSE 'a8e91b13-7706-4c71-8ead-61b201df1f7b'::uuid END,
           1,'Inventory draft '||n,'Inventory summary '||n,n=22
    FROM generate_series(1,22) n CROSS JOIN public.admin_principal u WHERE u.handle='tls-archive-article-owner'
    ORDER BY n RETURNING *
)
INSERT INTO public.article_revision (article_id,revision,title,body,happened_at)
SELECT id,revision,title,body,created_at FROM added;
UPDATE public.article_revision SET author_summary='Private restore summary' WHERE article_id=23 AND revision=1;
INSERT INTO public.category(id,name) VALUES (1,'Private restore category');
INSERT INTO public.article_revision_category(article_id,revision,category_id) VALUES (23,1,1);
INSERT INTO public.private_media (id,owner_id,command_id,request_hash,content_hash,name,format,length,width,height,phase)
VALUES ('b0c88a3b-e863-4ac2-9c63-e6223d647314','a8e91b13-7706-4c71-8ead-61b201df1f7b','e5778490-c1a0-44bc-9a34-98be184418a4',
    sha256('request'::bytea),sha256('content'::bytea),'private.png',1,68,1,1,1);
INSERT INTO public.article_revision_media(article_id,revision,asset_id)
VALUES (23,1,'b0c88a3b-e863-4ac2-9c63-e6223d647314');
INSERT INTO public.property_schema(owner_id,revision) VALUES ('a8e91b13-7706-4c71-8ead-61b201df1f7b',1);
INSERT INTO public.property_definition(owner_id,id,machine_key,revision,digest,shape)
VALUES ('a8e91b13-7706-4c71-8ead-61b201df1f7b','ea3d5022-fa03-427d-8bbc-cf83aeb5e549','restore_property',1,
    repeat('a',64),'{"machineKey":"restore_property","label":"Restore property","type":"text"}');
INSERT INTO public.property_article(article_id,owner_id,revision) VALUES (23,'a8e91b13-7706-4c71-8ead-61b201df1f7b',1);
INSERT INTO public.property_value(article_id,owner_id,definition_id,data,references_ids)
VALUES (23,'a8e91b13-7706-4c71-8ead-61b201df1f7b','ea3d5022-fa03-427d-8bbc-cf83aeb5e549','"Private restored property"','{}');
COMMIT;
