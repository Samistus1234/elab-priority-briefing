import { getSupabase } from "../supabase.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";

const AGENTS_EMAIL = "agents@elabsolution.org";

export async function postChannelMessage(params: {
  channelName: string;
  body: string;
  agent: string;
}): Promise<boolean> {
  try {
    const sb = getSupabase();
    const cfg = loadConfig();

    const { data: svc } = await sb
      .from("users")
      .select("id")
      .eq("email", AGENTS_EMAIL)
      .maybeSingle();
    if (!svc) {
      logger.warn({ channel: params.channelName }, "channel post skipped: service user missing");
      return false;
    }

    const { data: channel } = await sb
      .from("channels")
      .select("id")
      .eq("org_id", cfg.supabase.orgId)
      .eq("name", params.channelName)
      .maybeSingle();
    if (!channel) {
      logger.warn({ channel: params.channelName }, "channel post skipped: channel missing");
      return false;
    }

    const { error } = await sb.from("channel_messages").insert({
      channel_id: channel.id,
      user_id: svc.id,
      body: params.body,
      metadata: { agent: params.agent },
    });
    if (error) {
      logger.warn({ err: error.message }, "channel post failed");
      return false;
    }
    return true;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "channel post crashed");
    return false;
  }
}
