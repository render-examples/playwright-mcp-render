# Playwright MCP on Render

Deploy [Playwright MCP](https://github.com/microsoft/playwright-mcp) on Render in one click. Get a hosted, headless-Chromium [MCP](https://modelcontextprotocol.io) server your AI tools can drive over HTTP — no local browser install, no `npx` on every machine.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Ho1yShif/playwright-mcp/tree/render-template)

## What it does

[Playwright MCP](https://github.com/microsoft/playwright-mcp) is a Model Context Protocol server that lets an LLM open a real browser, navigate, click, type, and read pages through structured accessibility snapshots (not screenshots). It normally runs locally via `npx @playwright/mcp`. This template runs it as a single Render web service instead, so any MCP client can connect to a shared HTTPS URL.

It's a **thin wrapper** over the official `mcr.microsoft.com/playwright/mcp` image (headless Chromium already baked in) — no source changes. The wrapper adds the flags Render needs (`--headless`, `--no-sandbox`, `--host 0.0.0.0`) plus an optional locked-down [demo mode](#demo-mode).

For the full tool list, config options, and client setup, see the [upstream README](https://github.com/microsoft/playwright-mcp).

## Deploy

1. Click **Deploy to Render** above (or fork this repo and create a new Blueprint from it).
2. Render reads [`render.yaml`](./render.yaml) and provisions one Docker web service (`playwright-mcp`) on the `standard` plan.
3. Wait for the deploy to go **live**. Your server is at `https://<your-service>.onrender.com/mcp`.

No secrets or API keys are required.

> **Plan sizing:** headless Chromium OOMs on the free/`starter` tier (512 MB), so the Blueprint defaults to `standard` (2 GB). Downgrade only if you've confirmed your workload fits in less.

## Using the app

Point any MCP client at your service's `/mcp` endpoint. For example, with Claude Code:

```bash
claude mcp add --transport http playwright https://<your-service>.onrender.com/mcp
```

Or add it to a client config directly:

```json
{
  "mcpServers": {
    "playwright": {
      "url": "https://<your-service>.onrender.com/mcp"
    }
  }
}
```

Then ask your assistant to browse — e.g. *"Open example.com and give me the page title and the main heading."* It will call the Playwright MCP tools against your hosted browser and return the result.

## Configuration

Everything is set in [`render.yaml`](./render.yaml); [`.env.example`](./.env.example) documents the same knobs for running locally.

| Env var | Default | What it's for |
|---------|---------|---------------|
| `PORT` | `10000` | Port the MCP transport binds to; Render routes to it. |
| `DEMO` | `false` | See [Demo mode](#demo-mode). Off = full server. Plain value, not a secret. |

The entrypoint scopes the server's host check to your service's own `onrender.com` hostname automatically via Render's `RENDER_EXTERNAL_HOSTNAME`. **If you add a [custom domain](https://render.com/docs/custom-domains)**, requests to it will be rejected by the host check until you set `PLAYWRIGHT_MCP_ALLOWED_HOSTS` (comma-separated, e.g. `myapp.com,myapp.onrender.com`; `*` disables the check).

The browser session is **stateless and ephemeral** — no profile is persisted between requests. If you want a persistent Chromium profile (saved logins, cookies), attach a [Render Disk](https://render.com/docs/disks) and add `--user-data-dir <mount-path>` to `render-entrypoint.sh`.

## Security

**Playwright MCP has no built-in authentication in HTTP mode.** A Render web service is public by default, so anyone who learns the URL can drive your hosted browser (fetch arbitrary URLs, spend CPU/RAM). Before you rely on this:

- **Keep the URL private**, or put the service behind your own auth proxy / IP allow-list.
- Consider making it a [private service](https://render.com/docs/private-services) if only other Render services need it.
- If you expose it publicly, turn on [demo mode](#demo-mode) and add bot defense (e.g. Cloudflare / Turnstile) in front.

The host check is scoped to your own hostname automatically; the origin blocklists in demo mode are best-effort hardening, **not** a security boundary (per upstream, they don't cover redirects).

## Demo mode

`DEMO=true` turns the deployed service into a **public, locked-down demo** — use it only for a demo URL you host yourself and watch. **Forks default to `DEMO=false`** and get the full, all-capabilities server.

When on, the entrypoint ([`render-entrypoint.sh`](./render-entrypoint.sh)) starts Playwright MCP with:

| Lockdown | Flag | Why |
|----------|------|-----|
| Per-connection isolated sessions | `--isolated` | Profile kept in memory, never written to disk — nothing persists or leaks across visitors. |
| No shared context | *(default)* | Each connected client gets its own browser context; sessions don't cross. |
| Internal origins blocked | `--blocked-origins …` | Best-effort block of `localhost`, loopback, and cloud-metadata IPs. |
| Service workers off | `--block-service-workers` | Shrinks the abuse surface. |
| Tight timeouts | `--timeout-navigation 30000 --timeout-action 5000` | Caps how long a single request can tie up the browser. |
| No image payloads | `--image-responses omit` | Smaller, cheaper responses. |

**Limitations to know:** Playwright MCP has **no built-in per-IP rate limiting**, and `--blocked-origins` is not a hard security boundary. If you host a genuinely public demo, you are responsible for the operational floor from Render's demo-mode guidance:

- Put **bot defense** (Cloudflare / Turnstile / hCaptcha) in front of the URL.
- Add a **global concurrency cap** and watch Render metrics for traffic spikes.
- Keep a **kill switch** — suspend the service or flip `DEMO`/scale to zero if abused.
- Show a **"public demo — may reset, don't submit anything sensitive"** notice wherever you link it.

## Rolling Playwright MCP

Pinned to `v0.0.77` in **two** places — keep them in lockstep:

- `image` tag in [`Dockerfile.render`](./Dockerfile.render)
- the version comment in [`render.yaml`](./render.yaml)

To bump, change the tag in `Dockerfile.render`, commit, and redeploy. (`runtime: docker` images don't auto-deploy when a tag moves — a fresh deploy pulls the new base.)

---

Based on [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) · Deploys on [Render](https://render.com).
