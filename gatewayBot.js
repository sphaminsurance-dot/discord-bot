// gatewayBot.js — Multi-tenant Discord Gateway bot
// React 💰 on the per-client configured message to toggle agent status + role.
//
// Install:
//   npm i discord.js @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
//
// Required ENV:
//   DISCORD_BOT_TOKEN=...
//   ACTIVE_ROLE_ID=1477879654223446233
//   TARGET_EMOJI=💰
//   STATUS_ON_ADD=Available
//   STATUS_ON_REMOVE=Break
//   AWS_REGION=us-east-1
//
// Dynamo ENV (defaults ok if your names match):
//   CLIENTS_TABLE=Clients
//   CLIENTS_GUILD_GSI=Clients_DiscordGuild_GSI   (optional; if missing we Scan fallback)
//   AGENTS_TABLE=Agents
//   AGENTS_DISCORD_GSI=Agents_DiscordUser_GSI
//
// Clients row must include:
//   discord_guild_id = "<guild snowflake>"
//   and one of these message id fields (pick one; bot checks in this order):
//     active_message_id
//     active_marker_message_id
//     moneybag_message_id
//     active_react_message_id
//
// Agents rows must include:
//   discord_user_id = "<user snowflake>"

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

// -------- Crash guards (prevents silent exits) --------
process.on("unhandledRejection", (r) => console.error("UNHANDLED_REJECTION:", r));
process.on("uncaughtException", (e) => console.error("UNCAUGHT_EXCEPTION:", e));

// -------- ENV --------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const ACTIVE_ROLE_ID = process.env.ACTIVE_ROLE_ID;
const TARGET_EMOJI = process.env.TARGET_EMOJI || "💰";
const STATUS_ON_ADD = process.env.STATUS_ON_ADD || "Available";
const STATUS_ON_REMOVE = process.env.STATUS_ON_REMOVE || "Break";

const REGION = process.env.AWS_REGION || "us-east-1";

const CLIENTS_TABLE = process.env.CLIENTS_TABLE || "Clients";
const CLIENTS_GUILD_GSI = process.env.CLIENTS_GUILD_GSI || null; // optional

const AGENTS_TABLE = process.env.AGENTS_TABLE || "Agents";
const AGENTS_DISCORD_GSI = process.env.AGENTS_DISCORD_GSI || "Agents_DiscordUser_GSI";

function requireEnv(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}
requireEnv("DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN);
requireEnv("ACTIVE_ROLE_ID", ACTIVE_ROLE_ID);

// -------- AWS --------
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function nowIso() {
  return new Date().toISOString();
}

// -------- Clients lookup: guild_id -> client row --------

async function resolveClientByGuildId(guild_id) {
  // Preferred: GSI lookup
  if (CLIENTS_GUILD_GSI) {
    try {
      const out = await ddb.send(
        new QueryCommand({
          TableName: CLIENTS_TABLE,
          IndexName: CLIENTS_GUILD_GSI,
          KeyConditionExpression: "discord_guild_id = :g",
          ExpressionAttributeValues: { ":g": guild_id },
          Limit: 1,
        })
      );
      if (out?.Items?.[0]) return out.Items[0];
    } catch (e) {
      console.error("CLIENT_GSI_QUERY_FAILED:", e?.message || e);
      // fall through to scan
    }
  }

  // Fallback: scan (OK for low volume; add GSI for scale)
  // NOTE: This reads the table; fine for reaction events but not for high-QPS endpoints.
  let ExclusiveStartKey;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: CLIENTS_TABLE,
        ProjectionExpression:
          "client_key, discord_guild_id, active_message_id, active_marker_message_id, moneybag_message_id, active_react_message_id",
        FilterExpression: "discord_guild_id = :g",
        ExpressionAttributeValues: { ":g": guild_id },
        ExclusiveStartKey,
      })
    );
    if (out?.Items?.length) return out.Items[0];
    ExclusiveStartKey = out?.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return null;
}

function getClientActiveMessageId(clientRow) {
  return (
    clientRow?.active_message_id ||
    clientRow?.active_marker_message_id ||
    clientRow?.moneybag_message_id ||
    clientRow?.active_react_message_id ||
    null
  );
}

