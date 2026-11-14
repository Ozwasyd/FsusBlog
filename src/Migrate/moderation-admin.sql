ALTER TABLE public.comment ADD COLUMN moderation_version bigint NOT NULL DEFAULT 1 CHECK (moderation_version > 0);

CREATE TABLE public.admin_comment_claim (
    article_id integer NOT NULL,
    comment_id bigint NOT NULL,
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_digest bytea NOT NULL CHECK (octet_length(session_digest) = 32),
    admin_generation bigint NOT NULL CHECK (admin_generation > 0),
    claim_digest bytea NOT NULL CHECK (octet_length(claim_digest) = 32),
    claim_generation bigint NOT NULL CHECK (claim_generation > 0),
    claim_version bigint NOT NULL CHECK (claim_version > 0),
    claimed_comment_version bigint NOT NULL CHECK (claimed_comment_version > 0),
    expires_at timestamptz NOT NULL,
    state smallint NOT NULL CHECK (state BETWEEN 1 AND 3),
    PRIMARY KEY (article_id, comment_id),
    FOREIGN KEY (article_id, comment_id) REFERENCES public.comment_submit_command (article_id, comment_id)
);

CREATE TABLE public.admin_comment_moderation (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    article_id integer NOT NULL,
    comment_id bigint NOT NULL,
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    previous_status smallint NOT NULL CHECK (previous_status = 0),
    next_status smallint NOT NULL CHECK (next_status BETWEEN 1 AND 2),
    reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 1024),
    happened_at timestamptz NOT NULL,
    comment_version bigint NOT NULL CHECK (comment_version > 0),
    FOREIGN KEY (article_id, comment_id) REFERENCES public.comment_submit_command (article_id, comment_id)
);
