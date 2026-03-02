// gatewayBot.js — Node 20+
// Multi-tenant Discord Gateway listener:
// reaction (💰) -> add/remove Active role + update Dynamo Agent status
//
// Requires:
//   npm i discord.js @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
//
// ENV (Railway):
//   DISCORD_BOT_TOKEN=...
//   AWS_REGION=us-east-1
//
//   CLIENTS_TABLE=Clients
//   CLIENTS_GUILD_GSI=Clients_DiscordGuild_GSI          // PK: discord_guild_id, SK: client_key
//
//   AGENTS_TABLE=Agents
//   AGENTS_DISCORD_GSI=Agents_DiscordUser_GSI           // PK: client_key, SK: discord_user_id
//
//   ACTIVE_ROLE_ID=...
//   TARGET_EMOJI=💰
//
//   STATUS_ON_ADD=Available
//   STATUS_ON_REMOVE=Break
//
// OPTIONAL:
//   CLIENT_ACTIVE_MARKER_MESSAGE_ATTR=active_marker_message_id  // attribute in Clients row
//   CACHE_TTL_MS=300000                                         // 5m default
//   DEBUG=true

"use strict";

const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

// -------------------- ENV --------------------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const REGION = process.env.AWS_REGION || "us-east-1";
const DEBUG = String(process.env.DEBUG || "").toLowerCase() === "true";

const DISCORD_BOT_TOKEN = mustEnv("DISCORD_BOT_TOKEN");

const CLIENTS_TABLE = mustEnv("CLIENTS_TABLE");
const CLIENTS_GUILD_GSI = mustEnv("CLIENTS_GUILD_GSI");

const AGENTS_TABLE = process.env.AGENTS_TABLE || "Agents";
const AGENTS_DISCORD_GSI = process.env.AGENTS_DISCORD_GSI || "Agents_DiscordUser_GSI";

const ACTIVE_ROLE_ID = mustEnv("ACTIVE_ROLE_ID");
const TARGET_EMOJI = process.env.TARGET_EMOJI || "💰";

const STATUS_ON_ADD = process.env.STATUS_ON_ADD || "Available";
const STATUS_ON_REMOVE = process.env.STATUS_ON_REMOVE || "Break";

const CLIENT_ACTIVE_MARKER_MESSAGE_ATTR =
  process.env.CLIENT_ACTIVE_MARKER_MESSAGE_ATTR || "active_marker_message_id";

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || "300000"); // 5 minutes default

// -------------------- AWS Dynamo --------------------
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function nowIso() {
  return new Date().toISOString();
}

// -------------------- Caching --------------------
// Cache guild_id -> client row to reduce Dynamo queries
const guildCache = new Map(); // guildId -> { expiresAt, client }

function cacheGetGuild(guildId) {
  const hit = guildCache.get(guildId);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    guildCache.delete(guildId);
    return null;
  }
  return hit.client;
}

function cacheSetGuild(guildId, client) {
  guildCache.set(guildId, { expiresAt: Date.now() + CACHE_TTL_MS, client });
}

// -------------------- Dynamo access --------------------
async function getClientByGuildId(guildId) {
  const cached = cacheGetGuild(guildId);
  if (cached) return cached;

  const out = await ddb.send(
    new QueryCommand({
      TableName: CLIENTS_TABLE,
      IndexName: CLIENTS_GUILD_GSI,
      KeyConditionExpression: "discord_guild_id = :g",
      ExpressionAttributeValues: { ":g": String(guildId) },
      Limit: 2,
    })
  );

  const items = out?.Items || [];
  if (items.length === 0) return null;
  if (items.length > 1) {
    // This should never happen if guild_id is unique per client
    throw new Error(`Multiple clients match guild_id=${guildId}`);
  }

  const client = items[0];
  cacheSetGuild(guildId, client);
  return client;
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
      Limit: 2,
    })
  );

  const items = out?.Items || [];
  if (items.length === 0) return null;
  if (items.length > 1) {
    // Should never happen; means same discord_user_id linked to multiple agents in same client
    throw new Error(`Multiple agents linked for client_key=${client_key} discord_user_id=${discord_user_id}`);
  }
  return items[0];
}

