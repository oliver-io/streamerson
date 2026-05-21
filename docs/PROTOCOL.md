The `@streamerson` stream-message protocol is a fixed set of **named fields** written to each Redis stream entry (via `XADD`). The Redis client returns them as a field→value map, so there is no positional decoding.

| Field             | Type                  | Meaning                                                        |
|-------------------|-----------------------|----------------------------------------------------------------|
| `messageId`       | string (GUUID)        | id of the message; correlates a response with its request      |
| `messageType`     | string                | the event type — routed to a registered handler                |
| `incomingStream`  | string                | the stream to reply on (response destination), or empty        |
| `messageHeaders`  | JSON string or `nil`  | optional header map for routing                                |
| `messageProtocol` | `json` (or `text`)    | payload encoding                                               |
| `messageSourceId` | string                | id of the source/origin                                        |
| `payload`         | JSON or text          | the message payload, encoded per `messageProtocol`             |

> **Historical note:** earlier versions packed these positionally into the Redis key/value slots to halve the field count. The current implementation writes explicit named fields — simpler, and what the Redis client returns directly — so the positional scheme is no longer used.
