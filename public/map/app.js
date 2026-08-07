const sheetCsvUrl = 'https://docs.google.com/spreadsheets/d/1WErGMtEQuGYbfyq6p1KudxAslvOTqIgOcrDN4ruahoc/export?format=csv&gid=2';
const includedStatuses = new Set(['Active Affiliate', 'Affiliate']);
const coordinateCache = new Map();

const map = L.map('map', { zoomControl: true }).setView([39.5, -92.5], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const list = document.getElementById('list');
const search = document.getElementById('search');
const statusEl = document.getElementById('status');
const mappedCount = document.getElementById('mappedCount');
const totalCount = document.getElementById('totalCount');
const markers = [];
let radiusCircle = null;

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

function parseMiles(value) {
  const match = String(value || '').match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
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
    serviceRadiusMiles: parseMiles(row[columns['Travel Radius (Miles)']]),
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
  const radius = c.serviceRadiusMiles
    ? `<p><strong>Travel radius:</strong> ${esc(c.serviceRadiusMiles)} miles</p>`
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

function searchableText(c) {
  return [
    c.company,
    c.contact,
    c.address,
    c.city,
    c.state,
    c.zip,
    c.countyServiceArea,
    c.serviceRadiusMiles ? `${c.serviceRadiusMiles} miles` : ''
  ].join(' ').toLowerCase();
}

function showRadius(marker) {
  if (radiusCircle) map.removeLayer(radiusCircle);
  const miles = Number(marker.contractor.serviceRadiusMiles);
  if (!miles) return;
  radiusCircle = L.circle(marker.getLatLng(), {
    radius: miles * 1609.344,
    color: '#1d4ed8',
    weight: 2,
    fillColor: '#60a5fa',
    fillOpacity: 0.2
  }).addTo(map);
}

function addCard(c, marker) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.search = searchableText(c);
  const radius = c.serviceRadiusMiles ? `<p>${esc(c.serviceRadiusMiles)} mile travel radius</p>` : '';
  card.innerHTML = `<h3><span class="dot"></span>${esc(c.company)}</h3><p>${esc(c.contact)}</p><p>${esc(c.address)}</p>${radius}`;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Show ${c.company} on the map`);
  const selectContractor = () => {
    document.querySelectorAll('.card').forEach(x => x.classList.remove('active'));
    card.classList.add('active');
    showRadius(marker);
    const view = radiusCircle ? L.featureGroup([marker, radiusCircle]) : L.featureGroup([marker]);
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
  if (radiusCircle) {
    map.removeLayer(radiusCircle);
    radiusCircle = null;
  }
  list.replaceChildren();
}

function renderContractors(contractors, sourceLabel) {
  clearMap();
  totalCount.textContent = contractors.length;
  const bounds = [];
  let failures = 0;

  for (const c of contractors) {
    if (!c.coordinates) { failures++; continue; }
    const marker = L.marker([c.coordinates.lat, c.coordinates.lng])
      .addTo(map)
      .bindPopup(popupHtml(c), {maxWidth:320});
    marker.contractor = c;
    marker.on('click', () => showRadius(marker));
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

search.addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  document.querySelectorAll('.card').forEach(card => card.hidden = !card.dataset.search.includes(q));
  markers.forEach(marker => {
    const text = searchableText(marker.contractor);
    if (text.includes(q)) {
      if (!map.hasLayer(marker)) marker.addTo(map);
    } else if (map.hasLayer(marker)) map.removeLayer(marker);
  });
});

document.getElementById('fitBtn').onclick = () => {
  const visible = markers.filter(m => map.hasLayer(m));
  if (visible.length) map.fitBounds(L.featureGroup(visible).getBounds(), {padding:[35,35]});
};

load();
