# Max's Closet

Personal closet and secondhand-fit tracker. Cloudflare Worker + D1 database, deployed from this repo.

- **Fit log**: styles tried, approved, passed, with the size that fits and a max secondhand price.
- **Closet**: what you own (seeded from the Notion "Clothing" database on first run).
- **Outfits**: AI outfits built only from your closet.
- **Deal check**: paste a listing or screenshot, get buy / try first / skip.

AI calls run on the Worker, so the API key never reaches your phone.

## Setup (one time)

1. **Connect the repo.** Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick `Max_Closet`. Keep the project name `maxs-closet` (it must match `name` in `wrangler.jsonc`). Defaults are fine: build command empty, deploy command `npx wrangler deploy`. The D1 database (`fit-ledger`) is already bound in `wrangler.jsonc`.
2. **Add the AI key.** Worker → Settings → Variables and Secrets → Add → type *Secret*, name `OPENAI_API_KEY`.
3. **Turn on login.** Worker → Settings → Domains & Routes → workers.dev → *Enable Cloudflare Access*, then Manage → add a policy that allows your email. Until Access is on, the app answers 403 (`ALLOWED_EMAIL` in `wrangler.jsonc` guards every API call).
4. Open the workers.dev URL on your phone, sign in, Share → Add to Home Screen.

On the first request the app creates its tables and loads the 159 items from `src/seed.json`.

## Switching AI provider

Edit `PROVIDER` in `wrangler.jsonc` (`openai`, `gemini` or `anthropic`) and add the matching secret (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`). Optional model overrides: `OPENAI_MODEL` (default `gpt-4o-mini`), `GEMINI_MODEL` (`gemini-flash-latest`), `ANTHROPIC_MODEL` (`claude-haiku-5-5`). Put overrides under `vars` in `wrangler.jsonc`; plain variables set in the dashboard get reset on each deploy.

## Local dev

```
npm install
echo 'OPENAI_API_KEY=sk-...' > .dev.vars
npx wrangler dev
```
Locally, set `ALLOWED_EMAIL` to an empty string in `wrangler.jsonc` or send the `cf-access-authenticated-user-email` header.

Backup: `GET /api/export` downloads everything as JSON.
