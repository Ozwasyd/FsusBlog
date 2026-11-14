CREATE TABLE public.scoped_pow_consumed (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    expires_at timestamptz NOT NULL
);

CREATE INDEX scoped_pow_expiry ON public.scoped_pow_consumed (expires_at);
