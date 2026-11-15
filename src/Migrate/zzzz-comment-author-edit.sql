CREATE TABLE public.comment_author_edit_challenge (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    article_id integer NOT NULL,
    comment_id bigint NOT NULL,
    user_id uuid NOT NULL,
    session_digest bytea NOT NULL CHECK (octet_length(session_digest) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    comment_version bigint NOT NULL CHECK (comment_version > 0),
    publication_id bigint NOT NULL CHECK (publication_id > 0),
    expires_at timestamptz NOT NULL,
    UNIQUE (article_id, comment_id, session_digest),
    FOREIGN KEY (article_id, comment_id, user_id) REFERENCES public.comment_account_owner (article_id, comment_id, user_id)
);

CREATE INDEX comment_author_edit_expiry ON public.comment_author_edit_challenge (expires_at);

CREATE TABLE public.comment_author_edited (
    article_id integer NOT NULL,
    comment_id bigint NOT NULL,
    user_id uuid NOT NULL,
    comment_version bigint NOT NULL,
    previous_version bigint NOT NULL CHECK (previous_version > 0),
    previous_status smallint NOT NULL CONSTRAINT comment_author_edited_previous_status_check CHECK (previous_status >= 0 AND previous_status <= 1),
    moderation_status smallint NOT NULL CHECK (moderation_status = 0),
    previous_body text NOT NULL CHECK (octet_length(previous_body) <= 12288),
    body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 4096),
    previous_body_digest bytea NOT NULL CHECK (octet_length(previous_body_digest) = 32),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    happened_at timestamptz NOT NULL,
    PRIMARY KEY (article_id, comment_id, comment_version),
    FOREIGN KEY (article_id, comment_id, user_id) REFERENCES public.comment_account_owner (article_id, comment_id, user_id),
    CONSTRAINT comment_author_edited_next_version_check CHECK (comment_version = previous_version + 1)
);

CREATE TABLE public.comment_author_edit_outbox (
    article_id integer NOT NULL,
    comment_id bigint NOT NULL,
    comment_version bigint NOT NULL,
    event_type text NOT NULL CHECK (event_type = 'CommentEdited'),
    PRIMARY KEY (article_id, comment_id, comment_version),
    FOREIGN KEY (article_id, comment_id, comment_version) REFERENCES public.comment_author_edited (article_id, comment_id, comment_version)
);
