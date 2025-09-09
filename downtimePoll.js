const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  PermissionsBitField, 
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING;

const pool = new Pool({ connectionString: PG_CONNECTION_STRING });

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guesses (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      username TEXT NOT NULL,
      time VARCHAR(5) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS polls (
      guild_id VARCHAR(32) PRIMARY KEY,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
ensureTables();

const commands = [
  new SlashCommandBuilder()
    .setName('pollstart')
    .setDescription('Start the guessing poll (mods only)'),
  new SlashCommandBuilder()
    .setName('pollclose')
    .setDescription('End the guessing poll and determine the winner (mods only)')
    .addStringOption(option =>
      option.setName('zeit')
        .setDescription('The actual time when iRacing is back online (e.g. 18:23)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Submit your guess (format HH:MM)')
    .addStringOption(option =>
      option.setName('zeit')
        .setDescription('Your guess in 24h format, e.g. 15:30')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('guesses')
    .setDescription('Show all current guesses')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log('Slash commands registered globally!');
  } catch (error) {
    console.error(error);
  }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

function logCommand(interaction, extra = {}) {
  const timestamp = new Date().toISOString();
  const cmd = interaction.commandName;
  const user = `${interaction.user.tag} (${interaction.user.id})`;
  const guild = interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})` : 'DM/Unknown';
  const opts = Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join(', ');
  console.log(`[${timestamp}] [Command] ${cmd} by ${user} in ${guild}${opts ? ' | ' + opts : ''}`);
}

async function isPollActive(guildId) {
  const { rows } = await pool.query('SELECT active FROM polls WHERE guild_id = $1', [guildId]);
  return rows[0]?.active ?? false;
}
async function setPollActive(guildId, active) {
  await pool.query(`
    INSERT INTO polls (guild_id, active, updated_at) 
    VALUES ($1, $2, NOW())
    ON CONFLICT (guild_id) DO UPDATE SET active = EXCLUDED.active, updated_at = NOW()
  `, [guildId, active]);
}
async function clearGuesses(guildId) {
  await pool.query('DELETE FROM guesses WHERE guild_id = $1', [guildId]);
}
async function addGuess(guildId, userId, username, time) {
  await pool.query(`
    INSERT INTO guesses (guild_id, user_id, username, time)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (guild_id, user_id) DO NOTHING
  `, [guildId, userId, username, time]);
}
async function hasGuess(guildId, userId) {
  const { rows } = await pool.query('SELECT 1 FROM guesses WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  return rows.length > 0;
}
async function getGuesses(guildId) {
  const { rows } = await pool.query('SELECT user_id, username, time FROM guesses WHERE guild_id = $1', [guildId]);
  return rows;
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (!interaction.guild) {
    return interaction.reply({ content: 'This bot works only on servers (not in DMs).', ephemeral: true });
  }
  const guildId = interaction.guild.id;

  if (interaction.commandName === 'pollstart') {
    logCommand(interaction);
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'Only mods can start the poll!', ephemeral: true });
    }
    await clearGuesses(guildId);
    await setPollActive(guildId, true);
    return interaction.reply('The guessing poll is now open! Submit your guess with `/guess`.');
  }

  if (interaction.commandName === 'pollclose') {
    const realTime = interaction.options.getString('zeit');
    logCommand(interaction, { zeit: realTime });
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'Only mods can close the poll!', ephemeral: true });
    }
    if (!await isPollActive(guildId)) {
      return interaction.reply({ content: 'There is no active poll.', ephemeral: true });
    }

    if (!/^[0-2][0-9]:[0-5][0-9]$/.test(realTime)) {
      return interaction.reply({ content: 'Please provide the time in the format HH:MM.', ephemeral: true });
    }

    await setPollActive(guildId, false);

    const [realHour, realMinute] = realTime.split(':').map(Number);
    const referenceDate = new Date();
    referenceDate.setHours(realHour, realMinute, 0, 0);

    const guesses = await getGuesses(guildId);

    let winner = null;
    let minDiff = Infinity;
    guesses.forEach(entry => {
      const [h, m] = entry.time.split(':').map(Number);
      const guessDate = new Date(referenceDate);
      guessDate.setHours(h, m, 0, 0);
      let diff = Math.abs(guessDate - referenceDate);
      if (diff < minDiff) {
        minDiff = diff;
        winner = entry;
      }
    });

    await clearGuesses(guildId);

    if (winner) {
      return interaction.reply(
        `Poll closed!\nActual time: **${realTime}**\nWinner: <@${winner.user_id}> with guess **${winner.time}**.`
      );
    } else {
      return interaction.reply('Poll closed! No valid guesses submitted.');
    }
  }

  if (interaction.commandName === 'guess') {
    const zeit = interaction.options.getString('zeit');
    logCommand(interaction, { zeit });
    if (!await isPollActive(guildId)) {
      return interaction.reply({ content: 'There is currently no active poll.', ephemeral: true });
    }
    if (!/^[0-2][0-9]:[0-5][0-9]$/.test(zeit)) {
      return interaction.reply({ content: 'Please enter your guess in the format HH:MM (24h).', ephemeral: true });
    }
    if (await hasGuess(guildId, interaction.user.id)) {
      return interaction.reply({ content: 'You have already submitted a guess! Only one guess per person allowed.', ephemeral: true });
    }
    await addGuess(guildId, interaction.user.id, interaction.user.username, zeit);
    return interaction.reply({ content: `Your guess **${zeit}** has been saved.`, ephemeral: true });
  }

  if (interaction.commandName === 'guesses') {
    logCommand(interaction);
    const entries = await getGuesses(guildId);
    if (entries.length === 0) {
      return interaction.reply('No guesses submitted yet.');
    }

    const sortedGuesses = entries.sort((a, b) => {
      const [ah, am] = a.time.split(':').map(Number);
      const [bh, bm] = b.time.split(':').map(Number);
      return ah === bh ? am - bm : ah - bh;
    });

    const pageSize = 20;
    const totalPages = Math.ceil(sortedGuesses.length / pageSize);

    function makeEmbed(page) {
      const start = page * pageSize;
      const pageGuesses = sortedGuesses.slice(start, start + pageSize);
      const list = pageGuesses
        .map(entry => `🕒 \`${entry.time}\` — <@${entry.user_id}>`)
        .join('\n');
      return new EmbedBuilder()
        .setTitle('Current Guesses')
        .setDescription(list)
        .setColor(0x00b0f4)
        .setFooter({ text: `Page ${page + 1}/${totalPages} • iRacing Patch Guessing Poll`, iconURL: client.user.displayAvatarURL() });
    }

    let currentPage = 0;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('prev')
        .setLabel('⬅️ Back')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('next')
        .setLabel('Next ➡️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(totalPages <= 1)
    );

    await interaction.reply({ embeds: [makeEmbed(0)], components: [row] });

    if (totalPages <= 1) return;

    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 2 * 60 * 1000,
      filter: i => i.user.id === interaction.user.id,
    });

    collector.on('collect', async i => {
      if (i.customId === 'prev' && currentPage > 0) {
        currentPage--;
      }
      if (i.customId === 'next' && currentPage < totalPages - 1) {
        currentPage++;
      }
      row.components[0].setDisabled(currentPage === 0);
      row.components[1].setDisabled(currentPage === totalPages - 1);
      await i.update({ embeds: [makeEmbed(currentPage)], components: [row] });
    });

    collector.on('end', async () => {
      row.components[0].setDisabled(true);
      row.components[1].setDisabled(true);
      await message.edit({ components: [row] });
    });
  }
});

client.login(TOKEN);
