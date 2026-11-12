require('dotenv').config();
const fs = require('fs');
const path = require('path');
// Music integrations are loaded lazily so a music package issue cannot prevent
// the ticket, restock, and verification systems from starting.
const {
  Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder,
  AttachmentBuilder, MessageFlags,
} = require('discord.js');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// DisTube v5.2.3 requires an adapter and at least one source plugin.
let musicPlayer = null;
let musicLoadError = null;

function initializeMusicPlayer() {
  const { DiscordJSAdapter } = require('@distube/discordjs');
  const { YouTubePlugin } = require('@distube/youtube');
  const { DisTube } = require('distube');

  musicPlayer = new DisTube({
    adapter: new DiscordJSAdapter(client),
    plugins: [new YouTubePlugin()],
  });

  musicPlayer.on('queue.item.started', ({ item }) => {
    const textChannelId = item?.metadata?.textChannelId;
    const textChannel = textChannelId ? client.channels.cache.get(textChannelId) : null;
    const title = item?.song?.name || 'Unknown track';
    if (textChannel?.isTextBased()) {
      textChannel.send({
        content: `🎶 Now playing: **${title}**`,
        allowedMentions: { parse: [] },
      }).catch((err) => console.error('Could not announce music track:', err.message));
    }
  });

  musicPlayer.on('queue.item.failed', ({ item, error }) => {
    const textChannelId = item?.metadata?.textChannelId;
    const textChannel = textChannelId ? client.channels.cache.get(textChannelId) : null;
    console.error('Music track failed:', error);
    if (textChannel?.isTextBased()) {
      textChannel.send({
        content: `❌ Could not play **${item?.song?.name || 'that track'}**: ${error?.message || 'Playback failed.'}`,
        allowedMentions: { parse: [] },
      }).catch((err) => console.error('Could not report music error:', err.message));
    }
  });

  console.log('Music player initialized (DisTube v5 adapter + YouTube plugin).');
}

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

const DEFAULT_RESTOCK_SETTINGS = Object.freeze({
  authorText: '{server} • RESTOCK ALERT',
  titleTemplate: '🚀 {product} is BACK IN STOCK!',
  descriptionTemplate: '{message}\n\n🛍️ **Available now — order while stock lasts!**',
  priceLabel: '💰  PRICE',
  stockLabel: '📦  AVAILABLE STOCK',
  footerText: 'THANK YOU FOR SHOPPING WITH US',
  color: '22B8CF',
  showServerIcon: true,
  showTimestamp: true,
});

const RESTOCK_SETTING_FIELDS = {
  authorText: { label: 'Author text', inputLabel: 'Author text (use {server})', max: 256, placeholder: '{server} • RESTOCK ALERT' },
  titleTemplate: { label: 'Title', inputLabel: 'Title (use {product})', max: 256, placeholder: '🚀 {product} is BACK IN STOCK!' },
  descriptionTemplate: { label: 'Description', inputLabel: 'Description (use {message})', max: 4000, paragraph: true, placeholder: 'Your restock announcement text...' },
  priceLabel: { label: 'Price label', inputLabel: 'Price field label', max: 256, placeholder: '💰 PRICE' },
  stockLabel: { label: 'Stock label', inputLabel: 'Stock field label', max: 256, placeholder: '📦 AVAILABLE STOCK' },
  footerText: { label: 'Footer text', inputLabel: 'Footer text', max: 2048, placeholder: 'THANK YOU FOR SHOPPING WITH US' },
  color: { label: 'Embed color', inputLabel: 'Hex color, with or without #', max: 7, placeholder: '#22B8CF' },
};

function getRestockSettings(guildConfig) {
  if (!guildConfig.restockSettings || typeof guildConfig.restockSettings !== 'object') {
    guildConfig.restockSettings = { ...DEFAULT_RESTOCK_SETTINGS };
  } else {
    guildConfig.restockSettings = { ...DEFAULT_RESTOCK_SETTINGS, ...guildConfig.restockSettings };
  }
  return guildConfig.restockSettings;
}

function formatRestockText(template, values) {
  return String(template || '').replace(/\{(product|price|stock|message|server)\}/gi, (match, key) => {
    const value = values[key.toLowerCase()];
    return value === undefined || value === null ? match : String(value);
  });
}

