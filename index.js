require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder,
  AttachmentBuilder, MessageFlags,
} = require('discord.js');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

/* ---------- simple JSON storage ---------- */
let db = {};
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { db = {}; }
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const cfg = (guildId) => {
  if (!db[guildId]) {
    db[guildId] = {
      transcriptChannelId: null, staffRoleId: null, parentId: null, counter: 0,
      categories: [
        { id: 'buy', label: 'Buy', emoji: '🛒', description: 'Purchase questions' },
        { id: 'replacement', label: 'Replacement', emoji: '🔁', description: 'Request a replacement' },
        { id: 'support', label: 'Support', emoji: '🛠️', description: 'General support' },
        { id: 'other', label: 'Other', emoji: '❓', description: 'Anything else' },
      ],
      tickets: {},
    };
    save();
  }
  return db[guildId];
};

/* ---------- slash commands ---------- */
const commands = [
  new SlashCommandBuilder().setName('ticket').setDescription('Ticket system')
    .addSubcommand(s => s.setName('setup').setDescription('Send the ticket panel')
      .addChannelOption(o => o.setName('channel').setDescription('Where to send the panel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('transcript-channel').setDescription('Channel where transcripts go')
      .addChannelOption(o => o.setName('channel').setDescription('Transcript channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('staff-role').setDescription('Role that can see all tickets')
      .addRoleOption(o => o.setName('role').setDescription('Staff role').setRequired(true)))
    .addSubcommand(s => s.setName('parent').setDescription('Discord category where tickets are created')
      .addChannelOption(o => o.setName('category').setDescription('Discord category').addChannelTypes(ChannelType.GuildCategory).setRequired(true)))
    .addSubcommand(s => s.setName('category-add').setDescription('Add a ticket category')
      .addStringOption(o => o.setName('name').setDescription('Name, e.g. Billing').setRequired(true))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji'))
      .addStringOption(o => o.setName('description').setDescription('Short description')))
    .addSubcommand(s => s.setName('category-remove').setDescription('Remove a ticket category')
      .addStringOption(o => o.setName('name').setDescription('Category name').setRequired(true)))
    .addSubcommand(s => s.setName('category-list').setDescription('List ticket categories'))
    .addSubcommand(s => s.setName('close').setDescription('Close this ticket')
      .addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('add').setDescription('Add a user to this ticket')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a user from this ticket')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))),
].map(c => c.toJSON());

async function registerCommands(guild) {
  try { await guild.commands.set(commands); } catch (e) { console.error('Command register failed', guild.id, e.message); }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) await registerCommands(guild);
});
client.on('guildCreate', registerCommands);

/* ---------- helpers ---------- */
const isAdmin = (i) => i.memberPermissions.has(PermissionFlagsBits.ManageGuild);
const isStaff = (i, c) =>
  i.memberPermissions.has(PermissionFlagsBits.ManageChannels) ||
  (c.staffRoleId && i.member.roles.cache.has(c.staffRoleId));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'user';
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const reply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

function panelMessage(guild) {
  const c = cfg(guild.id);
  const embed = new EmbedBuilder()
    .setTitle('🎫 Support Tickets')
    .setDescription('Pick a category from the menu below to open a ticket.')
    .setColor(0x5865f2);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_open')
    .setPlaceholder('Select a category...')
    .addOptions(c.categories.slice(0, 25).map(cat => {
      const o = { label: cat.label, value: cat.id };
      if (cat.description) o.description = cat.description.slice(0, 100);
      if (cat.emoji) o.emoji = cat.emoji;
      return o;
    }));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

/* ---------- transcript ---------- */
async function buildTranscript(channel) {
  let all = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.reverse();
  const rows = all.map(m => {
    const time = m.createdAt.toISOString().replace('T', ' ').slice(0, 19);
    let body = esc(m.content);
    for (const e of m.embeds) body += `<div class="embed">${esc(e.title || '')} ${esc(e.description || '')}</div>`;
    for (const a of m.attachments.values()) body += `<div><a href="${esc(a.url)}">📎 ${esc(a.name)}</a></div>`;
    return `<div class="msg"><img src="${m.author.displayAvatarURL({ size: 64 })}"><div><b>${esc(m.author.tag)}</b> <span class="t">${time} UTC</span><div>${body}</div></div></div>`;
  }).join('\n');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(channel.name)}</title><style>
body{background:#313338;color:#dbdee1;font-family:Arial,sans-serif;padding:20px}
.msg{display:flex;gap:10px;margin:10px 0}.msg img{width:40px;height:40px;border-radius:50%}
.t{color:#949ba4;font-size:12px}.embed{border-left:4px solid #5865f2;padding:4px 8px;background:#2b2d31;margin-top:4px}
a{color:#00a8fc}</style></head><body><h2>Transcript: #${esc(channel.name)}</h2><hr>${rows}</body></html>`;
  return { html, count: all.length };
}

async function closeTicket(i, reason) {
  const c = cfg(i.guild.id);
  const t = c.tickets[i.channel.id];
  if (!t) return reply(i, 'This is not a ticket channel.');
  if (!(isStaff(i, c) || i.user.id === t.userId)) return reply(i, 'Only staff or the ticket owner can close this.');

  await i.reply({ content: '🔒 Closing ticket, saving transcript...' });
  const { html, count } = await buildTranscript(i.channel);
  const fileName = `transcript-${i.channel.name}.html`;
  const makeFile = () => new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName });

  const embed = new EmbedBuilder()
    .setTitle('🎫 Ticket Closed')
    .setColor(0xed4245)
    .addFields(
      { name: 'Ticket', value: `#${String(t.number).padStart(4, '0')}`, inline: true },
      { name: 'Category', value: t.category, inline: true },
      { name: 'Opened by', value: `<@${t.userId}>`, inline: true },
      { name: 'Closed by', value: `<@${i.user.id}>`, inline: true },
      { name: 'Messages', value: String(count), inline: true },
      { name: 'Reason', value: reason || 'No reason given' },
    )
    .setTimestamp();

  // 1) selected transcript channel
  if (c.transcriptChannelId) {
    const ch = await i.guild.channels.fetch(c.transcriptChannelId).catch(() => null);
    if (ch) await ch.send({ embeds: [embed], files: [makeFile()] }).catch(e => console.error('Log send failed', e.message));
  }
  // 2) DM to the member who opened it
  try {
    const user = await client.users.fetch(t.userId);
    await user.send({ content: `Your ticket in **${i.guild.name}** was closed.`, embeds: [embed], files: [makeFile()] });
  } catch { /* DMs closed */ }

  delete c.tickets[i.channel.id];
  save();
  setTimeout(() => i.channel.delete('Ticket closed').catch(() => {}), 5000);
}

/* ---------- interactions ---------- */
client.on('interactionCreate', async (i) => {
  try {
    if (!i.guild) return;
    const c = cfg(i.guild.id);

    /* slash commands */
    if (i.isChatInputCommand() && i.commandName === 'ticket') {
      const sub = i.options.getSubcommand();
      const adminOnly = ['setup', 'transcript-channel', 'staff-role', 'parent', 'category-add', 'category-remove'];
      if (adminOnly.includes(sub) && !isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');

      if (sub === 'setup') {
        const ch = i.options.getChannel('channel');
        await ch.send(panelMessage(i.guild));
        return reply(i, `✅ Panel sent to ${ch}.`);
      }
      if (sub === 'transcript-channel') {
        c.transcriptChannelId = i.options.getChannel('channel').id; save();
        return reply(i, `✅ Transcripts will go to <#${c.transcriptChannelId}>.`);
      }
      if (sub === 'staff-role') {
        c.staffRoleId = i.options.getRole('role').id; save();
        return reply(i, `✅ Staff role set to <@&${c.staffRoleId}>.`);
      }
      if (sub === 'parent') {
        c.parentId = i.options.getChannel('category').id; save();
        return reply(i, '✅ Tickets will be created in that category.');
      }
      if (sub === 'category-add') {
        if (c.categories.length >= 25) return reply(i, '❌ Max 25 categories.');
        const name = i.options.getString('name');
        const id = slug(name);
        if (c.categories.some(x => x.id === id)) return reply(i, '❌ That category already exists.');
        c.categories.push({ id, label: name, emoji: i.options.getString('emoji') || null, description: i.options.getString('description') || null });
        save();
        return reply(i, `✅ Added **${name}**. Run \`/ticket setup\` again to send a fresh panel.`);
      }
      if (sub === 'category-remove') {
        const id = slug(i.options.getString('name'));
        const before = c.categories.length;
        c.categories = c.categories.filter(x => x.id !== id); save();
        return reply(i, c.categories.length < before ? '✅ Removed. Run `/ticket setup` again to refresh the panel.' : '❌ Category not found.');
      }
      if (sub === 'category-list') {
        return reply(i, c.categories.map(x => `${x.emoji || '•'} **${x.label}** — ${x.description || ''}`).join('\n') || 'No categories.');
      }
      if (sub === 'close') return closeTicket(i, i.options.getString('reason'));
      if (sub === 'add' || sub === 'remove') {
        if (!c.tickets[i.channel.id]) return reply(i, 'This is not a ticket channel.');
        if (!isStaff(i, c)) return reply(i, '❌ Staff only.');
        const user = i.options.getUser('user');
        if (sub === 'add') {
          await i.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
          return i.reply(`✅ Added ${user}.`);
        }
        await i.channel.permissionOverwrites.delete(user.id);
        return i.reply(`✅ Removed ${user}.`);
      }
    }

    /* open ticket from the select menu */
    if (i.isStringSelectMenu() && i.customId === 'ticket_open') {
      const cat = c.categories.find(x => x.id === i.values[0]);
      if (!cat) return reply(i, '❌ Category no longer exists.');
      const existing = Object.entries(c.tickets).find(([chId, t]) => t.userId === i.user.id && i.guild.channels.cache.has(chId));
      if (existing) return reply(i, `❌ You already have an open ticket: <#${existing[0]}>`);

      await i.deferReply({ flags: MessageFlags.Ephemeral });
      c.counter += 1;
      const number = c.counter;
      const overwrites = [
        { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
      ];
      if (c.staffRoleId) overwrites.push({ id: c.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] });

      const channel = await i.guild.channels.create({
        name: `${cat.id}-${String(number).padStart(4, '0')}-${slug(i.user.username)}`,
        type: ChannelType.GuildText,
        parent: c.parentId || null,
        topic: `Ticket #${number} | ${cat.label} | opened by ${i.user.tag}`,
        permissionOverwrites: overwrites,
      });
      c.tickets[channel.id] = { userId: i.user.id, category: cat.label, number };
      save();

      const embed = new EmbedBuilder()
        .setTitle(`${cat.emoji || '🎫'} ${cat.label} Ticket`)
        .setDescription(`Hello ${i.user}, staff will be with you soon.\nPlease describe your issue in detail.`)
        .setColor(0x57f287);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      );
      await channel.send({ content: `${i.user}${c.staffRoleId ? ` <@&${c.staffRoleId}>` : ''}`, embeds: [embed], components: [row] });
      return i.editReply(`✅ Ticket created: ${channel}`);
    }

    /* close button -> reason modal */
    if (i.isButton() && i.customId === 'ticket_close') {
      const modal = new ModalBuilder().setCustomId('ticket_close_modal').setTitle('Close Ticket')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false),
        ));
      return i.showModal(modal);
    }
    if (i.isModalSubmit() && i.customId === 'ticket_close_modal') {
      return closeTicket(i, i.fields.getTextInputValue('reason'));
    }
  } catch (err) {
    console.error(err);
    const msg = { content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral };
    if (i.replied || i.deferred) i.followUp(msg).catch(() => {}); else i.reply(msg).catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
