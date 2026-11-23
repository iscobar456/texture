-- Deleting an account from inside the apps (App Store guideline 5.1.1(v)).
--
-- The client first removes every stored file under "<uid>/" in both buckets through the Storage API (rows in
-- storage.objects must not be deleted with SQL: that would leave the files themselves behind), then calls this.
-- It refuses while any of the caller's files remain, so an interrupted cleanup cannot leave files nobody can reach
-- once the user is gone, and the caller can simply try again. Deleting the auth user cascades to every table
-- (all `user_id` columns reference auth.users on delete cascade).
create or replace function public.delete_account() returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if exists (
    select 1 from storage.objects
    where bucket_id in ('photos', 'project-files') and (storage.foldername(name))[1] = uid::text
  ) then
    raise exception 'Some stored files could not be removed yet; try again' using errcode = 'P0001';
  end if;
  delete from auth.users where id = uid;
end;
$$;

revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
