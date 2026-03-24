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
    entry.push([entity.lon, entity.lat]);
  }
  state.history.set(entity.id, entry.slice(-18));
}

function createIconSvg(kind) {
  if (kind === 'vessel') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <g fill="none" fill-rule="evenodd">
        <path fill="#132235" d="M10 39h44l-6 9H16z"/>
        <path fill="#ff9db2" d="M8 41h48l-8 11H16z"/>
        <path fill="#ffe2ea" d="M24 19h16v12H24z"/>
        <path fill="#ffcad7" d="M21 31h22v7H21z"/>
        <path fill="#ffd9e3" d="M30 12h4v8h-4z"/>
      </g>
    </svg>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <g fill="none" fill-rule="evenodd">
      <path fill="#67d4ff" d="M30 4h4l4 20 14 8v4L38 32l3 20-3 2-6-16-6 16-3-2 3-20-14 4v-4l14-8z"/>
      <path fill="#c7f2ff" d="M30 4h4v18h-4z"/>
    </g>
  </svg>`;
}

function ensureMapImages() {
  for (const kind of ['aircraft', 'vessel']) {
    const imageId = `${kind}-icon`;
    if (state.map.hasImage(imageId)) continue;
    const svg = createIconSvg(kind);
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    state.map.loadImage(url, (error, image) => {
      if (!error && image && !state.map.hasImage(imageId)) {
        state.map.addImage(imageId, image, { pixelRatio: 2 });
      }
    });
  }
}

function buildGeoJson(entities) {
  const icons = createEmptyCollection();
  const trails = createEmptyCollection();
  const selection = createEmptyCollection();

  for (const entity of entities) {
    icons.features.push({
      type: 'Feature',
      id: entity.id,
      geometry: { type: 'Point', coordinates: [entity.lon, entity.lat] },
      properties: {
        id: entity.id,
        kind: entity.kind,
        label: entity.label,
        heading: Number.isFinite(entity.heading) ? entity.heading : 0,
        icon: entity.kind === 'aircraft' ? 'aircraft-icon' : 'vessel-icon',
        iconSize: entity.kind === 'aircraft' ? 0.62 : 0.74,
        color: entity.kind === 'aircraft' ? '#67d4ff' : '#ff9db2',
        speedKts: entity.speedKts ?? 0,
        altitudeFt: entity.altitudeFt ?? 0,
      },
    });

    const history = state.history.get(entity.id) || [];
    if (history.length >= 2) {
      trails.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: history },
        properties: {
          id: entity.id,
          color: entity.kind === 'aircraft' ? '#37bff8' : '#ff7c9b',
        },
      });
    }

    if (entity.id === state.selectedId) {
      selection.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [entity.lon, entity.lat] },
        properties: {
          id: entity.id,
          radius: entity.kind === 'aircraft' ? 14 : 16,
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

  const rows = [
    ['Type', entity.kind],
    ['Label', entity.label],
    ['ICAO / MMSI', entity.icao24 || entity.mmsi || '—'],
    ['Altitude', entity.altitudeFt ? `${fmtNumber(entity.altitudeFt)} ft` : '—'],
    ['Speed', entity.speedKts ? `${fmtNumber(entity.speedKts)} kts` : '—'],
    ['Heading', Number.isFinite(entity.heading) ? `${Math.round(entity.heading)}°` : '—'],
    ['Destination', entity.destination || '—'],
    ['Country / Status', entity.country || entity.navStatus || '—'],
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

  dom.entityList.innerHTML = state.visibleEntities.slice(0, 200).map((entity) => `
    <button class="entity-card ${entity.id === state.selectedId ? 'active' : ''}" data-entity-id="${entity.id}">
      <div class="entity-topline">
        <strong>${entity.label}</strong>
        <span class="badge ${entity.kind === 'vessel' ? 'vessel' : ''}">${entity.kind}</span>
      </div>
      <div class="entity-subline">
        <span>${entity.kind === 'aircraft' ? `${fmtNumber(entity.altitudeFt)} ft · ${fmtNumber(entity.speedKts)} kts` : `${fmtNumber(entity.speedKts)} kts · ${entity.destination || 'No destination'}`}</span>
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
  state.popup
    .setLngLat([entity.lon, entity.lat])
    .setHTML(`
      <div class="popup-title">${entity.label}</div>
      <div class="popup-grid">
        <div>Type</div><div>${entity.kind}</div>
        <div>Speed</div><div>${entity.speedKts ? `${fmtNumber(entity.speedKts)} kts` : '—'}</div>
        <div>Altitude</div><div>${entity.altitudeFt ? `${fmtNumber(entity.altitudeFt)} ft` : '—'}</div>
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
  for (const entity of state.entities) upsertHistory(entity);
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
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 1.7,
      'line-opacity': 0.8,
    },
  });

  state.map.addLayer({
    id: 'target-selection',
    type: 'circle',
    source: 'selection',
    paint: {
      'circle-radius': ['get', 'radius'],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.95,
    },
  });

  state.map.addLayer({
    id: 'target-icons',
    type: 'symbol',
    source: 'targets',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': ['get', 'iconSize'],
      'icon-rotate': ['get', 'heading'],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['case', ['==', ['get', 'kind'], 'aircraft'], 2, 1],
    },
  });

  state.map.addLayer({
    id: 'target-labels',
    type: 'symbol',
    source: 'targets',
    minzoom: 7.2,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Semibold'],
      'text-size': 11,
      'text-offset': [0, 1.55],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-max-width': 10,
    },
    paint: {
      'text-color': '#ebf5ff',
      'text-halo-color': '#06101d',
      'text-halo-width': 1.4,
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
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });
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

  state.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '280px' });

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
