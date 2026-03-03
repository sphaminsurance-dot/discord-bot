// gatewayBot.js — Node 20 (Railway)
// Always-on Discord Gateway listener for:
//  1) reaction 💰 on marker message -> add/remove Active role + update agent status in Dynamo
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
// Dynamo:
//   AWS_REGION=us-east-1
//   CLIENTS_TABLE=Clients
//   CLIENTS_GUILD_GSI=Clients_DiscordGuild_GSI        // PK discord_guild_id, SK client_key
//   AGENTS_TABLE=Agents
//   AGENTS_DISCORD_GSI=Agents_DiscordUser_GSI         // PK client_key, SK discord_user_id
//   LEADS_TABLE=Leads                                  // PK client_key, SK router_lead_id
//
// Status mapping:
//   STATUS_ON_ADD=Available
//   STATUS_ON_REMOVE=Break
//
// Optional:
//   HEALTH_PORT=8080

const http = require("http");
const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

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

// Dynamo config
const CLIENTS_TABLE = process.env.CLIENTS_TABLE || "Clients";
const CLIENTS_GUILD_GSI = process.env.CLIENTS_GUILD_GSI || "Clients_DiscordGuild_GSI";

const AGENTS_TABLE = process.env.AGENTS_TABLE || "Agents";
const AGENTS_DISCORD_GSI = process.env.AGENTS_DISCORD_GSI || "Agents_DiscordUser_GSI";

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

// -------------------- Discord client --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,          // needed to add/remove roles
    GatewayIntentBits.GuildMessageReactions, // needed for reaction add/remove
    GatewayIntentBits.GuildMessages,         // needed for message fetch
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// -------------------- Tenant resolution --------------------
// We resolve client_key by guild_id using Clients_DiscordGuild_GSI.
// This avoids needing CLIENT_KEY env and supports 1 bot for all clients.
async function getClientKeyByGuildId(guildId) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: CLIENTS_TABLE,
      IndexName: CLIENTS_GUILD_GSI,
      KeyConditionExpression: "discord_guild_id = :g",
      ExpressionAttributeValues: { ":g": String(guildId) },
      Limit: 1,
    })
  );

  const item = out?.Items?.[0] || null;
  return item?.client_key ? String(item.client_key) : null;
}

async function findAgentByDiscordUserId({ client_key, discord_user_id }) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: AGENTS_TABLE,
      IndexName: AGENTS_DISCORD_GSI,
      KeyConditionExpression: "client_key = :ck AND discord_user_id = :du",
      ExpressionAttributeValues: {
        ":ck": String(client_key),
        ":du": String(discord_user_id),
      },
      Limit: 1,
    })
  );
  return out?.Items?.[0] || null;
}

async function updateAgentStatus({ client_key, agent_id, status, discord_user_id }) {
  await ddb.send(
    new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: { client_key: String(client_key), agent_id: String(agent_id) },
      ConditionExpression: "discord_user_id = :du",
      UpdateExpression: "SET #st = :s, last_status_change_at = :now, updated_at = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":s": String(status),
        ":now": nowIso(),
        ":du": String(discord_user_id),
      },
    })
  );
}

// -------------------- Lead updates (buttons) --------------------
async function updateLeadFromAction({ client_key, router_lead_id, action, actor_discord_user_id }) {
  const now = nowIso();

  // Keep this simple + safe:
  // - connected true + connected_at on "connected"
  // - sold true + sold_at on "sold"
  // - mark last_disposition for "no_answer" / "callback" etc.
  // - always set last_action + updated_at + last_updated_by_discord_user_id
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
    // dispositions
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

    // Ensure the bot reacts to the marker message once so it's visible
    // (won't trigger role changes because we ignore user.bot)
    if (!user.bot) {
      // noop
    }

    const member = await guild.members.fetch(user.id);

    if (added) {
      await member.roles.add(ACTIVE_ROLE_ID, "Reacted to activate");
      console.log(`ROLE_OK: guild=${guild.id} user=${user.id} add=true`);
    } else {
      await member.roles.remove(ACTIVE_ROLE_ID, "Removed reaction to deactivate");
      console.log(`ROLE_OK: guild=${guild.id} user=${user.id} add=false`);
    }

    // Update agent status in Dynamo (multi-tenant)
    const client_key = await getClientKeyByGuildId(guild.id);
    if (!client_key) {
      console.log(`NO_TENANT_MAPPING: guild=${guild.id}`);
      return;
    }

    const agent = await findAgentByDiscordUserId({
      client_key,
      discord_user_id: user.id,
    });

    if (!agent?.agent_id) {
      console.log(`ROLE_OK_BUT_NO_AGENT_LINK: guild=${guild.id} user=${user.id} client=${client_key}`);
      return;
    }

    const status = added ? STATUS_ON_ADD : STATUS_ON_REMOVE;
    await updateAgentStatus({
      client_key,
      agent_id: agent.agent_id,
      status,
      discord_user_id: user.id,
    });

    console.log(`STATUS_OK: client=${client_key} agent=${agent.agent_id} -> ${status}`);
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

    // Update Leads row
    await updateLeadFromAction({
      client_key,
      router_lead_id,
      action,
      actor_discord_user_id: userId,
    });

    // Acknowledge to the clicker only (keeps channel clean)
    await interaction.reply({
      content: `✅ Saved: **${action}**`,
      ephemeral: true,
    });

    // Optional: lightly “stamp” the message so everyone can see disposition quickly
    // (edit embed footer or add a short non-ephemeral follow-up)
    // Keeping it minimal to avoid rate-limit spam.
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
    // Find the guild(s) where this channel exists; simplest approach: fetch channel by id globally
    const ch = await client.channels.fetch(ACTIVE_MARKER_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) return;

    const msg = await ch.messages.fetch(TARGET_MESSAGE_ID);
    if (!msg) return;

    // React once with the emoji so it's visible
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
  console.log(`DYNAMO: region=${REGION} Clients=${CLIENTS_TABLE}(${CLIENTS_GUILD_GSI}) Agents=${AGENTS_TABLE}(${AGENTS_DISCORD_GSI}) Leads=${LEADS_TABLE}`);

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
