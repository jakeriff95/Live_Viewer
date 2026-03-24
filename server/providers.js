import { config } from './config.js';

const MPS_TO_KTS = 1.943844;
const METERS_TO_FEET = 3.28084;
const MPS_TO_FPM = 196.850394;

const adsbCache = new Map();
let aisSocket = null;
let aisSocketState = {
  bbox: null,
  lastMessageAt: 0,
  lastConnectAt: 0,
  lastError: null,
};
const aisEntities = new Map();

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bboxKey(bbox) {
  return bbox.map((value) => value.toFixed(3)).join(',');
}

function inBbox(entity, bbox) {
  const [west, south, east, north] = bbox;
  return entity.lon >= west && entity.lon <= east && entity.lat >= south && entity.lat <= north;
}

function parseBbox(input) {
  const parts = String(input || '').split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return [-180, -85, 180, 85];
  }
  const [west, south, east, north] = parts;
  return [
    clamp(Math.min(west, east), -180, 180),
    clamp(Math.min(south, north), -85, 85),
    clamp(Math.max(west, east), -180, 180),
    clamp(Math.max(south, north), -85, 85),
  ];
}

function toFixedNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function normalizeAdsbState(state) {
  const [icao24, callsignRaw, originCountry, timePosition, lastContact, longitude, latitude, baroAltitude, onGround, velocity, trueTrack, verticalRate, _sensors, geoAltitude, squawk, spi, positionSource, category] = state;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const callsign = (callsignRaw || '').trim();
  return {
    id: `adsb:${icao24}`,
    source: 'adsb',
    kind: 'aircraft',
    key: icao24,
    label: callsign || icao24,
    callsign: callsign || null,
    icao24,
    country: originCountry || null,
    lat: latitude,
    lon: longitude,
    heading: Number.isFinite(trueTrack) ? trueTrack : 0,
    speedKts: Number.isFinite(velocity) ? toFixedNumber(velocity * MPS_TO_KTS, 0) : null,
    altitudeFt: Number.isFinite(geoAltitude ?? baroAltitude)
      ? toFixedNumber((geoAltitude ?? baroAltitude) * METERS_TO_FEET, 0)
      : null,
    verticalRateFpm: Number.isFinite(verticalRate) ? toFixedNumber(verticalRate * MPS_TO_FPM, 0) : null,
    squawk: squawk || null,
    onGround: Boolean(onGround),
    spi: Boolean(spi),
    positionSource: positionSource ?? null,
    category: category ?? null,
    updatedAt: new Date(((lastContact || timePosition || Math.floor(Date.now() / 1000)) * 1000)).toISOString(),
    raw: {
      timePosition,
      lastContact,
      baroAltitude,
      geoAltitude,
    },
  };
}

function demoAircraft(bbox) {
  const [west, south, east, north] = bbox;
  const lonSpan = Math.max(1, east - west);
  const latSpan = Math.max(1, north - south);
  const centerLon = west + lonSpan / 2;
  const centerLat = south + latSpan / 2;
  return [
    {
      id: 'adsb:demo-aal201',
      source: 'adsb',
      kind: 'aircraft',
      key: 'demo-aal201',
      label: 'AAL201',
      callsign: 'AAL201',
      icao24: 'demo01',
      country: 'United States',
      lat: centerLat + latSpan * 0.12,
      lon: centerLon - lonSpan * 0.18,
      heading: 74,
      speedKts: 438,
      altitudeFt: 32750,
      verticalRateFpm: 0,
      squawk: '4532',
      onGround: false,
      updatedAt: nowIso(),
      raw: {},
    },
    {
      id: 'adsb:demo-ual88',
      source: 'adsb',
      kind: 'aircraft',
      key: 'demo-ual88',
      label: 'UAL88',
      callsign: 'UAL88',
      icao24: 'demo02',
      country: 'United States',
      lat: centerLat - latSpan * 0.08,
      lon: centerLon + lonSpan * 0.14,
      heading: 231,
      speedKts: 405,
      altitudeFt: 28400,
      verticalRateFpm: -700,
      squawk: '2734',
      onGround: false,
      updatedAt: nowIso(),
      raw: {},
    },
  ];
}

