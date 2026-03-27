// gatewayBot.js — Node 20 (Railway)
  // Always-on Discord Gateway listener for:
  //  1) guildMemberAdd -> assign agent role + notify Dashboard API to grant category access
  //  2) reaction 💰 on per-client active-marker messages -> update agent status via Dashboard API
  //  3) interactive buttons on lead messages -> update Leads row in Dynamo
  //
  // Install:
  //   npm i discord.js @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
  //
  // Required Env:
  //   DISCORD_BOT_TOKEN=...
  //
  // Guild / role config:
  //   GUILD_ID=1477879653795496091
  //   ROLE_ID=1477879654210605187             (agent role assigned on join)
  //
  // Dashboard API (agent status + member join):
  //   MAS_API_URL=https://your-replit-app.replit.app
  //   BOT_API_TOKEN=...
  //
  // Dynamo (leads only):
  //   AWS_REGION=us-east-1
  //   LEADS_TABLE=Leads
  //
  // Optional:
  //   HEALTH_PORT=8080

  const http = require("http");
  const https = require("https");
  const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");

  const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

  const REGION = process.env.AWS_REGION || "us-east-1";

  function mustEnv(name) {
    const val = process.env[name];
    if (!val) throw new Error(`Missing ${name}`);
    return val;
  }

  const DISCORD_BOT_TOKEN = mustEnv("DISCORD_BOT_TOKEN");

  // Guild / role config
  const GUILD_ID = process.env.GUILD_ID || "1477879653795496091";
  const ROLE_ID = process.env.ROLE_ID || "1477879654210605187";

  // Dashboard API config (MAS_API_URL preferred; fall back to DASHBOARD_API_URL for backwards-compat)
  const MAS_API_URL = process.env.MAS_API_URL || process.env.DASHBOARD_API_URL;
  if (!MAS_API_URL) throw new Error("Missing MAS_API_URL");
  const BOT_API_TOKEN = mustEnv("BOT_API_TOKEN");

  // Dynamo config (leads only)
  const LEADS_TABLE = process.env.LEADS_TABLE || "Leads";

  const TARGET_EMOJI = "💰";

  function nowIso() {
    return new Date().toISOString();
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  // -------------------- Active-marker cache --------------------
  // Each entry: { active_marker_channel_id: string, active_marker_message_id: string }
  let activeMarkers = [];

  async function fetchActiveMarkers() {
    try {
      const resp = await dashboardRequest("GET", "/api/bot/active-markers");
      if (resp.statusCode === 200 && Array.isArray(resp.data)) {
        activeMarkers = resp.data;
        console.log(`MARKERS_REFRESHED: count=${activeMarkers.length}`);
      } else {
        console.log(`MARKERS_FETCH_WARN: status=${resp.statusCode}`, resp.data);
      }
    } catch (err) {
      console.error("MARKERS_FETCH_ERROR:", err?.message || err);
    }
  }

  function isMarkerMessage(channelId, messageId) {
    return activeMarkers.some(
      (m) =>
        String(m.active_marker_channel_id) === String(channelId) &&
        String(m.active_marker_message_id) === String(messageId)
    );
  }

  // -------------------- Dashboard API helpers --------------------
  function dashboardRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, MAS_API_URL);
      const isHttps = url.protocol === "https:";
      const options = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          Authorization: `Bearer ${BOT_API_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "MAS-DiscordBot/1.0",
        },
      };
      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }
      const lib = isHttps ? https : http;
      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode, data });
          }
        });
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async function updateAgentStatus({ discord_user_id, status }) {
    const resp = await dashboardRequest("POST", "/api/bot/agent-status", {
      discord_user_id,
      status,
    });
    if (resp.statusCode === 200) return resp.data;
    console.log(`API_STATUS_UPDATE_ERROR: status=${resp.statusCode}`, resp.data);
    return null;
  }

  // -------------------- Discord client --------------------
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMessages,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  // -------------------- guildMemberAdd handler --------------------
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      // Assign the standard agent role
      await member.roles.add(ROLE_ID, "New member — auto-assign agent role");
      console.log(`MEMBER_JOIN_ROLE_OK: guild=${member.guild.id} user=${member.user.id}`);
    } catch (err) {
      console.error(`MEMBER_JOIN_ROLE_FAIL: user=${member.user.id}`, err?.message || err);
    }

    try {
      // Notify MAS Dashboard to grant category access if this user is a registered agent
      const resp = await dashboardRequest("POST", "/api/bot/member-join", {
        discord_user_id: member.user.id,
      });
      if (resp.statusCode === 200) {
        console.log(`MEMBER_JOIN_API_OK: user=${member.user.id}`, resp.data);
      } else {
        console.log(`MEMBER_JOIN_API_WARN: user=${member.user.id} status=${resp.statusCode}`, resp.data);
      }
    } catch (err) {
      // Fail silently on API errors per spec
      console.error(`MEMBER_JOIN_API_FAIL: user=${member.user.id}`, err?.message || err);
    }
  });

  // -------------------- Lead updates (buttons) --------------------
  async function updateLeadFromAction({ client_key, router_lead_id, action, actor_discord_user_id }) {
    const now = nowIso();
    let updateExpr = "SET updated_at = :u, last_action = :a, last_updated_by_discord_user_id = :du";
    const names = {};
    const vals = {
      ":u": now,
      ":a": action,
      ":du": String(actor_discord_user_id),
    };

    if (action === "connected") {
      updateExpr += ", connected = :t, connected_at = if_not_exists(connected_at, :u)";
      vals[":t"] = true;
    } else if (action === "sold") {
      updateExpr += ", sold = :t, sold_at = if_not_exists(sold_at, :u)";
      vals[":t"] = true;
    } else {
      updateExpr += ", last_disposition = :d";
      vals[":d"] = action;
    }

    await ddb.send(
      new UpdateCommand({
        TableName: LEADS_TABLE,
        Key: { client_key: String(client_key), router_lead_id: String(router_lead_id) },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: vals,
      })
    );

    return { ok: true, updated_at: now };
  }

  // Button custom_id format:
  //   ml:<client_key>:<router_lead_id>:<action>
  function parseButtonCustomId(customId) {
    const s = String(customId || "");
    if (!s.startsWith("ml:")) return null;
    const parts = s.split(":");
    if (parts.length < 4) return null;
    const client_key = parts[1];
    const router_lead_id = parts[2];
    const action = parts.slice(3).join(":");
    if (!client_key || !router_lead_id || !action) return null;
    return { client_key, router_lead_id, action };
  }

  // -------------------- Marker reaction handler --------------------
  async function handleMoneybagReaction(reaction, user, added) {
    try {
      if (!reaction) return;
      if (!user || user.bot) return;

      if (reaction.partial) await reaction.fetch();
      if (reaction.message?.partial) await reaction.message.fetch();

      const msg = reaction.message;
      if (!msg?.id) return;

      // Check against dynamically-loaded marker list
      if (!isMarkerMessage(msg.channelId, msg.id)) return;

      const emojiName = reaction.emoji?.name || "";
      if (emojiName !== TARGET_EMOJI) return;

      // Status-only: no role assignment or removal
      const status = added ? "Available" : "Offline";
      const result = await updateAgentStatus({ discord_user_id: user.id, status });

      if (result?.ok) {
        console.log(`STATUS_OK: user=${user.id} -> ${status}`);
      } else {
        console.log(`STATUS_FAIL: user=${user.id} status=${status}`);
      }
    } catch (err) {
      console.error("REACTION_ERROR:", err?.message || err);
    }
  }

  // -------------------- Button interaction handler --------------------
  async function handleLeadButton(interaction) {
    try {
      if (!interaction.isButton()) return;

      const parsed = parseButtonCustomId(interaction.customId);
      if (!parsed) return;

      const { client_key, router_lead_id, action } = parsed;
      const userId = interaction.user?.id;

      await updateLeadFromAction({
        client_key,
        router_lead_id,
        action,
        actor_discord_user_id: userId,
      });

      await interaction.reply({
        content: `✅ Saved: **${action}**`,
        ephemeral: true,
      });

      console.log(`LEAD_BTN_OK: client=${client_key} router=${router_lead_id} action=${action} by=${userId}`);
    } catch (err) {
      console.error("LEAD_BTN_FAIL:", err?.message || err);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "❌ Could not save. Check logs.", ephemeral: true });
        }
      } catch (_) {}
    }
  }

  // -------------------- Event listeners --------------------
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleMoneybagReaction(reaction, user, true);
  });
  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    await handleMoneybagReaction(reaction, user, false);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    await handleLeadButton(interaction);
  });

  // -------------------- Startup --------------------
  client.once(Events.ClientReady, async () => {
    console.log(`READY: ${client.user.tag}`);
    console.log(`CONFIG: guild=${GUILD_ID} role=${ROLE_ID}`);
    console.log(`MAS_API: ${MAS_API_URL}`);
    console.log(`DYNAMO: region=${REGION} Leads=${LEADS_TABLE}`);

    // Fetch active markers on startup and refresh every 5 minutes
    await fetchActiveMarkers();
    setInterval(fetchActiveMarkers, 5 * 60 * 1000);
  });

  // Railway needs a port listener to keep the service healthy
  const HEALTH_PORT = Number(process.env.HEALTH_PORT || 8080);
  http
    .createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    })
    .listen(HEALTH_PORT, () => console.log(`HTTP_OK: listening on ${HEALTH_PORT}`));

  client.login(DISCORD_BOT_TOKEN);
  