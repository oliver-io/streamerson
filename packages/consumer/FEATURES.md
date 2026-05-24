# @streamerson/consumer — feature × test matrix

### `ConsumerGroupCoordinator` — [`group.ts`](./src/group.ts)

| Feature | Implementation | Tested |
|:--|:--|:--:|
| Group create — idempotent, returns `{ created }` | [`group.ts › create`](./src/group.ts) | <abbr title="bootstrap.test.ts › 'a consumer group can be created (idempotently)'; coordinator.test.ts › 'CG-B2 coordinator never consumes'">☑</abbr> |
| Create surfaces non-`BUSYGROUP` failure (CG-A5) | [`group.ts › create`](./src/group.ts) | <abbr title="coordinator.test.ts › 'CG-A5 a non-BUSYGROUP create failure is surfaced, not swallowed'">☑</abbr> |
| Create cursor — backlog `'0'` vs new `'$'` (CG-A4) | [`group.ts › create`](./src/group.ts) | <abbr title="coordinator.test.ts › 'CG-A4 create(cursor=0) delivers pre-group history to a joining member'">☑</abbr> |
| Coordinator never consumes (CG-B2 / D3 split) | [`group.ts › ConsumerGroupCoordinator`](./src/group.ts) | <abbr title="coordinator.test.ts › 'CG-B2 coordinator creates the group but never consumes; member gets every message' (XINFO CONSUMERS shows only the real member)">☑</abbr> |
| `connectAndListen` — connect + start reaper | [`group.ts › connectAndListen`](./src/group.ts) | <abbr title="reaper.test.ts › 'reaper moves an abandoned pending entry to the DLQ'; terminality.test.ts (beforeAll)">☑</abbr> |
| `connect` / `disconnect` | [`group.ts › connect/disconnect`](./src/group.ts) | <abbr title="bootstrap.test.ts; coordinator.test.ts; reaper.test.ts; terminality.test.ts (lifecycle)">☑</abbr> |
| Reaper — periodic sweep when `processingTimeout > 0` | [`group.ts › startReaper`](./src/group.ts) | <abbr title="reaper.test.ts › 'reaper moves an abandoned pending entry to the DLQ exactly once and drains the PEL'">☑</abbr> |
| Reaper disabled when grace `= 0` or `retry` on | [`group.ts › startReaper`](./src/group.ts) | <abbr title="reaper-policy.test.ts › 'disabled when processingTimeout = 0: an abandoned entry is left pending, never dead-lettered'; 'disabled when retry is on: the coordinator does not dead-letter (members own reclaim)'">☑</abbr> |
| Sweep — `XAUTOCLAIM` abandoned → DLQ `'abandoned'`, once | [`group.ts › sweep`](./src/group.ts) | <abbr title="reaper.test.ts › 'reaper moves an abandoned pending entry to the DLQ exactly once and drains the PEL'">☑</abbr> |
| Sweep — no re-dead-letter on later passes | [`group.ts › sweep`](./src/group.ts) | <abbr title="reaper.test.ts › '...not re-dead-lettered on subsequent sweeps'">☑</abbr> |
| Sweep — `NOGROUP`-tolerant + non-overlapping (`sweeping`) | [`group.ts › sweep`](./src/group.ts) | <abbr title="reaper-policy.test.ts › 'sweep tolerates NOGROUP (started before the group exists) and reaps once it does'. Non-overlap (`sweeping` re-entrancy guard) covered indirectly by reaper.test.ts exactly-once (no double dead-lettering across sweeps).">☑</abbr> |
| `stopReaper` | [`group.ts › stopReaper`](./src/group.ts) | <abbr title="indirect — coordinator.disconnect() in every coordinator test">☑</abbr> |

### `ConsumerGroupMember` — [`member.ts`](./src/member.ts)

