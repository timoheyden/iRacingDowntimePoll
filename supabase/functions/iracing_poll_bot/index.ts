import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import nacl from "https://esm.sh/tweetnacl@1.0.3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// =====================
// ENV
// =====================
const SUPABASE_URL = Deno.env.get("MY_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("MY_SERVICE_ROLE_KEY")!;
const DISCORD_PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// =====================
// HELPERS
// =====================
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hexToUint8Array(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return arr;
}

function verifySignature(body: string, signature: string, timestamp: string): boolean {
  const encoder = new TextEncoder();
  return nacl.sign.detached.verify(
      encoder.encode(timestamp + body),
      hexToUint8Array(signature),
      hexToUint8Array(DISCORD_PUBLIC_KEY),
  );
}

function calculateWinner(guesses: any[], actualValue: number) {
  let winner = null;
  let bestDiff = Infinity;

  for (const g of guesses) {
    const diff = Math.abs(g.guess_value - actualValue);
    if (diff < bestDiff) {
      bestDiff = diff;
      winner = g.user_id;
    }
  }
  return winner;
}

function parseTimeToSeconds(value: string): number | null {
  const parts = value.split(":");
  if (parts.length !== 2) return null;

  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);

  if (isNaN(minutes) || isNaN(seconds)) return null;

  return minutes * 60 + seconds;
}


