CREATE TABLE public.article_read_hour (
    article_id integer NOT NULL REFERENCES public.article(id) CHECK (article_id > 0),
    hour_utc timestamptz NOT NULL CHECK (isfinite(hour_utc)) CHECK (hour_utc = date_trunc('hour', hour_utc, 'UTC')),
    count bigint NOT NULL CHECK (count > 0),
    PRIMARY KEY (article_id, hour_utc)
);

CREATE TABLE public.article_read_dwell (
    article_id integer NOT NULL REFERENCES public.article(id) CHECK (article_id > 0),
    day_utc date NOT NULL CHECK (isfinite(day_utc)),
    bucket integer NOT NULL CHECK (bucket BETWEEN 0 AND 3),
    count bigint NOT NULL CHECK (count > 0),
    PRIMARY KEY (article_id, day_utc, bucket)
);

CREATE TABLE public.article_read_epoch (
    singleton boolean PRIMARY KEY CHECK (singleton),
    last_epoch bigint CHECK (last_epoch >= 0)
);

INSERT INTO public.article_read_epoch (singleton) VALUES (true);
