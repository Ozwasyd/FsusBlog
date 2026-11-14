BEGIN;

INSERT INTO public.category (id, name) VALUES (1, 'Taxonomy QA category');
INSERT INTO public.tag (id, name) VALUES (2, 'Taxonomy QA tag');
INSERT INTO public.tag (id, name)
SELECT id, 'Taxonomy QA filler ' || id FROM generate_series(3, 26) AS id;

COMMIT;
