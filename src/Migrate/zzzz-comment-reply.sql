CREATE TABLE public.comment_reply_notice (
    article_id integer NOT NULL,
    reply_id bigint NOT NULL,
    recipient_id uuid NOT NULL,
    conversation_id bigint NOT NULL UNIQUE,
    message_id bigint NOT NULL,
    moderation_version bigint NOT NULL CHECK (moderation_version > 1),
    delivered_at timestamptz NOT NULL,
    PRIMARY KEY (article_id,reply_id),
    FOREIGN KEY (article_id,reply_id) REFERENCES public.comment_account_owner(article_id,comment_id),
    FOREIGN KEY (recipient_id,conversation_id) REFERENCES public.inbox_conversation(account_id,id),
    FOREIGN KEY (conversation_id,message_id) REFERENCES public.inbox_message(conversation_id,id)
);
