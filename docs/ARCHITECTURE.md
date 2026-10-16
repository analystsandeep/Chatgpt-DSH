# High-level architecture

`apply(ctx)` in `chatgpt-plus-dsh/lib/index.js` wires three things into the DSH host:

1. **Token lifecycle** (`controller.js`, `oauth.js`, `store.js`) — loads the saved
   grant from the credential store (`chatgpt-plus/account`), schedules background
   refresh, handles OAuth sign-in via a short-lived `127.0.0.1:1455` listener.
2. **Provider route** (`provider.js`, `models.js`) — a `chatgpt-plus` LLM adapter
   registered with the `llm` service. Chat goes to
   `POST {backend}/codex/responses` (SSE), models to `GET {backend}/codex/models`,
   usage to `{backend}/wham/usage`. Re-announces on model changes so the picker
   updates after sign-in/out.
3. **Settings endpoints** (`rpc.js`, `client.js`) — same-origin JSON under
   `/_dsh/chatgpt-plus-dsh` on DSH's web server, guarded by DSH's connection
   check; POST-only mutations, no token material in responses.

The plugin never imports `@deepseek-ai/*` at runtime; host features are reached
through `ctx` services only. All timers, listeners and registrations are created
through `ctx.effect()`, so unload/hot-reload releases them.
