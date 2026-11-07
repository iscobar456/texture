-- Set by the desktop app once a photo has actually appeared in its inbox, so the phone can show "Delivered".
-- (status stays 'pending' until the photo is used, so it cannot tell delivered from merely uploaded.)
alter table photos add column delivered_at timestamptz;

-- Anything already used or trashed was necessarily seen by the desktop.
update photos set delivered_at = coalesce(imported_at, trashed_at, created_at) where status <> 'pending';
