require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ButtonBuilder, ButtonStyle,
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
const defaultQuestion = (cat) => {
  const id = String(cat?.id || '').toLowerCase();
  const label = String(cat?.label || '').toLowerCase();
  if (id === 'buy' || label === 'buy') return 'What do you want to buy?';
  if (id === 'replacement' || label === 'replacement') return 'What do you want to replace?';
  if (id === 'support' || label === 'support') return 'What support do you need?';
  if (id === 'other' || label === 'other') return 'How can we help you?';
  return 'What do you need help with?';
};
const cfg = (guildId) => {
  if (!db[guildId]) {
    db[guildId] = {
      transcriptChannelId: null, staffRoleId: null, parentId: null, closedParentId: null, counter: 0,
      categories: [
        { id: 'buy', label: 'Buy', emoji: '🛒', description: 'Purchase questions' },
        { id: 'replacement', label: 'Replacement', emoji: '🔁', description: 'Request a replacement' },
        { id: 'support', label: 'Support', emoji: '🛠️', description: 'General support' },
        { id: 'other', label: 'Other', emoji: '❓', description: 'Anything else' },
      ],
      tickets: {}, closed: {},
    };
    save();
  }
  if (!db[guildId].closed) db[guildId].closed = {};
  if (!db[guildId].tickets) db[guildId].tickets = {};
  if (!Array.isArray(db[guildId].categories)) db[guildId].categories = [];

  // Migrate older saved settings so every ticket type has an opening question.
  let migrated = false;
  for (const cat of db[guildId].categories) {
    if (typeof cat.question !== 'string' || !cat.question.trim()) {
      cat.question = defaultQuestion(cat);
      migrated = true;
    }
    // Discord modal text-input labels are limited to 45 characters.
    if (cat.question.length > 45) {
      cat.question = cat.question.slice(0, 45);
      migrated = true;
    }
  }
  if (migrated) save();
  return db[guildId];
};

