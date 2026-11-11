// The literal occupied-port case (a field report): when another
// helper already holds the first fallback port, the ws layer re-emits the
// http server's EADDRINUSE on the WebSocketServer instance; unhandled, that
// second emission killed the whole process before the port walk could run
// (banner printed, then node:events throw). The walk must survive the double
// emission and serve on the next port; full exhaustion must reject cleanly,
// never crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { bindFallbackWs } from "../lib/leader.js";

function occupy(port = 0) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

test("EADDRINUSE on the first fallback port walks to the next (ws re-emission survived)", async () => {
  const squatter = await occupy();
  const taken = squatter.address().port;
  const bound = await bindFallbackWs([taken, 0], () => {});
  assert.notEqual(bound.port, taken, "must not claim the occupied port");
  assert.ok(bound.port > 0, "must serve on the next (ephemeral) port");
  bound.wss.close();
  bound.server.close();
  squatter.close();
});

test("full range exhaustion rejects cleanly instead of crashing", async () => {
  const a = await occupy();
  const b = await occupy();
  await assert.rejects(
    bindFallbackWs([a.address().port, b.address().port], () => {}),
    /no free ws port/,
  );
  a.close();
  b.close();
});
