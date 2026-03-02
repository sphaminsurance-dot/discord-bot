// gatewayBot.js — Node 20+ (Railway)
// Discord Gateway listener: reaction add/remove -> add/remove role
// Scoped to EXACT message + channel.
// Multi-tenant: resolves client_key from Clients table via Clients_DiscordGuild_GSI,
// then resolves agent via Agents_DiscordUser_GSI and updates status (optional).

"use strict";

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

// -------------------- ENV --------------------
function must(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing ${name}`);
  return val;
}

const REGION = process.env.AWS_REGION || "us-east-1";

const DISCORD_BOT_TOKEN = must("DISCORD_BOT_TOKEN");

// EXACT targets you specified
const ACTIVE_ROLE_ID = must("ACTIVE_ROLE_ID"); // 1477879654223446233
const TARGET_MESSAGE_ID = must("TARGET_MESSAGE_ID"); // 1477890524563116063
const ACTIVE_MARKER_CHANNEL_ID = must("ACTIVE_MARKER_CHANNEL_ID"); // 1477879654848135265
const TARGET_EMOJI = process.env.TARGET_EMOJI || "💰"; // if you want to enforce emoji; default 💰

// Dynamo (multi-tenant)
const CLIENTS_TABLE = must("CLIENTS_TABLE"); // Clients
const CLIENTS_GUILD_GSI = must("CLIENTS_GUILD_GSI"); // Clients_DiscordGuild_GSI (PK discord_guild_id, SK client_key)
const AGENTS_TABLE = must("AGENTS_TABLE"); // Agents
const AGENTS_DISCORD_GSI = must("AGENTS_DISCORD_GSI"); // Agents_DiscordUser_GSI (PK client_key, SK discord_user_id)

// Optional statuses written to Agents table
const STATUS_ON_ADD = process.env.STATUS_ON_ADD || "Available";
const STATUS_ON_REMOVE = process.env.STATUS_ON_REMOVE || "Break";

// -------------------- Dynamo clients --------------------
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function nowIso() {
  return new Date().toISOString();
}

// -------------------- Client lookup (guild -> client_key) --------------------
async function getClientByGuildId(guild_id) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: CLIENTS_TABLE,
      IndexName: CLIENTS_GUILD_GSI,
      KeyConditionExpression: "discord_guild_id = :g",
      ExpressionAttributeValues: { ":g": String(guild_id) },
      Limit: 2,
    })
  );

  const items = out?.Items || [];
  if (items.length === 1) return items[0];
  if (items.length > 1) {
    console.warn(`MULTI_CLIENT_MATCH guild=${guild_id} count=${items.length}`);
    return items[0]; // fail-soft: pick first
  }
  return null;
}

// -------------------- Agent lookup & status update --------------------
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

async function updateAgentStatus({ client_key, agent_id, status }) {
  const now = nowIso();
  await ddb.send(
    new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: { client_key: String(client_key), agent_id: String(agent_id) },
      UpdateExpression: "SET #st = :s, last_status_change_at = :now, updated_at = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":s": status, ":now": now },
    })
  );
}

// -------------------- Discord client --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // required to add/remove roles
    GatewayIntentBits.GuildMessageReactions, // reaction add/remove
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once("clientReady", () => {
  console.log(`READY: ${client.user.tag}`);
});

// Core filter: must be exact message id + channel id (and optionally emoji)
function isTargetReaction(reaction) {
  const msg = reaction?.message;
  if (!msg?.id) return false;
  if (String(msg.id) !== String(TARGET_MESSAGE_ID)) return false;
  if (String(msg.channelId) !== String(ACTIVE_MARKER_CHANNEL_ID)) return false;

  if (TARGET_EMOJI) {
    const emojiName = reaction?.emoji?.name || "";
    if (emojiName !== TARGET_EMOJI) return false;
  }

  return true;
}

async function ensureFetched(reaction) {
  // partials safety
  if (reaction?.partial) await reaction.fetch();
  if (reaction?.message?.partial) await reaction.message.fetch();
}

async function handleReactionChange(reaction, user, action /* "added"|"removed" */) {
  try {
    if (!user || user.bot) return;

    await ensureFetched(reaction);

    if (!isTargetReaction(reaction)) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    // Fetch member
    const member = await guild.members.fetch(user.id);

    // Add/remove role
    if (action === "added") {
      await member.roles.add(ACTIVE_ROLE_ID, "Reacted on active marker message");
    } else {
      await member.roles.remove(ACTIVE_ROLE_ID, "Removed reaction on active marker message");
    }

    // Multi-tenant: map guild -> client -> agent -> status
    const clientRow = await getClientByGuildId(guild.id);
    if (!clientRow?.client_key) {
      console.warn(`NO_TENANT_MAPPING: guild=${guild.id}`);
      return;
    }

    const agent = await findAgentByDiscordUserId({
      client_key: clientRow.client_key,
      discord_user_id: user.id,
    });

    if (!agent?.agent_id) {
      console.log(`ROLE_OK_BUT_NO_AGENT_LINK: guild=${guild.id} user=${user.id} client=${clientRow.client_key}`);
      return;
    }

    const nextStatus = action === "added" ? STATUS_ON_ADD : STATUS_ON_REMOVE;
    await updateAgentStatus({
      client_key: clientRow.client_key,
      agent_id: agent.agent_id,
      status: nextStatus,
    });

    console.log(
      `OK: action=${action} guild=${guild.id} channel=${reaction.message.channelId} msg=${reaction.message.id} user=${user.id} role=${ACTIVE_ROLE_ID} client=${clientRow.client_key} agent=${agent.agent_id} status=${nextStatus}`
    );
  } catch (err) {
    console.error("REACTION_HANDLER_ERROR:", err?.message || err);
  }
}

// Reaction add
client.on("messageReactionAdd", async (reaction, user) => {
  await handleReactionChange(reaction, user, "added");
});

// Reaction remove
client.on("messageReactionRemove", async (reaction, user) => {
  await handleReactionChange(reaction, user, "removed");
});

// Login
client.login(DISCORD_BOT_TOKEN).catch((e) => {
  console.error("LOGIN_FAILED:", e?.message || e);
  process.exit(1);
});
