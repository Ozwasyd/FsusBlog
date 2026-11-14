CREATE TABLE public.article_revision_rights (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    enabled boolean NOT NULL,
    license_type text NOT NULL,
    copyright_holder text NOT NULL,
    copyright_year integer NOT NULL,
    rights_statement text NOT NULL,
    attribution_template text NOT NULL,
    copy_policy text NOT NULL,
    max_excerpt_chars integer NOT NULL CHECK (max_excerpt_chars >= 0 AND max_excerpt_chars <= 10000),
    allow_code_copy boolean NOT NULL,
    show_public_badge boolean NOT NULL,
    proof_binding_enabled boolean NOT NULL,
    PRIMARY KEY (article_id, revision),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision)
);

CREATE TABLE public.article_publication_rights (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    article_id integer NOT NULL,
    publication_id bigint NOT NULL UNIQUE CHECK (publication_id > 0),
    revision bigint NOT NULL,
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision_rights (article_id, revision)
);
