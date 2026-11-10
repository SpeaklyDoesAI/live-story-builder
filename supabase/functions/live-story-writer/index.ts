// Writes a Live story draft from the builder's answers and streams the text back.
// The prompt is built here; the browser only sends {answers: {...}}.
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";

// Add a custom domain here later, e.g. "https://story.creativeownersclub.com".
const ALLOWED_ORIGINS = [
  "https://live-story-builder.onrender.com",
];

const MAX_BODY_BYTES = 20 * 1024;
const REQUESTS_PER_HOUR = 10;
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Reads the body but stops as soon as it passes the limit.
async function readLimited(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

// Answers are a flat object of strings or arrays of strings (chips).
function isAnswers(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every((x) =>
    typeof x === "string" || typeof x === "boolean" ||
    (Array.isArray(x) && x.every((y) => typeof y === "string"))
  );
}

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") || "unknown";
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function allowRequest(clientKey: string): Promise<boolean> {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/allow_story_request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({ p_client_key: clientKey, p_per_hour: REQUESTS_PER_HOUR }),
  });
  if (!res.ok) throw new Error(`rate limit check failed: ${res.status} ${await res.text()}`);
  return (await res.json()) === true;
}

function prompt(A: Record<string, unknown>){
  const a = { ...A }; delete a.story; delete a.honest; delete a.who;
  return `You are helping a real person write a short, TRUE personal story they will tell out loud on a TikTok Live. They are on the team at Creative Owners Club, a community that shows everyday people (often renters, people with bad or no credit, ages 40 to 65) how to buy houses with little or no money down and no credit needed, or how to make money with this process.

Right BEFORE this story, they just finished a segment showing viewers how to search Zillow to find houses and sellers who are eager to sell. Right after this story, they will read a member invite script that begins with: "So, since I'm so interested in owning houses, I decided to research how to learn more about it." Do NOT write that line. End the story so it flows naturally into it.

THEIR ANSWERS (JSON):
${JSON.stringify(a, null, 2)}

WRITE THE STORY WITH THESE RULES:
1. Length: 500 to 650 words, so it takes 3 to 5 minutes to say out loud.
2. 2nd grade reading level. Short sentences. Simple words. Write how people talk, not how they write.
3. First person, in their voice. Casual and warm. Like a friend talking.
4. Use ONLY the facts in their answers. Never invent events, people, numbers, places, or results. If a detail would help but is missing, write a short placeholder in square brackets, like [what your landlord said]. Use at most 3 placeholders.
5. Structure, in this order:
   a. A smooth bridge out of the Zillow segment, 2 to 4 sentences. Start by wrapping up the Zillow lesson they just taught (finding houses and sellers who really want to sell) and connect it to their own life, using "zillow_feel" if given (how it felt to look at houses back then). Do not repeat or add any Zillow how-to steps. Then say who they are now.
   b. Life back then. Real numbers if they gave them.
   c. THE MOMENT: slow down here. Paint the one scene so viewers can see it. Use their exact words from scene_words if given. This should be the longest part.
   d. What they believed about themselves back then. Say it plainly, so viewers who believe the same thing feel seen.
   e. The turn (required): how they found out people can buy houses with little or no money down, even with bad or no credit, and how they and their team decided to share it with everyday people through their community. Speak with ownership and confidence about the community: "my team and I," "our community." Stay strictly honest to "status" about their own results. If they are still learning or working on their first deal, do NOT say or hint that they bought a house.
   f. Their why: helping people who want to buy a house (their first, or more than one) or who want to make money with this process, like the person they described. Their own reason must be about people and family, never about money for themselves or commissions.
   g. A closing line or two that sets up wanting to share what they learned with others.
6. Add exactly 2 chat moments on their own lines, worded like: "Type a 1 in the chat if you've ever felt that way." Put one right after the moment and one after the belief.
7. You may add (pause) on its own line once, right after the hardest line.
8. Do not promise results, income, or timelines to viewers. No guru talk. No hype words.
9. Never say "creative financing," "subject-to," "seller financing," or any real estate jargon. Describe what the community teaches only as buying houses with little or no money down and no credit needed, or making money with this process.
10. Never use em dashes or en dashes. Use periods or commas instead.
11. Output ONLY the story text with blank lines between paragraphs. No title, no headings, no notes.`;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.includes(origin)) return json(403, { error: "Origin not allowed" });
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" }, cors);

  const raw = await readLimited(req);
  if (raw === null) return json(413, { error: "Request too large" }, cors);

  let answers: unknown;
  try { answers = JSON.parse(raw)?.answers; } catch { answers = undefined; }
  if (!isAnswers(answers)) return json(400, { error: "Expected {answers: {...}}" }, cors);

  try {
    if (!(await allowRequest(await sha256Hex(clientIp(req))))) {
      return json(429, { error: "Too many requests" }, cors);
    }
  } catch (e) {
    console.error(e);
    return json(500, { error: "Server error" }, cors);
  }

  const stream = anthropic.messages.stream(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt(answers) }],
    },
    { signal: req.signal },
  );
  const events = stream[Symbol.asyncIterator]();

  // Wait for the first event so an upstream failure returns an error status, not an empty 200.
  let first: IteratorResult<Anthropic.MessageStreamEvent>;
  try {
    first = await events.next();
  } catch (e) {
    console.error(e);
    return json(502, { error: "Writer unavailable" }, cors);
  }

  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let r = first; !r.done; r = await events.next()) {
          const ev = r.value;
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            controller.enqueue(enc.encode(ev.delta.text));
          }
        }
        controller.close();
      } catch (e) {
        if (!req.signal.aborted) console.error(e);
        controller.error(e);
      }
    },
    cancel() { stream.abort(); },
  });

  return new Response(body, {
    headers: {
      ...cors,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
