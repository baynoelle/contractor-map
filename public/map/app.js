const sheetCsvUrl = 'https://docs.google.com/spreadsheets/d/1WErGMtEQuGYbfyq6p1KudxAslvOTqIgOcrDN4ruahoc/export?format=csv&gid=2';
const countiesTopoJsonUrl = 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json';
const includedStatuses = new Set(['Active Affiliate', 'Affiliate']);
const stateFips = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10',
  DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19',
  KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27',
  MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35',
  NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44',
  SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53',
  WV: '54', WI: '55', WY: '56'
};
const coordinateCache = new Map();

const map = L.map('map', { zoomControl: true }).setView([39.5, -92.5], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const list = document.getElementById('list');
const search = document.getElementById('search');
const serviceSearchForm = document.getElementById('serviceSearchForm');
const serviceSearch = document.getElementById('serviceSearch');
const clearServiceSearch = document.getElementById('clearServiceSearch');
const statusEl = document.getElementById('status');
const mappedCount = document.getElementById('mappedCount');
const totalCount = document.getElementById('totalCount');
const servicePanel = document.getElementById('servicePanel');
const markers = [];
let countyFeatures = null;
let serviceAreaLayer = null;
let activeServiceMatches = null;
let activeServiceDistances = new Map();
let currentContractors = [];

const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const externalLink = (url, label) => url
  ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  : `<span class="unavailable">${label} unavailable</span>`;

for (const contractor of window.CONTRACTORS || []) {
  if (!contractor.coordinates) continue;
  coordinateCache.set(normalize(contractor.company), contractor.coordinates);
  coordinateCache.set(normalize(contractor.address), contractor.coordinates);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }

  row.push(value);
  rows.push(row);
  return rows.filter(cells => cells.some(cell => cell.trim()));
}

function cleanUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || /^no\s/i.test(trimmed)) return '';
  return trimmed;
}

function cleanEmail(value) {
  return String(value || '').split('/')[0].trim();
}

function parseTravelRadius(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/\d+(\.\d+)?/);
  const isTime = /\b(hours?|hrs?)\b/i.test(raw);
  const miles = match && !isTime ? Number(match[0]) : null;
  return { raw, miles };
}

function formatTravelRadius(c) {
  if (c.serviceRadiusRaw) return c.serviceRadiusRaw;
  if (c.serviceRadiusMiles) return `${c.serviceRadiusMiles} miles`;
  return '';
}

function radiusCanBeMapped(c) {
  return Number(c.serviceRadiusMiles) > 0;
}

function makeAddress(row, columns) {
  return [
    row[columns['Street']],
    row[columns['City']],
    row[columns['State']],
    row[columns['ZIP Code']]
  ].map(value => String(value || '').trim()).filter(Boolean).join(', ');
}

function contractorFromRow(row, columns) {
  const address = makeAddress(row, columns);
  const company = String(row[columns['Company Name']] || '').trim();
  const travelRadius = parseTravelRadius(row[columns['Travel Radius (Miles)']]);
  return {
    company,
    contact: String(row[columns['Contact Name']] || '').trim(),
    phone: String(row[columns['Phone']] || '').trim(),
    email: cleanEmail(row[columns['Email']]),
    website: cleanUrl(row[columns['Website']]),
    facebook: cleanUrl(row[columns['Facebook Page']]),
    address,
    city: String(row[columns['City']] || '').trim(),
    state: String(row[columns['State']] || '').trim(),
    zip: String(row[columns['ZIP Code']] || '').trim(),
    countyServiceArea: String(row[columns['County Service Area']] || '').trim(),
    serviceRadiusRaw: travelRadius.raw,
    serviceRadiusMiles: travelRadius.miles,
    coordinates: coordinateCache.get(normalize(company)) || coordinateCache.get(normalize(address)) || null
  };
}

