-- Allow the MCP health digest job to write to priority_briefings_log.
alter table priority_briefings_log
  drop constraint if exists priority_briefings_log_job_type_check;

alter table priority_briefings_log
  add constraint priority_briefings_log_job_type_check
  check (job_type in (
    'morning_brief', 'escalation_sweep', 'ceo_rollup', 'health_check', 'mcp_health_digest'
  ));
