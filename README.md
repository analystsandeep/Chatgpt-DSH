# Chatgpt-DSH

A DeepSeek Harness (DSH) plugin that signs in with a ChatGPT Plus or Pro account
and exposes its ChatGPT models in DSH on the subscription quota. No API key needed.

The plugin package lives in `chatgpt-plus-dsh/`. This repository contains the
package plus top-level documentation; the package directory itself ships only
runtime files.

## How it works

The plugin registers a `chatgpt-plus` provider route with DSH's `llm` service, so
the account's ChatGPT models show up in the DSH model picker. Requests go to the
ChatGPT backend used by the Codex CLI (`https://chatgpt.com/backend-api`), billed
against the ChatGPT subscription rather than API usage.

Sign-in uses OpenAI OAuth (Authorization Code + PKCE S256) with the Codex CLI's
public client. A short-lived listener on `127.0.0.1:1455` receives the redirect;
if that port is busy, the settings page offers a paste-the-URL fallback. The
resulting grant (access, refresh and ID tokens) is kept in DSH's credential store
under `chatgpt-plus/account` and refreshed automatically before it expires.

## Features

- Sign in / sign out with a ChatGPT Plus or Pro account from the DSH settings page.
- Account models listed from the ChatGPT backend, with periodic refresh and usage
  figures shown in the settings UI.
- Streaming chat completions via the Codex Responses endpoint, including tool
  calls and reasoning items where the model returns them.
- Background token refresh plus single-flight refresh shared across concurrent
  requests and DSH processes sharing one home.
- Settings page served from DSH's own web server (same-origin JSON endpoints);
  responses never contain token material.
- Runs alongside `dsh-chatgpt-sub` in one profile: provider route, credential
  key, HTTP prefix and data directory are all distinct.

## Technology stack

- JavaScript (ES modules), Node.js `>= 20.11`.
- Zero runtime dependencies — `lib/` imports only Node built-ins and sibling
  modules. The settings UI (`lib/client.js`) is a module-loader factory using
  `react` and `@deepseek-ai/dsh-client-ui-primitives` supplied by the host.
- Tests run on Node's built-in test runner, no test dependencies.
- Requires DeepSeek Harness `0.2.0-rc.2` or newer (`llm.registerAdapter` and
  credential records APIs).

## Prerequisites

- Node.js 20.11 or newer (`node --version`).
- DeepSeek Harness 0.2.0-rc.2+.
- A ChatGPT Plus or Pro account for sign-in.

## Installation

No `npm install` is required — the package declares no dependencies or peers.

1. Place the `chatgpt-plus-dsh/` directory where DSH loads plugins from
   (for example a `link:` install, or `dsh plugin add <path>` — see your DSH
   docs for the exact command in your setup).
2. Add the bundle row to your profile so the plugin is mounted. The stock row
   from `chatgpt-plus-dsh/cordis.patch.yml`:

```yaml
- insert:
    - id: chatgpt-plus
      name: 'chatgpt-plus-dsh'
```

3. Start DSH, open Plugins → ChatGPT Plus, and click **Sign in with ChatGPT**.

Optional row config keys (all may be omitted): `callbackPort`
(OpenAI only accepts `1455` for this client), `signInTimeoutMs`,
`requestTimeoutMs`, `streamIdleTimeoutMs`, `clientVersion`.

## Configuration

There is no `.env` file. Secrets live only in DSH's credential store
(`$DSH_HOME/.credentials.yaml`, record `chatgpt-plus/account`, file mode 0600);
non-secret preferences and the cached model list live under
`$DSH_HOME/chatgpt-plus-dsh/` (directory 0700, owner-only ACL on Windows).
All tunables are row config keys (see above) with defaults in
`chatgpt-plus-dsh/lib/constants.js` (`DEFAULTS`).

## Running locally

```powershell
node --version            # needs >= 20.11
cd chatgpt-plus-dsh
node tests/run-all.mjs    # offline test suite, no network access
```

To exercise the plugin against a real DSH build, install the package into a DSH
profile as described above and open the ChatGPT Plus settings page.

## Building and testing

There is no build step. The supported check is the offline suite:

```powershell
cd chatgpt-plus-dsh
node tests/run-all.mjs
```

It runs every `tests/*.test.mjs` in its own process and exits non-zero on any
failure. Last verified: 93 passed, 0 failed (Node 24, Windows).

## Project structure

```text
chatgpt-plus-dsh/
  lib/
    index.js       # plugin entry: registers provider route, token lifecycle, settings endpoints
    controller.js  # sign-in flow, token refresh, preferences, usage/model fetching
    provider.js    # `chatgpt-plus` LLM adapter (Codex Responses endpoint)
    oauth.js       # PKCE helpers, token exchange/refresh, grant payload
    models.js      # model catalog fetch, quota/usage parsing
    rpc.js         # same-origin settings-page endpoints
    client.js      # settings page UI (host module-loader factory)
    store.js       # credential-store + $DSH_HOME persistence
    errors.js      # error taxonomy and user-facing messages
    util.js        # file, time and platform helpers
    constants.js   # identifiers, OAuth/backend endpoints, defaults
  tests/           # offline suite (`run-all.mjs` + `*.test.mjs`)
  locale/en.json   # plugin card title/description
  cordis.patch.yml # bundle row mounting the plugin
  package.json     # manifest (no dependencies, no peers)
```

`verify/` (local only, not published) holds sandbox QA harnesses and screenshots.

## Troubleshooting

- **Plugin fails to load with a message about missing APIs**: update DSH to
  0.2.0-rc.2 or newer (`assertHostSupport` in `lib/index.js` names the missing API).
- **Sign-in listener can't bind port 1455**: another process (or a second DSH
  profile signing in) holds it. Use the paste-the-URL fallback the settings page
  shows, or free the port and retry.
- **"Refresh token was rejected" / signed out unexpectedly**: the grant expired
  or was revoked (including by signing in elsewhere, since rotation invalidates
  the old family). Sign in again from the settings page.
- **Requests fail after the token expires though auto-refresh is off**: either
  enable "Refresh tokens automatically" or use "Refresh token now" in
  Plugins → ChatGPT Plus.

## License

MIT — see [LICENSE](LICENSE).