function buildRestockEmbed(guild, product, price, stock, announcement, productImageUrl, guildConfig) {
  const settings = getRestockSettings(guildConfig);
  const serverIcon = guild.iconURL({ extension: 'png', size: 128 }) || null;
  const values = {
    product,
    price,
    stock: stock.toLocaleString(),
    message: announcement,
    server: guild.name,
  };
  const color = /^[0-9a-fA-F]{6}$/.test(settings.color) ? parseInt(settings.color, 16) : 0x22b8cf;
  const embed = new EmbedBuilder().setColor(color);

  const authorText = formatRestockText(settings.authorText, values).slice(0, 256).trim();
  if (authorText) {
    embed.setAuthor({
      name: authorText,
      ...(settings.showServerIcon && serverIcon ? { iconURL: serverIcon } : {}),
    });
  }

  const title = formatRestockText(settings.titleTemplate, values).slice(0, 256).trim();
  if (title) embed.setTitle(title);

  const description = formatRestockText(settings.descriptionTemplate, values).slice(0, 4096).trim();
  if (description) embed.setDescription(description);

  const fields = [];
  const priceLabel = formatRestockText(settings.priceLabel, values).slice(0, 256).trim();
  const stockLabel = formatRestockText(settings.stockLabel, values).slice(0, 256).trim();
  if (priceLabel) fields.push({ name: priceLabel, value: `**${price}**`, inline: true });
  if (stockLabel) fields.push({ name: stockLabel, value: `**${stock.toLocaleString()}**`, inline: true });
  if (fields.length) embed.addFields(fields);

  const footerText = formatRestockText(settings.footerText, values).slice(0, 2048).trim();
  if (footerText) embed.setFooter({ text: footerText });
  if (settings.showTimestamp) embed.setTimestamp();
  if (settings.showServerIcon && serverIcon) embed.setThumbnail(serverIcon);
  if (productImageUrl) embed.setImage(productImageUrl);

  // Discord requires at least one visible content field on an embed.
  // If the admin clears every text field, retain the product name as a safe fallback.
  if (!authorText && !title && !description && fields.length === 0 && !footerText && !productImageUrl && !(settings.showServerIcon && serverIcon)) {
    embed.setTitle(product.slice(0, 256));
  }
  return embed;
}

function restockSettingsOverview(guild, notice = '') {
  const settings = getRestockSettings(cfg(guild.id));
  const show = (value, max = 900) => {
    const text = String(value || '').trim();
    return text ? (text.length > max ? `${text.slice(0, max - 3)}...` : text) : '_Hidden_';
  };
  const embed = new EmbedBuilder()
    .setTitle('🛍️ Restock Alert Settings')
    .setDescription([
      notice,
      'Choose an option below to customize your restock embed. Every change saves automatically.',
      '',
      '**Placeholders you can use:** `{product}` `{price}` `{stock}` `{message}` `{server}`',
    ].filter(Boolean).join('\n'))
    .setColor(/^[0-9a-fA-F]{6}$/.test(settings.color) ? parseInt(settings.color, 16) : 0x22b8cf)
    .addFields(
      { name: 'Author', value: show(settings.authorText), inline: false },
      { name: 'Title', value: show(settings.titleTemplate), inline: false },
      { name: 'Description', value: show(settings.descriptionTemplate), inline: false },
      { name: 'Price label', value: show(settings.priceLabel), inline: true },
      { name: 'Stock label', value: show(settings.stockLabel), inline: true },
      { name: 'Footer', value: show(settings.footerText), inline: false },
      { name: 'Embed color', value: `#${settings.color}`, inline: true },
      { name: 'Server icon', value: settings.showServerIcon ? 'Shown' : 'Hidden', inline: true },
      { name: 'Timestamp', value: settings.showTimestamp ? 'Shown' : 'Hidden', inline: true },
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId('restock_settings_field')
    .setPlaceholder('Choose what you want to edit...')
    .addOptions(Object.entries(RESTOCK_SETTING_FIELDS).map(([value, meta]) => ({
      label: meta.label,
      value,
      description: `Edit ${meta.label.toLowerCase()}`,
    })));

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('restock_settings_toggle_icon')
      .setLabel(settings.showServerIcon ? 'Hide server icon' : 'Show server icon')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('restock_settings_toggle_timestamp')
      .setLabel(settings.showTimestamp ? 'Hide timestamp' : 'Show timestamp')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('restock_settings_preview')
      .setLabel('Preview')
      .setEmoji('👁️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('restock_settings_reset')
      .setLabel('Reset defaults')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), buttons] };
}

