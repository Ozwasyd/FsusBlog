-- FsusBlog V2 Operations Schema: appearance activation, site page editor, article reads, and site traffic.

CREATE TABLE public.appearance_activation (
    singleton boolean PRIMARY KEY CHECK (singleton),
    revision bigint NOT NULL CHECK (revision >= 0),
    theme_digest text NOT NULL CHECK (theme_digest = '' OR theme_digest ~ '^[0-9a-f]{64}$'),
    font_digest text NOT NULL CHECK (font_digest = '' OR font_digest ~ '^[0-9a-f]{64}$')
);
INSERT INTO public.appearance_activation VALUES (true, 0, '', '');

CREATE TABLE public.appearance_activation_audit (
    revision bigint PRIMARY KEY CHECK (revision > 0),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    rollback boolean NOT NULL,
    previous_theme_digest text NOT NULL,
    previous_font_digest text NOT NULL,
    theme_digest text NOT NULL,
    font_digest text NOT NULL,
    happened_at timestamptz NOT NULL
);

CREATE TABLE public.admin_appearance_step_up (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_digest bytea NOT NULL REFERENCES public.admin_session (digest) ON DELETE CASCADE
        CHECK (octet_length(session_digest) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    action integer NOT NULL CHECK (action = 4),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    kind smallint NOT NULL,
    UNIQUE (session_digest, kind),
    CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
);

CREATE TABLE public.site_page_content (
    slug text PRIMARY KEY CHECK (slug = 'about' OR slug = 'privacy' OR slug = 'guidelines' OR slug = 'copyright'),
    revision bigint NOT NULL,
    markdown text CHECK (octet_length(markdown) <= 600000),
    CHECK ((revision = 0 AND markdown IS NULL) OR (revision > 0 AND markdown IS NOT NULL))
);
INSERT INTO public.site_page_content (slug, revision)
VALUES ('about', 0), ('privacy', 0), ('guidelines', 0), ('copyright', 0);

CREATE TABLE public.site_page_publish_audit (
    slug text NOT NULL REFERENCES public.site_page_content (slug),
    revision bigint NOT NULL CHECK (revision > 0),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    previous_digest bytea NOT NULL CHECK (octet_length(previous_digest) = 32),
    next_digest bytea NOT NULL CHECK (octet_length(next_digest) = 32),
    happened_at timestamptz NOT NULL,
    PRIMARY KEY (slug, revision)
);

CREATE TABLE public.admin_site_page_step_up (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_digest bytea NOT NULL REFERENCES public.admin_session (digest) ON DELETE CASCADE
        CHECK (octet_length(session_digest) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    action integer NOT NULL CHECK (action = 2),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    kind smallint NOT NULL,
    UNIQUE (session_digest, kind),
    CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
);

CREATE TABLE public.article_read_hour (
    article_id integer NOT NULL REFERENCES public.article (id) CHECK (article_id > 0),
    hour_utc timestamptz NOT NULL CHECK (isfinite(hour_utc)) CHECK (hour_utc = date_trunc('hour', hour_utc, 'UTC')),
    count bigint NOT NULL CHECK (count > 0),
    PRIMARY KEY (article_id, hour_utc)
);

CREATE TABLE public.article_read_dwell (
    article_id integer NOT NULL REFERENCES public.article (id) CHECK (article_id > 0),
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

CREATE TABLE public.article_read_total (
    article_id integer PRIMARY KEY REFERENCES public.article (id) CHECK (article_id > 0),
    views integer NOT NULL CHECK (views > 0)
);
CREATE INDEX article_read_total_rank ON public.article_read_total (views DESC, article_id DESC);

CREATE TABLE public.site_traffic_daily (
    day date NOT NULL CHECK (isfinite(day)),
    region text NOT NULL CHECK (region ~ '^([A-Z]{2}(-[A-Z0-9]{1,3})?|unknown)$'),
    views bigint NOT NULL CHECK (views > 0),
    PRIMARY KEY (day, region)
);
