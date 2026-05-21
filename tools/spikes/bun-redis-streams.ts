/**
 * SPIKE (throwaway experiment, per MODERNIZE.md Step 1.2).
 *
 * Question: can Bun's native Redis client drive the stream hot path our `core`
 * needs — specifically a *blocking* `XREADGROUP ... BLOCK` issued via the raw
 * `send()` escape hatch on a dedicated (`.duplicate()`'d) connection — plus
 * `XADD` (with MAXLEN), `XGROUP CREATE ... MKSTREAM`, and real `XACK`/PEL acks?
 *
 * Run (Redis must be on localhost:6379):  bun tools/spikes/bun-redis-streams.ts
 */
import { RedisClient } from "bun";

const URL = process.env.STREAMERSON_REDIS_URL ?? "redis://localhost:6379";
const stream = "spike:stream";
const group = "spike:group";
const member = "spike:member";

const log = (...a: unknown[]) => console.log(...a);

async function main() {
  const writer = new RedisClient(URL);
  const reader = await writer.duplicate(); // dedicated connection for blocking reads

  // Force/verify both connections (client is otherwise lazy).
  log("PING writer ->", await writer.send("PING", []));
  log("PING reader ->", await reader.send("PING", []));

  // Clean slate.
  await writer.send("DEL", [stream]);

  // 1) XGROUP CREATE ... MKSTREAM (must work against a not-yet-existent stream).
  try {
    log("XGROUP CREATE MKSTREAM ->", await writer.send("XGROUP", ["CREATE", stream, group, "$", "MKSTREAM"]));
  } catch (e) {
    log("XGROUP CREATE error (acceptable only if BUSYGROUP) ->", (e as Error).message);
  }

  // ---- Phase A: does a blocking read actually block, then deliver? ----
  const blockMs = 5000;
  const t0 = Date.now();
  log(`\n[A] starting blocking XREADGROUP (BLOCK ${blockMs}) with no data present...`);
  const readPromise = reader.send("XREADGROUP", [
    "GROUP", group, member,
    "COUNT", "10",
    "BLOCK", String(blockMs),
    "NOACK",
    "STREAMS", stream, ">",
  ]);

  // Sleep first to prove the read waits (rather than returning empty immediately),
  // then write — the blocking read should wake and deliver.
  await Bun.sleep(750);
  const idA = await writer.send("XADD", [
    stream, "MAXLEN", "~", "1000", "*",
    "messageId", "abc", "messageType", "test", "messageProtocol", "json",
    "payload", JSON.stringify({ hi: 1 }),
  ]);
  log("[A] XADD ->", idA);

  const resA = await readPromise;
  const elapsedA = Date.now() - t0;
  log(`[A] XREADGROUP resolved after ${elapsedA}ms ->`, JSON.stringify(resA));
  const blocked = elapsedA >= 700;                       // waited for the XADD
  const deliveredA = JSON.stringify(resA ?? null).includes("abc");

  // ---- Phase B: PEL + XACK (non-NOACK), relevant to real at-least-once ----
  log(`\n[B] testing PEL + XACK (non-NOACK read)...`);
  const idB = await writer.send("XADD", [
    stream, "*", "messageId", "def", "messageType", "test", "messageProtocol", "json",
    "payload", JSON.stringify({ hi: 2 }),
  ]) as string;
  await reader.send("XREADGROUP", [
    "GROUP", group, member, "COUNT", "10", "BLOCK", "2000",
    "STREAMS", stream, ">",
  ]);
  const ack = await writer.send("XACK", [stream, group, idB]);   // expect 1 (was pending)
  log(`[B] XADD id=${idB}; XACK ->`, ack);
  const ackWorks = Number(ack) === 1;

  // cleanup
  await writer.send("DEL", [stream]);
  writer.close();
  reader.close();

  log("\n================ VERDICT ================");
  log(`blocking read honored (waited for data): ${blocked}`);
  log(`blocking read delivered the message:     ${deliveredA}`);
  log(`XACK against PEL returned 1:              ${ackWorks}`);
  const pass = blocked && deliveredA && ackWorks;
  log(`OVERALL: ${pass ? "PASS — Bun-native Redis can drive the stream hot path" : "FAIL — see above"}`);
  process.exit(pass ? 0 : 2);
}

main().catch((e) => { console.error("SPIKE THREW:", e); process.exit(1); });
