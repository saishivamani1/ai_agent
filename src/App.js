import React, { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Circle,
  Marker,
  Popup,
  LayersControl,
  ScaleControl,
  useMap
} from "react-leaflet";
import L from "leaflet";
import io from "socket.io-client";

// Ensure once in src/index.js:
// import 'leaflet/dist/leaflet.css';
// import './index.css'; // html, body, #root { height:100%; margin:0; }

// --- Use env-driven URLs (Render + local dev) ---
const API_BASE =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:5000"; // Node server (REST)
const SOCKET_URL =
  process.env.REACT_APP_SOCKET_URL || API_BASE; // Socket.IO endpoint (often same as Node)

// Leaflet marker assets
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:   "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:         "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const pretty = (n) => new Intl.NumberFormat().format(n);

/* ---------------- AgentX chat widget ---------------- */
const AGX_TOKEN =
  "68dff1a39986ee44c8b62ca1ue0VBAf1+VW4Yt6kW2+TKg==|mS+AOZmcH2MIsYayk3zwMEgU9ZsMkEPE/OfQNMUBNOE=";

function initAgentX() {
  // avoid double-injecting
  if (document.getElementById("chatBubbleRoot")) return;
  // 1) container
  const div = document.createElement("div");
  div.setAttribute("id", "chatBubbleRoot");
  document.body.appendChild(div);
  // 2) token
  window.agx = AGX_TOKEN;
  // 3) script
  const script = document.createElement("script");
  script.src = "https://storage.googleapis.com/agentx-cdn-01/agentx-chat.js";
  script.async = true;
  script.id = "agentx-chat";
  document.body.appendChild(script);
}

/* ---------------- Geocoding / Ocean detection ---------------- */

async function geocodePlace(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=1`;
  const r = await fetch(url, { headers: { "Accept-Language": "en" } });
  if (!r.ok) throw new Error("Geocoding failed");
  const arr = await r.json();
  if (!arr.length) throw new Error("Place not found");
  const item = arr[0];
  return { name: item.display_name, lat: parseFloat(item.lat), lon: parseFloat(item.lon) };
}

async function reverseLookup(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
  const r = await fetch(url, { headers: { "Accept-Language": "en" } });
  if (!r.ok) throw new Error("Reverse geocoding failed");
  const j = await r.json();
  const addr = j.address || {};
  const name =
    j.name ||
    addr.city ||
    addr.town ||
    addr.village ||
    addr.state ||
    addr.country ||
    "Selected location";
  // ocean detection heuristic
  const isOcean = !!(addr.ocean || addr.sea || addr.water || addr.bay || addr.strait);
  return { name, isOcean };
}

/* ---------------- NASA CNEOS (CAD API) ----------------
   Fetch upcoming close approaches (small distance), limit to 20.
   Fields doc: https://ssd-api.jpl.nasa.gov/doc/cad.html
-------------------------------------------------------- */

async function fetchNEOFeed(limit = 20) {
  const url =
    `https://ssd-api.jpl.nasa.gov/cad.api?dist-max=0.05&date-min=now&sort=dist&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("CNEOS fetch failed");
  const j = await r.json();
  const idx = {};
  j.fields.forEach((f, i) => (idx[f] = i));
  return j.data.map((row) => {
    const des = row[idx["des"]];
    const v_rel = parseFloat(row[idx["v_rel"]]); // km/s
    const h = row[idx["h"]] !== null ? parseFloat(row[idx["h"]]) : null; // abs mag
    const date = row[idx["cd"]]; // close-approach date/time
    const dist_au = parseFloat(row[idx["dist"]]);
    return { des, v_rel, h, date, dist_au };
  });
}

// Estimate diameter (meters) from H using default albedo p=0.14
function estimateDiameterFromH(H, p = 0.14) {
  if (H == null) return null;
  const D_km = (1329 / Math.sqrt(p)) * Math.pow(10, -0.2 * H); // km
  return Math.round(D_km * 1000); // meters
}

/* ----------------------- App ------------------------- */