function restockSettingModal(key, currentValue) {
  const meta = RESTOCK_SETTING_FIELDS[key];
  const isDescription = Boolean(meta.paragraph);
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(meta.inputLabel.slice(0, 45))
    .setStyle(isDescription ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setMaxLength(meta.max)
    .setRequired(false)
    .setPlaceholder(meta.placeholder);
  if (typeof currentValue === 'string' && currentValue.length > 0) {
    input.setValue(currentValue.slice(0, meta.max));
  }
  return new ModalBuilder()
    .setCustomId(`restock_settings_modal:${key}`)
    .setTitle(`Edit ${meta.label}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
}
const cfg = (guildId) => {
  if (!db[guildId]) {
    db[guildId] = {
      transcriptChannelId: null, staffRoleId: null, parentId: null, closedParentId: null,
      restockChannelId: null,
      restockSettings: { ...DEFAULT_RESTOCK_SETTINGS },
      verifyChannelId: null, verifyMemberRoleId: null, verifyUnverifiedRoleId: null,
      counter: 0,
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

  // Migrate older guild settings with restock and verification configuration.
  let migrated = false;
  for (const key of ['restockChannelId', 'verifyChannelId', 'verifyMemberRoleId', 'verifyUnverifiedRoleId']) {
    if (!Object.prototype.hasOwnProperty.call(db[guildId], key)) {
      db[guildId][key] = null;
      migrated = true;
    }
  }

  const existingRestockSettings = db[guildId].restockSettings;
  const mergedRestockSettings = {
    ...DEFAULT_RESTOCK_SETTINGS,
    ...(existingRestockSettings && typeof existingRestockSettings === 'object' ? existingRestockSettings : {}),
  };
  if (!existingRestockSettings || typeof existingRestockSettings !== 'object' ||
      JSON.stringify(existingRestockSettings) !== JSON.stringify(mergedRestockSettings)) {
    migrated = true;
  }
  db[guildId].restockSettings = mergedRestockSettings;

  // Migrate older saved settings so every ticket type has an opening question.
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
    .addSubcommand(s => s.setName('closed-category').setDescription('Discord category where closed tickets are moved')
      .addChannelOption(o => o.setName('category').setDescription('Discord category for closed tickets').addChannelTypes(ChannelType.GuildCategory).setRequired(true)))
    .addSubcommand(s => s.setName('category-add').setDescription('Add a ticket category')
      .addStringOption(o => o.setName('name').setDescription('Name, e.g. Billing').setRequired(true))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji'))
      .addStringOption(o => o.setName('description').setDescription('Short description')))
    .addSubcommand(s => s.setName('category-remove').setDescription('Remove a ticket category')
      .addStringOption(o => o.setName('name').setDescription('Category name').setRequired(true)))
    .addSubcommand(s => s.setName('add').setDescription('Add a user to this ticket')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a user from this ticket')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))),
  new SlashCommandBuilder().setName('verify').setDescription('Configure new-member verification')
    .addSubcommand(s => s.setName('setup').setDescription('Set the verification channel and roles')
      .addChannelOption(o => o.setName('channel').setDescription('Channel where new members verify').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption(o => o.setName('member-role').setDescription('Role given after successful verification').setRequired(true))
      .addRoleOption(o => o.setName('unverified-role').setDescription('Optional role given while waiting for verification').setRequired(false))),
  new SlashCommandBuilder().setName('restock').setDescription('Post and customize product restock alerts')
    .addSubcommand(s => s.setName('setup').setDescription('Choose the channel for restock alerts')
      .addChannelOption(o => o.setName('channel').setDescription('Channel where restock alerts will be posted').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('setting').setDescription('Customize restock embed text, color, and appearance'))
    .addSubcommand(s => s.setName('post').setDescription('Post a styled product restock announcement')
      .addStringOption(o => o.setName('product').setDescription('Product name').setMaxLength(100).setRequired(true))
      .addStringOption(o => o.setName('price').setDescription('Product price, e.g. ₹850 or $8.5').setMaxLength(50).setRequired(true))
      .addIntegerOption(o => o.setName('stock').setDescription('Available stock quantity').setMinValue(1).setMaxValue(2147483647).setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Short message shown under the product name').setMaxLength(1000).setRequired(false))
      .addStringOption(o => o.setName('image').setDescription('Optional product image URL (HTTPS recommended)').setMaxLength(400).setRequired(false))),
  new SlashCommandBuilder().setName('play').setDescription('Play a song or YouTube link in your voice channel')
    .addStringOption(o => o.setName('query').setDescription('Song name or YouTube URL').setMaxLength(500).setRequired(true)),
  new SlashCommandBuilder().setName('add').setDescription('Add a song to the music queue')
    .addStringOption(o => o.setName('query').setDescription('Song name or YouTube URL').setMaxLength(500).setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the current music'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume the paused music'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop music and clear the queue'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop music and leave the voice channel'),
].map(c => c.toJSON());

async function registerCommands(guild) {
  try { await guild.commands.set(commands); } catch (e) { console.error('Command register failed', guild.id, e.message); }
}

async function refreshClosedTicketControls(guild) {
  const c = cfg(guild.id);
  for (const channelId of Object.keys(c.closed)) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel || !channel.messages) continue;
      const messages = await channel.messages.fetch({ limit: 100 });
      const controlMessage = messages.find(message =>
        message.author.id === client.user.id &&
        message.components.some(row => row.components.some(component => component.customId === 'ticket_delete_closed')),
      );
      if (!controlMessage) continue;

      const alreadyHasReopen = controlMessage.components.some(row =>
        row.components.some(component => component.customId === 'ticket_reopen_closed'),
      );
      if (alreadyHasReopen) continue;

      const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_reopen_closed')
          .setLabel('Reopen Ticket')
          .setEmoji('🔓')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('ticket_delete_closed')
          .setLabel('Delete')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
      );
      await controlMessage.edit({ components: [controls] });
    } catch (err) {
      console.error(`Could not refresh closed-ticket controls in ${channelId}:`, err.message);
    }
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    initializeMusicPlayer();
  } catch (err) {
    musicLoadError = err;
    console.error('Music features could not initialize. Check package installation and Node.js version:', err);
  }
  for (const guild of client.guilds.cache.values()) {
    await registerCommands(guild);
    await refreshClosedTicketControls(guild);
  }
});
client.on('guildCreate', registerCommands);
client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;
  try {
    const c = cfg(member.guild.id);
    if (!c.verifyChannelId || !c.verifyMemberRoleId) return;

    // Give the optional waiting role immediately, but still send the verify
    // prompt if this role cannot be assigned for any reason.
    if (c.verifyUnverifiedRoleId) {
      try {
        const pendingRole = await member.guild.roles.fetch(c.verifyUnverifiedRoleId);
        if (pendingRole) {
          await member.roles.add(pendingRole, 'Waiting for server verification');
        }
      } catch (err) {
        console.error(`Could not assign Unverified role to ${member.user.tag}:`, err.message);
      }
    }

    const verifyChannel = await member.guild.channels.fetch(c.verifyChannelId);
    if (!verifyChannel || verifyChannel.type !== ChannelType.GuildText) return;

    await verifyChannel.send({
      content: `Welcome ${member}! Click **Verify** below to receive the Member role and access the server.`,
      components: [verificationButtonRow()],
      allowedMentions: { users: [member.id], roles: [] },
    });
  } catch (err) {
    console.error(`Could not start verification for ${member.user.tag}:`, err);
  }
});

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

function verificationButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('member_verify')
      .setLabel('Verify')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
  );
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

async function reopenClosedTicket(i) {
  const c = cfg(i.guild.id);
  const channel = i.channel;
  const t = c.closed[channel.id];

  if (!isStaff(i, c)) return reply(i, '❌ Staff only.');
  if (!t) return reply(i, '❌ This ticket is not closed or has already been reopened.');

  await i.deferUpdate();
  const originalParentId = channel.parentId;
  const originalChannelName = channel.name;

  try {
    // Reopen in the ticket type's current folder, falling back to the default folder.
    const ticketCategory = c.categories.find(cat => cat.id === t.categoryId)
      || c.categories.find(cat => cat.label === t.category);
    const parentId = (ticketCategory && ticketCategory.parentId) || c.parentId || null;
    let parent = null;

    if (parentId) {
      parent = await i.guild.channels.fetch(parentId);
      if (!parent || parent.type !== ChannelType.GuildCategory) {
        throw new Error('The configured folder for this ticket no longer exists. Update it in `/ticket settings`.');
      }
    }

    // Restore the ticket owner's access, move it back to the configured open-ticket folder,
    // and remove the closed- prefix from the channel name.
    await channel.permissionOverwrites.edit(t.userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });
    await channel.setParent(parent ? parent.id : null, { lockPermissions: false });
    if (channel.name.startsWith('closed-')) {
      await channel.setName(channel.name.slice('closed-'.length).slice(0, 100));
    }

    const reopenedTicket = {
      ...t,
      reopenedBy: i.user.id,
      reopenedAt: new Date().toISOString(),
    };
    delete c.closed[channel.id];
    c.tickets[channel.id] = reopenedTicket;
    save();

    const embed = new EmbedBuilder()
      .setTitle('🔓 Ticket Reopened')
      .setDescription(`This ticket has been reopened by ${i.user}. The ticket owner can access this channel again.`)
      .addFields(
        { name: 'Ticket', value: `#${String(t.number).padStart(4, '0')}`, inline: true },
        { name: 'Category', value: t.category || 'Other', inline: true },
        { name: 'Opened by', value: `<@${t.userId}>`, inline: true },
      )
      .setColor(0x57f287)
      .setTimestamp();

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_close')
        .setLabel('Close Ticket')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger),
    );

    await channel.send({ embeds: [embed], components: [closeRow] }).catch(err => {
      console.error('Could not post reopened-ticket message:', err);
    });

    // Remove Reopen/Delete controls from the old closed-ticket message.
    await i.message.edit({
      embeds: [new EmbedBuilder()
        .setTitle('✅ Ticket Reopened')
        .setDescription(`Reopened by ${i.user}. Use the Close Ticket button in the channel when this ticket is finished.`)
        .setColor(0x57f287)
        .setTimestamp()],
      components: [],
    }).catch(err => console.error('Could not update old closed-ticket message:', err));

    await i.followUp({ content: `✅ Reopened ${channel}. The ticket owner has access again.`, flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('Ticket reopen failed:', err);

    // Best-effort rollback: restore the channel's original closed location and name.
    await channel.permissionOverwrites.edit(t.userId, { ViewChannel: false }).catch(() => {});
    if (channel.parentId !== originalParentId) {
      await channel.setParent(originalParentId, { lockPermissions: false }).catch(() => {});
    }
    if (channel.name !== originalChannelName) {
      await channel.setName(originalChannelName).catch(() => {});
    }

    await i.followUp({
      content: `❌ Could not reopen this ticket (${err.message}). Check the bot's Manage Channels permission and the selected ticket folder.`,
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

  const closedTicketRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_reopen_closed')
      .setLabel('Reopen Ticket')
      .setEmoji('🔓')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ticket_delete_closed')
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: problems.length ? `⚠️ ${problems.join('\n')}` : undefined,
    embeds: [embed.setDescription('This ticket is closed. Staff can reopen it or permanently delete it using the buttons below.')],
    components: [closedTicketRow],
  }).catch((err) => console.error('Could not post closed-ticket controls:', err));
}

/* ---------- music helpers ---------- */
const MUSIC_COMMANDS = new Set(['play', 'add', 'pause', 'resume', 'skip', 'stop', 'leave']);

function musicUnavailableText() {
  return musicLoadError
    ? '❌ Music is not available because its packages failed to load. Check the Railway deployment logs and package.json.'
    : '❌ The music player is still starting. Try again in a moment.';
}

async function playMusic({ guild, member, textChannel, query }) {
  if (!musicPlayer) throw new Error(musicUnavailableText());
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) throw new Error('Join a voice channel first, then use `/play` or mention me with `play <song>` .');

  const botMember = await guild.members.fetchMe();
  const voicePermissions = voiceChannel.permissionsFor(botMember);
  if (!voicePermissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    throw new Error(`I need **Connect** and **Speak** permissions in ${voiceChannel}.`);
  }

  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new Error('Tell me which song to play.');
  if (cleanQuery.length > 500) throw new Error('Song searches must be 500 characters or fewer.');

  const result = await musicPlayer.play(voiceChannel, cleanQuery, {
    metadata: {
      textChannelId: textChannel.id,
      requestedBy: member.id,
    },
  });

  const addedCount = Array.isArray(result?.items) ? result.items.length : 1;
  return `✅ Added **${cleanQuery}** to the music queue (${addedCount} ${addedCount === 1 ? 'track' : 'tracks'}).`;
}

