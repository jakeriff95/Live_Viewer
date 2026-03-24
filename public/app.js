const DEFAULT_VIEW = {
  center: [-77.0369, 38.9072],
  zoom: 7.2,
  pitch: 42,
  bearing: -12,
};

const state = {
  map: null,
  popup: null,
  lastPayload: null,
  entities: [],
  visibleEntities: [],
  selectedId: null,
  followSelected: false,
  history: new Map(),
  locationInitialized: false,
  refreshHandle: null,
  filters: {
    showAircraft: true,
    showVessels: true,
    showTrails: true,
    showLabels: true,
    aircraftAltitudeMin: 0,
    vesselSpeedMin: 0,
    search: '',
  },
};

const dom = {
  metricVisible: document.querySelector('#metric-visible'),
  metricAircraft: document.querySelector('#metric-aircraft'),
  metricVessels: document.querySelector('#metric-vessels'),
  metricUpdated: document.querySelector('#metric-updated'),
  selectedDetails: document.querySelector('#selected-details'),
  providerStatus: document.querySelector('#provider-status'),
  entityList: document.querySelector('#entity-list'),
  entityCountPill: document.querySelector('#entity-count-pill'),
  searchInput: document.querySelector('#search-input'),
  refreshNow: document.querySelector('#refresh-now'),
  clearSelection: document.querySelector('#clear-selection'),
  toggleAircraft: document.querySelector('#toggle-aircraft'),
  toggleVessels: document.querySelector('#toggle-vessels'),
  toggleTrails: document.querySelector('#toggle-trails'),
  toggleLabels: document.querySelector('#toggle-labels'),
  toggleFollow: document.querySelector('#toggle-follow'),
  aircraftAltitudeMin: document.querySelector('#aircraft-altitude-min'),
  vesselSpeedMin: document.querySelector('#vessel-speed-min'),
  locationInput: document.querySelector('#location-input'),
  locationSearch: document.querySelector('#location-search'),
  currentLocation: document.querySelector('#current-location'),
  resetView: document.querySelector('#reset-view'),
  locationStatus: document.querySelector('#location-status'),
};

function fmtNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat().format(value);
}

function fmtTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtAgo(value) {
  if (!value) return '—';
  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs)) return '—';
  const diffSec = Math.max(0, Math.round(diffMs / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr}h ago`;
}

function setLocationStatus(message) {
  dom.locationStatus.textContent = message;
}

function getMapStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      carto: {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors © CARTO'
      }
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#040b16' } },
      { id: 'carto', type: 'raster', source: 'carto' }
    ]
  };
}

function createEmptyCollection() {
  return { type: 'FeatureCollection', features: [] };
}

function smoothLine(points, segments = 6) {
  if (points.length < 3) return points;
  const result = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;

    for (let step = 0; step < segments; step += 1) {
      const t = step / segments;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (
        (2 * p1[0]) +
        (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
      );
      const y = 0.5 * (
        (2 * p1[1]) +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
      );
      result.push([x, y]);
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

function aircraftSubtype(entity) {
  const category = Number(entity.category);
  if (category === 8) return 'rotorcraft';
  if ([2, 3].includes(category)) return 'light';
  if ([5, 6].includes(category)) return 'heavy';
  if ([4, 7].includes(category)) return 'jet';
  return 'generic';
}

function vesselSubtype(entity) {
  const type = String(entity.vesselType || '').toLowerCase();
  if (type.includes('tanker')) return 'tanker';
  if (type.includes('cargo') || type.includes('freight') || type.includes('container') || type.includes('bulk')) return 'cargo';
  if (type.includes('passenger') || type.includes('ferry') || type.includes('cruise')) return 'passenger';
  if (type.includes('tug') || type.includes('fishing') || type.includes('pleasure') || type.includes('sailing')) return 'small';
  return 'generic';
}

function styleForEntity(entity) {
  if (entity.kind === 'aircraft') {
    const subtype = aircraftSubtype(entity);
    if (subtype === 'light') {
      return { subtype, iconId: 'aircraft-light', color: '#8bf18f', trailColor: '#5edd7a', iconSize: 0.7 };
    }
    if (subtype === 'heavy') {
      return { subtype, iconId: 'aircraft-jet', color: '#7f9bff', trailColor: '#6e84ff', iconSize: 0.82 };
    }
    if (subtype === 'rotorcraft') {
      return { subtype, iconId: 'aircraft-rotor', color: '#ffd166', trailColor: '#f5ba42', iconSize: 0.76 };
    }
    if (subtype === 'jet') {
      return { subtype, iconId: 'aircraft-jet', color: '#67d4ff', trailColor: '#38bdf8', iconSize: 0.78 };
    }
    return { subtype, iconId: 'aircraft-jet', color: '#9be4ff', trailColor: '#63cbff', iconSize: 0.74 };
  }

  const subtype = vesselSubtype(entity);
  if (subtype === 'cargo') {
    return { subtype, iconId: 'vessel-cargo', color: '#ff9a76', trailColor: '#ff7c5a', iconSize: 0.92 };
  }
  if (subtype === 'tanker') {
    return { subtype, iconId: 'vessel-tanker', color: '#ff6ea9', trailColor: '#ff4f93', iconSize: 0.94 };
  }
  if (subtype === 'passenger') {
    return { subtype, iconId: 'vessel-passenger', color: '#ffe18a', trailColor: '#ffd059', iconSize: 0.96 };
  }
  if (subtype === 'small') {
    return { subtype, iconId: 'vessel-small', color: '#7be7dd', trailColor: '#47d0c4', iconSize: 0.88 };
  }
  return { subtype, iconId: 'vessel-cargo', color: '#ffb1c4', trailColor: '#ff89a8', iconSize: 0.9 };
}

function drawJet(ctx, color) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, -28);
  ctx.lineTo(5, -10);
  ctx.lineTo(18, -3);
  ctx.lineTo(18, 2);
  ctx.lineTo(5, 3);
  ctx.lineTo(9, 26);
  ctx.lineTo(4, 28);
  ctx.lineTo(0, 15);
  ctx.lineTo(-4, 28);
  ctx.lineTo(-9, 26);
  ctx.lineTo(-5, 3);
  ctx.lineTo(-18, 2);
  ctx.lineTo(-18, -3);
  ctx.lineTo(-5, -10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawLightPlane(ctx, color) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, -26);
  ctx.lineTo(4, -8);
  ctx.lineTo(22, -1);
  ctx.lineTo(22, 4);
  ctx.lineTo(4, 2);
  ctx.lineTo(6, 24);
  ctx.lineTo(1, 26);
  ctx.lineTo(0, 14);
  ctx.lineTo(-1, 26);
  ctx.lineTo(-6, 24);
  ctx.lineTo(-4, 2);
  ctx.lineTo(-22, 4);
  ctx.lineTo(-22, -1);
  ctx.lineTo(-4, -8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawRotorcraft(ctx, color) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.fillStyle = color;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(-22, -12);
  ctx.lineTo(22, -12);
  ctx.moveTo(0, -18);
  ctx.lineTo(0, -6);
  ctx.moveTo(-12, 22);
  ctx.lineTo(12, 22);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-8, -4);
  ctx.lineTo(8, -4);
  ctx.lineTo(11, 10);
  ctx.lineTo(0, 18);
  ctx.lineTo(-11, 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawCargoVessel(ctx, color) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, -26);
  ctx.lineTo(11, -10);
  ctx.lineTo(11, 18);
  ctx.lineTo(0, 27);
  ctx.lineTo(-11, 18);
  ctx.lineTo(-11, -10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(-6, -6, 12, 9);
  ctx.restore();
}

function drawTanker(ctx, color) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, -28);
  ctx.lineTo(10, -14);
  ctx.lineTo(14, 12);
  ctx.lineTo(0, 28);
  ctx.lineTo(-14, 12);
  ctx.lineTo(-10, -14);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -2, 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawPassengerVessel(ctx, color) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, -26);
  ctx.lineTo(13, -8);
  ctx.lineTo(9, 20);
  ctx.lineTo(0, 28);
  ctx.lineTo(-9, 20);
  ctx.lineTo(-13, -8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(-8, -7, 16, 7);
  ctx.fillRect(-5, 3, 10, 5);
  ctx.restore();
}

function drawSmallVessel(ctx, color) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, -23);
  ctx.lineTo(10, -6);
  ctx.lineTo(7, 22);
  ctx.lineTo(0, 28);
  ctx.lineTo(-7, 22);
  ctx.lineTo(-10, -6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.lineTo(0, 6);
  ctx.moveTo(0, -12);
  ctx.lineTo(8, -2);
  ctx.stroke();
  ctx.restore();
}

function addCanvasImage(imageId, draw) {
  if (state.map.hasImage(imageId)) return;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  draw(ctx);
  state.map.addImage(imageId, canvas, { pixelRatio: 2 });
}

function ensureMapImages() {
  addCanvasImage('aircraft-jet', (ctx) => drawJet(ctx, '#67d4ff'));
  addCanvasImage('aircraft-light', (ctx) => drawLightPlane(ctx, '#8bf18f'));
  addCanvasImage('aircraft-rotor', (ctx) => drawRotorcraft(ctx, '#ffd166'));
  addCanvasImage('vessel-cargo', (ctx) => drawCargoVessel(ctx, '#ff9a76'));
  addCanvasImage('vessel-tanker', (ctx) => drawTanker(ctx, '#ff6ea9'));
  addCanvasImage('vessel-passenger', (ctx) => drawPassengerVessel(ctx, '#ffe18a'));
  addCanvasImage('vessel-small', (ctx) => drawSmallVessel(ctx, '#7be7dd'));
}

function buildGeoJson(entities) {
  const icons = createEmptyCollection();
  const trails = createEmptyCollection();
  const selection = createEmptyCollection();

  for (const entity of entities) {
    const style = styleForEntity(entity);

    icons.features.push({
      type: 'Feature',
      id: entity.id,
      geometry: { type: 'Point', coordinates: [entity.lon, entity.lat] },
      properties: {
        id: entity.id,
        kind: entity.kind,
        label: entity.label,
        heading: Number.isFinite(entity.heading) ? entity.heading : 0,
        iconId: style.iconId,
        iconSize: style.iconSize,
        color: style.color,
      },
    });

    const history = state.history.get(entity.id) || [];
    if (history.length >= 2) {
      trails.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: smoothLine(history, 7) },
        properties: {
          id: entity.id,
          color: style.trailColor,
        },
      });
    }

    if (entity.id === state.selectedId) {
      selection.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [entity.lon, entity.lat] },
        properties: {
          id: entity.id,
          radius: entity.kind === 'aircraft' ? 15 : 17,
          color: style.color,
        },
      });
    }
  }

  return { icons, trails, selection };
}

function getSelectedEntity() {
  return state.entities.find((entity) => entity.id === state.selectedId) || null;
}

function renderSelected() {
  const entity = getSelectedEntity();
  if (!entity) {
    dom.selectedDetails.innerHTML = '<div class="selected-empty">Select an aircraft or vessel to inspect it.</div>';
    return;
  }

  const style = styleForEntity(entity);
  const subtypeLabel = entity.kind === 'aircraft' ? aircraftSubtype(entity) : vesselSubtype(entity);

  const rows = [
    ['Type', entity.kind],
    ['Subtype', subtypeLabel],
    ['Label', entity.label],
    ['ICAO / MMSI', entity.icao24 || entity.mmsi || '—'],
    ['Altitude', entity.altitudeFt ? `${fmtNumber(entity.altitudeFt)} ft` : '—'],
    ['Speed', entity.speedKts ? `${fmtNumber(entity.speedKts)} kts` : '—'],
    ['Heading', Number.isFinite(entity.heading) ? `${Math.round(entity.heading)}°` : '—'],
    ['Destination', entity.destination || '—'],
    ['Status', entity.country || entity.navStatus || '—'],
    ['Trail Color', style.trailColor],
    ['Last Seen', fmtAgo(entity.updatedAt)],
    ['Coordinates', `${entity.lat.toFixed(4)}, ${entity.lon.toFixed(4)}`],
  ];

  dom.selectedDetails.innerHTML = `
    <div class="detail-grid">
      ${rows.map(([label, value]) => `
        <div class="detail-row">
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function renderProviderStatus() {
  const providers = state.lastPayload?.providers || {};
  dom.providerStatus.innerHTML = ['adsb', 'ais'].map((key) => {
    const provider = providers[key];
    if (!provider) return '';
    const ok = !String(provider.provider || '').includes('fallback');
    const meta = provider.meta || {};
    const metaRows = Object.entries(meta)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .slice(0, 4)
      .map(([label, value]) => `<div><span>${label}:</span> ${Array.isArray(value) ? JSON.stringify(value) : value}</div>`)
      .join('');
    return `
      <div class="status-card">
        <div class="status-title">
          <span>${key.toUpperCase()} · ${provider.provider}</span>
          <span class="status-dot ${ok ? 'ok' : ''}"></span>
        </div>
        <div class="status-body">${metaRows || '<div>No metadata.</div>'}</div>
      </div>
    `;
  }).join('');
}

function renderEntityList() {
  dom.entityCountPill.textContent = String(state.visibleEntities.length);

  if (!state.visibleEntities.length) {
    dom.entityList.innerHTML = '<div class="selected-empty">No targets match the current filters in this viewport.</div>';
    return;
  }

  dom.entityList.innerHTML = state.visibleEntities.slice(0, 200).map((entity) => {
    const subtype = entity.kind === 'aircraft' ? aircraftSubtype(entity) : vesselSubtype(entity);
    return `
      <button class="entity-card ${entity.id === state.selectedId ? 'active' : ''}" data-entity-id="${entity.id}">
        <div class="entity-topline">
          <strong>${entity.label}</strong>
          <span class="badge ${entity.kind === 'vessel' ? 'vessel' : ''}">${subtype}</span>
        </div>
        <div class="entity-subline">
          <span>${entity.kind === 'aircraft' ? `${fmtNumber(entity.altitudeFt)} ft · ${fmtNumber(entity.speedKts)} kts` : `${fmtNumber(entity.speedKts)} kts · ${entity.destination || 'No destination'}`}</span>
          <span>${fmtAgo(entity.updatedAt)}</span>
        </div>
      </button>
    `;
  }).join('');

  dom.entityList.querySelectorAll('[data-entity-id]').forEach((button) => {
    button.addEventListener('click', () => selectEntity(button.dataset.entityId));
  });
}

function renderMetrics() {
  const aircraft = state.visibleEntities.filter((entity) => entity.kind === 'aircraft').length;
  const vessels = state.visibleEntities.filter((entity) => entity.kind === 'vessel').length;
  dom.metricVisible.textContent = fmtNumber(state.visibleEntities.length);
  dom.metricAircraft.textContent = fmtNumber(aircraft);
  dom.metricVessels.textContent = fmtNumber(vessels);
  dom.metricUpdated.textContent = fmtTime(state.lastPayload?.updatedAt);
}

function showPopup(entity) {
  if (!state.popup) return;
  const subtypeLabel = entity.kind === 'aircraft' ? aircraftSubtype(entity) : vesselSubtype(entity);
  state.popup
    .setLngLat([entity.lon, entity.lat])
    .setHTML(`
      <div class="popup-title">${entity.label}</div>
      <div class="popup-grid">
        <div>Type</div><div>${entity.kind}</div>
        <div>Subtype</div><div>${subtypeLabel}</div>
        <div>Speed</div><div>${entity.speedKts ? `${fmtNumber(entity.speedKts)} kts` : '—'}</div>
        <div>Altitude</div><div>${entity.altitudeFt ? `${fmtNumber(entity.altitudeFt)} ft` : '—'}</div>
      </div>
    `)
    .addTo(state.map);
}

function refreshUi() {
  const bounds = state.map.getBounds();
  state.visibleEntities = state.entities
    .filter(entityMatchesFilters)
    .filter((entity) => bounds.contains([entity.lon, entity.lat]))
    .sort((a, b) => {
      const aMetric = a.kind === 'aircraft' ? (a.altitudeFt || 0) : (a.speedKts || 0);
      const bMetric = b.kind === 'aircraft' ? (b.altitudeFt || 0) : (b.speedKts || 0);
      return bMetric - aMetric;
    });

  const geo = buildGeoJson(state.visibleEntities);
  state.map.getSource('targets')?.setData(geo.icons);
  state.map.getSource('trails')?.setData(geo.trails);
  state.map.getSource('selection')?.setData(geo.selection);

  state.map.setLayoutProperty('target-trails', 'visibility', state.filters.showTrails ? 'visible' : 'none');
  state.map.setLayoutProperty('target-labels', 'visibility', state.filters.showLabels ? 'visible' : 'none');

  renderMetrics();
  renderSelected();
  renderProviderStatus();
  renderEntityList();

  const selected = getSelectedEntity();
  if (selected) {
    showPopup(selected);
    if (state.followSelected) {
      state.map.easeTo({ center: [selected.lon, selected.lat], duration: 700, essential: true });
    }
  } else {
    state.popup?.remove();
  }
}

function selectEntity(entityId) {
  state.selectedId = entityId;
  const entity = getSelectedEntity();
  if (!entity) {
    refreshUi();
    return;
  }
  state.map.easeTo({ center: [entity.lon, entity.lat], zoom: Math.max(state.map.getZoom(), entity.kind === 'aircraft' ? 7.4 : 8.3), duration: 600 });
  refreshUi();
}

async function fetchTraffic() {
  const bounds = state.map.getBounds();
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((value) => value.toFixed(5)).join(',');
  const response = await fetch(`/api/traffic?bbox=${encodeURIComponent(bbox)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Traffic fetch failed with ${response.status}`);
  const payload = await response.json();
  state.lastPayload = payload;
  state.entities = payload.entities || [];
  for (const entity of state.entities) {
    const entry = state.history.get(entity.id) || [];
    const last = entry[entry.length - 1];
    if (!last || last[0] !== entity.lon || last[1] !== entity.lat) {
      entry.push([entity.lon, entity.lat]);
    }
    state.history.set(entity.id, entry.slice(-14));
  }
  refreshUi();
}

function scheduleRefresh() {
  clearInterval(state.refreshHandle);
  state.refreshHandle = setInterval(() => {
    fetchTraffic().catch((error) => console.error(error));
  }, 8000);
}

function addSourcesAndLayers() {
  ensureMapImages();

  state.map.addSource('targets', { type: 'geojson', data: createEmptyCollection() });
  state.map.addSource('trails', { type: 'geojson', data: createEmptyCollection() });
  state.map.addSource('selection', { type: 'geojson', data: createEmptyCollection() });

  state.map.addLayer({
    id: 'target-trails',
    type: 'line',
    source: 'trails',
    layout: {
      'line-join': 'round',
      'line-cap': 'round',
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 2.2,
      'line-opacity': 0.82,
      'line-blur': 0.25,
    },
  });

  state.map.addLayer({
    id: 'target-selection',
    type: 'circle',
    source: 'selection',
    paint: {
      'circle-radius': ['get', 'radius'],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 2.3,
      'circle-stroke-color': ['get', 'color'],
      'circle-opacity': 0.96,
    },
  });

  state.map.addLayer({
    id: 'target-icons',
    type: 'symbol',
    source: 'targets',
    layout: {
      'icon-image': ['get', 'iconId'],
      'icon-size': ['get', 'iconSize'],
      'icon-rotate': ['get', 'heading'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['case', ['==', ['get', 'kind'], 'aircraft'], 2, 1],
    },
  });

  state.map.addLayer({
    id: 'target-labels',
    type: 'symbol',
    source: 'targets',
    minzoom: 8.4,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Semibold'],
      'text-size': 11,
      'text-offset': [0, 1.45],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-max-width': 10,
      'text-optional': true,
    },
    paint: {
      'text-color': '#eff7ff',
      'text-halo-color': '#06101d',
      'text-halo-width': 1.6,
    },
  });

  ['target-icons', 'target-labels', 'target-selection'].forEach((layerId) => {
    state.map.on('click', layerId, (event) => {
      const feature = event.features?.[0];
      const entityId = feature?.properties?.id;
      if (entityId) selectEntity(entityId);
    });

    state.map.on('mouseenter', layerId, () => {
      state.map.getCanvas().style.cursor = 'pointer';
    });

    state.map.on('mouseleave', layerId, () => {
      state.map.getCanvas().style.cursor = '';
    });
  });

  state.map.on('click', (event) => {
    const features = state.map.queryRenderedFeatures(event.point, { layers: ['target-icons', 'target-labels', 'target-selection'] });
    if (!features.length) {
      state.selectedId = null;
      refreshUi();
    }
  });
}

async function searchLocation() {
  const query = dom.locationInput.value.trim();
  if (!query) return;
  setLocationStatus(`Searching for ${query}...`);

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Search returned ${response.status}`);
    const results = await response.json();
    if (!Array.isArray(results) || !results.length) {
      setLocationStatus(`No location found for ${query}.`);
      return;
    }
    const result = results[0];
    const lon = Number(result.lon);
    const lat = Number(result.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      setLocationStatus(`Location result for ${query} was invalid.`);
      return;
    }
    state.map.easeTo({ center: [lon, lat], zoom: 8.6, pitch: 42, bearing: -10, duration: 800 });
    setLocationStatus(`Showing ${result.display_name}.`);
    fetchTraffic().catch(console.error);
  } catch (error) {
    setLocationStatus(`Location search failed: ${error.message}`);
  }
}

function goToCurrentLocation() {
  if (!navigator.geolocation) {
    setLocationStatus('Browser geolocation is not available.');
    return;
  }

  setLocationStatus('Requesting your current location...');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { longitude, latitude } = position.coords;
      state.locationInitialized = true;
      state.map.easeTo({ center: [longitude, latitude], zoom: 8.8, pitch: 42, bearing: -10, duration: 900 });
      setLocationStatus('Showing your current location.');
      fetchTraffic().catch(console.error);
    },
    (error) => {
      setLocationStatus(`Could not use current location: ${error.message}.`);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function resetView() {
  state.map.easeTo({ ...DEFAULT_VIEW, duration: 800 });
  setLocationStatus('Reset to default regional view.');
  fetchTraffic().catch(console.error);
}

function wireControls() {
  dom.searchInput.addEventListener('input', (event) => {
    state.filters.search = event.target.value || '';
    refreshUi();
  });

  dom.toggleAircraft.addEventListener('change', (event) => {
    state.filters.showAircraft = event.target.checked;
    refreshUi();
  });

  dom.toggleVessels.addEventListener('change', (event) => {
    state.filters.showVessels = event.target.checked;
    refreshUi();
  });

  dom.toggleTrails.addEventListener('change', (event) => {
    state.filters.showTrails = event.target.checked;
    refreshUi();
  });

  dom.toggleLabels.addEventListener('change', (event) => {
    state.filters.showLabels = event.target.checked;
    refreshUi();
  });

  dom.toggleFollow.addEventListener('change', (event) => {
    state.followSelected = event.target.checked;
  });

  dom.aircraftAltitudeMin.addEventListener('input', (event) => {
    state.filters.aircraftAltitudeMin = Number(event.target.value || 0);
    refreshUi();
  });

  dom.vesselSpeedMin.addEventListener('input', (event) => {
    state.filters.vesselSpeedMin = Number(event.target.value || 0);
    refreshUi();
  });

  dom.refreshNow.addEventListener('click', () => fetchTraffic().catch(console.error));
  dom.clearSelection.addEventListener('click', () => {
    state.selectedId = null;
    refreshUi();
  });
  dom.locationSearch.addEventListener('click', () => searchLocation());
  dom.locationInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchLocation();
    }
  });
  dom.currentLocation.addEventListener('click', () => goToCurrentLocation());
  dom.resetView.addEventListener('click', () => resetView());
}

function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: getMapStyle(),
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    pitch: DEFAULT_VIEW.pitch,
    bearing: DEFAULT_VIEW.bearing,
    antialias: true,
    hash: true,
  });

  state.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '300px' });

  state.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'top-right');
  state.map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'imperial' }), 'bottom-right');

  state.map.on('load', async () => {
    addSourcesAndLayers();
    wireControls();
    scheduleRefresh();
    await fetchTraffic();
    window.setTimeout(() => {
      if (!state.locationInitialized) goToCurrentLocation();
    }, 700);
  });

  state.map.on('moveend', () => {
    fetchTraffic().catch(console.error);
  });
}

initMap();
