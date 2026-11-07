/**
 * Where a school is, in words people use: country, county or district, and the
 * nearest town. Shared by the platform service (which validates) and the Angaza
 * console (which builds its form from it), so both always agree.
 *
 * No coordinates: Angaza staff need to recognise a school, group schools by
 * place, and know what time it is there, not to navigate to it.
 *
 * Every country listed has a single time zone, so a school's time zone follows
 * from its country and is never typed. Adding a country is one entry here.
 * Region lists are given only where the official list is stable and known;
 * other countries take the region as typed.
 */

const KENYA_COUNTIES = [
  'Baringo', 'Bomet', 'Bungoma', 'Busia', 'Elgeyo-Marakwet', 'Embu', 'Garissa', 'Homa Bay',
  'Isiolo', 'Kajiado', 'Kakamega', 'Kericho', 'Kiambu', 'Kilifi', 'Kirinyaga', 'Kisii',
  'Kisumu', 'Kitui', 'Kwale', 'Laikipia', 'Lamu', 'Machakos', 'Makueni', 'Mandera',
  'Marsabit', 'Meru', 'Migori', 'Mombasa', "Murang'a", 'Nairobi', 'Nakuru', 'Nandi',
  'Narok', 'Nyamira', 'Nyandarua', 'Nyeri', 'Samburu', 'Siaya', 'Taita-Taveta', 'Tana River',
  'Tharaka-Nithi', 'Trans Nzoia', 'Turkana', 'Uasin Gishu', 'Vihiga', 'Wajir', 'West Pokot',
];

const RWANDA_DISTRICTS = [
  'Bugesera', 'Burera', 'Gakenke', 'Gasabo', 'Gatsibo', 'Gicumbi', 'Gisagara', 'Huye',
  'Kamonyi', 'Karongi', 'Kayonza', 'Kicukiro', 'Kirehe', 'Muhanga', 'Musanze', 'Ngoma',
  'Ngororero', 'Nyabihu', 'Nyagatare', 'Nyamagabe', 'Nyamasheke', 'Nyanza', 'Nyarugenge', 'Nyaruguru',
  'Rubavu', 'Ruhango', 'Rulindo', 'Rusizi', 'Rutsiro', 'Rwamagana',
];

export const COUNTRIES = [
  { code: 'BI', name: 'Burundi', time_zone: 'Africa/Bujumbura', region_label: 'Province', regions: [] },
  { code: 'KE', name: 'Kenya', time_zone: 'Africa/Nairobi', region_label: 'County', regions: KENYA_COUNTIES },
  { code: 'RW', name: 'Rwanda', time_zone: 'Africa/Kigali', region_label: 'District', regions: RWANDA_DISTRICTS },
  { code: 'TZ', name: 'Tanzania', time_zone: 'Africa/Dar_es_Salaam', region_label: 'Region', regions: [] },
  { code: 'UG', name: 'Uganda', time_zone: 'Africa/Kampala', region_label: 'District', regions: [] },
];

export const MAX = { name: 100, region: 60, town: 60 };

const byCode = new Map(COUNTRIES.map((c) => [c.code, c]));

/** The country entry for an ISO 3166 alpha-2 code, or null. */
export const countryOf = (code) => byCode.get(String(code || '').toUpperCase()) || null;

const tidy = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');

/**
 * Checks and tidies a school's name and place. Returns { value } or { problem: { field, message } }.
 * A listed region is matched without regard to case and stored as spelled in the list, so
 * "nairobi" and "Nairobi" are the same county everywhere the console groups or filters.
 */
export function readSchoolPlace({ name, country, region, town }) {
  const n = tidy(name);
  if (!n) return { problem: { field: 'name', message: 'Enter the school’s name' } };
  if (n.length > MAX.name) return { problem: { field: 'name', message: `Keep the name under ${MAX.name} characters` } };

  const c = countryOf(country);
  if (!c) return { problem: { field: 'country', message: 'Choose the country the school is in' } };

  let r = tidy(region);
  const label = c.region_label.toLowerCase();
  if (!r) return { problem: { field: 'region', message: `Choose the school’s ${label}` } };
  if (c.regions.length) {
    const listed = c.regions.find((x) => x.toLowerCase() === r.toLowerCase());
    if (!listed) return { problem: { field: 'region', message: `${r} is not a ${label} of ${c.name}. Choose one from the list.` } };
    r = listed;
  } else if (r.length > MAX.region) {
    return { problem: { field: 'region', message: `Keep the ${label} under ${MAX.region} characters` } };
  }

  const t = tidy(town);
  if (t.length > MAX.town) return { problem: { field: 'town', message: `Keep the town under ${MAX.town} characters` } };

  return { value: { name: n, country: c.code, region: r, town: t || null, time_zone: c.time_zone } };
}

/** "Kitale, Trans Nzoia County, Kenya": the most specific part first. */
export function placeLabel({ town, region, country }) {
  const c = countryOf(country);
  const regionPart = region && c ? `${region} ${c.region_label}` : region;
  return [town, regionPart, c?.name || country].filter(Boolean).join(', ');
}

/** Two schools with this key are the same school entered twice. */
export const sameSchoolKey = ({ name, country, region }) =>
  [country, region, name].map((s) => tidy(s).toLowerCase()).join('|');
