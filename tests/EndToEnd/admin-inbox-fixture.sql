DO $$
DECLARE
    recipient uuid;
    thread bigint;
    first_message bigint;
    last_message bigint;
BEGIN
    SELECT id INTO STRICT recipient FROM public.blog_user WHERE name='tls-site-fixture';
    INSERT INTO public.inbox_conversation (account_id,subject,status,is_system,last_message_at)
    VALUES (recipient,'Inbox QA support case',0,false,now()) RETURNING id INTO thread;
    INSERT INTO public.inbox_message (conversation_id,sender,is_internal,body,sent_at)
    VALUES (thread,0,false,'Inbox QA first account message',now()) RETURNING id INTO first_message;
    INSERT INTO public.inbox_message (conversation_id,sender,is_internal,body,sent_at)
    VALUES (thread,1,true,'Inbox QA internal note <strong>literal</strong>',now());
    INSERT INTO public.inbox_message (conversation_id,sender,is_internal,body,sent_at)
    VALUES (thread,1,false,'Inbox QA newest public reply',now()) RETURNING id INTO last_message;
    UPDATE public.inbox_conversation SET read_through=first_message,last_message_id=last_message WHERE id=thread;
    INSERT INTO public.inbox_conversation (account_id,subject,status,is_system,last_message_at)
    VALUES (recipient,'Inbox QA closed case',2,false,now()) RETURNING id INTO thread;
    INSERT INTO public.inbox_message (conversation_id,sender,is_internal,body,sent_at)
    VALUES (thread,0,false,'Inbox QA closed message',now()) RETURNING id INTO last_message;
    UPDATE public.inbox_conversation SET read_through=last_message,last_message_id=last_message WHERE id=thread;
END $$;
