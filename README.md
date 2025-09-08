# iRacing Guessing Bot

A modern Discord bot to run guessing polls for iRacing updates, maintenance, and events.  
Automatically determines the winner, works independently on each server, and offers easy-to-use slash commands!

---

## Features

- **Slash commands** for all core functions
- **Start/close guessing polls** (moderator only)
- **Submit & update guesses** (while a poll is running)
- **Clear display** of all guesses (with paging if there are many entries)
- **Automatic winner detection** (closest guess wins)
- **Independent operation** per Discord server (guild)
- **Persistent storage** of all guesses during a poll

---

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/YOUR_GITHUB/iRacing-guessing-bot.git
   cd iRacing-guessing-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure the bot**
   - Create a `.env` file (see `.env.example`)
   - Enter your Discord Bot Token and Client ID:

     ```
     DISCORD_TOKEN=your_discord_token
     CLIENT_ID=your_client_id
     ```

4. **Start the bot**
   ```bash
   npm start
   ```

---

## Usage

Add the bot to your server and use the following slash commands:

```markdown
**iRacing Guessing Bot – Commands Overview**

/pollstart  
> Starts a new guessing poll (moderators only).

/pollclose [time]  
> Ends the current poll and determines the winner (moderators only).  
> Time format: HH:MM (24h, e.g., 18:30).

/guess [time]  
> Submit your guess for when iRacing will be back online (format: HH:MM, 24h).

/guesses  
> Show all current guesses (with paging for many entries).
```

---

## Example

```
/pollstart
/guess 17:34
/guess 18:10
/guesses
/pollclose 18:45
```

---

## Notes

- The bot only works on servers (not in DMs).
- Each guessing round is **independent per server**.
- Moderator permissions (“Manage Server”) are required to start/close a poll.
- **Winner detection** is automatic and based on the smallest time difference.

---

## Development

- Built with [discord.js](https://discord.js.org/)
- All guesses are stored in `guesses.json`
- Slash command registration happens globally at startup

---

## License

MIT

---

> Have fun guessing and good luck during the next iRacing downtime!
