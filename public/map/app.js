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
const markerByContractor = new Map();

// Reserved layer for future shaded GeoJSON service areas.
// Add features with: serviceAreasLayer.addData(serviceAreaGeoJson)
const serviceAreasLayer = L.geoJSON([], {
  style: { color: '#2563eb', weight: 2, fillColor: '#60a5fa', fillOpacity: 0.2 }
}).addTo(map);

totalCount.textContent = CONTRACTORS.length;

const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const externalLink = (url, label) => url
  ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  : `<span class="unavailable">${label} unavailable</span>`;

function popupHtml(c) {
  return `<div class="popup">
    <h2>${esc(c.company)}</h2>
    <p><strong>Contact:</strong> ${esc(c.contact)}</p>
    <p><strong>Address:</strong> ${esc(c.address)}</p>
    <p><strong>Phone:</strong> <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></p>
    <p><strong>Email:</strong> <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>
    <div class="actions">${externalLink(c.website,'Website')}${externalLink(c.facebook,'Facebook')}<a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(c.address)}" target="_blank" rel="noopener noreferrer">Directions</a></div>
  </div>`;
}

function addCard(c, marker) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.search = `${c.company} ${c.contact} ${c.address}`.toLowerCase();
  card.innerHTML = `<h3><span class="dot"></span>${esc(c.company)}</h3><p>${esc(c.contact)}</p><p>${esc(c.address)}</p>`;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Show ${c.company} on the map`);
  const selectContractor = () => {
    document.querySelectorAll('.card').forEach(x => x.classList.remove('active'));
    card.classList.add('active');
    map.setView(marker.getLatLng(), 13);
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

function load() {
  const bounds = [];
  let failures = 0;
  for (const c of CONTRACTORS) {
    if (!c.coordinates) { failures++; continue; }
    const marker = L.marker([c.coordinates.lat, c.coordinates.lng])
      .addTo(map)
      .bindPopup(popupHtml(c), {maxWidth:320});
    marker.contractor = c;
    markers.push(marker);
    markerByContractor.set(c.company, marker);
    addCard(c, marker);
    bounds.push([c.coordinates.lat, c.coordinates.lng]);
  }
  mappedCount.textContent = markers.length;
  if (bounds.length) map.fitBounds(bounds, {padding:[35,35]});
  statusEl.textContent = failures ? `${markers.length} mapped · ${failures} unavailable` : 'All contractor pins are ready';
}

search.addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  document.querySelectorAll('.card').forEach(card => card.hidden = !card.dataset.search.includes(q));
  markers.forEach(marker => {
    const text = `${marker.contractor.company} ${marker.contractor.contact} ${marker.contractor.address}`.toLowerCase();
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
