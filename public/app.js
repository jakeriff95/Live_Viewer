const state = {
  map: null,
  popup: null,
  lastPayload: null,
  entities: [],
  visibleEntities: [],
  selectedId: null,
  followSelected: false,
  filters: {
    showAircraft: true,
    showVessels: true,
    showTrails: true,
    showLabels: true,
    show3d: true,
    aircraftAltitudeMin: 0,
    vesselSpeedMin: 0,
    search: '',
  },
  history: new Map(),
  refreshHandle: null,
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
  toggle3d: document.querySelector('#toggle-3d'),
  toggleFollow: document.querySelector('#toggle-follow'),
  aircraftAltitudeMin: document.querySelector('#aircraft-altitude-min'),
  vesselSpeedMin: document.querySelector('#vessel-speed-min'),
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
      { id: 'background', type: 'background', paint: { 'background-color': '#050b16' } },
      { id: 'carto', type: 'raster', source: 'carto' }
    ]
  };
}

function createEmptyCollection() {
  return { type: 'FeatureCollection', features: [] };
}

function toSquarePolygon(lon, lat, radiusKm = 4) {
  const latOffset = radiusKm / 110.574;
  const lonOffset = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180) || 1);
  return [[
    [lon - lonOffset, lat - latOffset],
    [lon + lonOffset, lat - latOffset],
    [lon + lonOffset, lat + latOffset],
    [lon - lonOffset, lat + latOffset],
    [lon - lonOffset, lat - latOffset],
  ]];
}

function entityMatchesFilters(entity) {
  if (entity.kind === 'aircraft' && !state.filters.showAircraft) return false;
  if (entity.kind === 'vessel' && !state.filters.showVessels) return false;
  if (entity.kind === 'aircraft' && (entity.altitudeFt || 0) < state.filters.aircraftAltitudeMin) return false;
  if (entity.kind === 'vessel' && (entity.speedKts || 0) < state.filters.vesselSpeedMin) return false;

  const term = state.filters.search.trim().toLowerCase();
  if (!term) return true;
  const haystack = [
    entity.label,
    entity.callsign,
    entity.icao24,
    entity.mmsi,
    entity.name,
    entity.imo,
    entity.destination,
    entity.country,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(term);
}

function upsertHistory(entity) {
  const entry = state.history.get(entity.id) || [];
  const last = entry[entry.length - 1];
  if (!last || last[0] !== entity.lon || last[1] !== entity.lat) {
    entry.push([entity.lon, entity.lat, entity.updatedAt]);
  }
  state.history.set(entity.id, entry.slice(-40));
}

function buildGeoJson(entities) {
  const points = createEmptyCollection();
  const trails = createEmptyCollection();
  const extrusions = createEmptyCollection();

  for (const entity of entities) {
    points.features.push({
      type: 'Feature',
      id: entity.id,
      geometry: { type: 'Point', coordinates: [entity.lon, entity.lat] },
      properties: {
        id: entity.id,
        kind: entity.kind,
        label: entity.label,
        heading: Number.isFinite(entity.heading) ? entity.heading : 0,
        textGlyph: entity.kind === 'aircraft' ? '▲' : '◆',
        color: entity.kind === 'aircraft' ? '#7dd3fc' : '#fda4af',
        speedKts: entity.speedKts ?? 0,
        altitudeFt: entity.altitudeFt ?? 0,
      },
    });

    const history = state.history.get(entity.id) || [];
    if (history.length >= 2) {
      trails.features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: history.map(([lon, lat]) => [lon, lat]),
        },
        properties: {
          id: entity.id,
          kind: entity.kind,
          color: entity.kind === 'aircraft' ? '#38bdf8' : '#fb7185',
        },
      });
    }

    extrusions.features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: toSquarePolygon(entity.lon, entity.lat, entity.kind === 'aircraft' ? 5 : 7),
      },
      properties: {
        id: entity.id,
        kind: entity.kind,
        color: entity.kind === 'aircraft' ? '#0ea5e9' : '#f43f5e',
        height: entity.kind === 'aircraft'
          ? Math.min((entity.altitudeFt || 0) * 0.05, 6500)
          : Math.min((entity.speedKts || 0) * 55, 1600),
        base: 0,
      },
    });
  }

  return { points, trails, extrusions };
}

function getSelectedEntity() {
  return state.entities.find((entity) => entity.id === state.selectedId) || null;
}