async function fetchOpenSky(bbox) {
  const [west, south, east, north] = bbox;
  const url = new URL('https://opensky-network.org/api/states/all');
  url.searchParams.set('lamin', String(south));
  url.searchParams.set('lomin', String(west));
  url.searchParams.set('lamax', String(north));
  url.searchParams.set('lomax', String(east));

  const headers = {};
  if (config.openskyUsername && config.openskyPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${config.openskyUsername}:${config.openskyPassword}`).toString('base64')}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`OpenSky returned ${response.status}`);
  }
  const payload = await response.json();
  const entities = Array.isArray(payload.states)
    ? payload.states.map(normalizeAdsbState).filter(Boolean)
    : [];
  return {
    provider: 'opensky',
    updatedAt: nowIso(),
    total: entities.length,
    entities,
    sourceMeta: {
      time: payload.time ?? null,
      usedAuth: Boolean(config.openskyUsername && config.openskyPassword),
    },
  };
}

export async function getAdsbData(bboxInput) {
  const bbox = parseBbox(bboxInput);
  const key = `${config.adsbProvider}:${bboxKey(bbox)}`;
  const cached = adsbCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < config.adsbCacheTtlMs) {
    return cached.data;
  }

  let data;
  try {
    if (config.adsbProvider === 'opensky') {
      data = await fetchOpenSky(bbox);
    } else {
      data = {
        provider: 'demo',
        updatedAt: nowIso(),
        total: 0,
        entities: [],
        sourceMeta: { note: 'Unknown ADS-B provider, using demo mode.' },
      };
    }
  } catch (error) {
    data = {
      provider: `${config.adsbProvider}:fallback-demo`,
      updatedAt: nowIso(),
      total: 0,
      entities: demoAircraft(bbox),
      sourceMeta: {
        note: 'Provider fetch failed, using demo aircraft so the UI still renders.',
        error: error.message,
      },
    };
  }

  if (!data.entities.length) {
    data.entities = demoAircraft(bbox);
    data.total = data.entities.length;
    data.sourceMeta = {
      ...(data.sourceMeta || {}),
      note: data.sourceMeta?.note || 'No aircraft returned, showing demo aircraft.',
    };
  }

  adsbCache.set(key, { fetchedAt: Date.now(), data });
  return data;
}

function demoVessels(bbox) {
  const [west, south, east, north] = bbox;
  const lonSpan = Math.max(1, east - west);
  const latSpan = Math.max(1, north - south);
  const centerLon = west + lonSpan / 2;
  const centerLat = south + latSpan / 2;
  return [
    {
      id: 'ais:demo-366998100',
      source: 'ais',
      kind: 'vessel',
      key: '366998100',
      label: 'PACIFIC STAR',
      name: 'PACIFIC STAR',
      mmsi: '366998100',
      imo: '9312345',
      vesselType: 'Cargo',
      navStatus: 'Under way using engine',
      lat: centerLat + latSpan * 0.03,
      lon: centerLon - lonSpan * 0.05,
      heading: 118,
      course: 121,
      speedKts: 16,
      destination: 'LOS ANGELES',
      updatedAt: nowIso(),
      raw: { isDemo: true },
    },
    {
      id: 'ais:demo-538090091',
      source: 'ais',
      kind: 'vessel',
      key: '538090091',
      label: 'NORTH HARBOR',
      name: 'NORTH HARBOR',
      mmsi: '538090091',
      imo: '9476543',
      vesselType: 'Tanker',
      navStatus: 'Moored',
      lat: centerLat - latSpan * 0.06,
      lon: centerLon + lonSpan * 0.07,
      heading: 302,
      course: 300,
      speedKts: 0,
      destination: 'SINGAPORE',
      updatedAt: nowIso(),
      raw: { isDemo: true },
    },
  ];
}

function normalizeAisMessage(message) {
  const envelope = message.Message || message.message || message;
  const messageType = message.MessageType || envelope.MessageType || envelope.Message?.MessageType || null;
  const position = envelope.PositionReport || envelope.PositionReportClassA || envelope.PositionReportClassB || envelope.StandardClassBPositionReport || envelope.BaseStationReport || envelope.Message?.PositionReport || null;
  const shipStatic = envelope.ShipStaticData || envelope.Message?.ShipStaticData || null;

  const metadata = message.MetaData || envelope.MetaData || envelope.Metadata || {};
  const lat = position?.Latitude ?? position?.latitude;
  const lon = position?.Longitude ?? position?.longitude;
  const mmsi = String(metadata.MMSI ?? position?.UserID ?? position?.MMSI ?? shipStatic?.UserID ?? shipStatic?.MMSI ?? '').trim();
  if (!mmsi || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: `ais:${mmsi}`,
    source: 'ais',
    kind: 'vessel',
    key: mmsi,
    label: (shipStatic?.Name || shipStatic?.CallSign || metadata.ShipName || mmsi || '').trim(),
    name: (shipStatic?.Name || metadata.ShipName || '').trim() || null,
    mmsi,
    imo: String(shipStatic?.ImoNumber || shipStatic?.IMO || '').trim() || null,
    vesselType: shipStatic?.Type || shipStatic?.ShipType || metadata.ShipType || null,
    navStatus: position?.NavigationalStatus ?? metadata.NavigationalStatus ?? null,
    lat,
    lon,
    heading: Number.isFinite(position?.TrueHeading) ? position.TrueHeading : Number(position?.Cog || 0),
    course: Number.isFinite(position?.Cog) ? position.Cog : null,
    speedKts: Number.isFinite(position?.Sog) ? toFixedNumber(position.Sog, 1) : null,
    destination: shipStatic?.Destination || metadata.Destination || null,
    updatedAt: nowIso(),
    raw: {
      messageType,
      metadata,
      isDemo: false,
    },
  };
}

function closeAisSocket() {
  if (aisSocket && (aisSocket.readyState === WebSocket.OPEN || aisSocket.readyState === WebSocket.CONNECTING)) {
    aisSocket.close();
  }
  aisSocket = null;
}

function ensureAisStreamSubscription(bbox) {
  if (!config.aisstreamApiKey) {
    return;
  }

  const bboxChanged = !aisSocketState.bbox || bboxKey(aisSocketState.bbox) !== bboxKey(bbox);
  const socketIsAlive = aisSocket && (aisSocket.readyState === WebSocket.OPEN || aisSocket.readyState === WebSocket.CONNECTING);
  if (socketIsAlive && !bboxChanged) return;

  closeAisSocket();
  aisSocketState = {
    ...aisSocketState,
    bbox,
    lastConnectAt: Date.now(),
    lastError: null,
  };

  try {
    const socket = new WebSocket('wss://stream.aisstream.io/v0/stream');
    aisSocket = socket;

    socket.addEventListener('open', () => {
      if (socket !== aisSocket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const [west, south, east, north] = bbox;
      const payload = {
        APIKey: config.aisstreamApiKey,
        BoundingBoxes: [[[south, west], [north, east]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      };
      socket.send(JSON.stringify(payload));
    });

    socket.addEventListener('message', (event) => {
      if (socket !== aisSocket) return;
      try {
        const message = JSON.parse(String(event.data));
        const entity = normalizeAisMessage(message);
        if (entity) {
          aisEntities.set(entity.id, entity);
          aisSocketState.lastMessageAt = Date.now();
        }
      } catch (error) {
        aisSocketState.lastError = error.message;
      }
    });

    socket.addEventListener('error', () => {
      if (socket !== aisSocket) return;
      aisSocketState.lastError = 'AISStream socket error';
    });

    socket.addEventListener('close', () => {
      if (socket === aisSocket) {
        aisSocket = null;
      }
    });
  } catch (error) {
    aisSocketState.lastError = error.message;
  }
}

export async function getAisData(bboxInput) {
  const bbox = parseBbox(bboxInput);

  if (config.aisProvider === 'aisstream' && config.aisstreamApiKey) {
    ensureAisStreamSubscription(bbox);
    const entities = Array.from(aisEntities.values()).filter((entity) => inBbox(entity, bbox));
    if (entities.length) {
      return {
        provider: 'aisstream',
        updatedAt: nowIso(),
        total: entities.length,
        entities,
        sourceMeta: {
          bbox,
          lastSocketMessageAt: aisSocketState.lastMessageAt ? new Date(aisSocketState.lastMessageAt).toISOString() : null,
          lastSocketError: aisSocketState.lastError,
        },
      };
    }
  }

  const demo = demoVessels(bbox);
  return {
    provider: config.aisProvider === 'aisstream' ? 'aisstream:fallback-demo' : 'demo',
    updatedAt: nowIso(),
    total: demo.length,
    entities: demo,
    sourceMeta: {
      note: config.aisProvider === 'aisstream'
        ? 'AISStream has not yielded live positions yet, showing demo vessels.'
        : 'No live AIS provider configured, showing demo vessels.',
      lastSocketError: aisSocketState.lastError,
    },
  };
}

export function getProviderStatus() {
  return {
    adsbProvider: config.adsbProvider,
    aisProvider: config.aisProvider,
    aisSocket: config.aisProvider === 'aisstream'
      ? {
          connected: Boolean(aisSocket && aisSocket.readyState === WebSocket.OPEN),
          connecting: Boolean(aisSocket && aisSocket.readyState === WebSocket.CONNECTING),
          lastMessageAt: aisSocketState.lastMessageAt ? new Date(aisSocketState.lastMessageAt).toISOString() : null,
          lastError: aisSocketState.lastError,
          bbox: aisSocketState.bbox,
        }
      : null,
  };
}