async function loadSheetContractors() {
  const response = await fetch(`${sheetCsvUrl}&cacheBust=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Sheet could not be loaded');

  const rows = parseCsv(await response.text());
  const headers = rows[0].map(header => header.trim());
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const contractors = [];

  for (const row of rows.slice(1)) {
    const status = String(row[columns['Relationship Status']] || '').trim();
    if (!includedStatuses.has(status)) continue;
    const company = String(row[columns['Company Name']] || '').trim();
    if (!company || normalize(company) === 'test company') continue;
    contractors.push(contractorFromRow(row, columns));
  }

  return contractors;
}

async function geocode(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('q', query);

  const response = await fetch(url);
  if (!response.ok) return null;
  const results = await response.json();
  if (!results.length) return null;
  return { lat: Number(results[0].lat), lng: Number(results[0].lon) };
}

async function geocodePlace(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('q', query);

  const response = await fetch(url);
  if (!response.ok) return null;
  const results = await response.json();
  if (!results.length) return null;
  const result = results[0];
  return {
    lat: Number(result.lat),
    lng: Number(result.lon),
    county: result.address?.county || '',
    state: result.address?.state || '',
    stateCode: result.address?.state_code || '',
    postcode: result.address?.postcode || '',
    displayName: result.display_name || query
  };
}

async function getCountyFeatures() {
  if (countyFeatures) return countyFeatures;
  const response = await fetch(countiesTopoJsonUrl);
  if (!response.ok || !window.topojson) return [];
  const topology = await response.json();
  countyFeatures = window.topojson.feature(topology, topology.objects.counties).features;
  return countyFeatures;
}

async function geocodeMissingContractors(contractors) {
  const missing = contractors.filter(contractor => !contractor.coordinates && contractor.address);
  for (let i = 0; i < missing.length; i++) {
    const contractor = missing[i];
    statusEl.textContent = `Placing new address ${i + 1} of ${missing.length}...`;
    const candidates = [
      contractor.address,
      [contractor.city, contractor.state, contractor.zip].filter(Boolean).join(', '),
      [contractor.city, contractor.state].filter(Boolean).join(', ')
    ].filter(Boolean);

    for (const candidate of candidates) {
      contractor.coordinates = await geocode(candidate);
      if (contractor.coordinates) break;
      await sleep(1100);
    }
    await sleep(1100);
  }
}

function popupHtml(c) {
  const travelRadius = formatTravelRadius(c);
  const radius = travelRadius
    ? `<p><strong>Travel radius:</strong> ${esc(travelRadius)}</p>`
    : '';
  const county = c.countyServiceArea
    ? `<p><strong>County service area:</strong> ${esc(c.countyServiceArea)}</p>`
    : '';
  return `<div class="popup">
    <h2>${esc(c.company)}</h2>
    <p><strong>Contact:</strong> ${esc(c.contact)}</p>
    <p><strong>Address:</strong> ${esc(c.address)}</p>
    ${county}
    ${radius}
    <p><strong>Phone:</strong> <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></p>
    <p><strong>Email:</strong> <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>
    <div class="actions">${externalLink(c.website,'Website')}${externalLink(c.facebook,'Facebook')}<a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(c.address)}" target="_blank" rel="noopener noreferrer">Directions</a></div>
  </div>`;
}

function serviceAreaHtml(c) {
  const county = c.countyServiceArea || 'No county service area listed';
  const travelRadius = formatTravelRadius(c);
  const radius = radiusCanBeMapped(c)
    ? `${c.serviceRadiusMiles} mile radius shown in blue`
    : travelRadius || 'No travel radius listed';
  return `<button class="service-close" type="button" aria-label="Hide service area">x</button>
    <p class="eyebrow">Service Area</p>
    <h2>${esc(c.company)}</h2>
    <dl>
      <div><dt>Base location</dt><dd>${esc([c.city, c.state].filter(Boolean).join(', ') || c.address)}</dd></div>
      <div><dt>Area notes</dt><dd>${esc(county)}</dd></div>
      <div><dt>Radius</dt><dd>${esc(radius)}</dd></div>
    </dl>`;
}

function serviceAreaCountyTokens(c) {
  if (!c.countyServiceArea) return [];
  return c.countyServiceArea
    .split(/,|;|&|\band\b/i)
    .map(value => value.trim().replace(/\.$/, ''))
    .map(value => {
      const stateMatch = value.match(/\b([A-Z]{2})\b$/);
      const state = stateMatch ? stateMatch[1] : String(c.state || '').trim().toUpperCase();
      const county = value
        .replace(/\b([A-Z]{2})\b$/, '')
        .replace(/\bcounties\b/i, '')
        .replace(/\bcounty\b/i, '')
        .trim();
      return { county, state };
    })
    .filter(token => token.county && token.county.length < 50 && stateFips[token.state])
    .filter(token => !/\b(as far as|currently|open to|area|metro|locations?|zip code)\b/i.test(token.county))
    .slice(0, 12);
}

async function serviceAreaBoundaries(c) {
  const countyTokens = serviceAreaCountyTokens(c);
  if (!countyTokens.length) return [];
  const features = await getCountyFeatures();
  const wanted = new Set(countyTokens.map(token => `${stateFips[token.state]}:${normalize(token.county)}`));
  return features.filter(feature => {
    const featureState = String(feature.id || '').slice(0, 2);
    const featureName = normalize(feature.properties?.name);
    return wanted.has(`${featureState}:${featureName}`);
  });
}

function distanceMiles(a, b) {
  const earthMiles = 3958.8;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthMiles * Math.asin(Math.sqrt(h));
}

function textServiceMatch(c, query, place) {
  const haystack = normalize([
    c.countyServiceArea,
    c.city,
    c.state,
    c.zip,
    formatTravelRadius(c)
  ].join(' '));
  const needles = [
    query,
    place?.county,
    place?.state,
    place?.stateCode,
    place?.postcode
  ].flatMap(value => {
    const normalized = normalize(value);
    return [normalized, normalized.replace(/\bcounty\b/g, '').trim()];
  }).filter(Boolean);
  return needles.some(needle => haystack.includes(needle));
}

function contractorServicesPlace(c, query, place) {
  if (place && radiusCanBeMapped(c) && c.coordinates) {
    const distance = distanceMiles(c.coordinates, place);
    if (distance <= Number(c.serviceRadiusMiles)) return true;
  }
  return textServiceMatch(c, query, place);
}

function contractorDistance(c, place) {
  if (!place || !c.coordinates) return Number.POSITIVE_INFINITY;
  return distanceMiles(c.coordinates, place);
}

function applyFilters() {
  const q = search.value.toLowerCase().trim();
  document.querySelectorAll('.card').forEach(card => {
    const matchesContractorSearch = !q || card.dataset.search.includes(q);
    const matchesServiceSearch = !activeServiceMatches || activeServiceMatches.has(card.dataset.company);
    const visible = matchesContractorSearch && matchesServiceSearch;
    card.hidden = !visible;
  });
  markers.forEach(marker => {
    const text = searchableText(marker.contractor);
    const companyKey = normalize(marker.contractor.company);
    const matchesContractorSearch = !q || text.includes(q);
    const matchesServiceSearch = !activeServiceMatches || activeServiceMatches.has(companyKey);
    if (matchesContractorSearch && matchesServiceSearch) {
      if (!map.hasLayer(marker)) marker.addTo(map);
    } else if (map.hasLayer(marker)) {
      map.removeLayer(marker);
    }
  });
  if (activeServiceMatches) {
    const cards = Array.from(list.querySelectorAll('.card'));
    cards.sort((a, b) => {
      const aDistance = activeServiceDistances.get(a.dataset.company) ?? Number.POSITIVE_INFINITY;
      const bDistance = activeServiceDistances.get(b.dataset.company) ?? Number.POSITIVE_INFINITY;
      return aDistance - bDistance || a.dataset.name.localeCompare(b.dataset.name);
    });
    cards.forEach(card => list.appendChild(card));
  }
}

function fitVisibleMarkers() {
  const visible = markers.filter(marker => map.hasLayer(marker));
  if (visible.length) map.fitBounds(L.featureGroup(visible).getBounds(), {padding:[35,35]});
}

function resetMapView() {
  search.value = '';
  serviceSearch.value = '';
  activeServiceMatches = null;
  activeServiceDistances = new Map();
  clearServiceSearch.hidden = true;
  servicePanel.hidden = true;
  clearServiceArea();
  applyFilters();
  fitVisibleMarkers();
  statusEl.textContent = `${markers.length} pins loaded from Google Sheet`;
}

function searchableText(c) {
  return [
    c.company,
    c.contact,
    c.address,
    c.city,
    c.state,
    c.zip,
    c.countyServiceArea,
    formatTravelRadius(c)
  ].join(' ').toLowerCase();
}

function clearServiceArea() {
  if (serviceAreaLayer) {
    map.removeLayer(serviceAreaLayer);
    serviceAreaLayer = null;
  }
}

async function showServiceArea(marker) {
  clearServiceArea();
  const miles = radiusCanBeMapped(marker.contractor) ? Number(marker.contractor.serviceRadiusMiles) : null;
  servicePanel.innerHTML = serviceAreaHtml(marker.contractor);
  servicePanel.hidden = false;
  servicePanel.querySelector('.service-close').addEventListener('click', () => {
    servicePanel.hidden = true;
    clearServiceArea();
  });

  if (miles) {
    serviceAreaLayer = L.circle(marker.getLatLng(), {
      radius: miles * 1609.344,
      color: '#1d4ed8',
      weight: 2,
      fillColor: '#60a5fa',
      fillOpacity: 0.2
    }).addTo(map);
    return serviceAreaLayer;
  }

  const boundaries = await serviceAreaBoundaries(marker.contractor);

  if (!boundaries.length) return null;
  serviceAreaLayer = L.geoJSON(boundaries, {
    style: {
      color: '#1d4ed8',
      weight: 2,
      fillColor: '#60a5fa',
      fillOpacity: 0.2
    }
  }).addTo(map);
  return serviceAreaLayer;
}

function addCard(c, marker) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.company = normalize(c.company);
  card.dataset.name = c.company;
  card.dataset.search = searchableText(c);
  const travelRadius = formatTravelRadius(c);
  const radius = travelRadius ? `<p>${esc(travelRadius)} travel radius</p>` : '';
  card.innerHTML = `<h3><span class="dot"></span>${esc(c.company)}</h3><p>${esc(c.contact)}</p><p>${esc(c.address)}</p>${radius}`;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Show ${c.company} on the map`);
  const selectContractor = async () => {
    document.querySelectorAll('.card').forEach(x => x.classList.remove('active'));
    card.classList.add('active');
    const serviceArea = await showServiceArea(marker);
    const view = serviceArea ? L.featureGroup([marker, serviceArea]) : L.featureGroup([marker]);
    map.fitBounds(view.getBounds(), {padding:[35,35], maxZoom:13});
    marker.openPopup();
  };
  card.addEventListener('click', selectContractor);
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectContractor();
    }
  });
  list.appendChild(card);
}

