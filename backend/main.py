# backend/main.py
from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional
from math import pi

# ✅ Twilio import
from twilio.rest import Client

# ---------- Twilio Config ----------
account_sid = 'ACc78f4002d342b9c26f196a5ba7b41a8f'
auth_token = '55e630a9df878ad20cc166611458a3ce'   # <-- replace with your actual Auth Token
messaging_service_sid = 'MGbe56b4df6eb22a5bbe7a7f3cbe64c5e4'
alert_phone = '+919398351807'  # <-- your number

client = Client(account_sid, auth_token)


# ---------- FastAPI Setup ----------
app = FastAPI(title="Asteroid Hazard FastAPI", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000","https://ai-agent-iho3.onrender.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Models ----------
class PredictIn(BaseModel):
    type: str
    diameter_m: float = Field(..., gt=0)
    speed_kms: float = Field(..., gt=0)
    entry_angle_deg: float = Field(..., gt=0, le=90)
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    surface: str
    density_kg_m3: Optional[float] = None


class Ring(BaseModel):
    threshold: str
    radius_km: float


class PredictOut(BaseModel):
    energy_megatons: float
    breakup_altitude_km: float
    mode: str
    hazard_level: str
    red_alert: bool
    overpressure: List[Ring]


# ---------- Physics Helpers ----------
def density_from_type(kind: str) -> float:
    lut = {"stony": 3000.0, "iron": 7800.0, "comet": 600.0}
    return lut.get((kind or "").lower(), 3000.0)


def compute_energy_mt(diameter_m: float, speed_kms: float, rho: float) -> float:
    r = diameter_m / 2.0
    volume = (4.0 / 3.0) * pi * (r ** 3)
    mass = volume * rho
    v = speed_kms * 1000.0
    energy_j = 0.5 * mass * (v ** 2)
    return energy_j / 4.184e15


def band_radii_km(energy_mt: float, surface: str) -> tuple[float, float, float]:
    k = max(0.5, min(12.0, energy_mt ** 0.35))
    s = 1.2 if (surface or "").lower() == "land" else 1.0
    r5 = round(k * 6.0 * s, 2)
    r3 = round(k * 10.0 * s, 2)
    r1 = round(k * 18.0 * s, 2)
    return r5, r3, r1


def pick_mode(entry_angle_deg: float, speed_kms: float) -> tuple[str, float]:
    if entry_angle_deg < 25 and speed_kms > 15:
        return "airburst", 25.0
    return "ground impact", 0.0


def hazard_bucket(energy_mt: float, r5_km: float) -> str:
    if energy_mt < 0.05 and r5_km < 3:
        return "green"
    if energy_mt < 0.2 and r5_km < 5:
        return "info"
    if energy_mt < 1.0 and r5_km < 8:
        return "watch"
    return "warning"


# ---------- Twilio Send ----------
def send_sms_alert(body: str, to: str = alert_phone):
    try:
        message = client.messages.create(
            messaging_service_sid=messaging_service_sid,
            body=body,
            to=to
        )
        print("[twilio] Message SID:", message.sid)
    except Exception as e:
        print("[twilio] error:", e)


# ---------- Routes ----------
@app.get("/health")
def health():
    return {"ok": True}


@app.post("/predict", response_model=PredictOut)
def predict(inp: PredictIn, background: BackgroundTasks):
    rho = inp.density_kg_m3 if inp.density_kg_m3 else density_from_type(inp.type)
    energy_mt = round(compute_energy_mt(inp.diameter_m, inp.speed_kms, rho), 3)
    mode, breakup_alt_km = pick_mode(inp.entry_angle_deg, inp.speed_kms)
    r5, r3, r1 = band_radii_km(energy_mt, inp.surface)
    hazard = hazard_bucket(energy_mt, r5)
    red_alert = hazard == "warning" or r5 >= 5.0

    if red_alert:
        body = (
            f"🚨 RED ALERT 🚨\n"
            f"Hazard: {hazard.upper()}\n"
            f"Energy: {energy_mt} Mt TNT\n"
            f"Severe radius: {r5} km\n"
            f"Mode: {mode}\n"
            f"Location: lat {inp.lat}, lon {inp.lon}"
        )
        background.add_task(send_sms_alert, body)

    return PredictOut(
        energy_megatons=energy_mt,
        breakup_altitude_km=breakup_alt_km,
        mode=mode,
        hazard_level=hazard,
        red_alert=bool(red_alert),
        overpressure=[
            Ring(threshold="5 psi", radius_km=r5),
            Ring(threshold="3 psi", radius_km=r3),
            Ring(threshold="1 psi", radius_km=r1),
        ],

    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

