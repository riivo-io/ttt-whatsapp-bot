-- TTTFG-5188: a link for an email claim. Who to tell when the client submits the form; null on a WhatsApp link.
alter table guided_form_links add column if not exists callback_url text;