export default function App() {
  const [form, setForm] = useState({
    type: "stony",
    diameter_m: 20,
    speed_kms: 19,
    entry_angle_deg: 45,
    lat: 20,
    lon: 0,
    surface: "land",
    density_kg_m3: ""
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  // place search
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeName, setPlaceName] = useState("");

  // population density knob (people/km²) — swap with GHSL later
  const [popDensity, setPopDensity] = useState(1200);

  // NEO feed state
  const [neos, setNeos] = useState([]);
  const [loadingNEO, setLoadingNEO] = useState(false);

  // real-time push banner (from server / Twilio trigger)
  const [pushAlert, setPushAlert] = useState(null);

  // ---- AgentX chat widget ----
  useEffect(() => {
    initAgentX();
  }, []);

  // fetch top NEOs on mount
  useEffect(() => {
    (async () => {
      try {
        setLoadingNEO(true);
        const items = await fetchNEOFeed(20);
        setNeos(items);
      } catch (e) {
        console.warn(e.message);
      } finally {
        setLoadingNEO(false);
      }
    })();
  }, []);

  // connect to Socket.IO for red alerts
  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket"] });
    socket.on("connect", () => console.log("[socket] connected:", socket.id));
    socket.on("red_alert", (payload) => {
      const text = `🚨 RED ALERT: ${String(payload?.summary?.hazard_level || "").toUpperCase()} • ` +
                   `Severe radius ${payload?.summary?.severe_radius_km ?? "?"} km`;
      setPushAlert({ text, at: payload?.when });
      // auto-hide after 10s
      setTimeout(() => setPushAlert(null), 10000);
    });
    return () => socket.close();
  }, []);

  const handle = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const centerLat = +form.lat;
  const centerLon = +form.lon;

  const submit = async (e) => {
    if (e) e.preventDefault();
    setLoading(true);
    setResult(null);
    const payload = {
      ...form,
      diameter_m: +form.diameter_m,
      speed_kms: +form.speed_kms,
      entry_angle_deg: +form.entry_angle_deg,
      lat: +form.lat,
      lon: +form.lon,
      density_kg_m3: form.density_kg_m3 ? +form.density_kg_m3 : null,
    };
    try {
      const r = await fetch(`${API_BASE}/api/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Server error");
      setResult(data);
      // also show an inline banner immediately (in case Socket.IO is not connected)
      if (data?.red_alert) {
        const severeRadius =
          data?.overpressure?.find((b) => b.threshold === "5 psi")?.radius_km ?? "?";
        setPushAlert({
          text: `🚨 RED ALERT: ${String(data.hazard_level).toUpperCase()} • Severe radius ${severeRadius} km`,
          at: new Date().toISOString()
        });
        setTimeout(() => setPushAlert(null), 10000);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const locateAndPredict = async () => {
    if (!placeQuery.trim()) return;
    try {
      setLoading(true);
      const p = await geocodePlace(placeQuery.trim());
      setPlaceName(p.name);
      // ocean detection
      const rev = await reverseLookup(p.lat, p.lon);
      const surface = rev.isOcean ? "ocean" : "land";
      setForm((f) => ({ ...f, lat: p.lat, lon: p.lon, surface }));
      await submit();
    } catch (e) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  // not a hook
  const handleUseMyLocation = async () => {
    if (!navigator.geolocation) {
      alert("Geolocation not supported");
      return;
    }
    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const rev = await reverseLookup(latitude, longitude);
          setPlaceName(rev.name);
          const surface = rev.isOcean ? "ocean" : "land";
          setForm((f) => ({ ...f, lat: latitude, lon: longitude, surface }));
          await submit();
        } catch (e) {
          alert(e.message);
        } finally {
          setLoading(false);
        }
      },
      (err) => {
        setLoading(false);
        alert("Location error: " + err.message);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  // not a hook
  const applyNEO = (neo) => {
    const speed_kms = Math.max(5, Math.min(80, Math.round(neo.v_rel * 10) / 10));
    const d_est = estimateDiameterFromH(neo.h) || 20; // fallback if H missing
    setForm((f) => ({
      ...f,
      speed_kms,
      diameter_m: d_est,
    }));
  };

  // radii in km from API
  const bands = result?.overpressure || [];
  const r1 = bands.find((b) => b.threshold === "1 psi")?.radius_km ?? 0;
  const r3 = bands.find((b) => b.threshold === "3 psi")?.radius_km ?? 0;
  const r5 = bands.find((b) => b.threshold === "5 psi")?.radius_km ?? 0;

  const peopleAtRisk = useMemo(() => {
    if (!r5) return 0;
    const areaKm2 = Math.PI * r5 * r5;
    return Math.round(areaKm2 * (Number(popDensity) || 0));
  }, [r5, popDensity]);

  return (
    <div style={{ height: "100vh", display: "grid", gridTemplateRows: "auto 1fr" }}>
      {/* Real-time RED ALERT banner */}
      {pushAlert && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
          background: "#dc2626", color: "white", padding: "10px 16px",
          fontWeight: 800, boxShadow: "0 2px 8px rgba(0,0,0,.25)"
        }}>
          {pushAlert.text}{" "}
          <span style={{ opacity: 0.85, fontWeight: 600 }}>
            @ {new Date(pushAlert.at).toLocaleTimeString()}
          </span>
        </div>
      )}

      <header style={{ padding: 16, borderBottom: "1px solid #e5e7eb", marginTop: pushAlert ? 44 : 0 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Asteroid Hazard — Live NEO + My Location</h1>
        <div style={{ color: "#6b7280", fontSize: 13 }}>Educational MVP — not an official warning.</div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", minHeight: 0 }}>
        {/* Left panel */}
        <div style={{ padding: 16, borderRight: "1px solid #e5e7eb", overflow: "auto" }}>
          {/* Place search & geolocation */}
          <div style={card}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Find a place</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
              <input
                type="text"
                placeholder="e.g., Hyderabad, India"
                value={placeQuery}
                onChange={(e) => setPlaceQuery(e.target.value)}
                style={input}
              />
              <button onClick={locateAndPredict} disabled={loading} style={btnPrimary}>
                {loading ? "Locating…" : "Locate & Predict"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={handleUseMyLocation} disabled={loading} style={btnGhost}>📍 Use my location</button>
              <Badge tone={form.surface === "ocean" ? "blue" : "green"}>
                {form.surface === "ocean" ? "Surface: Ocean" : "Surface: Land"}
              </Badge>
            </div>
            {placeName && (
              <div style={{ marginTop: 8, color: "#374151", fontSize: 13 }}>
                Located: <strong>{placeName}</strong>
              </div>
            )}
          </div>

          {/* NEO feed */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>Live NEO approaches (CNEOS)</div>
              <button
                onClick={async () => {
                  try {
                    setLoadingNEO(true);
                    const items = await fetchNEOFeed(20);
                    setNeos(items);
                  } catch (e) {
                    alert(e.message);
                  } finally {
                    setLoadingNEO(false);
                  }
                }}
                style={btnGhost}
              >
                {loadingNEO ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {!neos.length ? (
              <div style={{ color: "#6b7280" }}>No items loaded.</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8, maxHeight: 220, overflow: "auto" }}>
                {neos.map((n) => (
                  <li key={`${n.des}-${n.date}`} style={{ border: "1px solid #f3f4f6", borderRadius: 12, padding: 10, display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{n.des}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        {new Date(n.date).toLocaleString()} • Dist: {n.dist_au.toFixed(4)} AU • v: {n.v_rel.toFixed(1)} km/s • H: {n.h ?? "—"}
                      </div>
                    </div>
                    <button onClick={() => applyNEO(n)} style={btnMini}>Use</button>
                  </li>
                ))}
              </ul>
            )}
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
              “Use” sets speed and estimates diameter from H (albedo 0.14). Pick a place, then Predict.
            </div>
          </div>

          {/* Prediction form */}
          <form onSubmit={submit} style={card}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Select label="Type" v={form.type} onChange={handle("type")} options={[
                ["stony","Stony"],["iron","Iron"],["comet","Cometary"]
              ]}/>
              <Select label="Surface" v={form.surface} onChange={handle("surface")} options={[
                ["land","Land"],["ocean","Ocean"]
              ]}/>
              <Num label="Diameter (m)" v={form.diameter_m} onChange={handle("diameter_m")} min={2} step={1}/>
              <Num label="Speed (km/s)" v={form.speed_kms} onChange={handle("speed_kms")} min={5} step={0.1}/>
              <Num label="Entry angle (° from horizontal)" v={form.entry_angle_deg} onChange={handle("entry_angle_deg")} min={5} max={90} step={1}/>
              <Num label="Density (kg/m³, optional)" v={form.density_kg_m3} onChange={handle("density_kg_m3")} placeholder="auto from type"/>
              <Num label="Latitude" v={form.lat} onChange={handle("lat")} min={-90} max={90} step={0.1}/>
              <Num label="Longitude" v={form.lon} onChange={handle("lon")} min={-180} max={180} step={0.1}/>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button disabled={loading} style={btnPrimary}>{loading ? "Predicting…" : "Predict"}</button>
              <button type="button" onClick={() => setResult(null)} style={btnGhost}>Reset</button>
            </div>
          </form>

          {/* Results & population overlay */}
          <div style={card}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Hazard Summary</div>
            {!result ? (
              <div style={{ color: "#6b7280" }}>No run yet.</div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <Badge tone={result.hazard_level}>{result.hazard_level.toUpperCase()}</Badge>
                  {result.red_alert && <Badge tone="red">RED ALERT</Badge>}
                  <Badge>{result.mode === "airburst" ? "Airburst" : "Ground impact"}</Badge>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <Stat label="Energy (Mt TNT)" value={pretty(result.energy_megatons)} />
                  <Stat label="Breakup Altitude (km)" value={pretty(result.breakup_altitude_km)} />
                </div>
                <div style={{ marginTop: 10, fontSize: 13 }}>
                  <div><strong>5 psi:</strong> {r5} km</div>
                  <div><strong>3 psi:</strong> {r3} km</div>
                  <div><strong>1 psi:</strong> {r1} km</div>
                </div>
                <div style={{ marginTop: 10, fontSize: 13 }}>
                  <div>Location: <strong>{placeName || `Lat ${centerLat.toFixed(3)}, Lon ${centerLon.toFixed(3)}`}</strong></div>
                </div>
              </>
            )}
          </div>

          <div style={card}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Population overlay (simple)</div>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span>Assumed average density (people/km²)</span>
              <input
                type="number"
                min={0}
                step={50}
                value={popDensity}
                onChange={(e) => setPopDensity(e.target.value)}
                style={input}
              />
            </label>
            <div style={{ marginTop: 10, fontSize: 14 }}>
              <div>Severe area (5 psi): <strong>{pretty(Math.round(Math.PI * r5 * r5))}</strong> km²</div>
              <div>Estimated people at risk: <strong>{pretty(peopleAtRisk)}</strong></div>
            </div>
          </div>
        </div>

        {/* Map panel */}
        <div style={{ height: "100%" }}>
          <MapPanel lat={centerLat} lon={centerLon} r1={r1} r3={r3} r5={r5} placeName={placeName} />
        </div>
      </div>
    </div>
  );
}

/** Auto-fit helper: zoom to include largest ring */
function AutoFit({ lat, lon, maxRadiusKm }) {
  const map = useMap();
  React.useEffect(() => {
    if (!isFinite(lat) || !isFinite(lon)) return;
    const rKm = Math.max(1, maxRadiusKm || 1);
    const meters = rKm * 1000 * 1.15;
    const dLat = meters / 111320;
    const dLng = meters / (111320 * Math.cos((lat * Math.PI) / 180) || 1e-6);
    const bounds = L.latLngBounds([lat - dLat, lon - dLng], [lat + dLat, lon + dLng]);
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [lat, lon, maxRadiusKm, map]);
  return null;
}

function MapPanel({ lat, lon, r1, r3, r5, placeName }) {
  const center = [isFinite(lat) ? lat : 0, isFinite(lon) ? lon : 0];
  const maxR = Math.max(r1, r3, r5);

  return (
    <MapContainer
      center={center}
      zoom={maxR ? 5 : 3}
      style={{ width: "100%", height: "100%" }}
      scrollWheelZoom
      worldCopyJump={false}
      maxBounds={[[-90, -180], [90, 180]]}
      maxBoundsViscosity={1.0}
    >
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Carto Voyager">
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            attribution="&copy; OpenStreetMap & CARTO"
            noWrap={true}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="OpenStreetMap">
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
            noWrap={true}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Esri Satellite">
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution="Tiles &copy; Esri"
            noWrap={true}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Carto Dark Matter">
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution="&copy; OpenStreetMap & CARTO"
            noWrap={true}
          />
        </LayersControl.BaseLayer>
      </LayersControl>

      <ScaleControl position="bottomleft" />

      <Marker position={center}>
        <Popup>
          <div style={{ fontFamily: "system-ui", fontSize: 13 }}>
            <div><strong>{placeName || "Selected location"}</strong></div>
            <div>Lat {center[0].toFixed(4)}, Lon {center[1].toFixed(4)}</div>
            {r5 ? (
              <div>Severe radius (5 psi): <strong>{r5} km</strong></div>
            ) : (
              <div>Run a prediction to see radii.</div>
            )}
          </div>
        </Popup>
      </Marker>

      {/* Hazard rings */}
      {r5 > 0 && (
        <Circle
          center={center}
          radius={r5 * 1000}
          pathOptions={{ color: "#b91c1c", weight: 2, fillColor: "#ef4444", fillOpacity: 0.18 }}
        />
      )}
      {r3 > 0 && (
        <Circle
          center={center}
          radius={r3 * 1000}
          pathOptions={{ color: "#c2410c", weight: 2, dashArray: "6,4", fillColor: "#fb923c", fillOpacity: 0.12 }}
        />
      )}
      {r1 > 0 && (
        <Circle
          center={center}
          radius={r1 * 1000}
          pathOptions={{ color: "#a16207", weight: 2, dashArray: "2,6", fillColor: "#f59e0b", fillOpacity: 0.08 }}
        />
      )}

      <AutoFit lat={center[0]} lon={center[1]} maxRadiusKm={maxR} />
    </MapContainer>
  );
}

/* ---------------- UI helpers ---------------- */

function Select({ label, v, onChange, options }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span>{label}</span>
      <select value={v} onChange={onChange} style={input}>
        {options.map(([val, text]) => (
          <option key={val} value={val}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function Num({ label, v, onChange, min, max, step, placeholder }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span>{label}</span>
      <input
        type="number"
        value={v}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        style={input}
      />
    </label>
  );
}
function Stat({ label, value }) {
  return (
    <div style={{ border: "1px solid #f3f4f6", borderRadius: 12, padding: 12 }}>
      <div style={{ color: "#6b7280", fontSize: 12 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
    </div>
  );
}
function Badge({ children, tone }) {
  const palette = {
    gray: { bg: "#f3f4f6", fg: "#111827" },
    green: { bg: "#ecfdf5", fg: "#065f46" },
    amber: { bg: "#fffbeb", fg: "#92400e" },
    red: { bg: "#fef2f2", fg: "#991b1b" },
    blue: { bg: "#eff6ff", fg: "#1e40af" },
  };
  const map = { info: "blue", watch: "amber", warning: "red", red: "red", green: "green" };
  const key = map[tone] || "gray";
  const { bg, fg } = palette[key];
  return (
    <span style={{ background: bg, color: fg, borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 600 }}>
      {children}
    </span>
  );
}

const input = {
  padding: "10px 12px",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  outline: "none",
  background: "white",
};
const card = {
  border: "1px solid #e5e7eb",
  borderRadius: 16,
  padding: 18,
  boxShadow: "0 4px 14px rgba(0,0,0,0.05)",
  marginBottom: 16,
};
const btnPrimary = {
  padding: "10px 14px",
  borderRadius: 12,
  background: "#111827",
  color: "white",
  fontWeight: 700,
  border: "1px solid #111827",
  cursor: "pointer",
};
const btnGhost = {
  padding: "10px 10px",
  borderRadius: 12,
  background: "white",
  color: "#111827",
  fontWeight: 700,
  border: "1px solid #e5e7eb",
  cursor: "pointer",
};
const btnMini = {
  padding: "6px 10px",
  borderRadius: 10,
  background: "#111827",
  color: "white",
  fontWeight: 700,
  border: "1px solid #111827",
  cursor: "pointer",
  fontSize: 12,
};
