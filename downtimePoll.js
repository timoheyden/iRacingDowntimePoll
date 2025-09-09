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
const fs = require('fs');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const DATA_FILE = 'guesses.json';

let guesses = {};
let pollActive = {};

function saveGuesses() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(guesses, null, 2));
}
function loadGuesses() {
  if (fs.existsSync(DATA_FILE)) {
    guesses = JSON.parse(fs.readFileSync(DATA_FILE));
  } else {
    guesses = {};
  }
}
loadGuesses();

const commands = [
  new SlashCommandBuilder()
    .setName('pollstart')
    .setDescription('Starte die Schätzungsumfrage (nur Mods)'),
  new SlashCommandBuilder()
    .setName('pollclose')
    .setDescription('Beende die Schätzungsumfrage und bestimme den Gewinner (nur Mods)')
    .addStringOption(option =>
      option.setName('zeit')
        .setDescription('Die tatsächliche Uhrzeit, zu der iRacing wieder online ist (z.B. 18:23)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Gib deine Schätzung ab (Format HH:MM)')
    .addStringOption(option =>
      option.setName('zeit')
        .setDescription('Deine Schätzung im 24h-Format, z.B. 15:30')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('guesses')
    .setDescription('Zeige alle aktuellen Schätzungen an')
].map(cmd => cmd.toJSON());

// Commands global registrieren (bei Bot-Start)
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
  console.log(`Bot angemeldet als ${client.user.tag}`);
});

function logCommand(interaction, extra = {}) {
  const timestamp = new Date().toISOString();
  const cmd = interaction.commandName;
  const user = `${interaction.user.tag} (${interaction.user.id})`;
  const guild = interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})` : 'DM/Unknown';
  const opts = Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join(', ');
  console.log(`[${timestamp}] [Command] ${cmd} von ${user} in ${guild}${opts ? ' | ' + opts : ''}`);
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (!interaction.guild) {
    return interaction.reply({ content: 'Dieser Bot funktioniert nur auf Servern (nicht in DMs).', ephemeral: true });
  }
  const guildId = interaction.guild.id;

  // /pollstart
  if (interaction.commandName === 'pollstart') {
    logCommand(interaction);
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'Nur Mods können die Umfrage starten!', ephemeral: true });
    }
    guesses[guildId] = {};
    pollActive[guildId] = true;
    saveGuesses();
    return interaction.reply('Die Schätzungs-Umfrage ist gestartet! Gib deine Schätzung mit `/guess` ab.');
  }

  // /pollclose
  if (interaction.commandName === 'pollclose') {
    const realTime = interaction.options.getString('zeit');
    logCommand(interaction, { zeit: realTime });
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'Nur Mods können die Umfrage schließen!', ephemeral: true });
    }
    if (!pollActive[guildId]) return interaction.reply({ content: 'Es läuft keine aktive Umfrage.', ephemeral: true });

    if (!/^[0-2][0-9]:[0-5][0-9]$/.test(realTime)) {
      return interaction.reply({ content: 'Bitte gib die Zeit im Format HH:MM an.', ephemeral: true });
    }

    pollActive[guildId] = false;
    const [realHour, realMinute] = realTime.split(':').map(Number);
    const referenceDate = new Date();
    referenceDate.setHours(realHour, realMinute, 0, 0);

    let winner = null;
    let minDiff = Infinity;
    Object.entries(guesses[guildId] || {}).forEach(([userId, entry]) => {
      const [h, m] = entry.time.split(':').map(Number);
      const guessDate = new Date(referenceDate);
      guessDate.setHours(h, m, 0, 0);
      let diff = Math.abs(guessDate - referenceDate);
      if (diff < minDiff) {
        minDiff = diff;
        winner = { userId, time: entry.time };
      }
    });

    guesses[guildId] = {};
    saveGuesses();

    if (winner) {
      return interaction.reply(
        `Umfrage geschlossen!\nRichtige Uhrzeit: **${realTime}**\nGewinner: <@${winner.userId}> mit Schätzung **${winner.time}**.`
      );
    } else {
      return interaction.reply('Umfrage geschlossen! Keine gültigen Schätzungen vorhanden.');
    }
  }

  // /guess
  if (interaction.commandName === 'guess') {
    const zeit = interaction.options.getString('zeit');
    logCommand(interaction, { zeit });
    if (!pollActive[guildId]) return interaction.reply({ content: 'Es läuft aktuell keine aktive Umfrage.', ephemeral: true });
    if (!/^[0-2][0-9]:[0-5][0-9]$/.test(zeit)) {
      return interaction.reply({ content: 'Bitte gib deine Schätzung im Format HH:MM (24h) an.', ephemeral: true });
    }
    if (!guesses[guildId]) guesses[guildId] = {};
    if (guesses[guildId][interaction.user.id]) {
      return interaction.reply({ content: 'Du hast bereits eine Schätzung abgegeben! Nur eine Schätzung pro Person erlaubt.', ephemeral: true });
    }
    guesses[guildId][interaction.user.id] = {
      name: interaction.user.username,
      time: zeit
    };
    saveGuesses();
    return interaction.reply({ content: `Deine Schätzung **${zeit}** wurde gespeichert.`, ephemeral: true });
  }

  // /guesses
  if (interaction.commandName === 'guesses') {
    logCommand(interaction);
    if (!guesses[guildId] || Object.keys(guesses[guildId]).length === 0) {
      return interaction.reply('Noch keine Schätzungen vorhanden.');
    }

    const sortedGuesses = Object.entries(guesses[guildId]).sort((a, b) => {
      const [ah, am] = a[1].time.split(':').map(Number);
      const [bh, bm] = b[1].time.split(':').map(Number);
      return ah === bh ? am - bm : ah - bh;
    });

    const pageSize = 20;
    const totalPages = Math.ceil(sortedGuesses.length / pageSize);

    function makeEmbed(page) {
      const start = page * pageSize;
      const pageGuesses = sortedGuesses.slice(start, start + pageSize);
      const list = pageGuesses
        .map(([userId, entry]) => `🕒 \`${entry.time}\` — <@${userId}>`)
        .join('\n');
      return new EmbedBuilder()
        .setTitle('Aktuelle Schätzungen')
        .setDescription(list)
        .setColor(0x00b0f4)
        .setFooter({ text: `Seite ${page + 1}/${totalPages} • iRacing Patch Schätzungsumfrage`, iconURL: client.user.displayAvatarURL() });
    }

    let currentPage = 0;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('prev')
        .setLabel('⬅️ Zurück')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('next')
        .setLabel('Weiter ➡️')
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
