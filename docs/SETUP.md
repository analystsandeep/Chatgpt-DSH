# Setup

## Requirements

- Node.js >= 20.11
- DeepSeek Harness >= 0.2.0-rc.2
- A ChatGPT Plus or Pro account

## Install

1. Make the `chatgpt-plus-dsh/` package visible to DSH (see your DSH docs for
   `dsh plugin add` or `link:` installs in your setup). No `npm install` is
   needed; the package has no dependencies.
2. Mount it in your profile with the row from `chatgpt-plus-dsh/cordis.patch.yml`:

```yaml
- insert:
    - id: chatgpt-plus
      name: 'chatgpt-plus-dsh'
```

3. Start DSH and open Plugins → ChatGPT Plus → **Sign in with ChatGPT**.
   Approve in the browser; the redirect lands on `127.0.0.1:1455`.
   If the port is busy, paste the redirect URL when prompted.

## Optional row config

```yaml
- insert:
    - id: chatgpt-plus
      name: 'chatgpt-plus-dsh'
      # callbackPort: 1455          # OpenAI only accepts 1455 for this client
      # signInTimeoutMs: 300000
      # requestTimeoutMs: 120000
      # streamIdleTimeoutMs: 300000
      # clientVersion: '0.162.1'
```

## Verify

```powershell
cd chatgpt-plus-dsh
node tests/run-all.mjs
```

## Where state lives

- Secrets: DSH credential store (`$DSH_HOME/.credentials.yaml`),
  record `chatgpt-plus/account`.
- Preferences and model cache: `$DSH_HOME/chatgpt-plus-dsh/`.
