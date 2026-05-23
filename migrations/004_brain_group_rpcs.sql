-- v1.1 synthesis: return group ids + last-activity for incremental, windowed,
-- cursor-based grouping. WhatsApp groups by conversation_id; cases by case_id.
-- (Tickets are queried directly off helpdesk_tickets.updated_at in the worker.)
create or replace function public.brain_whatsapp_groups(
  p_window_start timestamptz, p_cursor timestamptz, p_limit int
) returns table (group_id uuid, last_activity timestamptz)
language sql stable as $$
  select conversation_id as group_id, max(created_at) as last_activity
  from public.whatsapp_messages
  where conversation_id is not null and created_at >= p_window_start
  group by conversation_id
  having max(created_at) > p_cursor
  order by max(created_at) asc
  limit p_limit;
$$;

create or replace function public.brain_case_groups(
  p_window_start timestamptz, p_cursor timestamptz, p_limit int
) returns table (group_id uuid, last_activity timestamptz)
language sql stable as $$
  select case_id as group_id, max(created_at) as last_activity
  from public.case_notes
  where created_at >= p_window_start
  group by case_id
  having max(created_at) > p_cursor
  order by max(created_at) asc
  limit p_limit;
$$;
