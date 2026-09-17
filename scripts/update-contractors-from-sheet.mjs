import { readFile, writeFile } from 'node:fs/promises';

const sheetCsvUrl = 'https://docs.google.com/spreadsheets/d/1WErGMtEQuGYbfyq6p1KudxAslvOTqIgOcrDN4ruahoc/export?format=csv&gid=2';
const contractorsPath = new URL('../public/map/contractors.js', import.meta.url);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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

function readExistingContractors(source) {
  const json = source
    .replace(/^window\.CONTRACTORS\s*=\s*/, '')
    .replace(/;\s*$/, '');
  return JSON.parse(json);
}

function makeAddress(row, columns) {
  return [
    row[columns['Street']],
    row[columns['City']],
    row[columns['State']],
    row[columns['ZIP Code']]
  ].map(value => String(value || '').trim()).filter(Boolean).join(', ');
}

function cleanAddressForGeocoding(value) {
  return String(value || '')
    .replace(/\bGargfield\b/gi, 'Garfield')
    .replace(/\bFt\.?\b/gi, 'Fort')
    .replace(/\bHwy\b/gi, 'Highway')
    .replace(/\bSte\.?\b/gi, 'Suite')
    .replace(/\bP\.?\s*O\.?\s*Box\b/gi, 'PO Box')
    .replace(/[.#]/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutSecondaryAddress(value) {
  return cleanAddressForGeocoding(value)
    .replace(/\s+\b(?:suite|unit|apt|apartment|bldg|building|floor|fl)\b\s*[a-z0-9 -]*?(?=,|$)/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

function uniqueGeocodeCandidates(candidates) {
  return candidates.filter((candidate, index, all) => (
    candidate.query && all.findIndex(item => normalize(item.query) === normalize(candidate.query)) === index
  ));
}

function contractorGeocodeCandidates(contractor) {
  const address = cleanAddressForGeocoding(contractor.address);
  const street = cleanAddressForGeocoding(contractor.street || contractor.address);
  const streetWithoutSecondary = withoutSecondaryAddress(street);
  const cityStateZip = [contractor.city, contractor.state, contractor.zip].filter(Boolean).join(', ');
  const cityState = [contractor.city, contractor.state].filter(Boolean).join(', ');
  const streetCityState = [streetWithoutSecondary, contractor.city, contractor.state].filter(Boolean).join(', ');
  const streetCityStateZip = [streetWithoutSecondary, contractor.city, contractor.state, contractor.zip].filter(Boolean).join(', ');

  return uniqueGeocodeCandidates([
    { query: contractor.address },
    { query: address },
    { query: streetCityStateZip },
    { query: streetCityState },
    { query: cityStateZip },
    { query: contractor.zip },
    { query: cityState }
  ]);
}

async function geocode(address) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('q', address);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'contractor-map-data-refresh/1.0 (support@wekeepitclean.com)'
      }
    });
    if (!response.ok) return null;
    const results = await response.json();
    if (!results.length) return null;
    return {
      lat: Number(results[0].lat),
      lng: Number(results[0].lon)
    };
  } catch (error) {
    return null;
  }
}

async function geocodeContractor(contractor) {
  const candidates = contractorGeocodeCandidates(contractor);

  for (const candidate of candidates) {
    const coordinates = await geocode(candidate.query);
    if (coordinates) return coordinates;
    await sleep(1100);
  }
  return null;
}

const currentSource = await readFile(contractorsPath, 'utf8');
const existing = readExistingContractors(currentSource);
const existingByCompany = new Map(existing.map(contractor => [normalize(contractor.company), contractor]));
const existingByAddress = new Map(existing.map(contractor => [normalize(contractor.address), contractor]));

const csvResponse = await fetch(sheetCsvUrl);
if (!csvResponse.ok) {
  throw new Error(`Could not fetch Google Sheet CSV: ${csvResponse.status}`);
}
const rows = parseCsv(await csvResponse.text());
const headers = rows[0].map(header => header.trim());
const columns = Object.fromEntries(headers.map((header, index) => [header, index]));

const required = ['Relationship Status', 'Company Name', 'Contact Name', 'Phone', 'Email', 'Website', 'Facebook Page', 'Street', 'City', 'State', 'ZIP Code'];
for (const header of required) {
  if (!(header in columns)) throw new Error(`Missing expected column: ${header}`);
}

const contractors = [];
const missingCoordinates = [];

for (const row of rows.slice(1)) {
  const relationshipStatus = String(row[columns['Relationship Status']] || '').trim();
  if (!['Active Affiliate', 'Affiliate'].includes(relationshipStatus)) continue;

  const company = String(row[columns['Company Name']] || '').trim();
  if (!company || normalize(company) === 'test company') continue;

  const address = makeAddress(row, columns);
  const existingMatch = existingByCompany.get(normalize(company)) || existingByAddress.get(normalize(address));
  const travelRadius = parseTravelRadius(row[columns['Travel Radius (Miles)']]);
  const contractor = {
    company,
    contact: String(row[columns['Contact Name']] || '').trim(),
    phone: String(row[columns['Phone']] || '').trim(),
    email: cleanEmail(row[columns['Email']]),
    website: cleanUrl(row[columns['Website']]),
    facebook: cleanUrl(row[columns['Facebook Page']]),
    address,
    street: String(row[columns['Street']] || '').trim(),
    city: String(row[columns['City']] || '').trim(),
    state: String(row[columns['State']] || '').trim(),
    zip: String(row[columns['ZIP Code']] || '').trim(),
    countyServiceArea: String(row[columns['County Service Area']] || '').trim(),
    serviceRadiusRaw: travelRadius.raw,
    serviceRadiusMiles: travelRadius.miles,
    coordinates: existingMatch?.coordinates || null
  };

  if (!contractor.coordinates && address) missingCoordinates.push(contractor);
  contractors.push(contractor);
}

for (const contractor of missingCoordinates) {
  await sleep(1100);
  contractor.coordinates = await geocodeContractor(contractor);
}

const mapped = contractors.filter(contractor => contractor.coordinates).length;
const js = `window.CONTRACTORS = ${JSON.stringify(contractors, null, 2)};\n`;
await writeFile(contractorsPath, js);

console.log(JSON.stringify({
  rows: rows.length - 1,
  includedAffiliates: contractors.length,
  mapped,
  geocoded: missingCoordinates.filter(contractor => contractor.coordinates).length,
  missing: contractors.filter(contractor => !contractor.coordinates).map(contractor => ({
    company: contractor.company,
    address: contractor.address
  }))
}, null, 2));
