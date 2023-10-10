# Datasource:

> A module wrapping Redis connections and providing streaming methods

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [:factory: StreamingDataSource](#factory-streamingdatasource)
  - [Methods](#methods)
    - [:gear: writeToStream](#gear-writetostream)
    - [:gear: setResponseType](#gear-setresponsetype)
    - [:gear: addStreamId](#gear-addstreamid)
    - [:gear: hasStreamId](#gear-hasstreamid)
    - [:gear: removeStreamId](#gear-removestreamid)
    - [:gear: getReadStream](#gear-getreadstream)
    - [:gear: getWriteStream](#gear-getwritestream)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->
 
<!-- BEGIN-CODE: ./src/datasource/_API.md -->
[**_API.md**](./src/datasource/_API.md)

## :factory: StreamingDataSource

A remote source capable of retrieving stream records from a Redis instance.

### Methods

- [writeToStream](#gear-writetostream)
- [setResponseType](#gear-setresponsetype)
- [addStreamId](#gear-addstreamid)
- [hasStreamId](#gear-hasstreamid)
- [removeStreamId](#gear-removestreamid)
- [getReadStream](#gear-getreadstream)
- [getWriteStream](#gear-getwritestream)

#### :gear: writeToStream

| Method | Type |
| ---------- | ---------- |
| `writeToStream` | `(outgoingStream: string, incomingStream: string, messageType: MessageType, messageId: string, message: string, sourceId: string, shard?: string) => Promise<string>` |

Parameters:

* `outgoingStream`: : The stream ID to target in Redis
* `incomingStream`: : Maybe, a stream ID to reply to
* `messageType`: : The type of the event
* `messageId`: : The ID of the message
* `message`: : The message payload
* `sourceId`: : The ID of the source
* `shard`: : Maube, the shard to target


#### :gear: setResponseType

| Method | Type |
| ---------- | ---------- |
| `setResponseType` | `(type: string) => void` |

#### :gear: addStreamId

| Method | Type |
| ---------- | ---------- |
| `addStreamId` | `(streamId: string) => void` |

#### :gear: hasStreamId

| Method | Type |
| ---------- | ---------- |
| `hasStreamId` | `(streamId: string) => boolean` |

#### :gear: removeStreamId

| Method | Type |
| ---------- | ---------- |
| `removeStreamId` | `(streamId: string) => void` |

#### :gear: getReadStream

| Method | Type |
| ---------- | ---------- |
| `getReadStream` | `(options: { topic: Topic; shard?: string; } or GetReadStreamOptions) => Readable and { readableObjectMode: true; }` |

#### :gear: getWriteStream

| Method | Type |
| ---------- | ---------- |
| `getWriteStream` | `(options: { topic: Topic; shard?: string; } or { stream: string; responseChannel?: string; shard?: string; }) => Writable and { writableObjectMode: true; }` |



<!-- END-CODE: ./src/datasource/_API.md -->

Ok?