import {
    assertEquals,
    assertNotEquals,
    assertRejects,
    assertStrictEquals,
    assertThrows,
} from "jsr:@std/assert@1";
import { startServer } from "./serve.ts";
import {
    afterEach,
    beforeEach,
    describe,
    it,
} from "jsr:@std/testing@0.225.3/bdd";
import { encodeUpdateMessage } from "./msg.ts";
import { connectRoom } from "./client.ts";
import { Awareness, Loro } from "npm:loro-crdt@0.16.9";

const TEST_PORT = 8089;
const TEST_HOST = "127.0.0.1";
const TEST_ROOM_TIMEOUT = 1000; // 5 seconds for faster testing

let server: Deno.Server | null = null;

async function closeServer() {
    if (server) {
        await server.shutdown();
        server = null;
    }
}

describe("WebSocket Server Tests", async () => {
    beforeEach(async () => {
        await closeServer(); // Ensure server is closed before each test
    });

    afterEach(async () => {
        await closeServer(); // Ensure server is closed after each test
    });

    it("Unauthorized access", async () => {
        const authCallback = (_roomId: string, _authHeader: string | null) =>
            Promise.resolve(false);
        server = startServer({
            port: TEST_PORT,
            host: TEST_HOST,
            authCallback,
        });

        await assertRejects(
            async () => {
                await new Promise<void>((resolve, reject) => {
                    const ws = new WebSocket(
                        `ws://${TEST_HOST}:${TEST_PORT}?roomId=test`,
                    );
                    ws.onerror = () => reject(new Error());
                    ws.onopen = () => {
                        // Handle successful connection
                        resolve();
                    };
                });
            },
            Error,
        );
    });

    it("Broadcast to room", async () => {
        const authCallback = (_roomId: string, _authHeader: string | null) =>
            Promise.resolve(true);
        server = startServer({
            port: TEST_PORT,
            host: TEST_HOST,
            authCallback,
        });

        const client1 = new WebSocket(
            `ws://${TEST_HOST}:${TEST_PORT}?roomId=test`,
        );
        const client2 = new WebSocket(
            `ws://${TEST_HOST}:${TEST_PORT}?roomId=test`,
        );

        try {
            await Promise.all([
                new Promise<void>((resolve) =>
                    client1.onopen = () => resolve()
                ),
                new Promise<void>((resolve) =>
                    client2.onopen = () => resolve()
                ),
            ]);

            // Send update from client1
            await new Promise((r) => setTimeout(r, 10));
            const messagePromise = new Promise<ArrayBuffer>((resolve) => {
                client2.addEventListener("message", (event: MessageEvent) => {
                    resolve((event.data as Blob).arrayBuffer());
                });
            });

            const updateData = encodeUpdateMessage(
                "ephemeral",
                new Uint8Array([1, 2, 3]),
            );
            client1.send(updateData);
            const receivedMessage = await messagePromise;
            assertEquals(
                new Uint8Array(receivedMessage),
                updateData,
                "Broadcast message should match sent message",
            );
        } catch (e) {
            console.error(e);
            throw e;
        } finally {
            client1.close();
            client2.close();
        }
    });

    it("Room cleanup", async () => {
        const authCallback = (_roomId: string, _authHeader: string | null) =>
            Promise.resolve(true);
        server = startServer({
            port: TEST_PORT,
            host: TEST_HOST,
            authCallback,
            roomTimeout: TEST_ROOM_TIMEOUT,
        });

        const client = new WebSocket(
            `ws://${TEST_HOST}:${TEST_PORT}?roomId=test`,
        );

        try {
            await new Promise<void>((resolve) =>
                client.onopen = () => resolve()
            );

            // Send a test update (room join is now automatic)
            client.send(
                encodeUpdateMessage("ephemeral", new Uint8Array([1, 1])),
            );

            // Close connection
            client.close();

            // Wait for room cleanup (should be slightly more than TEST_ROOM_TIMEOUT)
            await new Promise((resolve) =>
                setTimeout(resolve, TEST_ROOM_TIMEOUT + 100)
            );

            // Try to join the same room
            const newClient = new WebSocket(
                `ws://${TEST_HOST}:${TEST_PORT}?roomId=test`,
            );

            try {
                await new Promise<void>((resolve) =>
                    newClient.onopen = () => resolve()
                );
                newClient.send(
                    encodeUpdateMessage("ephemeral", new Uint8Array([1, 1])),
                );
                // If we reach this point without errors, it means the room was successfully cleaned up and recreated
            } finally {
                newClient.close();
            }
        } finally {
            client.close();
        }
    });

    it("Sync Two Loro Docs Correctly", async () => {
        const authCallback = (_roomId: string, _authHeader: string | null) =>
            Promise.resolve(true);
        server = startServer({
            port: TEST_PORT,
            host: TEST_HOST,
            authCallback,
            roomTimeout: TEST_ROOM_TIMEOUT,
        });

        const docA = new Loro();
        const docB = new Loro();
        docA.getText("text").insert(0, "123");
        docA.commit();
        docB.getText("text").insert(0, "Hello!");
        docB.commit();

        const connA = await connectRoom(
            `http://${TEST_HOST}:${TEST_PORT}`,
            "TestRoom",
            docA,
            new Awareness(docA.peerIdStr),
        );
        const connB = await connectRoom(
            `http://${TEST_HOST}:${TEST_PORT}`,
            "TestRoom",
            docB,
            new Awareness(docA.peerIdStr),
        );

        await new Promise((r) => setTimeout(r, 50));
        assertEquals(docA.toJSON(), docB.toJSON());
        docA.getText("text").insert(8, "Nihao");
        docA.getText("text").insert(4, "ABC");
        assertNotEquals(docA.toJSON(), docB.toJSON());
        docA.commit();
        docB.commit();
        await new Promise((r) => setTimeout(r, 50));
        assertEquals(docA.toJSON(), docB.toJSON());
        connA.close();
        connB.close();
        console.log("DONE!");
    });
});
