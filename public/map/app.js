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
let radiusCircle = null;

totalCount.textContent = CONTRACTORS.length;

const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const externalLink = (url, label) => url
  ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  : `<span class="unavailable">${label} unavailable</span>`;

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

function load() {
  const bounds = [];
  let failures = 0;
  for (const c of CONTRACTORS) {
    if (!c.coordinates) { failures++; continue; }
    const marker = L.marker([c.coordinates.lat, c.coordinates.lng])
      .addTo(map)
      .bindPopup(popupHtml(c), {maxWidth:320});
    marker.contractor = c;
    marker.on('click', () => showRadius(marker));
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
