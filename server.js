const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const LLM_URL = process.env.LLM_URL || "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const API_KEY = process.env.GROQ_API_KEY;

// Abuse limits: the endpoint is public, so cap request size and rate per IP.
const MAX_BODY_BYTES = 20 * 1024;
const MAX_STORIES = 10;
const RATE_LIMIT = 60; // requests per IP per window
const RATE_WINDOW_MS = 60 * 1000;

const PAGE_PATH = path.join(__dirname, "public", "index.html");

if (!API_KEY) {
  console.error("GROQ_API_KEY is not set. Set it before starting the server.");
  process.exit(1);
}

const hits = new Map(); // ip -> { count, resetAt }

function clientIp(req) {
  // Behind a host's proxy (Render, Railway, ...) the real IP is the first X-Forwarded-For entry.
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress) || "unknown";
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function validStory(s) {
  return (
    s &&
    (typeof s.id === "string" || typeof s.id === "number") &&
    String(s.id).length <= 20 &&
    typeof s.title === "string" &&
    s.title.length > 0 &&
    s.title.length <= 300 &&
    (s.url == null || (typeof s.url === "string" && s.url.length <= 500))
  );
}

// The model is asked for a bare JSON object, but models sometimes wrap it in a code fence or add a preamble.
function parseSummaries(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Model reply was not JSON");
  const parsed = JSON.parse(text.slice(start, end + 1));
  const out = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim()) out[id] = value.trim();
  }
  return out;
}

async function handleSummarize(req, res) {
  if (rateLimited(clientIp(req))) {
    sendJson(res, 429, { error: "Too many requests, try again in a minute" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid or oversized JSON body" });
    return;
  }

  const { industry, stories } = body;
  if (typeof industry !== "string" || !industry || industry.length > 60) {
    sendJson(res, 400, { error: "industry is required (max 60 characters)" });
    return;
  }
  if (!Array.isArray(stories) || stories.length === 0 || stories.length > MAX_STORIES || !stories.every(validStory)) {
    sendJson(res, 400, { error: `stories must be 1-${MAX_STORIES} items with id and title (title max 300 characters)` });
    return;
  }

  const list = stories
    .map((s) => `id ${JSON.stringify(String(s.id))}: ${s.title} (${s.url || "no url"})`)
    .join("\n");
  const prompt =
    `For each Hacker News story below, write exactly 2 sentences explaining why it matters for the ${industry} industry.\n` +
    `Reply with ONLY a JSON object that maps each story id (as a string) to its 2-sentence summary. No other text.\n\n` +
    list;

  try {
    const llmRes = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        reasoning_effort: "low",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await llmRes.json();
    if (!llmRes.ok) {
      throw new Error(data.error?.message || `LLM request failed with status ${llmRes.status}`);
    }

    const content = data.choices?.[0]?.message?.content?.trim() || "";
    const parsed = parseSummaries(content);
    // Only return summaries for ids that were asked about.
    const summaries = {};
    for (const s of stories) {
      const id = String(s.id);
      if (parsed[id]) summaries[id] = parsed[id];
    }
    sendJson(res, 200, { summaries });
  } catch (err) {
    console.error("Summarize failed:", err.message);
    sendJson(res, 502, { error: "Summary service unavailable, try again later" });
  }
}

const server = http.createServer((req, res) => {
  // Page and API share one origin, so no CORS headers are needed (or sent).
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    fs.readFile(PAGE_PATH, (err, html) => {
      if (err) {
        sendJson(res, 500, { error: "Page not found" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/summarize") {
    handleSummarize(req, res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`HN Industry Digest listening on http://localhost:${PORT}`);
});
