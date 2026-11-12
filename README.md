# Discord All-in-One Bot

One Discord bot containing **Ticket Management**, **Restock Announcements**, **Member Verification**, and **Music**.

## Requirements

- Node.js 22.12 or newer.
- A Discord bot application and token.
- A persistent storage directory in Railway (recommended mount path: `/data`).

## Install and run

```bash
npm install
cp .env.example .env
# Edit .env and set DISCORD_TOKEN
npm start
```

For Railway, set:

- `DISCORD_TOKEN` = your bot token (Railway variable; never commit it)
- `DATA_DIR` = `/data`

Attach a Railway Volume mounted at `/data` so ticket settings, restock settings, verification settings and counters survive redeploys.

## Discord Developer Portal intents

Enable these privileged intents under **Bot → Privileged Gateway Intents**:

- **Server Members Intent** — required for the automatic member-join verification prompt.
- **Message Content Intent** — required for `@Bot play`, `@Bot stop`, and the other mention-based music controls.

The bot also uses the standard Guilds, Guild Messages and Guild Voice States intents.

## Invite permissions

Invite the bot with `bot` and `applications.commands` scopes. Grant the permissions needed for:

- **Tickets:** Manage Channels, View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Manage Roles only if you want role-based staff workflows.
- **Verification:** Manage Roles; move the bot role above both Member and optional Unverified roles.
- **Music:** Connect and Speak in voice channels.
- **Restock:** View Channel, Send Messages and Embed Links in the selected announcement channel.

Also ensure the bot can view the ticket folder categories and transcript channel. Set the staff role above ticket owners as needed.

## Ticket commands

- `/ticket setup channel:#channel` — post the ticket panel.
- `/ticket settings` — configure default and per-ticket-type folders and opening questions.
- `/ticket transcript-channel channel:#channel` — choose transcript destination.
- `/ticket staff-role role:@role` — choose staff role.
- `/ticket closed-category category:#category` — choose where closed tickets are moved.
- `/ticket category-add name:... emoji:... description:...` — add a ticket type.
- `/ticket category-remove name:...` — remove a ticket type.
- `/ticket add user:@member` — add a member to the current ticket.
- `/ticket remove user:@member` — remove a member from the current ticket.

Members open tickets from the select-menu panel. They answer the type-specific modal question first. Closing a ticket asks for a reason, generates an HTML transcript, sends it to the transcript channel and ticket owner by DM, locks and moves the channel, then shows **Reopen Ticket** and **Delete** buttons. Staff can use those buttons on closed tickets.

## Restock commands

- `/restock setup channel:#channel` — choose the restock announcement channel.
- `/restock setting` — open the private customization panel (text, labels, HEX color, server icon, timestamp, preview and reset).
- `/restock post product:... price:... stock:... message:... image:...` — manually publish a restock alert.

Restock embed placeholders: `{product}`, `{price}`, `{stock}`, `{message}`, `{server}`.

## Verification

- `/verify setup channel:#verify member-role:@Member unverified-role:@Unverified`

The Unverified role is optional. New non-bot members receive a verification prompt in the configured channel. Clicking **Verify** assigns the Member role and removes the optional Unverified role. Configure channel permissions so new members can view the verification channel but cannot access the rest of the server until they have the Member role.

The bot needs Manage Roles, and its highest role must be above the Member and Unverified roles.

## Music commands

Slash commands:

- `/play query:...` — join the voice channel you are in and play/search a song.
- `/add query:...` — add a song to the queue.
- `/pause`, `/resume`, `/skip`, `/stop`, `/leave` — playback controls.

Mention-based controls:

- `@Bot play <song or YouTube URL>`
- `@Bot add <song or YouTube URL>`
- `@Bot pause`, `@Bot resume`, `@Bot skip`, `@Bot stop`, `@Bot leave`

For control commands, be in the same voice channel as the bot. It checks Connect and Speak permissions before starting playback. Music uses the published DisTube v5.2.x API, with YouTube search/link playback. `ffmpeg-static` is added to PATH for hosts that do not provide FFmpeg.

## Notes

- Ticket, restock, verification, and counters are stored in the same per-guild `data.json`.
- Do not commit `.env`, bot tokens, `node_modules`, or `data.json`.
- If a token has ever been posted publicly or in chat, reset it in the Discord Developer Portal and update the Railway variable.
- Railway deploy command: `npm start`.