function clearMap() {
  markers.splice(0).forEach(marker => marker.remove());
  clearServiceArea();
  list.replaceChildren();
}

function renderContractors(contractors, sourceLabel) {
  clearMap();
  currentContractors = contractors;
  activeServiceMatches = null;
  activeServiceDistances = new Map();
  clearServiceSearch.hidden = true;
  totalCount.textContent = contractors.length;
  const bounds = [];
  let failures = 0;

  for (const c of contractors) {
    if (!c.coordinates) { failures++; continue; }
    const marker = L.marker([c.coordinates.lat, c.coordinates.lng])
      .addTo(map)
      .bindPopup(popupHtml(c), {maxWidth:320});
    marker.contractor = c;
    marker.on('click', async () => {
      const serviceArea = await showServiceArea(marker);
      if (serviceArea) {
        map.fitBounds(L.featureGroup([marker, serviceArea]).getBounds(), {padding:[35,35], maxZoom:13});
      }
    });
    markers.push(marker);
    addCard(c, marker);
    bounds.push([c.coordinates.lat, c.coordinates.lng]);
  }

  mappedCount.textContent = markers.length;
  if (bounds.length) map.fitBounds(bounds, {padding:[35,35]});
  statusEl.textContent = failures
    ? `${markers.length} mapped from ${sourceLabel} · ${failures} need cleaner addresses`
    : `${markers.length} pins loaded from ${sourceLabel}`;
}