// -------- Agent lookup (per tenant) --------
async function findAgentByDiscordUserId(client_key, discord_user_id) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: AGENTS_TABLE,
      IndexName: AGENTS_DISCORD_GSI,
      KeyConditionExpression: "client_key = :ck AND discord_user_id = :du",
      ExpressionAttributeValues: {
        ":ck": client_key,
        ":du": discord_user_id,
      },
      Limit: 1,
    })
  );
  return out?.Items?.[0] || null;
}

async function updateAgentStatus({ client_key, agent_id, discord_user_id, status }) {
  await ddb.send(
    new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: { client_key, agent_id },
      ConditionExpression: "discord_user_id = :du",
      UpdateExpression: "SET #st = :s, updated_at = :now, last_status_change_at = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":now": nowIso(),
        ":du": discord_user_id,
      },
    })
  );
}

// -------- Discord client --------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers, // needed to add/remove roles reliably
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once("ready", () => {
  console.log("READY:", client.user.tag);
});

async function handleReaction(reaction, user, action) {
  try {
    if (!user || user.bot) return;

    // Resolve partials (common on reaction events)
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (reaction.message?.partial) await reaction.message.fetch().catch(() => null);

    const msg = reaction.message;
    if (!msg?.guild?.id || !msg?.id) return;

    // Emoji check
    if ((reaction.emoji?.name || "") !== TARGET_EMOJI) return;

    // Resolve tenant from guild
    const clientRow = await resolveClientByGuildId(msg.guild.id);
    if (!clientRow?.client_key) {
      console.log(`NO_TENANT_MAPPING: guild=${msg.guild.id}`);
      return;
    }

    const expectedMessageId = getClientActiveMessageId(clientRow);
    if (!expectedMessageId) {
      console.log(`NO_ACTIVE_MESSAGE_ID: client=${clientRow.client_key} guild=${msg.guild.id}`);
      return;
    }

    // Only react-role on the configured message for that client
    if (msg.id !== String(expectedMessageId)) return;

    // Find agent linked to this discord user inside this tenant
    const agent = await findAgentByDiscordUserId(clientRow.client_key, user.id);
    if (!agent?.agent_id) {
      console.log(`NOT_LINKED: client=${clientRow.client_key} user=${user.id}`);
      return;
    }

    // Apply role + update Dynamo status
    const member = await msg.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      console.log(`MEMBER_FETCH_FAIL: guild=${msg.guild.id} user=${user.id}`);
      return;
    }

    if (action === "added") {
      await member.roles.add(ACTIVE_ROLE_ID, "Reacted 💰 to activate").catch((e) => {
        console.error("ROLE_ADD_FAILED:", e?.message || e);
        throw e;
      });

      await updateAgentStatus({
        client_key: clientRow.client_key,
        agent_id: agent.agent_id,
        discord_user_id: user.id,
        status: STATUS_ON_ADD,
      });

      console.log(`OK_ADD: client=${clientRow.client_key} agent=${agent.agent_id} -> ${STATUS_ON_ADD}`);
    } else {
      await member.roles.remove(ACTIVE_ROLE_ID, "Removed 💰 to break").catch((e) => {
        console.error("ROLE_REMOVE_FAILED:", e?.message || e);
        throw e;
      });

      await updateAgentStatus({
        client_key: clientRow.client_key,
        agent_id: agent.agent_id,
        discord_user_id: user.id,
        status: STATUS_ON_REMOVE,
      });

      console.log(`OK_REMOVE: client=${clientRow.client_key} agent=${agent.agent_id} -> ${STATUS_ON_REMOVE}`);
    }
  } catch (err) {
    console.error("REACTION_HANDLER_ERROR:", err?.message || err);
  }
}

client.on("messageReactionAdd", (r, u) => handleReaction(r, u, "added"));
client.on("messageReactionRemove", (r, u) => handleReaction(r, u, "removed"));

client.login(DISCORD_BOT_TOKEN).catch((e) => {
  console.error("LOGIN_FAILED:", e?.message || e);
  process.exit(1);
});
