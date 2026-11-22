\if :{?fixture_count}
\else
\set fixture_count 12
\endif

BEGIN;

SELECT id AS fixture_owner FROM public.admin_principal WHERE handle = 'browser-author'
\gset

INSERT INTO public.category (id, name, description)
VALUES (1, 'Web engineering', 'Published implementation notes.'), (2, 'Empty category', null);
INSERT INTO public.tag (id, name, description) VALUES (4, 'Café', null);
INSERT INTO public.tag_url_name (name_key, tag_id) VALUES ('ANCIENNE', 4);

INSERT INTO public.article (owner_id, revision, title, body, published_revision, publication_count, deleted, created_at)
SELECT :'fixture_owner', 1, 'Browser fixture ' || seed.ordinal, 'A fixed public article.', 1, 1, false,
       TIMESTAMPTZ '2026-01-01 00:00:00+00' + seed.ordinal * INTERVAL '1 minute'
FROM generate_series(1, :fixture_count) seed(ordinal)
ORDER BY seed.ordinal;

INSERT INTO public.article_revision (article_id, revision, title, body, happened_at)
SELECT id, revision, title, body, created_at FROM public.article;
INSERT INTO public.article_publication (article_id, revision, published_at)
SELECT id, revision, created_at FROM public.article ORDER BY id;
INSERT INTO public.article_revision_category
SELECT id, revision, 1 FROM public.article WHERE title = 'Browser fixture 12';
INSERT INTO public.article_revision_tag
SELECT id, revision, 4 FROM public.article WHERE title = 'Browser fixture 12';

COMMIT;
