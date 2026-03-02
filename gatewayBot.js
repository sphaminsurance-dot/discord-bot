// gatewayBot.js — Always-on Discord Gateway listener (Railway)
// Reaction 💰 on a specific message in a specific channel -> add/remove Active role
// Bot also reacts to that same message with 💰 for visibility (once) but NEVER changes its own role
// Dynamo status updates:
//   - If CLIENT_KEY is set: use Agents_DiscordUser_GSI (PK client_key, SK discord_user_id)
//   - If CLIENT_KEY is missing: use Agents_DiscordUser_Global_GSI (PK discord_user_id, SK client_key)
//
// npm i discord.js @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb

const http = require("http");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const DISCORD_BOT_TOKEN = must("DISCORD_BOT_TOKEN");

const ACTIVE_ROLE_ID = must("ACTIVE_ROLE_ID");
const TARGET_MESSAGE_ID = must("TARGET_MESSAGE_ID");
const ACTIVE_MARKER_CHANNEL_ID = must("ACTIVE_MARKER_CHANNEL_ID");
const TARGET_EMOJI = process.env.TARGET_EMOJI || "💰";

// Dynamo
const REGION = process.env.AWS_REGION || "us-east-1";
const CLIENT_KEY = (process.env.CLIENT_KEY || "").trim(); // optional in multi-tenant mode

const AGENTS_TABLE = process.env.AGENTS_TABLE || "Agents";
const AGENTS_DISCORD_GSI = process.env.AGENTS_DISCORD_GSI || "Agents_DiscordUser_GSI"; // PK client_key, SK discord_user_id
const AGENTS_DISCORD_GLOBAL_GSI =
  process.env.AGENTS_DISCORD_GLOBAL_GSI || "Agents_DiscordUser_Global_GSI"; // PK discord_user_id, SK client_key (recommended)

const STATUS_ON_ADD = process.env.STATUS_ON_ADD || "Available";
const STATUS_ON_REMOVE = process.env.STATUS_ON_REMOVE || "Break";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function nowIso() {
  return new Date().toISOString();
}

async function findAgentByDiscordUserId_SingleTenant({ client_key, discord_user_id }) {
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

async function findAgentByDiscordUserId_Global({ discord_user_id }) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: AGENTS_TABLE,
      IndexName: AGENTS_DISCORD_GLOBAL_GSI,
      KeyConditionExpression: "discord_user_id = :du",
      ExpressionAttributeValues: { ":du": discord_user_id },
      Limit: 2,
    })
  );

  const items = out?.Items || [];
  if (items.length === 0) return null;

  if (items.length > 1) {
    console.log(
      `DDB_AMBIGUOUS_USER: discord_user_id=${discord_user_id} matches ${items.length} agents (multi-tenant collision)`
    );
    return null;
  }

  return items[0];
}

async function updateAgentStatus({ client_key, agent_id, status, discord_user_id }) {
  await ddb.send(
    new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: { client_key, agent_id },
      ConditionExpression: "discord_user_id = :du",
      UpdateExpression: "SET #st = :s, last_status_change_at = :now, updated_at = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":now": nowIso(),
        ":du": discord_user_id,
      },
    })
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once("clientReady", async () => {
  console.log(`READY: ${client.user.tag}`);
  console.log(
    `CONFIG: role=${ACTIVE_ROLE_ID} channel=${ACTIVE_MARKER_CHANNEL_ID} message=${TARGET_MESSAGE_ID} emoji=${TARGET_EMOJI}`
  );

  console.log(
    `DYNAMO: region=${REGION} client_key=${CLIENT_KEY || "(missing)"} table=${AGENTS_TABLE} gsi=${AGENTS_DISCORD_GSI} global_gsi=${AGENTS_DISCORD_GLOBAL_GSI} status_add=${STATUS_ON_ADD} status_remove=${STATUS_ON_REMOVE}`
  );

  // React to marker message for visibility
  try {
    const channel = await client.channels.fetch(String(ACTIVE_MARKER_CHANNEL_ID));
    if (!channel || !channel.isTextBased()) {
      console.log("MARKER_REACT_SKIPPED: channel_not_text_based");
      return;
    }
    const msg = await channel.messages.fetch(String(TARGET_MESSAGE_ID));
    if (!msg) {
      console.log("MARKER_REACT_SKIPPED: message_not_found");
      return;
    }
    await msg.react(TARGET_EMOJI);
    console.log("MARKER_REACT_OK");
  } catch (err) {
    console.log("MARKER_REACT_FAIL:", err?.message || err);
  }
});

