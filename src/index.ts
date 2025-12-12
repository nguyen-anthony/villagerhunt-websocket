import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

type Subscriber = {
  ws: WebSocket;
  rooms: Set<string>;
};

type BroadcastMessage = {
  room: string;
  payload: any;
  metadata?: any;
};

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;
const API_KEY = process.env.API_KEY || ""; // optional: protect HTTP endpoint

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// Simple health check
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * HTTP broadcast endpoint (creator can POST here after writing to Supabase)
 * Body: { room: string, payload: {...}, metadata?: {...} }
 * Header: x-api-key: <API_KEY> (if set)
 */
app.post("/broadcast", (req, res) => {
  if (API_KEY) {
    const key = (req.headers["x-api-key"] || "") as string;
    if (!key || key !== API_KEY) {
      return res.status(401).json({ error: "invalid api key" });
    }
  }

  const body = req.body as BroadcastMessage;
  if (!body || typeof body.room !== "string") {
    return res.status(400).json({ error: "bad request: room required" });
  }

  const msg = {
    type: "update",
    room: body.room,
    payload: body.payload,
    metadata: body.metadata || null,
    ts: Date.now()
  };

  const count = broadcastToRoom(body.room, msg);
  return res.json({ ok: true, sentTo: count });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Map a WebSocket to a Subscriber object:
 * key: ws
 * value: Subscriber (rooms set)
 */
const subs = new Map<WebSocket, Subscriber>();

/**
 * Map of rooms -> Set<Subscriber>
 */
const rooms = new Map<string, Set<Subscriber>>();

function ensureRoom(room: string) {
  if (!rooms.has(room)) rooms.set(room, new Set());
}

function subscribe(ws: WebSocket, room: string) {
  let s = subs.get(ws);
  if (!s) {
    s = { ws, rooms: new Set() };
    subs.set(ws, s);
  }
  if (s.rooms.has(room)) return;
  s.rooms.add(room);
  ensureRoom(room);
  rooms.get(room)!.add(s);
}

function unsubscribe(ws: WebSocket, room: string) {
  const s = subs.get(ws);
  if (!s) return;
  if (!s.rooms.has(room)) return;
  s.rooms.delete(room);
  const r = rooms.get(room);
  if (r) {
    r.delete(s);
    if (r.size === 0) rooms.delete(room);
  }
}

function cleanup(ws: WebSocket) {
  const s = subs.get(ws);
  if (!s) return;
  for (const room of s.rooms) {
    const r = rooms.get(room);
    if (r) {
      r.delete(s);
      if (r.size === 0) rooms.delete(room);
    }
  }
  subs.delete(ws);
}

/**
 * Broadcast a JSON message to all subscribers in a room.
 * Returns number of sockets attempted to send to.
 */
function broadcastToRoom(room: string, message: any): number {
  const r = rooms.get(room);
  if (!r) return 0;
  const data = JSON.stringify(message);
  let count = 0;
  for (const s of r) {
    if (s.ws.readyState === WebSocket.OPEN) {
      try {
        s.ws.send(data);
        count++;
      } catch (e) {
        // ignore per-socket send errors; cleanup will occur on close
      }
    }
  }
  return count;
}

/**
 * Protocol:
 * Client (viewer) connects via WebSocket.
 * Messages from client are JSON:
 * - { type: "subscribe", room: "hunt_123" }
 * - { type: "unsubscribe", room: "hunt_123" }
 * - { type: "ping" } -> server replies pong
 *
 * The server can also accept "publish" messages if you want creators to send
 * updates directly over WS:
 * - { type: "publish", room: "hunt_123", payload: {...}, apiKey?: "..." }
 *
 * For better security, prefer calling the HTTP /broadcast endpoint from your Next.js serverless or client with API_KEY.
 */

wss.on("connection", (ws, req) => {
  // optional: quick log
  console.log("WS connected", req.socket.remoteAddress);

  let lastMessage = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - lastMessage > 60000) { // 60 seconds timeout
      console.log("WS timeout, closing", req.socket.remoteAddress);
      ws.close();
    }
  }, 30000); // check every 30 seconds

  ws.on("message", (raw) => {
    lastMessage = Date.now();
    let m: any;
    try {
      m = JSON.parse(raw.toString());
    } catch (e) {
      // ignore invalid JSON
      return;
    }
    if (!m || typeof m.type !== "string") return;

    switch (m.type) {
      case "subscribe":
        if (typeof m.room === "string") {
          subscribe(ws, m.room);
          ws.send(JSON.stringify({ type: "subscribed", room: m.room }));
        }
        break;

      case "unsubscribe":
        if (typeof m.room === "string") {
          unsubscribe(ws, m.room);
          ws.send(JSON.stringify({ type: "unsubscribed", room: m.room }));
        }
        break;

      case "ping":
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        break;

      case "publish":
        // Optional: allow direct WS publishing if the client supplies the right apiKey
        // Use with caution — HTTP endpoint is recommended
        if (typeof m.room === "string") {
          if (API_KEY && m.apiKey !== API_KEY) {
            ws.send(JSON.stringify({ type: "err", message: "invalid apiKey" }));
            return;
          }
          const msg = {
            type: "update",
            room: m.room,
            payload: m.payload || null,
            metadata: m.metadata || null,
            ts: Date.now()
          };
          const count = broadcastToRoom(m.room, msg);
          ws.send(JSON.stringify({ type: "published", room: m.room, sentTo: count }));
        }
        break;

      default:
        // unknown type - ignore
        break;
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    cleanup(ws);
    console.log("WS disconnected", req.socket.remoteAddress);
  });

  ws.on("error", () => {
    clearInterval(heartbeat);
    cleanup(ws);
    console.log("WS error", req.socket.remoteAddress);
  });
});

server.listen(PORT, () => {
  console.log(`Realtime broadcaster listening on port ${PORT}`);
  console.log(`HTTP broadcast POST /broadcast (x-api-key header)`);
});
