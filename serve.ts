import { parse } from "@std/flags";
import { WebSocketServer } from "npm:ws@8.13.0";
import { Awareness, Loro } from "npm:loro-crdt@0.16.10";
import { encodeServerAckMessage, parseMessage, sendUpdate } from "./msg.ts";

interface Room {
    participants: Map<WebSocket, string>; // WebSocket to token mapping
    lastActive: number;
    awareness: Awareness;
    crdtData: Uint8Array[];
}

export type AuthCallback = (
    roomId: string,
    authHeader: string | null,
) => Promise<boolean>;
export type OnCompaction = (roomId: string, data: Uint8Array) => Promise<void>;

export type ServerConfig = {
    port: number;
    host?: string;
    authCallback?: AuthCallback | null;
    roomTimeout?: number;
    compactionInterval?: number;
    onCompaction?: OnCompaction | null;
};

const rooms = new Map<string, Room>();

function createRoom(roomId: string): Room {
    const a = new Awareness("100");
    const room: Room = {
        participants: new Map(),
        lastActive: Date.now(),
        awareness: a,
        crdtData: [],
    };
    rooms.set(roomId, room);
    return room;
}

async function cleanupRooms(
    roomTimeout: number,
    onCompaction: OnCompaction | null,
) {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
        if (
            room.participants.size === 0 && now - room.lastActive > roomTimeout
        ) {
            // Persist CRDT data here (e.g., to a database)
            if (onCompaction) {
                try {
                    const data = room.crdtData;
                    const doc = new Loro();
                    doc.importUpdateBatch(data);
                    const finalData = doc.exportSnapshot();
                    onCompaction(roomId, finalData);
                } catch (e) {
                    console.error(e);
                }
            }

            rooms.delete(roomId);
        } else if (room.crdtData.length > 16) {
            try {
                console.info(`Compacting Room[${roomId}]`);
                const data = room.crdtData;
                const doc = new Loro();
                doc.importUpdateBatch(data);
                room.crdtData = [doc.exportSnapshot()];
                onCompaction?.(roomId, room.crdtData[0]);
                // avoid blocking for too long
                await new Promise((r) => setTimeout(r, 16));
                console.info(`Compacting Room[${roomId}] Done`);
            } catch (e) {
                console.error(e);
            }
        }
    }
}

/**
 * Send the initial data for the given client
 *
 * @param currentRoom
 * @param ws
 */
function sendInitDataOfRoom(currentRoom: Room, ws: WebSocket) {
    for (const d of currentRoom.crdtData) {
        sendUpdate(ws, "crdt", d);
    }
    const bytes = currentRoom.awareness.encodeAll();
    sendUpdate(ws, "ephemeral", bytes);
}

export function startServer(
    config: ServerConfig,
): Deno.HttpServer<Deno.NetAddr> {
    const {
        port,
        host = "0.0.0.0",
        authCallback = null,
        roomTimeout = 600000, // Default to 10 minutes
        compactionInterval = 300000, // Default to 5 minutes
        onCompaction = null,
    } = config;

    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (ws: WebSocket, roomId: string) => {
        const isNewRoom = !rooms.get(roomId);
        const currentRoom: Room = rooms.get(roomId) || createRoom(roomId);
        currentRoom.participants.set(ws, "");
        currentRoom.lastActive = Date.now();
        ws.send(encodeServerAckMessage({
            roomId,
            isNewRoom,
        }));
        console.log(`New user joined ROOM[${roomId}] isNewRoom=${isNewRoom}`);
        sendInitDataOfRoom(currentRoom, ws);

        ws.addEventListener("message", (ev: MessageEvent<Uint8Array>) => {
            const message = parseMessage(new Uint8Array(ev.data));

            if (message.type === "update") {
                if (!currentRoom) return;
                currentRoom.lastActive = Date.now();
                console.log(
                    `Room[${roomId}] Received Update Type[${message.updateType}] Size=${message.payload.length} TotalLength=${currentRoom.crdtData.length}`,
                );
                broadcastToRoom(currentRoom, ev.data, ws);
                switch (message.updateType) {
                    case "ephemeral":
                        break;
                    case "awareness":
                        currentRoom.awareness.apply(message.payload);
                        break;
                    case "crdt":
                        currentRoom.crdtData.push(message.payload);
                        break;
                }
            } else {
                console.error("Unexpected message type:", message.type);
            }
        });

        ws.addEventListener("close", () => {
            if (currentRoom) {
                currentRoom.participants.delete(ws);
                currentRoom.lastActive = Date.now();
            }
        });
    });

    const server = Deno.serve({ port, hostname: host }, async (req) => {
        if (req.headers.get("upgrade") !== "websocket") {
            return new Response("Not a WebSocket request", { status: 400 });
        }

        // Extract roomId from URL or query parameters
        const url = new URL(req.url);
        const roomId = url.searchParams.get("roomId");

        if (!roomId) {
            return new Response("Room ID is required", { status: 400 });
        }

        // Perform authentication
        if (authCallback) {
            const authHeader = req.headers.get("Authorization");
            const isAuthorized = await authCallback(roomId, authHeader);
            if (!isAuthorized) {
                return new Response("Unauthorized", { status: 401 });
            }
        }

        // If authentication passes, upgrade to WebSocket
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.addEventListener("open", () => {
            wss.emit("connection", socket, roomId);
        });
        return response;
    });

    const timer = setInterval(() => {
        cleanupRooms(roomTimeout, onCompaction);
    }, Math.min(roomTimeout, compactionInterval));
    server.finished.then(() => {
        clearInterval(timer);
        rooms.forEach((x) => {
            x.awareness.destroy();
        });
        rooms.clear();
    });
    return server;
}

function broadcastToRoom(room: Room, data: Uint8Array, sender: WebSocket) {
    for (const [participant, _] of room.participants) {
        if (participant !== sender) {
            participant.send(data);
        }
    }
}

// CLI implementation
if (import.meta.main) {
    const { args } = Deno;
    const parsedArgs = parse(args);
    const port = parsedArgs.port || parsedArgs.p || 8080;
    const host = parsedArgs.host || parsedArgs.h || "0.0.0.0";
    const roomTimeout = parsedArgs.timeout || parsedArgs.t || 600000; // Default to 10 minutes

    if (typeof port !== "number" || isNaN(port)) {
        console.error("Invalid port number. Please provide a valid number.");
        Deno.exit(1);
    }

    if (typeof roomTimeout !== "number" || isNaN(roomTimeout)) {
        console.error(
            "Invalid room timeout. Please provide a valid number in milliseconds.",
        );
        Deno.exit(1);
    }

    startServer({ port, host, roomTimeout });
}
