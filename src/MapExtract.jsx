import React from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, useMapEvents } from "react-leaflet";
import L from "leaflet";

// Fix default marker icons in bundlers
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`);
    const j = await r.json();
    return j.address.city || j.address.town || j.address.village || j.address.state || j.address.country || "Unknown";
  } catch {
    return "Unknown";
  }
}

function ClickHandler({ onPick }) {
  useMapEvents({
    click: async (e) => {
      const name = await reverseGeocode(e.latlng.lat, e.latlng.lng);
      onPick({ lat: e.latlng.lat, lon: e.latlng.lng, name });
    }
  });
  return null;
}

export default function MapExtract({ center=[20,0], zoom=2 }) {
  const [picked, setPicked] = React.useState(null);

  return (
    <MapContainer center={center} zoom={zoom} style={{ width: "100%", height: "100%" }} scrollWheelZoom>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
      />
      <ClickHandler onPick={setPicked} />
      {picked && (
        <CircleMarker center={[picked.lat, picked.lon]} radius={10} pathOptions={{ color: "orange", fillColor: "orange", fillOpacity: 0.85 }}>
          <Popup>
            <div style={{ fontFamily: "system-ui", fontSize: 14 }}>
              <b>📍 {picked.name}</b><br/>
              Lat {picked.lat.toFixed(4)}, Lon {picked.lon.toFixed(4)}
            </div>
          </Popup>
        </CircleMarker>
      )}
    </MapContainer>
  );
}