/* ---------- slash commands ---------- */
const commands = [
  new SlashCommandBuilder().setName('ticket').setDescription('Ticket system')
    .addSubcommand(s => s.setName('settings').setDescription('Choose where each ticket type is created'))
    .addSubcommand(s => s.setName('setup').setDescription('Send the ticket panel')
      .addChannelOption(o => o.setName('channel').setDescription('Where to send the panel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('transcript-channel').setDescription('Channel where transcripts go')
      .addChannelOption(o => o.setName('channel').setDescription('Transcript channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('staff-role').setDescription('Role that can see all tickets')
      .addRoleOption(o => o.setName('role').setDescription('Staff role').setRequired(true)))
    .addSubcommand(s => s.setName('parent').setDescription('Discord category where tickets are created')
      .addChannelOption(o => o.setName('category').setDescription('Discord category').addChannelTypes(ChannelType.GuildCategory).setRequired(true)))
    .addSubcommand(s => s.setName('closed-category').setDescription('Discord category where closed tickets are moved')
      .addChannelOption(o => o.setName('category').setDescription('Discord category for closed tickets').addChannelTypes(ChannelType.GuildCategory).setRequired(true)))
    .addSubcommand(s => s.setName('delete').setDescription('Delete this closed ticket channel (staff)'))
    .addSubcommand(s => s.setName('category-add').setDescription('Add a ticket category')
      .addStringOption(o => o.setName('name').setDescription('Name, e.g. Billing').setRequired(true))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji'))
      .addStringOption(o => o.setName('description').setDescription('Short description')))
    .addSubcommand(s => s.setName('category-remove').setDescription('Remove a ticket category')
      .addStringOption(o => o.setName('name').setDescription('Category name').setRequired(true)))
    .addSubcommand(s => s.setName('category-parent').setDescription('Set which Discord category a ticket type is created in')
      .addStringOption(o => o.setName('name').setDescription('Ticket category name, e.g. Buy').setRequired(true))
      .addChannelOption(o => o.setName('category').setDescription('Discord category (leave empty to reset)').addChannelTypes(ChannelType.GuildCategory)))
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

function ticketSettingsOverview(guild) {
  const c = cfg(guild.id);
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Ticket Settings')
    .setDescription('Choose a ticket type to change its folder, or change the default folder used by ticket types without their own folder.')
    .setColor(0x5865f2);

  if (!c.categories.length) {
    embed.addFields({ name: 'Ticket types', value: 'No ticket types yet. Add one with `/ticket category-add`.' });
  } else {
    for (const cat of c.categories.slice(0, 25)) {
      const destinationId = cat.parentId || c.parentId;
      const destination = destinationId ? guild.channels.cache.get(destinationId) : null;
      const destinationText = destinationId
        ? (destination ? `<#${destinationId}>` : '`Folder unavailable — choose another`')
        : '`Not set`';
      const routingText = cat.parentId ? 'Custom folder' : 'Uses the default folder';
      embed.addFields({
        name: `${cat.emoji || '🎫'} ${cat.label}`.slice(0, 256),
        value: `${destinationText}\n_${routingText}_\n**Opening question:** ${cat.question || defaultQuestion(cat)}`,
        inline: true,
      });
    }
  }

  const components = [];
  if (c.categories.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket_settings_type')
      .setPlaceholder('Choose a ticket type...')
      .addOptions(c.categories.slice(0, 25).map(cat => ({
        label: cat.label.slice(0, 100),
        value: cat.id,
        ...(cat.emoji ? { emoji: cat.emoji } : {}),
      })));
    components.push(new ActionRowBuilder().addComponents(menu));
  }

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_settings_default')
      .setLabel('Change default folder')
      .setStyle(ButtonStyle.Secondary),
  ));

  return { embeds: [embed], components };
}

function ticketSettingsDetail(guild, cat, notice = '') {
  const c = cfg(guild.id);
  const destinationId = cat.parentId || c.parentId;
  const destination = destinationId ? guild.channels.cache.get(destinationId) : null;
  const currentDestination = destinationId
    ? (destination ? `<#${destinationId}>` : '`Folder unavailable`')
    : '`Not set — tickets will be created without a parent folder`';
  const routingMode = cat.parentId ? 'This ticket type has its own folder.' : 'This ticket type uses the default ticket folder.';

  const embed = new EmbedBuilder()
    .setTitle(`${cat.emoji || '🎫'} ${cat.label} Ticket Folder`)
    .setDescription([
      notice,
      `**Current folder:** ${currentDestination}`,
      routingMode,
      `**Opening question:** ${cat.question || defaultQuestion(cat)}`,
      '',
      'Choose a Discord category below, or edit the question members answer when opening this ticket type. Changes are saved automatically.',
    ].filter(Boolean).join('\n'))
    .setColor(0x5865f2);

  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`ticket_settings_parent:${cat.id}`)
    .setPlaceholder('Select a Discord folder...')
    .setChannelTypes(ChannelType.GuildCategory)
    .setMinValues(1)
    .setMaxValues(1);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_settings_reset:${cat.id}`)
      .setLabel('Use default folder')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ticket_settings_question:${cat.id}`)
      .setLabel('Edit opening question')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ticket_settings_back')
      .setLabel('Back')
      .setStyle(ButtonStyle.Primary),
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(channelMenu), buttons],
  };
}

function ticketSettingsDefaultDetail(guild, notice = '') {
  const c = cfg(guild.id);
  const destination = c.parentId ? guild.channels.cache.get(c.parentId) : null;
  const currentDestination = c.parentId
    ? (destination ? `<#${c.parentId}>` : '`Folder unavailable`')
    : '`Not set`';
  const embed = new EmbedBuilder()
    .setTitle('📁 Default Ticket Folder')
    .setDescription([
      notice,
      `**Current default folder:** ${currentDestination}`,
      'Ticket types with a custom folder will keep using their own folder. All other ticket types will use this default.',
      '',
      'Choose a Discord category below. The change is saved automatically.',
    ].filter(Boolean).join('\n'))
    .setColor(0x5865f2);

  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId('ticket_settings_default_parent')
    .setPlaceholder('Select the default Discord folder...')
    .setChannelTypes(ChannelType.GuildCategory)
    .setMinValues(1)
    .setMaxValues(1);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_settings_default_reset')
      .setLabel('Clear default folder')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_settings_back')
      .setLabel('Back')
      .setStyle(ButtonStyle.Primary),
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(channelMenu), buttons],
  };
}

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
    for (const e of m.embeds) {
      let embedHtml = `<div class="embed"><b>${esc(e.title || '')}</b><div>${esc(e.description || '')}</div>`;
      for (const field of (e.fields || [])) {
        embedHtml += `<p><b>${esc(field.name)}</b><br>${esc(field.value)}</p>`;
      }
      body += `${embedHtml}</div>`;
    }
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

