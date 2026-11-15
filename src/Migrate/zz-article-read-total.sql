CREATE TABLE public.article_read_total (
    article_id integer PRIMARY KEY REFERENCES public.article(id) CHECK (article_id > 0),
    views integer NOT NULL CHECK (views > 0)
);

CREATE INDEX article_read_total_rank ON public.article_read_total (views DESC, article_id DESC);
