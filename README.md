# Rex Relay

Send a prompt from OpenCode on your phone and the conversation opens in a background Rex tab on your Mac. If it's already open, nothing happens. Laptop prompts don't create extra tabs.

## Install

Requires OpenCode V2.1.2+, Rex with its CLI on your PATH, and your phone connected to the Mac's shared OpenCode server.

Add this to `plugins` in both `~/.config/opencode/opencode.json` and `~/.config/opencode/cli.json`. Keep your existing entries.

```json
{
  "plugins": ["github:jwbaldwin/rex-relay#main"]
}
```

Then run:

```sh
opencode reload
```

Make sure the plugin has loaded in your existing Rex/OpenCode tabs so it can recognise them and avoid duplicates.

## How it behaves

- Opens tabs in the matching project's Rex session, or **meta** if there's no clear match; creates **meta** if needed
- Updates titles on tabs it creates, without stealing focus
- Leaves deliberately closed tabs closed. Use `/rex-relay` to reopen one
- Remembers mappings across restarts. Ctrl+O stays unchanged

Phone detection uses the iOS app's `metadata.notification.callbackURL` marker. If the app doesn't send it, Rex Relay can't detect that phone prompt. No iOS app changes are needed.

For fixed project mappings or other settings, see [options and defaults](rpc.ts).

## Development

```sh
bun install
bun test
bun run typecheck
bun run verify:integration
```

The integration check uses a temporary OpenCode service and disposable Rex session. It doesn't run model requests.

[MIT](LICENSE)
