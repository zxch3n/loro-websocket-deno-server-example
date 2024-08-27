import { encodeUpdateMessage, parseMessage } from "./msg.ts";
import type { Awareness, Loro } from "npm:loro-crdt@0.16.7";

type CustomWebSocket = {
    new(url: string, protocols?: string | string[]): WebSocket;
};

export function connectRoom(
    addr: string,
    room: string,
    doc: Loro,
    awareness: Awareness,
    onEphemeral?: (data: Uint8Array) => void,
    customWebSocket?: CustomWebSocket,
): Promise<WebSocket> {
    const url = `${addr}?roomId=${room}`;
    const WebSocketImpl = customWebSocket || WebSocket;

    const socket = new WebSocketImpl(url);

    socket.binaryType = "arraybuffer";

    return new Promise<WebSocket>((resolve, reject) => {
        socket.onopen = () => {
            console.log(`Connected to room: ${room}`);
            resolve(socket);
        };

        socket.onerror = (error) => {
            console.error(`WebSocket error: ${error}`);
            reject(error);
        };

        socket.onmessage = (event) => {
            const message = parseMessage(new Uint8Array(event.data));
            if (message.type === "ack" && message.roomId === room) {
                console.log(`Joined room: ${room}`);
            } else if (message.type === "update") {
                // Handle different update types
                switch (message.updateType) {
                    case "ephemeral":
                        onEphemeral?.(message.payload);
                        break;
                    case "awareness":
                        awareness.apply(message.payload);
                        break;
                    case "crdt":
                        doc.import(message.payload);
                        break;
                }
            }
        };

        socket.onclose = () => {
            console.log(`Disconnected from room: ${room}`);
        };
    });
}

// Helper function to send updates
export function sendUpdate(
    socket: WebSocket,
    updateType: "ephemeral" | "awareness" | "crdt",
    data: Uint8Array,
) {
    const message = encodeUpdateMessage(updateType, data);
    socket.send(message);
}
