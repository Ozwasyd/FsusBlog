CREATE TABLE public.article_body_insertion (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    source_revision bigint NOT NULL,
    offset_utf16 integer NOT NULL CHECK (offset_utf16 >= 0),
    length_utf16 integer NOT NULL CHECK (length_utf16 > 0),
    source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    PRIMARY KEY (article_id, revision),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (article_id, source_revision) REFERENCES public.article_revision (article_id, revision),
    CHECK (revision = source_revision + 1)
);
