-- Groups org-channel messages by channel+day for Brain synthesis.
-- Excludes: DM channels, deleted messages, agent/bot messages (service user or metadata.agent).
begin;

create or replace function public.brain_channel_groups(
  p_window_start timestamptz,
  p_cursor timestamptz,
  p_limit int
)
returns table (group_key text, cursor_ts timestamptz, lines jsonb)
language sql
stable
as $$
  with msgs as (
    select
      m.channel_id,
      c.name as channel_name,
      date_trunc('day', m.created_at) as day,
      m.created_at,
      coalesce(u.full_name, 'Staff') as speaker,
      m.body
    from channel_messages m
    join channels c on c.id = m.channel_id
    left join users u on u.id = m.user_id
    where m.created_at > greatest(p_window_start, p_cursor)
      and coalesce(m.is_deleted, false) = false
      and c.channel_type <> 'dm'
      and coalesce(m.metadata->>'agent', '') = ''
      and coalesce(u.email, '') <> 'agents@elabsolution.org'
      and coalesce(m.body, '') <> ''
  ),
  grouped as (
    select
      channel_id,
      channel_name,
      day,
      max(created_at) as cursor_ts,
      jsonb_agg(jsonb_build_object('who', speaker, 'text', body, 'at', created_at) order by created_at) as lines
    from msgs
    group by channel_id, channel_name, day
  )
  select
    channel_id::text || ':' || to_char(day, 'YYYY-MM-DD') as group_key,
    cursor_ts,
    lines
  from grouped
  order by cursor_ts asc
  limit p_limit
$$;

commit;
