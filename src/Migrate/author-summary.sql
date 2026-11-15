ALTER TABLE public.article_revision ADD COLUMN author_summary text
    CONSTRAINT article_revision_author_summary_length CHECK (char_length(author_summary) BETWEEN 1 AND 512);
