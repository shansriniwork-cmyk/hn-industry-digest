const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const LLM_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const API_KEY = process.env.GROQ_API_KEY;

// Abuse limits: the endpoint is public, so cap request size and rate per IP.
const MAX_BODY_BYTES = 10 * 1024;
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

  const { title, url, industry } = body;
  if (typeof title !== "string" || typeof industry !== "string" || !title || !industry) {
    sendJson(res, 400, { error: "title and industry are required" });
    return;
  }
  if (title.length > 300 || industry.length > 60 || (url != null && String(url).length > 500)) {
    sendJson(res, 400, { error: "title, url or industry too long" });
    return;
  }

  try {
    const llmRes = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        reasoning_effort: "low",
        messages: [
          {
            role: "user",
            content: `In exactly 2 sentences, explain why this Hacker News story matters for the ${industry} industry.\n\nTitle: ${title}\nURL: ${url || "(no url)"}`,
          },
        ],
      }),
    });

    const data = await llmRes.json();
    if (!llmRes.ok) {
      throw new Error(data.error?.message || `LLM request failed with status ${llmRes.status}`);
    }

    const summary = data.choices?.[0]?.message?.content?.trim() || "";
    sendJson(res, 200, { summary });
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