async function load() {
  statusEl.textContent = 'Loading latest Google Sheet...';
  try {
    const contractors = await loadSheetContractors();
    await geocodeMissingContractors(contractors);
    renderContractors(contractors, 'Google Sheet');
  } catch (error) {
    renderContractors(window.CONTRACTORS || [], 'saved backup');
    statusEl.textContent = 'Showing saved backup because the Google Sheet could not load';
  }
}

search.addEventListener('input', applyFilters);

serviceSearchForm.addEventListener('submit', async event => {
  event.preventDefault();
  const query = serviceSearch.value.trim();
  if (!query) return;
  statusEl.textContent = `Finding contractors for ${query}...`;
  const place = await geocodePlace(query);
  const matches = currentContractors.filter(contractor => contractorServicesPlace(contractor, query, place));
  activeServiceMatches = new Set(matches.map(contractor => normalize(contractor.company)));
  activeServiceDistances = new Map(matches.map(contractor => [
    normalize(contractor.company),
    contractorDistance(contractor, place)
  ]));
  clearServiceSearch.hidden = false;
  applyFilters();
  fitVisibleMarkers();
  statusEl.textContent = `${matches.length} contractor${matches.length === 1 ? '' : 's'} service ${place?.displayName || query}`;
});

clearServiceSearch.addEventListener('click', () => {
  serviceSearch.value = '';
  activeServiceMatches = null;
  activeServiceDistances = new Map();
  clearServiceSearch.hidden = true;
  applyFilters();
  fitVisibleMarkers();
  statusEl.textContent = `${markers.length} pins loaded from Google Sheet`;
});

document.getElementById('fitBtn').onclick = resetMapView;

load();