async function shouldHandle(reaction) {
  if (reaction.partial) await reaction.fetch();
  if (reaction.message?.partial) await reaction.message.fetch();

  const msg = reaction.message;
  if (!msg?.id || !msg?.channelId) return false;

  if (String(msg.id) !== String(TARGET_MESSAGE_ID)) return false;
  if (String(msg.channelId) !== String(ACTIVE_MARKER_CHANNEL_ID)) return false;

  const emojiName = reaction.emoji?.name || "";
  if (emojiName !== TARGET_EMOJI) return false;

  return true;
}

async function applyRoleChange({ guild, userId, add }) {
  const member = await guild.members.fetch(userId);
  if (add) {
    await member.roles.add(ACTIVE_ROLE_ID, "Reacted to active marker");
  } else {
    await member.roles.remove(ACTIVE_ROLE_ID, "Removed reaction from active marker");
  }
}

async function reportStatusToDynamo({ userId, add }) {
  const status = add ? STATUS_ON_ADD : STATUS_ON_REMOVE;

  try {
    if (CLIENT_KEY) {
      const agent = await findAgentByDiscordUserId_SingleTenant({
        client_key: CLIENT_KEY,
        discord_user_id: userId,
      });

      if (!agent) {
        console.log(`DDB_NO_AGENT_LINK: user=${userId} client_key=${CLIENT_KEY}`);
        return;
      }

      await updateAgentStatus({
        client_key: CLIENT_KEY,
        agent_id: agent.agent_id,
        status,
        discord_user_id: userId,
      });

      console.log(`DDB_OK: user=${userId} agent=${agent.agent_id} client=${CLIENT_KEY} -> ${status}`);
      return;
    }

    // Multi-tenant mode
    const agent = await findAgentByDiscordUserId_Global({ discord_user_id: userId });
    if (!agent) {
      console.log(`DDB_NO_AGENT_LINK_OR_AMBIGUOUS: user=${userId}`);
      return;
    }

    const resolvedClientKey = String(agent.client_key || "");
    const resolvedAgentId = String(agent.agent_id || "");
    if (!resolvedClientKey || !resolvedAgentId) {
      console.log(`DDB_BAD_AGENT_ROW: user=${userId} missing client_key/agent_id`);
      return;
    }

    await updateAgentStatus({
      client_key: resolvedClientKey,
      agent_id: resolvedAgentId,
      status,
      discord_user_id: userId,
    });

    console.log(
      `DDB_OK: user=${userId} agent=${resolvedAgentId} client=${resolvedClientKey} -> ${status}`
    );
  } catch (err) {
    console.log(`DDB_FAIL: user=${userId} msg=${err?.message || err}`);
  }
}

async function handleReaction(reaction, user, add) {
  try {
    if (user.bot) return;

    const ok = await shouldHandle(reaction);
    if (!ok) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    await applyRoleChange({ guild, userId: user.id, add });
    console.log(`ROLE_OK: guild=${guild.id} user=${user.id} add=${add}`);

    await reportStatusToDynamo({ userId: user.id, add });
  } catch (err) {
    console.error("REACTION_ERROR:", err?.message || err);
  }
}

client.on("messageReactionAdd", (reaction, user) => handleReaction(reaction, user, true));
client.on("messageReactionRemove", (reaction, user) => handleReaction(reaction, user, false));

client.login(DISCORD_BOT_TOKEN);

// ---- Keep-alive HTTP server for Railway/Web services expecting a PORT ----
const PORT = Number(process.env.PORT || 3000);
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("MAS Leads gateway bot running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP_OK: listening on ${PORT}`);
  });
