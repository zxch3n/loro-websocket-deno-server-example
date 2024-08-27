import { parseMessage, sendUpdate } from "./msg.ts";
import type { Awareness, LoroEventBatch } from "npm:loro-crdt@0.16.10";
import { Loro } from "npm:loro-crdt@0.16.10";

type CustomWebSocket = {
    new (url: string, protocols?: string | string[]): WebSocket;
};

export function connectRoom(
    addr: string,
    room: string,
    doc: Loro,
    awareness?: Awareness,
    onEphemeral?: (data: Uint8Array) => void,
    customWebSocket?: CustomWebSocket,
): Promise<WebSocket> {
    const url = `${addr}?roomId=${room}`;
    const WebSocketImpl = customWebSocket || WebSocket;

    const socket = new WebSocketImpl(url);
    let sub: null | number = null;
    let isFirst = true;
    socket.binaryType = "arraybuffer";
    const listener = (
        _e: unknown,
        origin: "local" | "remote" | "timeout" | string,
    ) => {
        if (!awareness) {
            return;
        }

        if (origin === "local") {
            const update = awareness.encode([doc.peerIdStr]);
            sendUpdate(socket, "awareness", update);
        }
    };
    return new Promise<WebSocket>((resolve, reject) => {
        socket.onopen = () => {
            let vv = doc.version();
            sub = doc.subscribe((e: LoroEventBatch) => {
                if (e.by === "local") {
                    // TODO: PERF: this creates a lot of redundancy for the server side
                    // We can find a way to trim the updates
                    sendUpdate(
                        socket,
                        "crdt",
                        doc.exportFrom(
                            vv,
                        ),
                    );

                    vv = doc.version();
                }
            });
            if (awareness) {
                awareness.addListener(listener);
            }
            console.log(`Connected to room: ${room}`);
            resolve(socket);
        };

        socket.onerror = (error) => {
            console.error(`WebSocket error: ${error}`);
            reject(error);
        };

        socket.onclose = () => {
            if (sub) {
                doc.unsubscribe(sub);
            }
            if (awareness) {
                awareness.removeListener(listener);
            }
        };

        socket.onmessage = (event) => {
            const message = parseMessage(new Uint8Array(event.data));
            if (message.type === "ack" && message.roomInfo.roomId === room) {
                console.log(`Joined room: ${room}`);
                if (message.roomInfo.isNewRoom) {
                    const snapshot = doc.exportSnapshot();
                    sendUpdate(socket, "crdt", snapshot);
                }
            } else if (message.type === "update") {
                // Handle different update types
                switch (message.updateType) {
                    case "ephemeral":
                        onEphemeral?.(message.payload);
                        break;
                    case "awareness":
                        console.log("got awareness update");
                        awareness?.apply(message.payload);
                        break;
                    case "crdt":
                        if (isFirst) {
                            const vv = doc.version();
                            const newDoc = new Loro();
                            newDoc.import(message.payload);
                            const newVV = newDoc.version();
                            if (newVV.compare(vv) == null) {
                                // there are offline updates that haven't been uploaded to the server
                                sendUpdate(
                                    socket,
                                    "crdt",
                                    doc.exportFrom(newVV),
                                );
                            }

                            isFirst = false;
                        }

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
