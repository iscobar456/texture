-- Soft deletes (so other devices learn about them), folders as rows, and synced previews.
alter table documents add column kind text not null default 'document' check (kind in ('document', 'folder'));
alter table documents add column deleted_at timestamptz;
-- Opaque marker for the preview image in storage; clients only compare it for equality.
alter table documents add column preview_at text;
alter table templates add column deleted_at timestamptz;

insert into documents (user_id, path, kind) select user_id, path, 'folder' from folders on conflict do nothing;
drop table folders;

-- The version (updated_at) must only move when content or deletion state changes,
-- otherwise uploading a preview would look like a conflicting edit.
create function touch_document() returns trigger language plpgsql as $$
begin
  if new.source is distinct from old.source
     or new.deleted_at is distinct from old.deleted_at
     or new.kind is distinct from old.kind then
    new.updated_at = now();
  end if;
  return new;
end $$;

drop trigger documents_touch on documents;
create trigger documents_touch before update on documents for each row execute function touch_document();

-- Previews are stored at "<user_id>/<document path>/preview.png" in the existing project-files bucket.