| Feature | Implementation | Tested |
|:--|:--|:--:|
| Constructor rejects empty `groupMemberId` (D1) | [`member.ts › constructor`](./src/member.ts) | <abbr title="coordinator.test.ts › 'D1 constructing a member with an empty groupMemberId is a hard error'">☑</abbr> |
| Reads as a named group member (`consumerGroupInstanceConfig`) | [`member.ts › constructor`](./src/member.ts) | <abbr title="indirect — every member test consumes as a group: coordinator/terminality/receipt/retry/cluster*.test.ts">☑</abbr> |
| Drops inherited outgoing channel (one connection/member) | [`member.ts › constructor`](./src/member.ts) | <abbr title="member-construction.test.ts › 'drops the inherited outgoing channel/stream (one connection per member), even when bidirectional'">☑</abbr> |
| `connectAndListen` — background read loop | [`member.ts › connectAndListen`](./src/member.ts) | <abbr title="all member tests: coordinator/terminality/receipt/retry.test.ts">☑</abbr> |
| Consume loop — `XREADGROUP '>'`, PREFETCH=1 | [`member.ts › listen`](./src/member.ts) | <abbr title="terminality.test.ts › 'atomic terminal transitions'; receipt.test.ts; coordinator.test.ts › 'CG-B2'">☑</abbr> |
| Backlog delivered on late connect (CG-C3) | [`member.ts › listen`](./src/member.ts) | <abbr title="backlog.test.ts › 'backlog produced before a member connects is delivered once the member starts (CG-C3)'">☑</abbr> |
| `dispatch` — classify ok / no-handler / handler-threw (CG-I4) | [`member.ts › dispatch`](./src/member.ts) | <abbr title="terminality.test.ts (echo=ok, boom=handler-threw, mystery=no-handler); receipt.test.ts">☑</abbr> |
| Handler throw does not wedge the loop (CG-I5) | [`member.ts › listen`](./src/member.ts) | <abbr title="receipt.test.ts › 'handler failure ... does not wedge the loop; success acks' (echo answered after boom)">☑</abbr> |
| `terminal` — bidi success → `respondAndAck` atomic (CG-I6) | [`member.ts › terminal`](./src/member.ts) | <abbr title="terminality.test.ts › 'respond+ack on success'; receipt.test.ts; cluster.test.ts (round-trip)">☑</abbr> |
| `terminal` — one-way success → plain `XACK` | [`member.ts › terminal`](./src/member.ts) | <abbr title="oneway.test.ts › 'a one-way (non-bidirectional) success is plain-XACKd: no response written, PEL drains'">☑</abbr> |
| `terminal` — failure → inline dead-letter (no-handler / handler-threw) | [`member.ts › terminal/deadLetter`](./src/member.ts) | <abbr title="terminality.test.ts › 'dead-letter+ack on failure'; receipt.test.ts">☑</abbr> |
| `terminal` — retry on + throw → leave pending | [`member.ts › terminal`](./src/member.ts) | <abbr title="retry.test.ts › 'redelivery after crash'; 'poison message'">☑</abbr> |
| `drain` — flush in-flight before close (CG-I3) | [`member.ts › drain`](./src/member.ts) | <abbr title="cluster-lifecycle.test.ts › 'graceful stop drains an in-flight handler and flushes its response within idleTimeout'">☑</abbr> |
| Retry — self-PEL `'0'`-drain on (re)start | [`member.ts › selfDrain`](./src/member.ts) | <abbr title="retry.test.ts › 'redelivery after crash: a restarted member self-drains its own PEL'">☑</abbr> |
| Retry — cross-machine `XAUTOCLAIM` reclaim | [`member.ts › reclaimStale`](./src/member.ts) | <abbr title="retry.test.ts › 'poison message ... re-run up to maxAttempts'">☑</abbr> |
| Retry — poison cap (`deliveryCount > maxAttempts`) → DLQ | [`member.ts › attempt`](./src/member.ts) | <abbr title="retry.test.ts › 'poison message: an always-failing handler is re-run up to maxAttempts, then dead-lettered'">☑</abbr> |
| CG-I7 — reclaim does not steal a healthy in-flight entry | [`member.ts › reclaimStale`](./src/member.ts) | <abbr title="retry.test.ts › 'CG-I7: reclaim does not steal a healthy in-flight entry when processingTimeout > handler time'">☑</abbr> |
| `deliveryCounts` — `XPENDING` extended | [`member.ts › deliveryCounts`](./src/member.ts) | <abbr title="indirect — retry.test.ts (self-drain + poison count)">☑</abbr> |
| `prefetch > 1` (batched reads) | [`member.ts › listen`](./src/member.ts) | <abbr title="prefetch.test.ts › 'prefetch > 1 reads a batch and terminalizes every entry (no batch-boundary loss)'">☑</abbr> |
| `clone` | [`member.ts › clone`](./src/member.ts) | <abbr title="member-construction.test.ts › 'clone() returns a fresh, independent member with member settings overlaid'">☑</abbr> |

### `StreamConsumer` (base) — [`base/stream-consumer.ts`](./src/base/stream-consumer.ts)

