# Live Viewer

A small local web app that combines ADS-B aircraft traffic and AIS vessel traffic on one 3D-leaning map. It is designed as the first slice of a broader multi-source live operations viewer.

## What this version includes

- Combined ADS-B and AIS targets on one map
- 3D-style tracking view with pitch, rotation, globe mode, and optional extruded columns
- Live target list with search, filters, and selection state
- Per-target popup and detail panel
- Trail history per entity while the session is running
- Provider status cards so you can see whether you are on live data or demo fallback
- Server-side provider adapters so browser CORS and secret handling stay out of the frontend

## Data providers wired in

### ADS-B

- `opensky` provider via `https://opensky-network.org/api/states/all`
- Falls back to demo aircraft if the provider returns nothing, rate-limits you, or is misconfigured

### AIS

- `aisstream` provider via websocket if you supply an API key
- Falls back to demo vessels until the socket yields live traffic

## Run it

1. Clone the repo.
2. Copy `.env.example` to `.env`.
3. Set the providers you want.
4. Start the server:

```bash
npm start
```

5. Open `http://localhost:3000`

## Example `.env`

```env
PORT=3000
ADSB_PROVIDER=opensky
OPENSKY_USERNAME=
OPENSKY_PASSWORD=
AIS_PROVIDER=aisstream
AISSTREAM_API_KEY=your_key_here
AISSTREAM_INITIAL_BBOX=-180,-85,180,85
```

## Notes

- OpenSky and AISStream policies, quotas, and response shapes can change. The backend is structured so you can swap or extend providers without touching the UI.
- This repo intentionally starts with no build step. The frontend is plain browser JS, and the backend uses Node's built-in HTTP server and WebSocket support.
- The AIS adapter is designed for a single local operator session. If you want multi-user viewport-aware subscriptions later, move the subscription manager into a more explicit session model.

## Next additions that fit this architecture

- Historical playback and time slider
- Heatmaps and density layers
- Geofences and alerts
- Additional sources such as trains, buses, weather, satellites, CCTV, and seismic feeds
- AI summary layer over selected viewport and time window
