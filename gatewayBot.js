// gatewayBot.js — Node 20 (Railway)
  // Always-on Discord Gateway listener for:
  //  1) reaction 💰 on marker message -> add/remove Active role + update agent status via Dashboard API
  //  2) interactive buttons on lead messages -> update Leads row in Dynamo (connected/sold/no-answer/etc)
  //
  // Install:
  //   npm i discord.js @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
  //
  // Required Env:
  //   DISCORD_BOT_TOKEN=...
  //
  // Marker (role toggle):
  //   ACTIVE_ROLE_ID=1477879654223446233
  //   ACTIVE_MARKER_CHANNEL_ID=1477879654848135265
  //   TARGET_MESSAGE_ID=1477890524563116063
  //   TARGET_EMOJI=💰
  //
  // Dashboard API (agent status):
  //   DASHBOARD_API_URL=https://your-replit-app.replit.app
  //   BOT_API_TOKEN=...
  //
  // Dynamo (leads only):
  //   AWS_REGION=us-east-1
  //   LEADS_TABLE=Leads
  //
  // Status mapping:
  //   STATUS_ON_ADD=Available
  //   STATUS_ON_REMOVE=Break
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

  // Marker config
  const ACTIVE_ROLE_ID = mustEnv("ACTIVE_ROLE_ID");
  const ACTIVE_MARKER_CHANNEL_ID = mustEnv("ACTIVE_MARKER_CHANNEL_ID");
  const TARGET_MESSAGE_ID = mustEnv("TARGET_MESSAGE_ID");
  const TARGET_EMOJI = process.env.TARGET_EMOJI || "💰";

  // Dashboard API config
  const DASHBOARD_API_URL = mustEnv("DASHBOARD_API_URL");
  const BOT_API_TOKEN = mustEnv("BOT_API_TOKEN");

  // Dynamo config (leads only)
  const LEADS_TABLE = process.env.LEADS_TABLE || "Leads";

  // Status mapping
  const STATUS_ON_ADD = process.env.STATUS_ON_ADD || "Available";
  const STATUS_ON_REMOVE = process.env.STATUS_ON_REMOVE || "Break";

  function nowIso() {
    return new Date().toISOString();
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  // -------------------- Dashboard API helpers --------------------
  function dashboardRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, DASHBOARD_API_URL);
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

  async function findAgentByDiscordUserId(discord_user_id) {
    const resp = await dashboardRequest("GET", `/api/bot/agent-by-discord/${discord_user_id}`);
    if (resp.statusCode === 200) return resp.data;
    if (resp.statusCode === 404) return null;
    console.log(`API_AGENT_LOOKUP_ERROR: status=${resp.statusCode}`, resp.data);
    return null;
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
      if (!msg?.id || msg.id !== TARGET_MESSAGE_ID) return;
      if (String(msg.channelId) !== String(ACTIVE_MARKER_CHANNEL_ID)) return;

      const emojiName = reaction.emoji?.name || "";
      if (emojiName !== TARGET_EMOJI) return;

      const guild = msg.guild;
      if (!guild) return;

      const member = await guild.members.fetch(user.id);

      if (added) {
        await member.roles.add(ACTIVE_ROLE_ID, "Reacted to activate");
        console.log(`ROLE_OK: guild=${guild.id} user=${user.id} add=true`);
      } else {
        await member.roles.remove(ACTIVE_ROLE_ID, "Removed reaction to deactivate");
        console.log(`ROLE_OK: guild=${guild.id} user=${user.id} add=false`);
      }

      // Look up agent via Dashboard API (searches all clients)
      const agent = await findAgentByDiscordUserId(user.id);
      if (!agent) {
        console.log(`ROLE_OK_BUT_NO_AGENT_LINK: guild=${guild.id} user=${user.id}`);
        return;
      }

      const status = added ? STATUS_ON_ADD : STATUS_ON_REMOVE;
      const result = await updateAgentStatus({ discord_user_id: user.id, status });

      if (result?.ok) {
        console.log(`STATUS_OK: client=${agent.client_key} agent=${agent.agent_id} -> ${status}`);
      } else {
        console.log(`STATUS_FAIL: client=${agent.client_key} agent=${agent.agent_id} status=${status}`);
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

  // -------------------- Startup: react to marker message once --------------------
  async function ensureMarkerReact() {
    try {
      const ch = await client.channels.fetch(ACTIVE_MARKER_CHANNEL_ID);
      if (!ch || !ch.isTextBased()) return;

      const msg = await ch.messages.fetch(TARGET_MESSAGE_ID);
      if (!msg) return;

      await msg.react(TARGET_EMOJI);
      console.log("MARKER_REACT_OK");
    } catch (err) {
      console.log("MARKER_REACT_FAIL:", err?.message || err);
    }
  }

  client.once(Events.ClientReady, async () => {
    console.log(`READY: ${client.user.tag}`);
    console.log(
      `CONFIG: role=${ACTIVE_ROLE_ID} channel=${ACTIVE_MARKER_CHANNEL_ID} message=${TARGET_MESSAGE_ID} emoji=${TARGET_EMOJI}`
    );
    console.log(`DASHBOARD: ${DASHBOARD_API_URL}`);
    console.log(`DYNAMO: region=${REGION} Leads=${LEADS_TABLE}`);

    await ensureMarkerReact();
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleMoneybagReaction(reaction, user, true);
  });
  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    await handleMoneybagReaction(reaction, user, false);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    await handleLeadButton(interaction);
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
  