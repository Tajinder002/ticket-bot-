# Discord Ticket Bot

## Setup
1. https://discord.com/developers/applications -> New Application -> Bot -> copy token.
2. In the Bot tab turn ON **Message Content Intent** (needed for transcripts).
3. Invite the bot with scopes `bot` + `applications.commands` and permissions:
   Manage Channels, View Channels, Send Messages, Read Message History, Attach Files, Embed Links.
4. Copy `.env.example` to `.env` and paste your token.
5. `npm install` then `npm start`

## Commands (admins need Manage Server)
- `/ticket setup channel:#tickets`  -> sends the panel with the category menu
- `/ticket transcript-channel channel:#logs`  -> where transcripts go on close
- `/ticket staff-role role:@Staff`  -> who can see/close all tickets
- `/ticket parent category:<discord category>`  -> where ticket channels are created (optional)
- `/ticket category-add name:Billing emoji:💳 description:...`
- `/ticket category-remove name:Billing`
- `/ticket category-list`
- `/ticket close reason:...` or press the Close button in the ticket
- `/ticket add user:@x` / `/ticket remove user:@x`

After adding/removing categories, run `/ticket setup` again to send a fresh panel.
On close: HTML transcript is sent to the transcript channel AND to the DM of the person who opened it, then the channel is deleted.