async function getMusicControlContext(guild, userId) {
  const member = await guild.members.fetch(userId);
  const userVoiceChannelId = member.voice.channelId;
  if (!userVoiceChannelId) {
    throw new Error('Join my voice channel first to control the music.');
  }

  const botMember = await guild.members.fetchMe();
  const botVoiceChannelId = botMember.voice.channelId;
  if (!botVoiceChannelId) throw new Error('I am not connected to a voice channel. Use `/play` first.');
  if (userVoiceChannelId !== botVoiceChannelId) {
    throw new Error('You must be in the same voice channel as me to control the music.');
  }

  return { member, queue: musicPlayer?.getQueue(guild.id) || null };
}

async function runMusicControl(guild, userId, action) {
  if (!musicPlayer) throw new Error(musicUnavailableText());
  const { queue } = await getMusicControlContext(guild, userId);

  if (action === 'leave') {
    await musicPlayer.voices.leave(guild.id);
    return '👋 Stopped the music and left the voice channel.';
  }

  if (!queue) throw new Error('There is no active music queue.');
  if (action === 'pause') {
    await queue.pause();
    return '⏸️ Music paused.';
  }
  if (action === 'resume') {
    await queue.resume();
    return '▶️ Music resumed.';
  }
  if (action === 'skip') {
    const next = await queue.skip();
    return next ? `⏭️ Skipped. Up next: **${next.song.name}**.` : '⏭️ Skipped. Nothing is waiting in the queue.';
  }
  if (action === 'stop') {
    await queue.stop();
    return '⏹️ Music stopped and the queue was cleared. I will stay in the voice channel until you use `/leave` or play another song.';
  }
  throw new Error('Unknown music command.');
}