async function updateAgentStatus({ client_key, agent_id, status, discord_user_id }) {
  await ddb.send(
    new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: { client_key: String(client_key), agent_id: String(agent_id) },
      ConditionExpression: "discord_user_id = :du",
      UpdateExpression:
        "SET #st = :s, last_status_change_at = :now, updated_at = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":s": String(status),
        ":now": nowIso(),
        ":du": String(discord_user_id),
      },
    })
  );
}

// -------------------- Discord client --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,           // required to add/remove roles
    GatewayIntentBits.GuildMessages,          // message context
    GatewayIntentBits.GuildMessageReactions,  // reaction events
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User,
    Partials.GuildMember,
  ],
});

client.once(Events.ClientReady, () => {
  console.log(`READY: ${client.user.tag}`);
});

// -------------------- Helpers --------------------
function emojiMatches(reaction) {
  // For unicode emoji: reaction.emoji.name === "💰"
  // For custom emoji: you'll need to match on emoji.id instead (not implemented here)
  const name = reaction?.emoji?.name || "";
  return name === TARGET_EMOJI;
}

async function ensureFetched(reaction) {
  if (reaction.partial) await reaction.fetch();
  if (reaction.message?.partial) await reaction.message.fetch();
}

async function handleReaction(reaction, user, action) {
  try {
    if (!reaction || !user) return;
    if (user.bot) return;

    await ensureFetched(reaction);

    if (!emojiMatches(reaction)) return;

    const msg = reaction.message;
    const guild = msg?.guild;
    if (!guild) return;

    const guildId = String(guild.id);

    // Resolve client by guild id
    const clientRow = await getClientByGuildId(guildId);
    if (!clientRow) {
      console.log(`NO_TENANT_MAPPING: guild=${guildId}`);
      return;
    }

    const client_key = String(clientRow.client_key || "");
    if (!client_key) {
      console.log(`NO_CLIENT_KEY_IN_CLIENT_ROW: guild=${guildId}`);
      return;
    }

    // Optional guard: only react to the configured marker message per client
    const markerMessageId = String(clientRow[CLIENT_ACTIVE_MARKER_MESSAGE_ATTR] || "");
    if (!markerMessageId) {
      console.log(`NO_ACTIVE_MARKER: client_key=${client_key} guild=${guildId}`);
      return;
    }
    if (String(msg.id) !== markerMessageId) return;

    // Find linked agent
    const agent = await findAgentByDiscordUserId({
      client_key,
      discord_user_id: String(user.id),
    });

    if (!agent) {
      console.log(`IGNORED_NOT_LINKED: client_key=${client_key} user=${user.id}`);
      return;
    }

    // Fetch member
    const member = await guild.members.fetch(String(user.id));

    if (action === "added") {
      await member.roles.add(ACTIVE_ROLE_ID, `Reacted ${TARGET_EMOJI} to activate`);
      await updateAgentStatus({
        client_key,
        agent_id: String(agent.agent_id),
        status: STATUS_ON_ADD,
        discord_user_id: String(user.id),
      });
      console.log(`OK_ADD: client=${client_key} user=${user.id} agent=${agent.agent_id} -> ${STATUS_ON_ADD}`);
    } else {
      await member.roles.remove(ACTIVE_ROLE_ID, `Removed ${TARGET_EMOJI} to break`);
      await updateAgentStatus({
        client_key,
        agent_id: String(agent.agent_id),
        status: STATUS_ON_REMOVE,
        discord_user_id: String(user.id),
      });
      console.log(`OK_REMOVE: client=${client_key} user=${user.id} agent=${agent.agent_id} -> ${STATUS_ON_REMOVE}`);
    }
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("REACTION_ERROR:", msg);
    if (DEBUG && err?.stack) console.error(err.stack);
  }
}

// Reaction add/remove
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  await handleReaction(reaction, user, "added");
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  await handleReaction(reaction, user, "removed");
});

// Start
client.login(DISCORD_BOT_TOKEN).catch((e) => {
  console.error("LOGIN_FAILED:", e?.message || e);
  process.exit(1);
});
