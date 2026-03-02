// gatewayBot.js
// Node 20
// Requires:
//   npm i discord.js @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
//
// ENV REQUIRED:
//   DISCORD_BOT_TOKEN
//   CLIENT_KEY=client1
//   AGENTS_TABLE=Agents
//   AGENTS_DISCORD_GSI=Agents_DiscordUser_GSI
//   ACTIVE_ROLE_ID=1477879654223446233
//   TARGET_MESSAGE_ID=1477890524563116063
//   TARGET_EMOJI=💰
//   STATUS_ON_ADD=Available
//   STATUS_ON_REMOVE=Break
//   AWS_REGION=us-east-1
//
// Also requires AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
// (unless running inside AWS with role attached)

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
console.log("Boot config:", {
  CLIENT_KEY,
  AGENTS_TABLE,
  AGENTS_DISCORD_GSI,
  TARGET_MESSAGE_ID,
  ACTIVE_ROLE_ID
});
// ---------------- ENV ----------------

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_KEY = process.env.CLIENT_KEY;

const AGENTS_TABLE = process.env.AGENTS_TABLE || "Agents";
const AGENTS_DISCORD_GSI =
  process.env.AGENTS_DISCORD_GSI || "Agents_DiscordUser_GSI";

const ACTIVE_ROLE_ID = process.env.ACTIVE_ROLE_ID;
const TARGET_MESSAGE_ID = process.env.TARGET_MESSAGE_ID;
const TARGET_EMOJI = process.env.TARGET_EMOJI || "💰";

const STATUS_ON_ADD = process.env.STATUS_ON_ADD || "Available";
const STATUS_ON_REMOVE = process.env.STATUS_ON_REMOVE || "Break";

const REGION = process.env.AWS_REGION || "us-east-1";

// ---------------- VALIDATION ----------------

if (!DISCORD_BOT_TOKEN) throw new Error("Missing DISCORD_BOT_TOKEN");
if (!CLIENT_KEY) throw new Error("Missing CLIENT_KEY");
if (!ACTIVE_ROLE_ID) throw new Error("Missing ACTIVE_ROLE_ID");
if (!TARGET_MESSAGE_ID) throw new Error("Missing TARGET_MESSAGE_ID");

// ---------------- AWS ----------------

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function nowIso() {
  return new Date().toISOString();
}

// ---------------- AGENT LOOKUP ----------------

async function findAgentByDiscordUserId(discord_user_id) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: AGENTS_TABLE,
      IndexName: AGENTS_DISCORD_GSI,
      KeyConditionExpression:
        "client_key = :ck AND discord_user_id = :du",
      ExpressionAttributeValues: {
        ":ck": CLIENT_KEY,
        ":du": discord_user_id,
      },
      Limit: 1,
    })
  );

  return result?.Items?.[0] || null;
}

async function updateAgentStatus(agent, discord_user_id, newStatus) {
  await ddb.send(
    new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: {
        client_key: CLIENT_KEY,
        agent_id: agent.agent_id,
      },
      ConditionExpression: "discord_user_id = :du",
      UpdateExpression:
        "SET #st = :status, updated_at = :now, last_status_change_at = :now",
      ExpressionAttributeNames: {
        "#st": "status",
      },
      ExpressionAttributeValues: {
        ":status": newStatus,
        ":now": nowIso(),
        ":du": discord_user_id,
      },
    })
  );
}

// ---------------- DISCORD CLIENT ----------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ---------------- REACTION HANDLER ----------------

async function handleReaction(reaction, user, actionType) {
  try {
    if (user.bot) return;

    // Resolve partials (important)
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();

    const message = reaction.message;
    if (!message || message.id !== TARGET_MESSAGE_ID) return;

    const emojiName = reaction.emoji?.name;
    if (emojiName !== TARGET_EMOJI) return;

    const guild = message.guild;
    if (!guild) return;

    const agent = await findAgentByDiscordUserId(user.id);

    if (!agent) {
      console.log(
        `⚠️ User ${user.id} reacted but is not linked to an agent`
      );
      return;
    }

    const member = await guild.members.fetch(user.id);

    if (actionType === "added") {
      await member.roles.add(
        ACTIVE_ROLE_ID,
        "Reacted 💰 to activate"
      );

      await updateAgentStatus(agent, user.id, STATUS_ON_ADD);

      console.log(
        `🟢 ${agent.agent_id} set to ${STATUS_ON_ADD}`
      );
    } else {
      await member.roles.remove(
        ACTIVE_ROLE_ID,
        "Removed 💰 to break"
      );

      await updateAgentStatus(agent, user.id, STATUS_ON_REMOVE);

      console.log(
        `🟡 ${agent.agent_id} set to ${STATUS_ON_REMOVE}`
      );
    }
  } catch (err) {
    console.error("❌ Reaction handler error:", err.message);
  }
}

client.on("messageReactionAdd", (reaction, user) =>
  handleReaction(reaction, user, "added")
);

client.on("messageReactionRemove", (reaction, user) =>
  handleReaction(reaction, user, "removed")
);

// ---------------- START ----------------

client.login(DISCORD_BOT_TOKEN);