async function deleteClosedTicket(i) {
  const c = cfg(i.guild.id);
  const channel = i.channel;

  if (!isStaff(i, c)) return reply(i, '❌ Staff only.');
  if (!c.closed[channel.id]) return reply(i, '❌ This is not a closed ticket.');

  await i.reply({ content: '🗑️ Deleting this closed ticket...', flags: MessageFlags.Ephemeral });
  try {
    await channel.delete(`Closed ticket deleted by ${i.user.tag}`);
    delete c.closed[channel.id];
    save();
  } catch (err) {
    console.error('Closed ticket deletion failed:', err);
    await i.followUp({
      content: `❌ Could not delete this ticket (${err.message}). Make sure the bot has Manage Channels permission.`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}

async function closeTicket(i, reason) {
  const c = cfg(i.guild.id);
  const channel = i.channel;
  const t = c.tickets[channel.id];
  if (!t) return reply(i, 'This is not an open ticket channel.');
  if (!(isStaff(i, c) || i.user.id === t.userId)) return reply(i, 'Only staff or the ticket owner can close this.');

  await i.reply({ content: '🔒 Closing ticket, saving transcript...' });
  const problems = [];
  const { html, count } = await buildTranscript(channel);
  const fileName = `transcript-${channel.name}.html`;
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

  // 1) transcript channel (the one you selected)
  if (!c.transcriptChannelId) {
    problems.push('No transcript channel is set. Use `/ticket transcript-channel`.');
  } else {
    try {
      const ch = await i.guild.channels.fetch(c.transcriptChannelId);
      await ch.send({ embeds: [embed], files: [makeFile()] });
    } catch (e) {
      console.error('Transcript channel send failed:', e);
      problems.push(`Could not send transcript to <#${c.transcriptChannelId}> (${e.message}). Give the bot View Channel, Send Messages, Embed Links and Attach Files there.`);
    }
  }

  // 2) DM to the member who opened the ticket
  try {
    const user = await client.users.fetch(t.userId);
    await user.send({ content: `Your ticket in **${i.guild.name}** was closed.`, embeds: [embed], files: [makeFile()] });
  } catch {
    problems.push('Could not DM the user (their DMs are closed).');
  }

  // 3) close = lock + move (NOT delete)
  delete c.tickets[channel.id];
  c.closed[channel.id] = { ...t, closedBy: i.user.id };
  save();
  try {
    await channel.permissionOverwrites.edit(t.userId, { ViewChannel: false });
    if (c.closedParentId) await channel.setParent(c.closedParentId, { lockPermissions: false });
    else problems.push('No closed category set, so the channel stayed in place. Use `/ticket closed-category`.');
    if (!channel.name.startsWith('closed-')) await channel.setName(`closed-${channel.name}`.slice(0, 100));
  } catch (e) {
    console.error('Move failed:', e);
    problems.push(`Could not move/lock the channel (${e.message}). Give the bot Manage Channels in that category.`);
  }

  const deleteRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_delete_closed')
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: problems.length ? `⚠️ ${problems.join('\n')}` : undefined,
    embeds: [embed.setDescription('This ticket is closed. Staff can delete it using the button below.')],
    components: [deleteRow],
  }).catch((err) => console.error('Could not post closed-ticket controls:', err));
}

/* ---------- interactions ---------- */
client.on('interactionCreate', async (i) => {
  try {
    if (!i.guild) return;
    const c = cfg(i.guild.id);

    /* slash commands */
    if (i.isChatInputCommand() && i.commandName === 'ticket') {
      const sub = i.options.getSubcommand();
      const adminOnly = ['settings', 'setup', 'transcript-channel', 'staff-role', 'parent', 'category-add', 'category-remove', 'category-parent', 'closed-category'];
      if (adminOnly.includes(sub) && !isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');

      if (sub === 'settings') {
        return i.reply({ ...ticketSettingsOverview(i.guild), flags: MessageFlags.Ephemeral });
      }
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
        const newCategory = {
          id,
          label: name,
          emoji: i.options.getString('emoji') || null,
          description: i.options.getString('description') || null,
        };
        newCategory.question = defaultQuestion(newCategory);
        c.categories.push(newCategory);
        save();
        return reply(i, `✅ Added **${name}**. Run \`/ticket setup\` again to send a fresh panel.`);
      }
      if (sub === 'category-remove') {
        const id = slug(i.options.getString('name'));
        const before = c.categories.length;
        c.categories = c.categories.filter(x => x.id !== id); save();
        return reply(i, c.categories.length < before ? '✅ Removed. Run `/ticket setup` again to refresh the panel.' : '❌ Category not found.');
      }
      if (sub === 'closed-category') {
        c.closedParentId = i.options.getChannel('category').id; save();
        return reply(i, `✅ Closed tickets will be moved to **${i.options.getChannel('category').name}**.`);
      }
      if (sub === 'delete') {
        return deleteClosedTicket(i);
      }
      if (sub === 'category-parent') {
        const id = slug(i.options.getString('name'));
        const cat = c.categories.find(x => x.id === id);
        if (!cat) return reply(i, '❌ Ticket category not found. Use `/ticket category-list`.');
        const parent = i.options.getChannel('category');
        cat.parentId = parent ? parent.id : null; save();
        return reply(i, parent ? `✅ **${cat.label}** tickets will now open inside **${parent.name}**.` : `✅ **${cat.label}** reset to the default category.`);
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

    /* ticket folder settings menu */
    if (i.isStringSelectMenu() && i.customId === 'ticket_settings_type') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const cat = c.categories.find(x => x.id === i.values[0]);
      if (!cat) return i.update({ content: 'That ticket type no longer exists. Run `/ticket settings` again.', embeds: [], components: [] });
      return i.update(ticketSettingsDetail(i.guild, cat));
    }

    if (i.isButton() && i.customId === 'ticket_settings_default') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      return i.update(ticketSettingsDefaultDetail(i.guild));
    }

    if (i.isChannelSelectMenu() && i.customId === 'ticket_settings_default_parent') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const parent = await i.guild.channels.fetch(i.values[0]);
      if (!parent || parent.type !== ChannelType.GuildCategory) {
        return reply(i, '❌ Please select a valid Discord category folder.');
      }
      c.parentId = parent.id;
      save();
      return i.update(ticketSettingsDefaultDetail(i.guild, `✅ Default folder saved as **${parent.name}**.`));
    }

    if (i.isButton() && i.customId === 'ticket_settings_default_reset') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      c.parentId = null;
      save();
      return i.update(ticketSettingsDefaultDetail(i.guild, '✅ The default folder has been cleared.'));
    }

    if (i.isChannelSelectMenu() && i.customId.startsWith('ticket_settings_parent:')) {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const catId = i.customId.slice('ticket_settings_parent:'.length);
      const cat = c.categories.find(x => x.id === catId);
      if (!cat) return i.update({ content: 'That ticket type no longer exists. Run `/ticket settings` again.', embeds: [], components: [] });

      const parentId = i.values[0];
      const parent = await i.guild.channels.fetch(parentId);
      if (!parent || parent.type !== ChannelType.GuildCategory) {
        return reply(i, '❌ Please select a valid Discord category folder.');
      }

      cat.parentId = parent.id;
      save();
      return i.update(ticketSettingsDetail(i.guild, cat, `✅ Saved! New **${cat.label}** tickets will go into **${parent.name}**.`));
    }

    if (i.isButton() && i.customId.startsWith('ticket_settings_reset:')) {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const catId = i.customId.slice('ticket_settings_reset:'.length);
      const cat = c.categories.find(x => x.id === catId);
      if (!cat) return i.update({ content: 'That ticket type no longer exists. Run `/ticket settings` again.', embeds: [], components: [] });

      cat.parentId = null;
      save();
      return i.update(ticketSettingsDetail(i.guild, cat, `✅ **${cat.label}** now uses the default ticket folder.`));
    }

    if (i.isButton() && i.customId.startsWith('ticket_settings_question:')) {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const catId = i.customId.slice('ticket_settings_question:'.length);
      const cat = c.categories.find(x => x.id === catId);
      if (!cat) return reply(i, '❌ That ticket type no longer exists. Run `/ticket settings` again.');

      const modal = new ModalBuilder()
        .setCustomId(`ticket_settings_question_modal:${cat.id}`)
        .setTitle(`Edit ${cat.label} Question`.slice(0, 45))
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('question')
            .setLabel('Question shown when opening this ticket')
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(45)
            .setRequired(true)
            .setValue((cat.question || defaultQuestion(cat)).slice(0, 45)),
        ));
      return i.showModal(modal);
    }

    if (i.isModalSubmit() && i.customId.startsWith('ticket_settings_question_modal:')) {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const catId = i.customId.slice('ticket_settings_question_modal:'.length);
      const cat = c.categories.find(x => x.id === catId);
      if (!cat) return reply(i, '❌ That ticket type no longer exists. Run `/ticket settings` again.');
      const question = i.fields.getTextInputValue('question').trim();
      if (!question) return reply(i, '❌ Please enter a question.');
      if (question.length > 45) return reply(i, '❌ The question must be 45 characters or fewer.');
      cat.question = question;
      save();
      return i.reply({
        ...ticketSettingsDetail(i.guild, cat, `✅ Opening question saved: **${question}**`),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (i.isButton() && i.customId === 'ticket_settings_back') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      return i.update(ticketSettingsOverview(i.guild));
    }

    /* select a ticket type -> ask the member for details in a modal */
    if (i.isStringSelectMenu() && i.customId === 'ticket_open') {
      const cat = c.categories.find(x => x.id === i.values[0]);
      if (!cat) return reply(i, '❌ Category no longer exists.');
      const existing = Object.entries(c.tickets).find(([chId, t]) =>
        t.userId === i.user.id && i.guild.channels.cache.has(chId),
      );
      if (existing) return reply(i, `❌ You already have an open ticket: <#${existing[0]}>`);

      const question = (cat.question || defaultQuestion(cat)).slice(0, 45);
      const modal = new ModalBuilder()
        .setCustomId(`ticket_open_modal:${cat.id}`)
        .setTitle(`Open ${cat.label} Ticket`.slice(0, 45))
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('answer')
            .setLabel(question)
            .setPlaceholder('Type your answer here...')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(1)
            .setMaxLength(1000)
            .setRequired(true),
        ));
      return i.showModal(modal);
    }

    /* submit opening form -> create the private ticket channel */
    if (i.isModalSubmit() && i.customId.startsWith('ticket_open_modal:')) {
      const catId = i.customId.slice('ticket_open_modal:'.length);
      const cat = c.categories.find(x => x.id === catId);
      if (!cat) return reply(i, '❌ This ticket type no longer exists. Please use the ticket panel again.');

      const answer = i.fields.getTextInputValue('answer').trim();
      if (!answer) return reply(i, '❌ Please answer the question before opening a ticket.');

      const existing = Object.entries(c.tickets).find(([chId, t]) =>
        t.userId === i.user.id && i.guild.channels.cache.has(chId),
      );
      if (existing) return reply(i, `❌ You already have an open ticket: <#${existing[0]}>`);

      await i.deferReply({ flags: MessageFlags.Ephemeral });
      c.counter += 1;
      const number = c.counter;
      const question = (cat.question || defaultQuestion(cat)).slice(0, 45);
      const overwrites = [
        { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
      ];
      if (c.staffRoleId) overwrites.push({ id: c.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] });

      const channel = await i.guild.channels.create({
        name: `${cat.id}-${String(number).padStart(4, '0')}-${slug(i.user.username)}`,
        type: ChannelType.GuildText,
        parent: cat.parentId || c.parentId || null,
        topic: `Ticket #${number} | ${cat.label} | opened by ${i.user.tag}`,
        permissionOverwrites: overwrites,
      });
      c.tickets[channel.id] = {
        userId: i.user.id,
        category: cat.label,
        categoryId: cat.id,
        number,
        openingQuestion: question,
        openingAnswer: answer,
      };
      save();

      const embed = new EmbedBuilder()
        .setTitle(`${cat.emoji || '🎫'} ${cat.label} Ticket`)
        .setDescription(`Hello ${i.user}, staff will be with you soon.\nPlease describe any additional details in this channel.`)
        .addFields({ name: question, value: answer.slice(0, 1024) })
        .setColor(0x57f287);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      );
      await channel.send({ content: `${i.user}${c.staffRoleId ? ` <@&${c.staffRoleId}>` : ''}`, embeds: [embed], components: [row] });
      return i.editReply(`✅ Ticket created: ${channel}`);
    }

    /* delete button on a closed ticket */
    if (i.isButton() && i.customId === 'ticket_delete_closed') {
      return deleteClosedTicket(i);
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
