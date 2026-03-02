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

function opt(name, fallback = "") {
  const val = process.env[name];
  return val == null ? fallback : val;
}

const REGION = opt("AWS_REGION", "us-east-1");

const DISCORD_BOT_TOKEN = must("DISCORD_BOT_TOKEN");

// EXACT targets you specified (now OPTIONAL to prevent crash)
const ACTIVE_ROLE_ID = opt("ACTIVE_ROLE_ID", "");
const TARGET_MESSAGE_ID = opt("TARGET_MESSAGE_ID", "");
const ACTIVE_MARKER_CHANNEL_ID = opt("ACTIVE_MARKER_CHANNEL_ID", "");
const TARGET_EMOJI = opt("TARGET_EMOJI", "💰"); // optional enforcement

// Dynamo (multi-tenant) (required if you want DB updates)
const CLIENTS_TABLE = opt("CLIENTS_TABLE", "");
const CLIENTS_GUILD_GSI = opt("CLIENTS_GUILD_GSI", "");
const AGENTS_TABLE = opt("AGENTS_TABLE", "");
const AGENTS_DISCORD_GSI = opt("AGENTS_DISCORD_GSI", "");

// Optional statuses written to Agents table
const STATUS_ON_ADD = opt("STATUS_ON_ADD", "Available");
const STATUS_ON_REMOVE = opt("STATUS_ON_REMOVE", "Break");

// Startup diagnostics
function startupReport() {
  const missing = [];
  if (!ACTIVE_ROLE_ID) missing.push("ACTIVE_ROLE_ID");
  if (!TARGET_MESSAGE_ID) missing.push("TARGET_MESSAGE_ID");
  if (!ACTIVE_MARKER_CHANNEL_ID) missing.push("ACTIVE_MARKER_CHANNEL_ID");

  if (missing.length) {
    console.warn(
      `WARNING: Missing required target env vars: ${missing.join(
        ", "
      )}. Role changes will be disabled until set.`
    );
  } else {
    console.log(
      `CONFIG: role=${ACTIVE_ROLE_ID} channel=${ACTIVE_MARKER_CHANNEL_ID} message=${TARGET_MESSAGE_ID} emoji=${TARGET_EMOJI || "(any)"}`
    );
  }

  const dbMissing = [];
  if (!CLIENTS_TABLE) dbMissing.push("CLIENTS_TABLE");
  if (!CLIENTS_GUILD_GSI) dbMissing.push("CLIENTS_GUILD_GSI");
  if (!AGENTS_TABLE) dbMissing.push("AGENTS_TABLE");
  if (!AGENTS_DISCORD_GSI) dbMissing.push("AGENTS_DISCORD_GSI");

  if (dbMissing.length) {
    console.warn(
      `WARNING: Missing Dynamo env vars: ${dbMissing.join(
        ", "
      )}. Dynamo status updates will be disabled.`
    );
  } else {
    console.log(
      `DYNAMO: Clients=${CLIENTS_TABLE}(${CLIENTS_GUILD_GSI}) Agents=${AGENTS_TABLE}(${AGENTS_DISCORD_GSI})`
    );
  }
}

startupReport();

// -------------------- Dynamo clients (optional) --------------------
let ddb = null;
const dynamoEnabled =
  CLIENTS_TABLE && CLIENTS_GUILD_GSI && AGENTS_TABLE && AGENTS_DISCORD_GSI;

if (dynamoEnabled) {
  ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function nowIso() {
  return new Date().toISOString();
}

// -------------------- Client lookup (guild -> client_key) --------------------
async function getClientByGuildId(guild_id) {
  if (!dynamoEnabled) return null;

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
    return items[0]; // fail-soft
  }
  return null;
}

// -------------------- Agent lookup & status update --------------------
async function findAgentByDiscordUserId({ client_key, discord_user_id }) {
  if (!dynamoEnabled) return null;

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
  if (!dynamoEnabled) return;

  const now = nowIso();
  await ddb.send(
    new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: { client_key: String(client_key), agent_id: String(agent_id) },
      UpdateExpression:
        "SET #st = :s, last_status_change_at = :now, updated_at = :now",
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
  if (!ACTIVE_ROLE_ID || !TARGET_MESSAGE_ID || !ACTIVE_MARKER_CHANNEL_ID) {
    return false; // disabled until envs are set
  }

  const msg = reaction?.message;
  if (!msg?.id) return false;

  if (String(msg.id) !== String(TARGET_MESSAGE_ID)) return false;
  if (String(msg.channelId) !== String(ACTIVE_MARKER_CHANNEL_ID)) return false;

  // If TARGET_EMOJI is set, enforce it; if empty, allow any emoji
  if (TARGET_EMOJI) {
    const emojiName = reaction?.emoji?.name || "";
    if (emojiName !== TARGET_EMOJI) return false;
  }

  return true;
}

async function ensureFetched(reaction) {
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

    // Optional Dynamo updates
    if (!dynamoEnabled) {
      console.log(
        `ROLE_OK_NO_DYNAMO: action=${action} guild=${guild.id} user=${user.id}`
      );
      return;
    }

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
      console.log(
        `ROLE_OK_BUT_NO_AGENT_LINK: guild=${guild.id} user=${user.id} client=${clientRow.client_key}`
      );
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

client.on("messageReactionAdd", async (reaction, user) => {
  await handleReactionChange(reaction, user, "added");
});

client.on("messageReactionRemove", async (reaction, user) => {
  await handleReactionChange(reaction, user, "removed");
});

client.login(DISCORD_BOT_TOKEN).catch((e) => {
  console.error("LOGIN_FAILED:", e?.message || e);
  process.exit(1);
});
