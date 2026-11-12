# Discord Ticket Bot

Standalone ticket bot. Restock announcements are no longer included in this bot.

## Features

- `/ticket setup` posts the ticket panel.
- `/ticket settings` configures each ticket type's destination folder and opening question.
- Default types: Buy, Replacement, Support, Other.
- Private ticket channels and one open ticket per member.
- Staff role and transcript channel configuration.
- Close Ticket button with a reason modal.
- HTML transcripts sent to the transcript channel and ticket owner DM (DM delivery depends on the user's privacy settings).
- Closed tickets are moved to the configured closed folder and have Reopen Ticket and Delete buttons.
- `/ticket category-add`, `/ticket category-remove`, `/ticket add`, and `/ticket remove`.

## Requirements

- Node.js 18 or newer.
- Discord bot token.
- Bot invite scopes: `bot` and `applications.commands`.
- Required permissions: Manage Channels, View Channels, Send Messages, Embed Links, Attach Files, Read Message History.
- Enable **Message Content Intent** in the Discord Developer Portal so transcripts can include ordinary message text.
- Place the bot role above the staff role.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `DISCORD_TOKEN` to this Ticket Bot's token.
3. Run `npm install`.
4. Run `npm start`.

## Railway

Deploy this folder as its own Railway service. Set `DISCORD_TOKEN` to the Ticket Bot token. Attach a persistent Volume mounted at `/data` and set `DATA_DIR=/data`. Do not share the same data file with the Restock Bot.

The bot registers only `/ticket` commands in each guild when it starts.
