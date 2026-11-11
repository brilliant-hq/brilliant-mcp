# Security policy

## Supported versions

The latest version of `@brilliant-hq/mcp` on npm is the supported one. Fixes ship
as a new version; older versions are not patched.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- Preferred: GitHub private vulnerability reporting on this repository
  (Security tab, "Report a vulnerability").
- Or email hello@brilliant.design with "Security" in the subject.

Include what you found, how to reproduce it, and the version (`npx @brilliant-hq/mcp --version`).
We acknowledge a report within 3 business days and tell you what we plan to do
and when. We credit reporters in the release notes unless you ask us not to.

## What is in scope

This package is a local relay, so the boundary it defends is the machine's
loopback interface:

- Any way for a web page on an origin other than `https://brilliant.design` to
  connect to the local server, read from it, or drive a design.
- Any way to obtain a pairing token or an approved association without the user.
- Any listener that binds an address other than `127.0.0.1`.
- Any way for a local process without the follower token to take over the leader.
- Any write by `install` outside the MCP config file it names.

The threat model and every gate are written down in [`PROTOCOL.md`](./PROTOCOL.md).

Problems in the Brilliant editor, website or services are out of scope for this
repository; report them to hello@brilliant.design.
