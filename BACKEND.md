# NEXORA backend
`server.js` serves the site and proxies AI requests. API keys live only in environment variables on the server.

    ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node server.js      # Node 18+, no dependencies

Optional: PORT, HOST, ANTHROPIC_MODEL, OPENAI_MODEL, RATE_LIMIT_PER_MIN (default 10), ALLOWED_ORIGIN, TRUST_PROXY=1 (behind a reverse proxy with HTTPS).
Put it behind HTTPS. Without any key, live AI stays off and the site works as before.

Data flow: browser -> your server -> provider you picked (Anthropic or OpenAI). Only the prompt text is sent, only after the user ticks consent. The server does not store or log prompts or answers; your host may still log IP and time.
Not verified: calls to the real provider APIs (request format follows their public docs; model names are env-configurable). Test with your own key before relying on it.
After changing index.html run `python3 build-csp.py`. Bump `V` in sw.js when you ship changes, or returning visitors keep the cached copy.