// =====================
// MAIN
// =====================
serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) return json({ error: "Missing signature headers" }, 401);

  const body = await req.text();
  if (!verifySignature(body, signature, timestamp)) {
    return json({ error: "Invalid request signature" }, 401);
  }

  const payload = JSON.parse(body);

  // Discord ping
  if (payload.type === 1) return json({ type: 1 });

  const { name, options } = payload.data;
  const guildId = payload.guild_id;

  // ===================== POLLSTART
  if (name === "pollstart") {
    const channelId = payload.channel_id;

    const { data: poll } = await supabase
        .from("iracing_downtime_poll.polls")
        .insert({ server_id: guildId, channel_id: channelId, started_at: new Date().toISOString() })
        .select("*")
        .single();

    return json({
      type: 4,
      data: { content: `✅ Poll started! ID: ${poll?.id}` },
    });
  }

  // ===================== POLLCLOSE
  if (name === "pollclose") {
    const { data: openPolls } = await supabase
        .from("iracing_downtime_poll.polls")
        .select("*")
        .eq("server_id", guildId)
        .is("ended_at", null)
        .order("started_at", { ascending: false })
        .limit(1);

    if (!openPolls || openPolls.length === 0) {
      return json({ type: 4, data: { content: "No active poll found for this guild." } });
    }

    const pollId = openPolls[0].id;

    const actualValueRaw = options.find((o: any) => o.name === "zeit")?.value;
    if (!actualValueRaw) {
      return json({
        type: 4,
        data: { content: "Actual time (zeit) is required (MM:SS)." },
      });
    }

    const actualValue = parseTimeToSeconds(String(actualValueRaw));
    if (actualValue === null) {
      return json({
        type: 4,
        data: { content: "Invalid time format. Use MM:SS (e.g. 15:30)." },
      });
    }

    const { data: guesses, error: guessesError } = await supabase
        .from("iracing_downtime_poll.guesses")
        .select("*")
        .eq("poll_id", pollId);

    if (guessesError) {
      return json({
        type: 4,
        data: { content: "Failed to load guesses." },
      });
    }

    const winner = calculateWinner(guesses || [], actualValue);

    const { error } = await supabase
        .from("iracing_downtime_poll.polls")
        .update({
          ended_at: new Date().toISOString(),
          winner: winner
        })
        .eq("id", pollId);

    if (error) {
      return json({
        type: 4,
        data: { content: "Failed to close poll." },
      });
    }

    return json({
      type: 4,
      data: { content: `🛑 Poll ${pollId} closed! Winner: <@${winner}>` },
    });
  }

  // ===================== GUESS
  if (name === "guess") {
    const guessValue = options.find((o: any) => o.name === "zeit")?.value;
    if (guessValue === undefined) {
      return json({ type: 4, data: { content: "Guess value is required." } });
    }

    const { data: openPolls } = await supabase
        .from("iracing_downtime_poll.polls")
        .select("*")
        .eq("server_id", guildId)
        .is("ended_at", null)
        .order("started_at", { ascending: false })
        .limit(1);

    if (!openPolls || openPolls.length === 0) {
      return json({ type: 4, data: { content: "No active poll to submit a guess." } });
    }

    const pollId = openPolls[0].id;
    const userId = payload.member?.user?.id ?? "unknown";

    const { data: existingGuess } = await supabase
        .from("iracing_downtime_poll.guesses")
        .select("id")
        .eq("poll_id", pollId)
        .eq("user_id", userId)
        .maybeSingle();

    if (existingGuess) {
      return json({
        type: 4,
        data: {
          content: "❌ You have already submitted a guess for this poll."
        },
      });
    }

    const parsed = parseTimeToSeconds(String(guessValue));

    if (parsed === null) {
      return json({
        type: 4,
        data: { content: "Invalid time format. Please use MM:SS (e.g. 15:30)." },
      });
    }

    const { error } = await supabase
        .from("iracing_downtime_poll.guesses")
        .insert({
          poll_id: pollId,
          user_id: userId,
          guess_value: parsed,
        });

    if (error) {
      return json({
        type: 4,
        data: { content: "Failed to store your guess." },
      });
    }

    return json({
      type: 4,
      data: { content: `✅ Your guess has been recorded.` },
    });
  }

  // ===================== LIST POLLS
  if (name === "listpolls") {
    const { data: polls } = await supabase
        .from("iracing_downtime_poll.polls")
        .select("*")
        .eq("server_id", guildId)
        .order("started_at", { ascending: false });

    if (!polls || polls.length === 0) {
      return json({ type: 4, data: { content: "No polls found for this guild." } });
    }

    const fields = polls.map((p) => ({
      name: `Poll ID: ${p.id}`,
      value: `Channel: ${p.channel_id}\nStarted: ${p.started_at}\nEnded: ${p.ended_at ?? "Active"}\nWinner: ${p.winner ?? "TBD"}`,
      inline: false,
    }));

    return json({
      type: 4,
      data: { embeds: [{ title: "Polls in this Guild", color: 0x00ff99, fields }] },
    });
  }

  // ===================== LIST GUESSES
  if (name === "guesses") {
    const { data: latestPolls } = await supabase
        .from("iracing_downtime_poll.polls")
        .select("*")
        .eq("server_id", guildId)
        .order("started_at", { ascending: false })
        .limit(1);

    if (!latestPolls || latestPolls.length === 0) {
      return json({ type: 4, data: { content: "No poll found for this guild." } });
    }

    const pollId = latestPolls[0].id;

    const { data: guesses } = await supabase
        .from("iracing_downtime_poll.guesses")
        .select("*")
        .eq("poll_id", pollId);

    if (!guesses || guesses.length === 0) {
      return json({ type: 4, data: { content: "No guesses found for this poll." } });
    }

    // Sort by time (guess_value -> HH:MM)
    const sortedGuesses = guesses
        .map(g => {
          const hours = Math.floor(g.guess_value / 60);
          const minutes = g.guess_value % 60;
          const time = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
          return { ...g, time };
        })
        .sort((a, b) => {
          const [ah, am] = a.time.split(":").map(Number);
          const [bh, bm] = b.time.split(":").map(Number);
          return ah === bh ? am - bm : ah - bh;
        });

    const pageSize = 20;
    const totalPages = Math.ceil(sortedGuesses.length / pageSize);

    function makeEmbed(page: number) {
      const start = page * pageSize;
      const pageGuesses = sortedGuesses.slice(start, start + pageSize);
      const list = pageGuesses
          .map(entry => `🕒 \`${entry.time}\` — <@${entry.user_id}>`)
          .join("\n");

      return {
        title: "Current Guesses",
        description: list,
        color: 0x00b0f4,
        footer: {
          text: `Page ${page + 1}/${totalPages} • iRacing Patch Guessing Poll`
        }
      };
    }

    // For simplicity, we return the first page
    return json({
      type: 4,
      data: {
        embeds: [makeEmbed(0)],
        components: totalPages > 1 ? [
          {
            type: 1,
            components: [
              { type: 2, label: "⬅️ Back", style: 1, custom_id: "prev", disabled: true },
              { type: 2, label: "Next ➡️", style: 1, custom_id: "next", disabled: totalPages <= 1 }
            ]
          }
        ] : []
      }
    });
  }

});
