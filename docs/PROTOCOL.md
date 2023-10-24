| Field           | type             | Meaning                                                  |
|-----------------|------------------|----------------------------------------------------------|
| streamId        | string           | the GUUID of the message                                 |
| messageType     | string           | the event type                                           |
| streamHeaders   | JSON string      | a map of header values for routing                       |
| messageProtocol | `text` or `json` | some encoding (maybe future support for BSON/GRPC _etc_) |
| sourceId        | GUUID            | the source of the message                                |
| UnoccupiedField | nil              | [currently unused]                                       |
| payload         | `text` or `JSON` | the message payload                                      |