function renderSelected() {
  const entity = getSelectedEntity();
  if (!entity) {
    dom.selectedDetails.innerHTML = '<div class="selected-empty">Nothing selected.</div>';
    return;
  }

  const rows = [
    ['Type', entity.kind],
    ['Label', entity.label],
    ['Source', entity.source],
    ['ICAO / MMSI', entity.icao24 || entity.mmsi || '—'],
    ['Altitude', entity.altitudeFt ? `${fmtNumber(entity.altitudeFt)} ft` : '—'],
    ['Speed', entity.speedKts ? `${fmtNumber(entity.speedKts)} kts` : '—'],
    ['Heading', Number.isFinite(entity.heading) ? `${Math.round(entity.heading)}°` : '—'],
    ['Destination', entity.destination || '—'],
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
  const selectedId = state.selectedId;
  dom.entityCountPill.textContent = String(state.visibleEntities.length);

  if (!state.visibleEntities.length) {
    dom.entityList.innerHTML = '<div class="selected-empty">No targets match the current filters.</div>';
    return;
  }

  dom.entityList.innerHTML = state.visibleEntities.slice(0, 250).map((entity) => `
    <button class="entity-card ${entity.id === selectedId ? 'active' : ''}" data-entity-id="${entity.id}">
      <div class="entity-topline">
        <strong>${entity.label}</strong>
        <span class="badge ${entity.kind === 'vessel' ? 'vessel' : ''}">${entity.kind}</span>
      </div>
      <div class="entity-subline">
        <span>${entity.kind === 'aircraft'
          ? `${fmtNumber(entity.altitudeFt)} ft · ${fmtNumber(entity.speedKts)} kts`
          : `${fmtNumber(entity.speedKts)} kts · ${entity.destination || 'No destination'}`}</span>
        <span>${fmtAgo(entity.updatedAt)}</span>
      </div>
    </button>
  `).join('');

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
  const speedLine = entity.speedKts ? `${fmtNumber(entity.speedKts)} kts` : '—';
  const altitudeLine = entity.altitudeFt ? `${fmtNumber(entity.altitudeFt)} ft` : '—';
  state.popup
    .setLngLat([entity.lon, entity.lat])
    .setHTML(`
      <div class="popup-title">${entity.label}</div>
      <div class="popup-grid">
        <div>Type</div><div>${entity.kind}</div>
        <div>Speed</div><div>${speedLine}</div>
        <div>Altitude</div><div>${altitudeLine}</div>
        <div>Heading</div><div>${Number.isFinite(entity.heading) ? `${Math.round(entity.heading)}°` : '—'}</div>
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
  state.map.getSource('targets')?.setData(geo.points);
  state.map.getSource('trails')?.setData(geo.trails);
  state.map.getSource('extrusions')?.setData(geo.extrusions);

  state.map.setLayoutProperty('target-labels', 'visibility', state.filters.showLabels ? 'visible' : 'none');
  state.map.setLayoutProperty('target-glyphs', 'visibility', 'visible');
  state.map.setLayoutProperty('target-trails', 'visibility', state.filters.showTrails ? 'visible' : 'none');
  state.map.setLayoutProperty('target-columns', 'visibility', state.filters.show3d ? 'visible' : 'none');

  renderMetrics();
  renderSelected();
  renderProviderStatus();
  renderEntityList();

  const selected = getSelectedEntity();
  if (selected) {
    showPopup(selected);
    if (state.followSelected) {
      state.map.easeTo({ center: [selected.lon, selected.lat], duration: 800, essential: true });
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
  state.map.easeTo({ center: [entity.lon, entity.lat], zoom: Math.max(state.map.getZoom(), entity.kind === 'aircraft' ? 7 : 9), duration: 700 });
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
  for (const entity of state.entities) upsertHistory(entity);
  refreshUi();
}

function scheduleRefresh() {
  clearInterval(state.refreshHandle);
  state.refreshHandle = setInterval(() => {
    fetchTraffic().catch((error) => {
      console.error(error);
    });
  }, 8000);
}

function addSourcesAndLayers() {
  state.map.addSource('targets', { type: 'geojson', data: createEmptyCollection() });
  state.map.addSource('trails', { type: 'geojson', data: createEmptyCollection() });
  state.map.addSource('extrusions', { type: 'geojson', data: createEmptyCollection() });

  state.map.addLayer({
    id: 'target-columns',
    type: 'fill-extrusion',
    source: 'extrusions',
    paint: {
      'fill-extrusion-color': ['get', 'color'],
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-opacity': 0.38,
    },
  });

  state.map.addLayer({
    id: 'target-trails',
    type: 'line',
    source: 'trails',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 2,
      'line-opacity': 0.8,
    },
  });

  state.map.addLayer({
    id: 'target-glyphs',
    type: 'symbol',
    source: 'targets',
    layout: {
      'text-field': ['get', 'textGlyph'],
      'text-size': ['case', ['==', ['get', 'kind'], 'aircraft'], 18, 16],
      'text-rotate': ['get', 'heading'],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-offset': [0, 0],
      'text-font': ['Open Sans Bold'],
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': '#08101e',
      'text-halo-width': 1.2,
    },
  });

  state.map.addLayer({
    id: 'target-labels',
    type: 'symbol',
    source: 'targets',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.4],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#dbe7f4',
      'text-halo-color': '#08101e',
      'text-halo-width': 1.4,
    },
  });

  ['target-glyphs', 'target-labels', 'target-columns'].forEach((layerId) => {
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

  dom.toggle3d.addEventListener('change', (event) => {
    state.filters.show3d = event.target.checked;
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

  dom.refreshNow.addEventListener('click', () => {
    fetchTraffic().catch((error) => console.error(error));
  });

  dom.clearSelection.addEventListener('click', () => {
    state.selectedId = null;
    refreshUi();
  });
}

function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: getMapStyle(),
    center: [-73.9857, 40.7484],
    zoom: 5.2,
    pitch: 58,
    bearing: -18,
    antialias: true,
    hash: true,
  });

  state.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '280px' });

  state.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'top-right');
  state.map.addControl(new maplibregl.ScaleControl({ maxWidth: 160, unit: 'imperial' }), 'bottom-right');
  if (typeof maplibregl.GlobeControl === 'function') {
    state.map.addControl(new maplibregl.GlobeControl(), 'top-right');
  }

  state.map.on('load', async () => {
    try {
      if (typeof state.map.setProjection === 'function') {
        state.map.setProjection({ type: 'globe' });
      }
    } catch (error) {
      console.debug('Globe projection unavailable:', error);
    }

    addSourcesAndLayers();
    wireControls();
    scheduleRefresh();
    await fetchTraffic();
  });

  state.map.on('moveend', () => {
    fetchTraffic().catch((error) => console.error(error));
  });
}

initMap();
