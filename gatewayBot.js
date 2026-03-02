// gatewayBot.js — Always-on Discord Gateway listener (Railway)
// Reaction 💰 on a specific message in a specific channel -> add/remove Active role
// Bot also reacts to that same message with 💰 for visibility (once) but NEVER changes its own role
// Dynamo status updates are attempted on every matching reaction (logs if misconfigured)
//
// npm i discord.js @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
//
// Required ENV:
//   DISCORD_BOT_TOKEN=...
//   ACTIVE_ROLE_ID=1477879654223446233
//   TARGET_MESSAGE_ID=1477890524563116063
//   ACTIVE_MARKER_CHANNEL_ID=1477879654848135265
//   TARGET_EMOJI=💰
//
// Required-for-Dynamo (given your GSI shape):
//   CLIENT_KEY=client1
//   AGENTS_TABLE=Agents
//   AGENTS_DISCORD_GSI=Agents_DiscordUser_GSI
//   AWS_REGION=us-east-1
//   STATUS_ON_ADD=Available
//   STATUS_ON_REMOVE=Break

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

// Dynamo (we will ALWAYS attempt to update; if env missing we will log loudly)
const REGION = process.env.AWS_REGION || "us-east-1";
const CLIENT_KEY = process.env.CLIENT_KEY || ""; // required for your current GSI shape
const AGENTS_TABLE = process.env.AGENTS_TABLE || "Agents";
const AGENTS_DISCORD_GSI = process.env.AGENTS_DISCORD_GSI || "Agents_DiscordUser_GSI";
const STATUS_ON_ADD = process.env.STATUS_ON_ADD || "Available";
const STATUS_ON_REMOVE = process.env.STATUS_ON_REMOVE || "Break";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function nowIso() {
  return new Date().toISOString();
}

// Your current Agents_DiscordUser_GSI is PK=client_key, SK=discord_user_id
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
    `DYNAMO: region=${REGION} client_key=${CLIENT_KEY || "(missing)"} table=${AGENTS_TABLE}(${AGENTS_DISCORD_GSI}) status_add=${STATUS_ON_ADD} status_remove=${STATUS_ON_REMOVE}`
  );

  // Add bot's own reaction to make the marker easy to see (one-time / idempotent)
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

    // react() is effectively idempotent; Discord won’t duplicate the same emoji reaction for the same user
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
  if (!CLIENT_KEY) {
    console.log(`DDB_DISABLED_OR_MISCONFIGURED: Missing CLIENT_KEY (cannot resolve tenant) user=${userId}`);
    return;
  }

  try {
    const agent = await findAgentByDiscordUserId({
      client_key: CLIENT_KEY,
      discord_user_id: userId,
    });

    if (!agent) {
      console.log(`DDB_NO_AGENT_LINK: user=${userId} client_key=${CLIENT_KEY}`);
      return;
    }

    const status = add ? STATUS_ON_ADD : STATUS_ON_REMOVE;

    await updateAgentStatus({
      client_key: CLIENT_KEY,
      agent_id: agent.agent_id,
      status,
      discord_user_id: userId,
    });

    console.log(`DDB_OK: user=${userId} agent=${agent.agent_id} -> ${status}`);
  } catch (err) {
    console.log(`DDB_FAIL: user=${userId} msg=${err?.message || err}`);
  }
}

async function handleReaction(reaction, user, add) {
  try {
    // never process bots (including ourselves) for role changes OR Dynamo updates
    if (user.bot) return;

    const ok = await shouldHandle(reaction);
    if (!ok) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    // Role change first (what the agents see)
    await applyRoleChange({ guild, userId: user.id, add });
    console.log(`ROLE_OK: guild=${guild.id} user=${user.id} add=${add}`);

    // Then Dynamo reporting (what your router / dashboard sees)
    await reportStatusToDynamo({ userId: user.id, add });
  } catch (err) {
    console.error("REACTION_ERROR:", err?.message || err);
  }
}

client.on("messageReactionAdd", (reaction, user) => handleReaction(reaction, user, true));
client.on("messageReactionRemove", (reaction, user) => handleReaction(reaction, user, false));

client.login(DISCORD_BOT_TOKEN);
