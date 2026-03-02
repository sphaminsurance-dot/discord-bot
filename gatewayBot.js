// gatewayBot.js — Node 20 (Railway)
// Always-on Discord Gateway listener for reaction → role + Dynamo status updates
//
// Install:
//   npm i discord.js @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
//
// Env:
//   DISCORD_BOT_TOKEN=...
//   CLIENT_KEY=client1
//   AGENTS_TABLE=Agents
//   AGENTS_DISCORD_GSI=Agents_DiscordUser_GSI
//
//   ACTIVE_ROLE_ID=1477879654223446233
//   TARGET_MESSAGE_ID=1477890524563116063
//   TARGET_EMOJI=💰
//
//   STATUS_ON_ADD=Available
//   STATUS_ON_REMOVE=Break
//
//   AWS_REGION=us-east-1 (optional)

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION || "us-east-1";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_KEY = process.env.CLIENT_KEY;

const AGENTS_TABLE = process.env.AGENTS_TABLE || "Agents";
const AGENTS_DISCORD_GSI = process.env.AGENTS_DISCORD_GSI || "Agents_DiscordUser_GSI";

const ACTIVE_ROLE_ID = process.env.ACTIVE_ROLE_ID;
const TARGET_MESSAGE_ID = process.env.TARGET_MESSAGE_ID;
const TARGET_EMOJI = process.env.TARGET_EMOJI || "💰";

const STATUS_ON_ADD = process.env.STATUS_ON_ADD || "Available";
const STATUS_ON_REMOVE = process.env.STATUS_ON_REMOVE || "Break";

function must(name, val) {
  if (!val) throw new Error(`Missing ${name}`);
  return val;
}

must("DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN);
must("CLIENT_KEY", CLIENT_KEY);
must("ACTIVE_ROLE_ID", ACTIVE_ROLE_ID);
must("TARGET_MESSAGE_ID", TARGET_MESSAGE_ID);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function nowIso() {
  return new Date().toISOString();
}

async function findAgentByDiscordUserId({ client_key, discord_user_id }) {
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
    GatewayIntentBits.GuildMembers, // needed for role ops + member fetch
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

function log(obj) {
  console.log(JSON.stringify({ ts: nowIso(), ...obj }));
}

// discord.js v15 renamed "ready" -> "clientReady"
// support both without breaking either version.
client.once("ready", () => log({ level: "info", msg: "READY", tag: client.user?.tag || null }));
client.once("clientReady", () => log({ level: "info", msg: "CLIENT_READY", tag: client.user?.tag || null }));

async function handleMoneybagReaction(reaction, user, action) {
  try {
    if (!reaction) return;
    if (!user || user.bot) return;

    // Resolve partials
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();

    const msg = reaction.message;
    if (!msg?.id) return;

    // Only the one “active marker” message
    if (String(msg.id) !== String(TARGET_MESSAGE_ID)) return;

    // Emoji match
    const emojiName = reaction.emoji?.name || "";
    if (String(emojiName) !== String(TARGET_EMOJI)) return;

    const guild = msg.guild;
    if (!guild) return;

    log({
      level: "info",
      msg: "REACTION_MATCH",
      action,
      guild: guild.id,
      channel: msg.channel?.id || null,
      message: msg.id,
      user: user.id,
      emoji: emojiName,
    });

    // Find linked agent
    const agent = await findAgentByDiscordUserId({
      client_key: CLIENT_KEY,
      discord_user_id: user.id,
    });

    if (!agent) {
      log({ level: "warn", msg: "NO_AGENT_LINK", user: user.id, client_key: CLIENT_KEY });
      return;
    }

    // Fetch member (requires GuildMembers intent)
    const member = await guild.members.fetch(user.id);

    if (action === "added") {
      await member.roles.add(String(ACTIVE_ROLE_ID), "Reacted 💰 to activate");
      await updateAgentStatus({
        client_key: CLIENT_KEY,
        agent_id: agent.agent_id,
        status: STATUS_ON_ADD,
        discord_user_id: user.id,
      });
      log({ level: "info", msg: "ROLE_ADDED_STATUS_SET", user: user.id, agent_id: agent.agent_id, status: STATUS_ON_ADD });
    } else {
      await member.roles.remove(String(ACTIVE_ROLE_ID), "Removed 💰 to break");
      await updateAgentStatus({
        client_key: CLIENT_KEY,
        agent_id: agent.agent_id,
        status: STATUS_ON_REMOVE,
        discord_user_id: user.id,
      });
      log({ level: "info", msg: "ROLE_REMOVED_STATUS_SET", user: user.id, agent_id: agent.agent_id, status: STATUS_ON_REMOVE });
    }
  } catch (err) {
    log({ level: "error", msg: "REACTION_ERROR", error: err?.message || String(err) });
  }
}

client.on("messageReactionAdd", (reaction, user) => handleMoneybagReaction(reaction, user, "added"));
client.on("messageReactionRemove", (reaction, user) => handleMoneybagReaction(reaction, user, "removed"));

client.login(DISCORD_BOT_TOKEN);
