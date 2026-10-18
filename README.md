# pi-web-mini

Minimal web access for the [pi coding agent](https://pi.dev). Two tools, two commands, zero runtime dependencies.

```
web_search  Exa /search — title, URL, date, short snippet per result
web_fetch   dual mode: builtin (plain text) | exa (markdown)

/webauth <key>       store Exa API key in ~/.pi/agent/web-mini.json
/webauth             show key status (masked, file vs env source)
/webmode [builtin|exa]  show or switch web_fetch mode (applies immediately)
```

## Tools

**web_search** — always Exa. Lean by design: returns one compact block per result (default 5, `numResults` 1–10); the model calls `web_fetch` only for pages it needs.

**web_fetch** — mode switched at call time, no reload needed:

| mode | source | output |
|---|---|---|
| `builtin` (default) | direct fetch | plain text — script/style/comments stripped, block tags → newlines, entities decoded. Links lost. |
| `exa` | Exa `/contents` | Exa-cleaned text — keeps headings and code blocks; inline links are **not** guaranteed (Exa's extraction decides). `livecrawl: fallback`. |

## API key

`/webauth <key>` writes `exaApiKey` to `~/.pi/agent/web-mini.json`. Fallback: `EXA_API_KEY` environment variable. Config is read on every tool call, so edits apply instantly. web_search requires a key; in `exa` fetch mode a missing key is an error — switch to `builtin` or set the key.

## Guards (both fetch paths)

- http/https only; DNS-based SSRF block of private/loopback/link-local targets
- 30 s total timeout, ~2 MiB body cap, textual content-types only
- model-facing text capped at 20 000 chars with a truncation marker
- Known limitation: redirects are followed by fetch itself, so a public URL redirecting to a private host is not re-checked.

## Install

```bash
pi install D:/Source/pi-web-mini        # local
# or
pi install git:github.com/kapojko/pi-web-mini
```

## Check

```bash
npm install && npm run check
```
