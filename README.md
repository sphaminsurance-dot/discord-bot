# MAS Discord Gateway Bot

  Always-on Discord.js process hosted on Railway. Handles:
  - **Member join**: assigns the agent role and notifies the MAS Dashboard API to grant category channel access
  - **Reaction-based status**: watches per-client active-marker messages for 💰 reactions and updates agent status in DynamoDB via the MAS Dashboard API
  - **Lead buttons**: interactive button interactions update lead records directly in DynamoDB

  ## Required Environment Variables (set in Railway)

  | Variable | Description |
  |---|---|
  | `DISCORD_BOT_TOKEN` | Discord bot token (from Discord Developer Portal) |
  | `MAS_API_URL` | Public URL of the MAS Dashboard Replit app (e.g. `https://your-app.replit.app`) |
  | `BOT_API_TOKEN` | Internal MAS API bearer token — **not** the Discord bot token |

  ## Optional Environment Variables

  | Variable | Default | Description |
  |---|---|---|
  | `GUILD_ID` | `1477879653795496091` | Discord server (guild) ID |
  | `ROLE_ID` | `1477879654210605187` | Role assigned to new members on join |
  | `AWS_REGION` | `us-east-1` | AWS region for DynamoDB |
  | `LEADS_TABLE` | `Leads` | DynamoDB table name for leads |
  | `HEALTH_PORT` | `8080` | Port for Railway health-check HTTP listener |

  > **Note:** The legacy `DASHBOARD_API_URL` env var is supported as a fallback for `MAS_API_URL`.
  > Legacy single-marker env vars (`ACTIVE_MARKER_CHANNEL_ID`, `TARGET_MESSAGE_ID`, `ACTIVE_ROLE_ID`)
  > are no longer used — active markers are now fetched dynamically from the MAS API.

  ## Discord Developer Portal — Privileged Gateway Intents

  The following privileged intents **must** be enabled in the bot's application settings
  at [discord.com/developers/applications](https://discord.com/developers/applications):

  - **Server Members Intent** (required for `guildMemberAdd`)
  - **Message Content Intent** (required for reaction context)

  Guild Message Reactions is a standard (non-privileged) intent.

  ## How it works

  ### Member Join Flow
  1. New member joins the Discord server
  2. Bot assigns `ROLE_ID` to the member (Discord.js `member.roles.add()`, equivalent to `PUT /guilds/{guild_id}/members/{user_id}/roles/{role_id}`)
  3. Bot calls `POST {MAS_API_URL}/api/bot/member-join` with `{ discord_user_id }` — MAS grants category channel access if the user is a registered agent

  ### Active-Marker Reaction Flow
  1. On startup, bot fetches `GET {MAS_API_URL}/api/bot/active-markers` to get per-client marker channel/message IDs
  2. Cache refreshes every 5 minutes
  3. When a user adds/removes 💰 on a marker message:
     - Add → `POST /api/bot/agent-status` with `{ discord_user_id, status: "Available" }`
     - Remove → `POST /api/bot/agent-status` with `{ discord_user_id, status: "Offline" }`
     - No Discord role changes occur (status-only)

  ### Lead Button Flow
  Button interactions with custom ID format `ml:<client_key>:<router_lead_id>:<action>` update DynamoDB leads directly.
  