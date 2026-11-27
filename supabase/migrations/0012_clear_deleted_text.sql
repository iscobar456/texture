-- Deleted documents and templates stay as rows ("tombstones") so other devices learn of the deletion, but their text
-- is only needed while they can still be restored (30 days, DELETED_KEEP_DAYS in packages/api). After that it is
-- cleared, as the privacy policy says. Sync never reads a tombstone's text: a clean local copy is removed, an edited
-- one wins and pushes its own text, so an empty source changes nothing for the apps. Clearing bumps updated_at
-- (touch_document / touch_template), which for a tombstone only means "still deleted".
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.clear_deleted_text() returns void
language sql
security definer
set search_path = ''
as $$
  update public.documents set source = ''
  where deleted_at < now() - interval '30 days' and source <> '';
  update public.templates set source = ''
  where deleted_at < now() - interval '30 days' and source <> '';
$$;

revoke execute on function public.clear_deleted_text() from public, anon, authenticated;

-- Daily; scheduling by name replaces an existing job of that name, so re-running this is harmless.
select cron.schedule('clear-deleted-text', '17 4 * * *', 'select public.clear_deleted_text()');

-- Catch up on anything already past the window.
select public.clear_deleted_text();