| Feature | Implementation | Tested |
|:--|:--|:--:|
| Construction — incoming channel + read-stream wiring | [`stream-consumer.ts › constructor`](./src/base/stream-consumer.ts) | <abbr title="indirect — ConsumerGroupMember extends it; live connect in every member test">☑</abbr> |
| `registerStreamEvent` / `eventMap` binding | [`stream-consumer.ts › registerStreamEvent`](./src/base/stream-consumer.ts) | <abbr title="all member tests register echo/boom/work/slow via eventMap">☑</abbr> |
| `_handle_message` — decode payload, run handler, stamp `'resp'` | [`stream-consumer.ts › _handle_message`](./src/base/stream-consumer.ts) | <abbr title="terminality.test.ts / receipt.test.ts / cluster.test.ts (echo payload asserted)">☑</abbr> |
| `disconnect` (base) | [`stream-consumer.ts › disconnect`](./src/base/stream-consumer.ts) | <abbr title="indirect — member.disconnect()/drain() in coordinator/terminality/receipt/cluster*.test.ts">☑</abbr> |
| `deregisterStreamEvent` | [`stream-consumer.ts › deregisterStreamEvent`](./src/base/stream-consumer.ts) | <abbr title="base-consumer-integration.test.ts › 'removes one handler (→ no-handler dead-letter) while a retained handler still answers'">☑</abbr> |
| Base `process` — no-handler → `Error` object | [`stream-consumer.ts › process`](./src/base/stream-consumer.ts) | <abbr title="base-consumer-unit.test.ts › 'no registered handler → returns an Error naming the type + consumer key (not a throw)'; 'registered handler → event re-stamped resp carrying the handler payload'">☑</abbr> |
| Base `connectAndListen` — pipe + CG-G2 callback-always | [`stream-consumer.ts › connectAndListen`](./src/base/stream-consumer.ts) | <abbr title="base-consumer-integration.test.ts › 'a throwing handler does not wedge the pipe — the loop keeps consuming (CG-G2)' (multiple throws processed + echoes still answered)">☑</abbr> |
| `bindStreamEvents` — channel error/end/close routing | [`stream-consumer.ts › bindStreamEvents/_optionallyRouteMessage`](./src/base/stream-consumer.ts) | <abbr title="base-consumer-unit.test.ts › 'a channel error is wired and routed to a registered listener / logged otherwise' (exercises _optionallyRouteMessage: per-stream event preferred, generic-event fallback, else log — same code path for end/close)">☑</abbr> |
| `addStream` / `hasStream` / `removeStream` (dynamic set) | [`stream-consumer.ts`](./src/base/stream-consumer.ts) | <abbr title="dynamic-set-delegation.test.ts › 'addStream/hasStream/removeStream delegate to the channel stream-set and track membership' (consumer-side delegation/bookkeeping). The runtime behavioural contract (live add/remove without interrupting other streams) is owned by core's dynamic-stream-set.test.ts — the F1 acceptance suite, now passing (F1 fixed).">☑</abbr> |
| `produceMessage` | [`stream-consumer.ts › produceMessage`](./src/base/stream-consumer.ts) | <abbr title="base-consumer-integration.test.ts › 'writes a correlated message onto the producer (response) stream'">☑</abbr> |
| `cacheComposite` | [`stream-consumer.ts › cacheComposite`](./src/base/stream-consumer.ts) | <abbr title="base-consumer-unit.test.ts › 'returns { key, shard }'">☑</abbr> |

### `ConsumerGroupCluster` — [`cluster.ts`](./src/cluster.ts)

