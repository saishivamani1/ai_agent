// server/Server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import http from "http";
import { Server as SocketServer } from "socket.io";
import twilio from "twilio";

// Load .env locally; Render injects env so this is harmless there
dotenv.config();

// ---------- Env ----------
const PORT = process.env.PORT || 5000;

// Allow single origin or comma-separated origins in CLIENT_ORIGIN
const rawOrigins = process.env.CLIENT_ORIGIN || "http://localhost:3000";
const ORIGINS = rawOrigins
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FASTAPI_URL_RAW =
  process.env.FASTAPI_URL || "https://backend-service-w8d7.onrender.com";
const FASTAPI_URL = FASTAPI_URL_RAW.replace(/\/+$/g, ""); // strip trailing slash

// Twilio (support both common env names for messaging service SID)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_MSID =
  process.env.TWILIO_MESSAGING_SID ||
  process.env.TWILIO_MESSAGING_SERVICE_SID; // MGxxxxxxxx
const DEFAULT_ALERT_TO = process.env.ALERT_PHONE; // e.g. +9193xxxxxxx

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// ---------- App / Sockets ----------
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: ORIGINS, methods: ["GET", "POST"], credentials: true },
});

// CORS + JSON
app.use(cors({ origin: ORIGINS, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// ---------- De-duplication (basic debounce) ----------
const lastSendByKey = new Map(); // key -> timestamp
const DEBOUNCE_MS = 90 * 1000; // 90s

function shouldSend(key) {
  const now = Date.now();
  const last = lastSendByKey.get(key) || 0;
  if (now - last < DEBOUNCE_MS) return false;
  lastSendByKey.set(key, now);
  return true;
}

// ---------- Twilio helpers ----------
function requireTwilio() {
  if (!twilioClient) {
    console.error("[twilio] not configured: set TWILIO_ACCOUNT_SID & TWILIO_AUTH_TOKEN");
    return false;
  }
  if (!TWILIO_MSID) {
    console.error("[twilio] missing TWILIO_MESSAGING_SID or TWILIO_MESSAGING_SERVICE_SID");
    return false;
  }
  return true;
}

async function sendImmediateSMS({ to, body }) {
  if (!requireTwilio()) return { ok: false, error: "Twilio not configured" };
  if (!to) return { ok: false, error: 'Missing "to" number' };
  if (!body) return { ok: false, error: 'Missing "body"' };

  try {
    const msg = await twilioClient.messages.create({
      to,
      body,
      messagingServiceSid: TWILIO_MSID,
    });
    console.log("[twilio] SMS created:", msg.sid);
    return { ok: true, sid: msg.sid };
  } catch (err) {
    console.error("[twilio] send error:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function scheduleSMS({ to, body, sendAtISO }) {
  if (!requireTwilio()) return { ok: false, error: "Twilio not configured" };
  if (!to) return { ok: false, error: 'Missing "to" number' };
  if (!body) return { ok: false, error: 'Missing "body"' };

  try {
    const msg = await twilioClient.messages.create({
      to,
      body,
      messagingServiceSid: TWILIO_MSID,
      sendAt: sendAtISO, // must be in the future, ISO 8601
      scheduleType: "fixed",
    });
    console.log("[twilio] scheduled:", msg.sid, "sendAt:", sendAtISO);
    return { ok: true, sid: msg.sid };
  } catch (err) {
    console.error("[twilio] schedule error:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ ok: true })); // for Render
app.get("/api/health", (_req, res) => res.json({ ok: true })); // your existing path

// ---------- Manual SMS (immediate) ----------
app.post("/api/send-sms", async (req, res) => {
  const to = req.body?.to || DEFAULT_ALERT_TO;
  const body = req.body?.body || "Test from Node ✅";
  const key = `send|${to}|${body}`;
  if (!shouldSend(key)) return res.status(429).json({ error: "Debounced duplicate send" });

  const r = await sendImmediateSMS({ to, body });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// ---------- Manual SMS (scheduled) ----------
app.post("/api/schedule-sms", async (req, res) => {
  const to = req.body?.to || DEFAULT_ALERT_TO;
  const body = req.body?.body || "Scheduled from Node ⏰";
  const sendAtISO = req.body?.sendAt || new Date(Date.now() + 60_000).toISOString();
  const key = `sched|${to}|${body}|${sendAtISO}`;
  if (!shouldSend(key)) return res.status(429).json({ error: "Debounced duplicate schedule" });

  const r = await scheduleSMS({ to, body, sendAtISO });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// ---------- Proxy to FastAPI + alert bridge ----------
app.post("/api/predict", async (req, res) => {
  try {
    const r = await axios.post(`${FASTAPI_URL}/predict`, req.body, { timeout: 15000 });
    const data = r.data;

    // Broadcast to clients
    io.emit("red_alert", {
      when: new Date().toISOString(),
      summary: {
        hazard_level: data?.hazard_level,
        energy_megatons: data?.energy_megatons,
        severe_radius_km:
          data?.overpressure?.find((b) => b.threshold === "5 psi")?.radius_km ?? null,
        mode: data?.mode,
      },
      location: { lat: req.body?.lat, lon: req.body?.lon },
    });

    // On red alert, send SMS
    if (data?.red_alert) {
      const to = req.body?.notify_phone || DEFAULT_ALERT_TO;
      if (!to) {
        console.error('[twilio] "to" number missing: set ALERT_PHONE env or send notify_phone in body.');
      } else {
        const severeRadius =
          data?.overpressure?.find((b) => b.threshold === "5 psi")?.radius_km ?? "?";
        const body =
          `🚨 EVACUATE NOW – area near ${req.body?.lat?.toFixed?.(3) ?? req.body?.lat},` +
          `${req.body?.lon?.toFixed?.(3) ?? req.body?.lon}. ` +
          `Move beyond ${Math.max(6, Math.round(Number(severeRadius) || 0))}km from impact point. ` +
          `Severe zone ≈ ${severeRadius}km. ` +
          `If coastal, go inland/uphill. Help: 104 – Disaster Mgmt Dept`;

        const key = `alert|${to}|${req.body?.lat}|${req.body?.lon}|${severeRadius}`;
        if (shouldSend(key)) {
          const r2 = await sendImmediateSMS({ to, body });
          if (!r2.ok) console.error("[twilio] red alert send failed:", r2.error);
        } else {
          console.log("[alerts] skipped duplicate within debounce window");
        }
      }
    }

    res.json(data);
  } catch (err) {
    const details = err?.response?.data || err.message;
    console.error("[/api/predict] ERROR:", details);
    res.status(400).json({ error: "Prediction failed", details });
  }
});

// ---------- Socket events (optional demo) ----------
io.on("connection", (socket) => {
  console.log("[socket] client connected:", socket.id);
  socket.on("disconnect", () => console.log("[socket] client disconnected:", socket.id));
});

// ---------- Start server (single listener) ----------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] listening on :${PORT}`);
});

// ---------- Graceful shutdown ----------
function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down...`);
  server.close(() => {
    console.log("[server] closed");
    process.exit(0);
  });
  // force-exit if not closed in time
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
