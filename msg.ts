/**
# WebSocket Binary Protocol Documentation

This document outlines the binary protocol used for communication in our WebSocket - based room system.

## Message Structure

All messages follow this general structure:
[1 byte: Message Type][Payload]

### Message Types

- 0: Join Room
- 1: Update
- 2: Server Acknowledgment(for join)

## Detailed Message Formats

### 1. Join Room(Type 0)
Format: [0][Room ID(UTF - 8 encoded string)]

### 2. Update(Type 1)
Format: [1][1 byte: Update Type][Payload]

Update Types:
- 0: Ephemeral
    - 1: Awareness
        - 2: CRDT

#### 2.1 Ephemeral Update
Format: [1][0][Arbitrary binary data]

#### 2.2 Awareness Update
Format: [1][1][Awareness data(as defined by loro - crdt)]

#### 2.3 CRDT Update
Format: [1][2][CRDT update data]

### 3. Server Acknowledgment(Type 2)
Format: [2][Room ID(UTF - 8 encoded string)]

*/


// Types
type UpdateType = "ephemeral" | "awareness" | "crdt";
type UpdateMessage = { type: "update"; updateType: UpdateType; payload: Uint8Array };
type ServerAckMessage = { type: "ack"; roomId: string };

type Message = UpdateMessage | ServerAckMessage;

// Parsing function
export function parseMessage(data: Uint8Array): Message {
    const messageType = data[0];
    switch (messageType) {
        case 1: // Update
            {

                const updateType = (() => {
                    switch (data[1]) {
                        case 0: return "ephemeral";
                        case 1: return "awareness";
                        case 2: return "crdt";
                        default: throw new Error(`Unknown update type: ${data[1]}`);
                    }
                })();
                return {
                    type: "update",
                    updateType,
                    payload: data.slice(2)
                };
            }
        case 2: // Server Acknowledgment
            return {
                type: "ack",
                roomId: new TextDecoder().decode(data.slice(1))
            };
        default:
            throw new Error(`Unknown message type: ${messageType}`);
    }
}

export function encodeUpdateMessage(updateType: UpdateType, payload: Uint8Array): Uint8Array {
    const message = new Uint8Array(2 + payload.length);
    message[0] = 1;
    message[1] = updateType === "ephemeral" ? 0 : updateType === "awareness" ? 1 : 2;
    message.set(payload, 2);
    return message;
}

export function encodeServerAckMessage(roomId: string): Uint8Array {
    const roomIdBytes = new TextEncoder().encode(roomId);
    const message = new Uint8Array(1 + roomIdBytes.length);
    message[0] = 2;
    message.set(roomIdBytes, 1);
    return message;
}
