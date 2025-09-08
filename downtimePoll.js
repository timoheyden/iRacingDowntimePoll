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

// Poll status speichern
let pollActive = false;

// guesses laden
let guesses = {};
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

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    // /pollstart
    if (interaction.commandName === 'pollstart') {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return interaction.reply({ content: 'Nur Mods können die Umfrage starten!', ephemeral: true });
        }
        guesses = {};
        pollActive = true;
        saveGuesses();
        return interaction.reply('Die Schätzungs-Umfrage ist gestartet! Gib deine Schätzung mit `/guess` ab.');
    }

    // /pollclose
    if (interaction.commandName === 'pollclose') {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return interaction.reply({ content: 'Nur Mods können die Umfrage schließen!', ephemeral: true });
        }
        if (!pollActive) return interaction.reply({ content: 'Es läuft keine aktive Umfrage.', ephemeral: true });

        const realTime = interaction.options.getString('zeit');
        if (!/^[0-2][0-9]:[0-5][0-9]$/.test(realTime)) {
            return interaction.reply({ content: 'Bitte gib die Zeit im Format HH:MM an.', ephemeral: true });
        }

        pollActive = false;

        // Uhrzeit als Date-Objekt für den Vergleich erstellen (heute)
        const [realHour, realMinute] = realTime.split(':').map(Number);
        const referenceDate = new Date();
        referenceDate.setHours(realHour, realMinute, 0, 0);

        let winner = null;
        let minDiff = Infinity;
        Object.entries(guesses).forEach(([userId, entry]) => {
            const [h, m] = entry.time.split(':').map(Number);
            const guessDate = new Date(referenceDate);
            guessDate.setHours(h, m, 0, 0);
            let diff = Math.abs(guessDate - referenceDate);
            if (diff < minDiff) {
                minDiff = diff;
                winner = { userId, time: entry.time };
            }
        });

        // guesses.json löschen
        if (fs.existsSync(DATA_FILE)) {
            fs.unlinkSync(DATA_FILE);
        }
        guesses = {};

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
        if (!pollActive) return interaction.reply({ content: 'Es läuft aktuell keine aktive Umfrage.', ephemeral: true });
        const zeit = interaction.options.getString('zeit');
        if (!/^[0-2][0-9]:[0-5][0-9]$/.test(zeit)) {
            return interaction.reply({ content: 'Bitte gib deine Schätzung im Format HH:MM (24h) an.', ephemeral: true });
        }
        guesses[interaction.user.id] = {
            name: interaction.user.username,
            time: zeit
        };
        saveGuesses();
        return interaction.reply({ content: `Deine Schätzung **${zeit}** wurde gespeichert.`, ephemeral: true });
    }

    // /guesses (mit Paging und Discord-Mentions)
    if (interaction.commandName === 'guesses') {
        if (Object.keys(guesses).length === 0) {
            return interaction.reply('Noch keine Schätzungen vorhanden.');
        }

        // Sortieren nach Uhrzeit
        const sortedGuesses = Object.entries(guesses).sort((a, b) => {
            const [ah, am] = a[1].time.split(':').map(Number);
            const [bh, bm] = b[1].time.split(':').map(Number);
            return ah === bh ? am - bm : ah - bh;
        });

        const pageSize = 20; // Schätzungen pro Seite
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
            time: 2 * 60 * 1000, // 2 Minuten
            filter: i => i.user.id === interaction.user.id,
        });

        collector.on('collect', async i => {
            if (i.customId === 'prev' && currentPage > 0) {
                currentPage--;
            }
            if (i.customId === 'next' && currentPage < totalPages - 1) {
                currentPage++;
            }

            // Buttons aktualisieren
            row.components[0].setDisabled(currentPage === 0);
            row.components[1].setDisabled(currentPage === totalPages - 1);

            await i.update({ embeds: [makeEmbed(currentPage)], components: [row] });
        });

        collector.on('end', async () => {
            // Buttons deaktivieren, wenn Zeit abgelaufen
            row.components[0].setDisabled(true);
            row.components[1].setDisabled(true);
            await message.edit({ components: [row] });
        });
    }
});

client.login(TOKEN);