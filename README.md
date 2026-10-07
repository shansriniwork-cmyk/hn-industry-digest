# HN Industry Digest

Top 5 Hacker News stories, each with a two-sentence "why this matters" summary for the industry you pick. One Node server (no dependencies) serves the page and a `/api/summarize` endpoint that calls Groq. The API key stays on the server.

```
server.js          Node server: serves the page, POST /api/summarize, rate limit
public/index.html  the page
```

## Run locally

Needs Node 18 or newer and a Groq API key.

```
export GROQ_API_KEY="your_groq_key"
node server.js
```

Open http://localhost:3000.

Optional: `GROQ_MODEL` changes the model (default `openai/gpt-oss-20b`), `PORT` changes the port.

## Deploy on Render (free tier)

1. Push this folder to a GitHub repo. Never commit your key (`.env` is git-ignored).
2. On render.com choose New → Web Service and connect the repo.
3. Runtime: Node. Build command: leave empty. Start command: `node server.js`.
4. Under Environment, add `GROQ_API_KEY` with your key.
5. Deploy. Render gives you a public URL that serves the page and the API together.

Railway and Fly.io work the same way: run `node server.js` and set `GROQ_API_KEY` as a secret.

## Protection for a public site

The endpoint is public, so anyone with the link can use your Groq quota. Built in: 20 KB request cap, input length limits, and 60 requests per minute per IP. For more, set a spending or usage limit in your Groq account, and rotate the key if you see unexpected usage.
