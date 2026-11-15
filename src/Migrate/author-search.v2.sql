ALTER TABLE public.author_text_document
    ADD COLUMN summary_digest bytea NOT NULL
        DEFAULT pg_catalog.decode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex')
        CONSTRAINT author_text_document_summary_digest_check CHECK (octet_length(summary_digest) = 32),
    DROP CONSTRAINT author_text_document_profile_check,
    ADD CONSTRAINT author_text_document_profile_check CHECK (profile BETWEEN 1 AND 2);

ALTER TABLE public.author_text_document ALTER COLUMN summary_digest DROP DEFAULT;

ALTER TABLE public.author_text_posting
    DROP CONSTRAINT author_text_posting_field_check,
    ADD CONSTRAINT author_text_posting_field_check CHECK (field BETWEEN 1 AND 3);
