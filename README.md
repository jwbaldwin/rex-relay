# Rex Relay 🦖

**OpenCode × Rex. Small arms. Long conversations.**

An OpenCode V2 plugin that brings conversations you use on your phone into Rex on your Mac. One plugin package; no daemon, launch agent, or iOS app changes.

Send a prompt from the iOS app:

- If that conversation is already open in Rex, Rex Relay leaves it alone.
- Otherwise, Rex Relay opens it in a background Rex tab under the matching project session.
- Laptop prompts do not trigger new Rex tabs. Ctrl+O stays unchanged.

The conversation stays on the same OpenCode server. Rex Relay does not copy transcripts, submit extra prompts, or run another agent.

## Requirements

- OpenCode **2.1.2 or later in V2**, using the local shared service.
- Rex running on the same machine as that service, with its CLI available.
- The phone connected to that same OpenCode service.
- The iOS app sending notification callback metadata with its prompts.

Rex Relay detects the existing `metadata.notification.callbackURL` marker. It does not know where a conversation was originally created. If the app does not send the marker—for example, if its notification setup is unavailable—Rex Relay cannot detect that phone prompt. Merely viewing a conversation on the phone is not a trigger.

## Install from GitHub

Add this entry to `plugins` in both `~/.config/opencode/opencode.json` and `~/.config/opencode/cli.json`, preserving existing plugins:

```json
{
  "plugins": ["github:jwbaldwin/rex-relay#main"]
}
```

OpenCode installs the plugin and its dependencies. Reload its configuration after adding the entry.

## Install from a local checkout

Clone [jwbaldwin/rex-relay](https://github.com/jwbaldwin/rex-relay), then run:

```sh
bun install
```

Add the directory to `plugins` in both `~/.config/opencode/opencode.json` and `~/.config/opencode/cli.json`, preserving existing plugins:

```json
{
  "plugins": ["/absolute/path/to/rex-relay"]
}
```

The server entry handles phone prompts and Rex tabs. The terminal entry reports the conversation IDs open in each Rex terminal, including inactive OpenCode tabs and session switches. Both belong to this package.

Reload OpenCode configuration. Ensure the terminal plugin has loaded in any existing Rex/OpenCode tabs before sending phone prompts; otherwise Rex Relay cannot identify those pre-existing conversations. OpenCode's plugin list should show `rex-relay` as active. This plugin requires the managed shared service; it refuses private `--standalone` servers rather than attach Rex to a different service.

Nothing is published to npm or GitHub by installation.

## Project routing

Rex Relay compares the conversation's canonical project and worktree paths with working directories in existing local Rex terminals. One matching Rex session wins. No match or an ambiguous match goes to a session called **OpenCode**, created if needed.

For a fixed mapping, use the object form in the server config:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/rex-relay",
      "options": {
        "projects": {
          "/absolute/path/to/project": "my-rex-session"
        },
        "fallbackSession": "OpenCode"
      }
    }
  ]
}
```

Mapping values can be full Rex session IDs or unique session labels. More specific paths take precedence. Worktrees can map to their canonical project's session. An invalid explicit mapping stays pending rather than silently going somewhere else.

## Closing, renaming, and recovery

- Automatically created tabs follow the conversation title. Rex Relay does not rename tabs you opened yourself.
- Closing a linked Rex tab dismisses it. Further phone prompts do not keep reopening it.
- `/rex-relay` explicitly restores a dismissed conversation. It also works as a server command for clients that support OpenCode commands.
- Switching a linked Rex terminal to another conversation relinquishes the old mapping instead of renaming the wrong tab.
- Requests survive OpenCode restarts. After a Rex server replacement, missing linked tabs can be restored; ordinary tab closure is treated as dismissal.
- Startup and new requests leave a six-second registration window for existing terminals, including terminals resuming after sleep. An immediate registration can reuse a tab without waiting. Normal reconciliation runs every 15 seconds, including title changes.
- Child-agent, deleted, and archived sessions do not open new tabs. Rex Relay never closes or deletes an OpenCode conversation.

If a tab disappears while Rex Relay is offline but the Rex server instance is unchanged, Rex Relay conservatively treats it as dismissed. It cannot know whether an unobserved closure was deliberate.

## Options

Server options must be consistent across projects:

- `rexExecutable`: Rex CLI path; default `rex`.
- `rexServer`: optional explicit Rex server endpoint; otherwise uses Rex's saved home server, not the OpenCode server's inherited terminal location.
- `opencodeExecutable`: OpenCode CLI path; default `opencode`.
- `projects`: absolute project paths mapped to Rex session IDs or unique labels.
- `fallbackSession`: default `OpenCode`.
- `stateDirectory`: default `$XDG_STATE_HOME/rex-relay` or `~/.local/state/rex-relay`.
- `intervalMs`: reconciliation period, default `15000`, minimum `1000`.

When `rexExecutable` is not on the terminal's PATH, give that option to the CLI plugin too. Rex itself must already be running; Rex Relay does not start it.

## State and privacy

Rex Relay stores local conversation IDs, Rex resource IDs, titles, and pending/open/dismissed states in an owner-readable state file, scoped to the OpenCode service endpoint. It uses atomic file replacement. It does not save prompts, transcripts, callback URLs, notification tokens, or service credentials. Callback URLs are validated locally and never fetched by Rex Relay.

Terminal claims expire and must match the Rex host, running server instance, block, and actual terminal process. The server ignores its own inherited `REX_BLOCK` context when making decisions.

For diagnostics, the plugin exposes `rex-relay.status` through OpenCode's plugin RPC API. It returns observed conversation IDs and mapping states, not notification data.

## Development

```sh
bun test
bun run typecheck
bun run verify:integration
```

The opt-in integration check starts an isolated OpenCode service with a temporary configuration/database, creates a disposable Rex session, and exercises prompt admission, real terminal launching, focus preservation, title changes, terminal registration, phone/laptop deduplication, dismissal, and reopening. It submits prompts with `resume: false`; no model requests run. It stops its own service and destroys only the Rex session it created. Failed runs retain their isolated files for inspection.

## License

MIT.