| Feature | Implementation | Tested |
|:--|:--|:--:|
| `start` — coordinator connect + create + reaper, scale to `count` | [`cluster.ts › start`](./src/cluster.ts) | <abbr title="cluster.test.ts › 'round-trips a request through a Bun worker thread'; cluster-lifecycle.test.ts">☑</abbr> |
| Round-trip request → handler → response via worker thread | [`cluster.ts`](./src/cluster.ts) + [fixture](./test/fixtures/cluster-echo-member.ts) | <abbr title="cluster.test.ts › 'cluster member round-trips a request through a Bun worker thread'">☑</abbr> |
| `count` / `members` / `readyMembers` getters | [`cluster.ts`](./src/cluster.ts) | <abbr title="cluster.test.ts (count=2, readyMembers=2); cluster-lifecycle.test.ts › 'scale() reconciles up and down'">☑</abbr> |
| `scale` — reconcile member count up / down | [`cluster.ts › scale`](./src/cluster.ts) | <abbr title="cluster-lifecycle.test.ts › 'scale() reconciles the live member count up and down'">☑</abbr> |
| Distribution across members — exactly-once | [`cluster.ts`](./src/cluster.ts) | <abbr title="cluster-lifecycle.test.ts › 'members stay alive under sustained load and the group distributes every message' (30 msgs / 3 members)">☑</abbr> |
| Restart-on-crash maintains `count` | [`cluster.ts › spawnMember/scheduleRestart`](./src/cluster.ts) | <abbr title="cluster.test.ts › 'coordinator restarts a crashed member to maintain the desired count'">☑</abbr> |
| Restart — exponential backoff + `MAX_RESTARTS` bound | [`cluster.ts › scheduleRestart`](./src/cluster.ts) | <abbr title="restart.test.ts › 'a flapping member is restarted repeatedly via the backoff loop (cap reset on each ready, never tripped)'. FINDING (verified empirically): the MAX_RESTARTS give-up branch is unreachable — `ready` resets restartCounts→0 and a respawn that crashes before ready rejects without rescheduling, so the per-attempt backoff resets each cycle and never climbs to the cap. Left as-is per TDD.">☑</abbr> |
| `stop` — drain all members + coordinator disconnect | [`cluster.ts › stop`](./src/cluster.ts) | <abbr title="cluster-lifecycle.test.ts › 'graceful stop ...'; cluster.test.ts (afterAll)">☑</abbr> |
| `drainMember` — drain signal | [`cluster.ts › drainMember`](./src/cluster.ts) | <abbr title="cluster-lifecycle.test.ts › 'scale() ... down' and 'graceful stop drains an in-flight handler'">☑</abbr> |
| `drainMember` — overrun → in-flight left pending (no loss), stop bounded | [`cluster.ts › drainMember`](./src/cluster.ts) | <abbr title="cluster-lifecycle.test.ts › 'a handler that overruns idleTimeout is abandoned on stop — left pending (no loss), and stop still returns'. (The literal worker.terminate() force-kill is the safety net for a wedged worker and is not exercised — the worker exits cleanly after the drain budget.)">☑</abbr> |
| `createMemberOptions` — clone-safe `MemberParams` | [`cluster.ts › createMemberOptions`](./src/cluster.ts) | <abbr title="indirect — invoked on every spawn in cluster.test.ts / cluster-lifecycle.test.ts">☑</abbr> |
| `isRunning` getter | [`cluster.ts › isRunning`](./src/cluster.ts) | <abbr title="cluster-misc.test.ts › 'isRunning tracks start→stop, and fill() brings the cluster up like start()'">☑</abbr> |
| `fill()` — deprecated `start` alias | [`cluster.ts › fill`](./src/cluster.ts) | <abbr title="cluster-misc.test.ts › 'isRunning tracks start→stop, and fill() brings the cluster up like start()' (fill() spawns the member, same as start())">☑</abbr> |

### `runClusterMember` (worker host) — [`cluster-member.ts`](./src/cluster-member.ts)

| Feature | Implementation | Tested |
|:--|:--|:--:|
| Worker entry — `start` → build → connect → `ready` | [`cluster-member.ts › runClusterMember`](./src/cluster-member.ts) | <abbr title="cluster.test.ts; cluster-lifecycle.test.ts (via fixtures/cluster-echo-member.ts)">☑</abbr> |
| `drain` → `member.drain` then exit 0 | [`cluster-member.ts › drain`](./src/cluster-member.ts) | <abbr title="cluster-lifecycle.test.ts › 'graceful stop drains an in-flight handler and flushes its response'">☑</abbr> |
| `wrapHandlers` — per-message `processingTimeout` budget | [`cluster-member.ts › wrapHandlers`](./src/cluster-member.ts) | <abbr title="budget.test.ts › 'a handler exceeding processingTimeout is dead-lettered (handler-threw) and the loop survives'">☑</abbr> |
| `error` signal + exit 1 on build/connect failure | [`cluster-member.ts`](./src/cluster-member.ts) | <abbr title="cluster-misc.test.ts › 'a member whose factory throws at build → error+exit1 → start() rejects (not a hang)' (fixtures/cluster-failing-member.ts)">☑</abbr> |

### `config` — [`config.ts`](./src/config.ts)