async function handleMusicSlashCommand(i) {
  const command = i.commandName;
  try {
    const member = await i.guild.members.fetch(i.user.id);
    if (command === 'play' || command === 'add') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await playMusic({
        guild: i.guild,
        member,
        textChannel: i.channel,
        query: i.options.getString('query', true),
      });
      return i.editReply(message);
    }

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await runMusicControl(i.guild, i.user.id, command);
    return i.editReply(message);
  } catch (err) {
    const message = `❌ ${err?.message || 'The music command failed.'}`;
    if (i.deferred || i.replied) return i.editReply(message).catch(() => {});
    return reply(i, message);
  }
}

/* Mention controls: @Bot play <song>, @Bot add <song>, @Bot pause/resume/skip/stop/leave */
client.on('messageCreate', async (message) => {
  try {
    if (!message.guild || message.author.bot || !client.user) return;
    const mentionPattern = new RegExp(`^<@!?${client.user.id}>(?:\\s+|$)([\\s\\S]*)$`);
    const matched = message.content.match(mentionPattern);
    if (!matched) return;

    const input = matched[1].trim();
    const [rawAction, ...rest] = input.split(/\s+/);
    const action = String(rawAction || '').toLowerCase();
    const query = rest.join(' ').trim();

    if (!action || action === 'help') {
      return message.reply({
        content: [
          '**Music commands**',
          '`@Bot play <song or YouTube URL>` — play or queue a song',
          '`@Bot add <song or YouTube URL>` — add a song to the queue',
          '`@Bot pause` · `@Bot resume` · `@Bot skip` · `@Bot stop` · `@Bot leave`',
        ].join('\n'),
        allowedMentions: { repliedUser: false },
      });
    }

    if (action === 'play' || action === 'add') {
      if (!query) return message.reply({ content: 'Use `@Bot play <song name or YouTube URL>`.', allowedMentions: { repliedUser: false } });
      const result = await playMusic({
        guild: message.guild,
        member: message.member,
        textChannel: message.channel,
        query,
      });
      return message.reply({ content: result, allowedMentions: { repliedUser: false, parse: [] } });
    }

    if (MUSIC_COMMANDS.has(action)) {
      const result = await runMusicControl(message.guild, message.author.id, action);
      return message.reply({ content: result, allowedMentions: { repliedUser: false, parse: [] } });
    }
  } catch (err) {
    console.error('Mention-based music command failed:', err);
    message.reply({
      content: `❌ ${err?.message || 'The music command failed.'}`,
      allowedMentions: { repliedUser: false, parse: [] },
    }).catch(() => {});
  }
});

