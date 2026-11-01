-- Template thumbnails sync like document previews: an opaque marker column plus a file in storage
-- ("<user_id>/.templates/<name>/preview.png"; document paths can never start with '.', so no collision).
alter table templates add column preview_at text;

-- Setting preview_at must not look like an edit of the template, so the version (updated_at) only moves
-- when the text or the deletion state changes.
create function touch_template() returns trigger language plpgsql as $$
begin
  if new.source is distinct from old.source or new.deleted_at is distinct from old.deleted_at then
    new.updated_at = now();
  end if;
  return new;
end $$;

drop trigger templates_touch on templates;
create trigger templates_touch before update on templates for each row execute function touch_template();