| Feature | Implementation | Tested |
|:--|:--|:--:|
| `createConsumerGroupConfig` — defaults applied + plumbed | [`config.ts › createConsumerGroupConfig`](./src/config.ts) | <abbr title="config.test.ts › 'applies documented defaults'; 'passes through valid explicit values'">☑</abbr> |
| `validateOptions` — reject bad count / timeouts / blockTimeout / prefetch | [`config.ts › validateOptions`](./src/config.ts) | <abbr title="config.test.ts › 'count: negative or non-integer'; 'processingTimeout / idleTimeout: negative'; 'blockTimeout: negative'; 'prefetch: below 1 or non-integer'">☑</abbr> |
| `validateOptions` — `retry` needs `maxAttempts ≥ 1` and `processingTimeout > 0` | [`config.ts › validateOptions`](./src/config.ts) | <abbr title="config.test.ts › 'retry.maxAttempts: below 1 or non-integer'; 'retry requires processingTimeout > 0 (CG-I7)'">☑</abbr> |

### `cluster-protocol` — [`cluster-protocol.ts`](./src/cluster-protocol.ts)

| Feature | Implementation | Tested |
|:--|:--|:--:|
| Clone-safe coordinator ↔ worker message types | [`cluster-protocol.ts`](./src/cluster-protocol.ts) | <abbr title="cluster-protocol.test.ts › 'the start payload (createMemberOptions) is plain data and survives structuredClone intact'; 'structured clone rejects a function — why handlers/loggers are excluded'. (bun run build also type-checks the module.)">☑</abbr> |

### `core` substrate (consumed by the group layer)

| Feature | Implementation | Tested |
|:--|:--|:--:|
| `respondAndAck` — atomic `{XADD response; XACK}` (Lua) | [`streamable.ts › respondAndAck`](../core/src/datasource/streamable.ts) | <abbr title="terminality.test.ts; receipt.test.ts; cluster.test.ts (round-trip)">☑</abbr> |
| `deadLetterAndAck` — atomic `{XADD dead-letter; XACK}` (Lua) | [`streamable.ts › deadLetterAndAck`](../core/src/datasource/streamable.ts) | <abbr title="terminality.test.ts; reaper.test.ts; retry.test.ts (poison)">☑</abbr> |
| `claimStale` — `XAUTOCLAIM` wrapper | [`streamable.ts › claimStale`](../core/src/datasource/streamable.ts) | <abbr title="reaper.test.ts; retry.test.ts">☑</abbr> |
| `readGroupEntries` — read at explicit cursor (`'0'` self-PEL) | [`streamable.ts › readGroupEntries`](../core/src/datasource/streamable.ts) | <abbr title="retry.test.ts › 'redelivery after crash' (self-drain at '0')">☑</abbr> |
| `pendingDetails` — `XPENDING` extended → per-entry delivery count | [`streamable.ts › pendingDetails`](../core/src/datasource/streamable.ts) | <abbr title="indirect — retry.test.ts (delivery-count gating)">☑</abbr> |
| `createConsumerGroup` — idempotent; `BUSYGROUP` sentinel; propagates real errors | [`streamable.ts › createConsumerGroup`](../core/src/datasource/streamable.ts) | <abbr title="bootstrap.test.ts; coordinator.test.ts › 'CG-A5'; receipt/retry.test.ts setup">☑</abbr> |
| `markProcessedByGroup` — plain `XACK` (one-way success) | [`streamable.ts › markProcessedByGroup`](../core/src/datasource/streamable.ts) | <abbr title="oneway.test.ts › 'a one-way (non-bidirectional) success is plain-XACKd: no response written, PEL drains' (member.terminal one-way branch → markProcessedByGroup)">☑</abbr> |
| `Topic.deadLetterKey` | [`topic.ts › deadLetterKey`](../core/src/utils/topic.ts) | <abbr title="indirect — DLQ asserted in terminality/reaper/retry.test.ts">☑</abbr> |
| `iterateStream` — single persistent UPDATE listener (CG-I1) | [`streamable.ts › iterateStream`](../core/src/datasource/streamable.ts) | <abbr title="core: iterate-stream-listeners.test.ts › 'an idle getReadStream consumer neither leaks nor strands keyEvents(update) listeners'; receipt.test.ts (listener count ≤ 2)">☑</abbr> |
| `isClosing` — clean teardown mid-blocking-read (CG-I2) | [`remote.ts › isClosing`](../core/src/datasource/base/remote.ts) | <abbr title="indirect — receipt/reaper.test.ts teardown; member loop closing checks">☑</abbr> |
