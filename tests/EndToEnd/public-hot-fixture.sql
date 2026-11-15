BEGIN;
UPDATE public.article_read_epoch SET last_epoch = 0 WHERE singleton;
INSERT INTO public.article_read_total(article_id, views)
VALUES (3, 20), (9, 10), (8, 10), (4, 5), (2, 2), (6, 1);
INSERT INTO public.article_read_hour(article_id, hour_utc, count)
SELECT article_id, TIMESTAMPTZ '2026-01-01 00:00:00+00', views FROM public.article_read_total;
COMMIT;