/* ---------- interactions ---------- */
client.on('interactionCreate', async (i) => {
  try {
    if (!i.guild) return;
    const c = cfg(i.guild.id);

    if (i.isChatInputCommand() && MUSIC_COMMANDS.has(i.commandName)) {
      return handleMusicSlashCommand(i);
    }

    /* new-member verification setup */
    if (i.isChatInputCommand() && i.commandName === 'verify') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission to configure verification.');

      const channel = i.options.getChannel('channel', true);
      const memberRole = i.options.getRole('member-role', true);
      const unverifiedRole = i.options.getRole('unverified-role');

      if (memberRole.id === i.guild.id) {
        return reply(i, '❌ The Member role cannot be @everyone. Choose a regular role.');
      }
      if (unverifiedRole && (unverifiedRole.id === i.guild.id || unverifiedRole.id === memberRole.id)) {
        return reply(i, '❌ Choose a different role for Unverified.');
      }
      if (memberRole.managed || (unverifiedRole && unverifiedRole.managed)) {
        return reply(i, '❌ Managed integration/bot roles cannot be assigned by this verification system.');
      }

      const botMember = await i.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return reply(i, '❌ I need the **Manage Roles** permission to give members their role.');
      }
      if (botMember.roles.highest.comparePositionTo(memberRole) <= 0) {
        return reply(i, `❌ Move my bot role above **${memberRole.name}** in Server Settings → Roles.`);
      }
      if (unverifiedRole && botMember.roles.highest.comparePositionTo(unverifiedRole) <= 0) {
        return reply(i, `❌ Move my bot role above **${unverifiedRole.name}** in Server Settings → Roles.`);
      }

      const channelPermissions = channel.permissionsFor(botMember);
      if (!channelPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ])) {
        return reply(i, `❌ I need View Channel and Send Messages permissions in ${channel}.`);
      }

      const panel = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Server Verification')
        .setDescription('Welcome! Press the **Verify** button below to confirm you are joining the server. Once verified, you will automatically receive the Member role.');

      try {
        await channel.send({ embeds: [panel], components: [verificationButtonRow()] });
      } catch (err) {
        console.error('Could not post verification panel:', err);
        return reply(i, `❌ I could not post in ${channel}. Check my channel permissions and try again.`);
      }

      c.verifyChannelId = channel.id;
      c.verifyMemberRoleId = memberRole.id;
      c.verifyUnverifiedRoleId = unverifiedRole?.id || null;
      save();

      return reply(i, [
        `✅ Verification is configured in ${channel}.`,
        `**After verifying:** <@&${memberRole.id}>`,
        unverifiedRole ? `**While waiting:** <@&${unverifiedRole.id}>` : '**While waiting:** no temporary role configured.',
        'New members will receive a verification prompt in that channel when they join.',
      ].join('\n'));
    }

    /* member verification button */
    if (i.isButton() && i.customId === 'member_verify') {
      if (!c.verifyMemberRoleId || !c.verifyChannelId) {
        return reply(i, '❌ Verification is not configured yet. Ask a server admin to run `/verify setup`.');
      }
      if (i.channelId !== c.verifyChannelId) {
        return reply(i, `❌ Please verify in <#${c.verifyChannelId}>.`);
      }

      const member = await i.guild.members.fetch(i.user.id);
      const memberRole = await i.guild.roles.fetch(c.verifyMemberRoleId);
      if (!memberRole || memberRole.managed) {
        return reply(i, '❌ The configured Member role no longer exists or cannot be assigned. Ask an admin to run `/verify setup` again.');
      }
      if (member.roles.cache.has(memberRole.id)) {
        return reply(i, '✅ You are already verified and have the Member role.');
      }

      const botMember = await i.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) || botMember.roles.highest.comparePositionTo(memberRole) <= 0) {
        return reply(i, '❌ I cannot assign the Member role. Check my Manage Roles permission and role position.');
      }

      try {
        await member.roles.add(memberRole, 'Member completed server verification');
      } catch (err) {
        console.error('Could not assign Member role:', err);
        return reply(i, `❌ I could not assign the Member role (${err.message}). Ask an admin to check my Manage Roles permission and role position.`);
      }

      let pendingRoleWarning = '';
      if (c.verifyUnverifiedRoleId) {
        try {
          const pendingRole = await i.guild.roles.fetch(c.verifyUnverifiedRoleId);
          if (pendingRole) {
            if (botMember.roles.highest.comparePositionTo(pendingRole) <= 0) {
              pendingRoleWarning = ' I could not remove your Unverified role because my bot role is not above it.';
            } else {
              await member.roles.remove(pendingRole, 'Member completed server verification');
            }
          }
        } catch (err) {
          console.error('Could not remove unverified role:', err);
          pendingRoleWarning = ' Your Member role was added, but I could not remove your Unverified role. Please contact staff.';
        }
      }

      return reply(i, `✅ Verification complete! You have received <@&${memberRole.id}>.${pendingRoleWarning}`);
    }

    /* manual product restock alerts */
    if (i.isChatInputCommand() && i.commandName === 'restock') {
      const sub = i.options.getSubcommand();

      if (sub === 'setup') {
        if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission to configure the restock channel.');
        const channel = i.options.getChannel('channel');
        c.restockChannelId = channel.id;
        save();
        return reply(i, `✅ Restock alerts will be posted in ${channel}.`);
      }

      if (sub === 'setting') {
        if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission to edit restock settings.');
        return i.reply({ ...restockSettingsOverview(i.guild), flags: MessageFlags.Ephemeral });
      }

      if (sub === 'post') {
        if (!(isAdmin(i) || isStaff(i, c))) return reply(i, '❌ Only admins or ticket staff can post restock alerts.');
        if (!c.restockChannelId) {
          return reply(i, '❌ No restock channel is configured. An admin must run `/restock setup` first.');
        }

        const product = i.options.getString('product', true).trim();
        const price = i.options.getString('price', true).trim();
        const stock = i.options.getInteger('stock', true);
        const announcement = i.options.getString('message')?.trim() || 'Our product has just been restocked!';
        const imageInput = i.options.getString('image')?.trim() || '';

        if (!product || !price || !Number.isSafeInteger(stock) || stock < 1) {
          return reply(i, '❌ Enter a product name, price, and stock quantity greater than zero.');
        }

        let productImageUrl = null;
        if (imageInput) {
          try {
            const parsedImage = new URL(imageInput);
            if (!['https:', 'http:'].includes(parsedImage.protocol)) throw new Error('Unsupported image URL protocol');
            productImageUrl = parsedImage.toString();
          } catch {
            return reply(i, '❌ The image must be a valid HTTP or HTTPS URL.');
          }
        }

        let target;
        try {
          target = await i.guild.channels.fetch(c.restockChannelId);
        } catch (err) {
          console.error('Restock channel fetch failed:', err);
        }
        if (!target || target.type !== ChannelType.GuildText) {
          c.restockChannelId = null;
          save();
          return reply(i, '❌ The saved restock channel is missing or is not a text channel. An admin must run `/restock setup` again.');
        }

        const botMember = await i.guild.members.fetchMe();
        const permissions = target.permissionsFor(botMember);
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          return reply(i, `❌ I need View Channel, Send Messages, and Embed Links permissions in ${target}.`);
        }

        const embed = buildRestockEmbed(
          i.guild,
          product,
          price,
          stock,
          announcement,
          productImageUrl,
          c,
        );

        try {
          await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
          return reply(i, `✅ Restock alert for **${product}** posted in ${target}.`);
        } catch (err) {
          console.error('Restock alert send failed:', err);
          return reply(i, `❌ I couldn't post in ${target}. Check my Send Messages and Embed Links permissions.`);
        }
      }
    }

    /* interactive restock settings */
    if (i.isStringSelectMenu() && i.customId === 'restock_settings_field') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const key = i.values[0];
      if (!RESTOCK_SETTING_FIELDS[key]) return reply(i, '❌ Unknown restock setting.');
      const settings = getRestockSettings(c);
      return i.showModal(restockSettingModal(key, settings[key]));
    }

    if (i.isButton() && i.customId === 'restock_settings_toggle_icon') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const settings = getRestockSettings(c);
      settings.showServerIcon = !settings.showServerIcon;
      save();
      return i.update(restockSettingsOverview(i.guild, `✅ Server icon ${settings.showServerIcon ? 'enabled' : 'hidden'}.`));
    }

    if (i.isButton() && i.customId === 'restock_settings_toggle_timestamp') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const settings = getRestockSettings(c);
      settings.showTimestamp = !settings.showTimestamp;
      save();
      return i.update(restockSettingsOverview(i.guild, `✅ Timestamp ${settings.showTimestamp ? 'enabled' : 'hidden'}.`));
    }

    if (i.isButton() && i.customId === 'restock_settings_reset') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      c.restockSettings = { ...DEFAULT_RESTOCK_SETTINGS };
      save();
      return i.update(restockSettingsOverview(i.guild, '✅ Restock appearance restored to default settings.'));
    }

    if (i.isButton() && i.customId === 'restock_settings_preview') {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const preview = buildRestockEmbed(
        i.guild,
        'Example Product',
        '₹850',
        3,
        'This is an example restock announcement. Edit the settings to change this text.',
        null,
        c,
      );
      return i.reply({ content: '👁️ **Restock embed preview**', embeds: [preview], flags: MessageFlags.Ephemeral });
    }

    if (i.isModalSubmit() && i.customId.startsWith('restock_settings_modal:')) {
      if (!isAdmin(i)) return reply(i, '❌ You need Manage Server permission.');
      const key = i.customId.slice('restock_settings_modal:'.length);
      const meta = RESTOCK_SETTING_FIELDS[key];
      if (!meta) return reply(i, '❌ Unknown restock setting.');
      const value = i.fields.getTextInputValue('value').trim();
      const settings = getRestockSettings(c);

      if (key === 'color') {
        const normalizedColor = value.replace(/^#/, '');
        if (!/^[0-9a-fA-F]{6}$/.test(normalizedColor)) {
          return reply(i, '❌ Enter a valid 6-digit hex color, for example `#22B8CF`.');
        }
        settings.color = normalizedColor.toUpperCase();
      } else {
        if (value.length > meta.max) return reply(i, `❌ This setting can be at most ${meta.max} characters.`);
        settings[key] = value;
      }

      save();
      return i.reply({
        ...restockSettingsOverview(i.guild, `✅ **${meta.label}** saved successfully.`),
        flags: MessageFlags.Ephemeral,
      });
    }

    /* slash commands */
    if (i.isChatInputCommand() && i.commandName === 'ticket') {
      const sub = i.options.getSubcommand();
      const adminOnly = ['settings', 'setup', 'transcript-channel', 'staff-role', 'category-add', 'category-remove', 'closed-category'];
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

    /* buttons on a closed ticket */
    if (i.isButton() && i.customId === 'ticket_reopen_closed') {
      return reopenClosedTicket(i);
    }
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

if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_TOKEN.trim()) {
  console.error('Missing DISCORD_TOKEN. Add your bot token in Railway Variables.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Discord login failed. Check DISCORD_TOKEN and bot configuration:', err);
  process.exit(1);
});
