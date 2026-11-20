# Brilliant Design

Codex plugin for designing on a Brilliant canvas: pages, screens, dashboards, posts and posters
as real, editable layers, plus background removal for photos.

## What it does

- Starts a design from a prompt and returns a link the user opens to see and edit it by hand.
- Adds to and changes that design from the conversation, and reads the canvas back.
- Removes the background from a photo and returns a transparent cutout.
- With the local canvas connected: designs inside the user's own Brilliant project with the
  repository's real tokens, checks the result visually, and exports HTML or React.

## Codex files included

- `.codex-plugin/plugin.json`
- `.mcp.json`: `brilliant` (hosted, `https://brilliant.design/mcp`, no sign-in) and
  `brilliant-canvas` (local, `npx -y @brilliant-hq/mcp`, open source:
  https://github.com/brilliant-hq/brilliant-mcp)
- `.app.json`: the published Brilliant Design app
  (https://chatgpt.com/plugins/plugin_asdk_app_6ac5003e286c8191859ce548d7393709)
- `skills/brilliant-design/SKILL.md`
- `assets/logo.png`, `assets/logo.svg`

## What it runs, sends and stores

The hosted server receives the rows Codex writes and the images the user asks it to cut or
place. Designs made there are scratch designs that expire after 30 days unless the user keeps
them in Brilliant; cutouts expire after 24 hours. The local helper is a relay on 127.0.0.1
between Codex and a brilliant.design tab the user approves or the Brilliant desktop app; it
makes no network calls of its own. Privacy policy: https://brilliant.design/privacy

## Support

https://brilliant.design/contact

## Licence

Apache-2.0 for the files of this plugin. Brilliant itself is not open source.
