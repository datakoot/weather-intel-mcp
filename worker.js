/**
 * Weather & Geo Intel MCP — Datakoot
 * Keyless Model Context Protocol server giving AI agents live US weather, hazards
 * and geospatial data: multi-day forecasts, current conditions, active weather
 * alerts, recent earthquakes, ground elevation, and US address geocoding.
 *
 * Data sources (all US-government, public domain, no API keys, commercial-reuse OK):
 *   - NWS / NOAA   https://api.weather.gov            (US public domain; UA required)
 *   - USGS quakes  https://earthquake.usgs.gov/fdsnws (US public domain)
 *   - USGS EPQS    https://epqs.nationalmap.gov       (US public domain)
 *   - US Census    https://geocoding.geo.census.gov   (US public domain)
 * US-focused by design: every source above is a keyless US-government feed, so the
 * whole server is legal to resell with attribution and needs no third-party license.
 *
 * Cloudflare Worker (module). Bindings: KV namespace "RL" (rate-limit day counter).
 */

const POLAR_ORG = "7f455043-0b15-4a1c-b7a0-9c06c9f3b95e";
const CHECKOUT = "https://buy.polar.sh/polar_cl_Q9y3qLrNbtsssN3w5m8SK56oNcruwrmxLEPnd34oAZf";
const FREE_LIMIT = 100;
const UA = "Datakoot-Weather-Intel/1.0 (+https://datakoot.com; contact@datakoot.com)";
const SERVER = { name: "weather-intel", version: "1.0.0" };

/* ------------------------------------------------------------------ helpers */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });

async function getJSON(url, { ttl = 900, accept = "application/json" } = {}) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: accept },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!r.ok && (r.status === 403 || r.status === 429 || r.status >= 500)) { await new Promise((s) => setTimeout(s, 600)); const r2 = await fetch(url, { headers: { "User-Agent": UA, Accept: accept } }); if (r2.ok) { try { return await r2.json(); } catch { return { _error: "bad json from upstream" }; } } return { _error: "upstream " + r.status + " (retried once)" }; } if (r.status === 404) return { _notfound: true };
  if (!r.ok) return { _error: `upstream ${r.status}` };
  try { return await r.json(); } catch { try { await new Promise((s) => setTimeout(s, 500)); const r3 = await fetch(url, { headers: { "User-Agent": UA, Accept: accept } }); if (r3.ok) return await r3.json(); } catch (e) {} return { _error: "upstream returned a non-JSON body twice (likely an error or maintenance page)" }; }
}

const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
const r4 = (v) => Math.round(Number(v) * 1e4) / 1e4; // NWS wants <=4 decimals

/* checkAccess() was removed on 2026-09-02. It was defined but never called —
 * dkGate() is the live paywall — and it still held the old licence test
 * `d.status === "granted" || d.valid || d.id`, whose `|| d.id` clause accepts a
 * REVOKED key, because Polar returns the key object for revoked keys too.
 * Dead code that would silently reinstate a fixed billing hole if anyone ever
 * re-pointed a call site at it. */
/* ------------------------------------------------------------- data layer */
async function nwsPoint(lat, lon) {
  const d = await getJSON(`https://api.weather.gov/points/${r4(lat)},${r4(lon)}`, { ttl: 86400 });
  if (!d || d._error || d._notfound || !d.properties) return null;
  const p = d.properties;
  const loc = p.relativeLocation && p.relativeLocation.properties;
  return {
    forecast: p.forecast,
    forecastHourly: p.forecastHourly,
    stations: p.observationStations,
    grid: `${p.gridId} ${p.gridX},${p.gridY}`,
    place: loc ? `${loc.city}, ${loc.state}` : null,
    tz: p.timeZone,
  };
}

async function censusGeocode(address) {
  const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  const d = await getJSON(u, { ttl: 86400 });
  if (!d || d._error) return { _error: (d && d._error) || "upstream unreachable" }; if (!d.result || !Array.isArray(d.result.addressMatches)) return { _error: "unexpected response shape from the Census geocoder" };
  return d.result.addressMatches.slice(0, 5).map((m) => ({
    matched_address: m.matchedAddress,
    lat: m.coordinates ? m.coordinates.y : null,
    lon: m.coordinates ? m.coordinates.x : null,
  }));
}

/* ------------------------------------------------------------------- tools */
const DK_AD = {"weather_forecast.lat":"Latitude in decimal degrees, e.g. 36.1867. US coverage only (National Weather Service).","weather_forecast.lon":"Longitude in decimal degrees, negative in the western hemisphere, e.g. -94.1288.","weather_current.lat":"Latitude in decimal degrees, e.g. 36.1867. US coverage only (National Weather Service).","weather_current.lon":"Longitude in decimal degrees, negative in the western hemisphere, e.g. -94.1288.","elevation.lat":"Latitude in decimal degrees, e.g. 39.5883. US coverage only (USGS).","elevation.lon":"Longitude in decimal degrees, negative in the western hemisphere, e.g. -105.6438.","earthquakes.min_magnitude":"Only return quakes at or above this magnitude.","earthquakes.limit":"Maximum number of quakes to return."};
function dkDescribe(ts) { try { for (const t of ts) { const p = ((t.inputSchema || {}).properties) || {}; for (const k of Object.keys(p)) { const d = DK_AD[t.name + "." + k] || DK_AD["*." + k]; if (d && p[k] && !p[k].description) p[k].description = d; } } } catch (e) {} return ts; }
const TOOLS = [
  {
    name: "geocode",
    description: "Convert a US street address into latitude/longitude coordinates (US Census geocoder). Use this first when you have an address but need coordinates for the weather/elevation tools. US addresses only.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "A US street address, e.g. '1600 Pennsylvania Ave NW, Washington DC'" } }, required: ["address"] },
  },
  {
    name: "weather_forecast",
    description: "Get a multi-day weather forecast for a US location by latitude/longitude (National Weather Service). Returns named periods (Today, Tonight, ...) with temperature, wind, and a short + detailed forecast. Use geocode first if you only have an address.",
    inputSchema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" }, hourly: { type: "boolean", description: "If true, return the hourly forecast instead of daily periods.", default: false } }, required: ["lat", "lon"] },
  },
  {
    name: "weather_current",
    description: "Get the latest observed weather conditions for a US location by latitude/longitude, from the nearest NWS observation station: temperature, humidity, wind, and text description.",
    inputSchema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
  },
  {
    name: "weather_alerts",
    description: "List active NWS weather alerts (warnings, watches, advisories) for a US state or marine area. Pass a two-letter state code like CA, TX, FL. Returns event type, severity, headline, affected area and expiry.",
    inputSchema: { type: "object", properties: { area: { type: "string", description: "Two-letter US state/territory code, e.g. CA, TX, FL, PR." } }, required: ["area"] },
  },
  {
    name: "earthquakes",
    description: "List recent earthquakes worldwide from the USGS feed. Filter by minimum magnitude, look-back window in days, and optionally a bounding box or a point+radius (km). Returns magnitude, place, time, depth and coordinates.",
    inputSchema: { type: "object", properties: {
      min_magnitude: { type: "number", default: 4.5 },
      days: { type: "integer", description: "Look back this many days (default 7, max 30).", default: 7 },
      lat: { type: "number", description: "Optional center latitude for a radius search." },
      lon: { type: "number", description: "Optional center longitude for a radius search." },
      radius_km: { type: "number", description: "Radius in km around lat/lon (requires lat+lon)." },
      limit: { type: "integer", default: 20 },
    }, required: [] },
  },
  {
    name: "elevation",
    description: "Get the ground elevation at a latitude/longitude within the US, from the USGS Elevation Point Query Service. Returns elevation in feet and meters.",
    inputSchema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
  },
];

async function runTool(name, args) {
  if (name === "geocode") {
    if (!args.address) return { error: "Provide a US 'address'." };
    const m = await censusGeocode(args.address);
    if (m && m._error) return { error: "The US Census geocoder is not answering right now (" + m._error + "). This is an upstream failure, NOT a statement that '" + args.address + "' is not a real address. Try again shortly." }; if (!m || !m.length) return { error: `No US address match for '${args.address}'. The Census geocoder matches street addresses, so include house number, street, city and state (a ZIP helps); it cannot match a city, landmark or place name on its own.` };
    return { query: args.address, matches: m, source: "US Census Bureau geocoder (public domain)" };
  }

  if (name === "weather_forecast" || name === "weather_current") {
    const lat = num(args.lat), lon = num(args.lon);
    if (lat == null || lon == null) return { error: "Provide numeric 'lat' and 'lon'. Use geocode for an address." };
    const pt = await nwsPoint(lat, lon);
    if (!pt) return { error: "No NWS data for that point. Coordinates must be within the US and its territories." };

    if (name === "weather_forecast") {
      const url = args.hourly ? pt.forecastHourly : pt.forecast;
      const d = await getJSON(url, { ttl: 900 });
      if (!d || d._error || !d.properties) return { error: "Forecast temporarily unavailable from NWS; try again shortly." };
      const periods = (d.properties.periods || []).slice(0, args.hourly ? 24 : 14).map((p) => ({
        name: p.name, start: p.startTime, is_daytime: p.isDaytime,
        temperature: `${p.temperature}°${p.temperatureUnit}`,
        wind: `${p.windSpeed} ${p.windDirection}`.trim(),
        short: p.shortForecast, detailed: p.detailedForecast || undefined,
        precip_prob: p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value != null ? `${p.probabilityOfPrecipitation.value}%` : undefined,
      }));
      return { location: pt.place, timezone: pt.tz, type: args.hourly ? "hourly" : "daily", periods, source: "NWS / NOAA (public domain)" };
    }

    // weather_current
    const st = await getJSON(pt.stations, { ttl: 86400 });
    const sid = st && st.features && st.features[0] && st.features[0].properties && st.features[0].properties.stationIdentifier;
    if (!sid) return { error: "No nearby NWS station for that point." };
    const obs = await getJSON(`https://api.weather.gov/stations/${sid}/observations/latest`, { ttl: 600 });
    if (!obs || obs._error || !obs.properties) return { error: "Current conditions temporarily unavailable from NWS." };
    const o = obs.properties;
    const c2f = (v) => (v == null ? null : Math.round((v * 9) / 5 + 32));
    const ms2mph = (v) => (v == null ? null : Math.round(v * 2.23694));
    const tC = o.temperature ? num(o.temperature.value) : null;
    const wS = o.windSpeed ? num(o.windSpeed.value) : null;
    return {
      location: pt.place, station: sid, observed: o.timestamp, description: o.textDescription,
      temperature: tC == null ? null : `${c2f(tC)}°F (${Math.round(tC)}°C)`,
      humidity: o.relativeHumidity && o.relativeHumidity.value != null ? `${Math.round(o.relativeHumidity.value)}%` : null,
      wind: wS == null ? null : `${ms2mph(wS)} mph`,
      source: "NWS / NOAA (public domain)",
    };
  }

  if (name === "weather_alerts") {
    const area = String(args.area || "").toUpperCase().trim();
    if (!/^[A-Z]{2}$/.test(area)) return { error: "Provide a two-letter US state/area code, e.g. CA, TX, FL." };
    const d = await getJSON(`https://api.weather.gov/alerts/active?area=${area}`, { ttl: 300 });
    if (!d || d._error || !Array.isArray(d.features)) return { error: "Alerts temporarily unavailable from NWS." };
    const alerts = d.features.slice(0, 25).map((f) => {
      const p = f.properties || {};
      return { event: p.event, severity: p.severity, urgency: p.urgency, headline: p.headline, area: p.areaDesc, effective: p.effective, expires: p.expires };
    });
    return { area, active_count: alerts.length, alerts, source: "NWS / NOAA (public domain)" };
  }

  if (name === "earthquakes") {
    const minmag = num(args.min_magnitude) != null ? num(args.min_magnitude) : 4.5;
    const days = Math.min(Math.max(parseInt(args.days || 7, 10), 1), 30);
    const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const limit = Math.min(Math.max(parseInt(args.limit || 20, 10), 1), 100);
    let u = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minmagnitude=${minmag}&limit=${limit}&orderby=time`;
    const lat = num(args.lat), lon = num(args.lon), rad = num(args.radius_km);
    if (lat != null && lon != null && rad != null) u += `&latitude=${lat}&longitude=${lon}&maxradiuskm=${rad}`;
    const d = await getJSON(u, { ttl: 300 });
    if (!d || d._error || !Array.isArray(d.features)) return { error: "USGS earthquake feed temporarily unavailable." };
    const quakes = d.features.map((f) => {
      const p = f.properties || {}, g = f.geometry || {};
      const c = g.coordinates || [];
      return { magnitude: p.mag, place: p.place, time: new Date(p.time).toISOString(), depth_km: c[2], lat: c[1], lon: c[0], tsunami: p.tsunami ? true : undefined, url: p.url };
    });
    return { count: quakes.length, criteria: { min_magnitude: minmag, days }, earthquakes: quakes, source: "USGS (public domain)" };
  }

  if (name === "elevation") {
    const lat = num(args.lat), lon = num(args.lon);
    if (lat == null || lon == null) return { error: "Provide numeric 'lat' and 'lon'." };
    const d = await getJSON(`https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&units=Meters&wkid=4326&includeDate=false`, { ttl: 86400 });
    if (!d || d._error) return { error: "The USGS Elevation Point Query Service is not answering right now (" + ((d && d._error) || "unreachable") + "). This is an upstream failure, NOT a statement that the point has no elevation data. Try again shortly." }; if (d.value == null || String(d.value).toLowerCase().indexOf("no data") >= 0) return { error: "USGS has no elevation value at that point. Coverage is the United States and its territories." };
    const m = num(d.value);
    return { lat, lon, elevation_m: m, elevation_ft: m == null ? null : Math.round(m * 3.28084), source: "USGS EPQS (public domain)" };
  }

  return { error: "unknown tool" };
}

/* --------------------------------------------------------------- MCP core */
function rpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcErr(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleMCP(request, env) {
  let body;
  try { body = await request.json(); } catch { return json(rpcErr(null, -32700, "Parse error")); }
  const { id, method, params } = body || {};
  console.log("DKPULSE " + (method || "?") + " " + ((params && params.name) || "-"));
  if (method === "initialize") {
    return json(rpc(id, {
      protocolVersion: dkProto(params), capabilities: { tools: {} }, serverInfo: SERVER,
      instructions: "Weather & Geo Intel: US weather forecasts, current conditions, active NWS alerts, recent earthquakes (USGS), ground elevation, and US address geocoding. Have an address? Call geocode first to get lat/lon, then the weather tools.",
    }));
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return new Response(null, { status: 202, headers: CORS });
  if (method === "ping") return json(rpc(id, {}));
  if (method === "tools/list") return json(rpc(id, { tools: dkDescribe(TOOLS) }));
  if (method === "tools/call") {
    const access = await dkGate(request, env);
    if (!access.ok) return json(rpc(id, { content: [{ type: "text", text: access.message }], isError: true }), 200, access.headers);
    const tname = params && params.name;
    const args = (params && params.arguments) || {};
    if (!TOOLS.find((t) => t.name === tname)) return json(rpcErr(id, -32602, `Unknown tool: ${tname}`)); { const _s = (TOOLS.find((t) => t.name === tname).inputSchema || {}).properties || {}; const _rq = ((TOOLS.find((t) => t.name === tname) || {}).inputSchema || {}).required || []; const _bad = Object.keys(args).filter((k) => !(k in _s)).map((k) => "unexpected '" + k + "'").concat(_rq.filter((k) => args[k] === undefined || args[k] === null || args[k] === "").map((k) => "missing required '" + k + "'")); if (_bad.length) return json(rpcErr(id, -32602, "Bad arguments for " + tname + ": " + _bad.join(", ") + ". Valid: " + (Object.keys(_s).join(", ") || "none") + ". The call was refused rather than ignoring them, because ignoring an argument returns a confident answer to a different question than the one asked.")); }
    try {
      const out = await runTool(tname, args);
      const meta = access.pro ? "" : `\n\n(${access.remaining} free calls left today)`;
      return json(rpc(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) + meta }], isError: !!(out && out.error) }), 200, access.headers);
    } catch (e) {
      return json(rpc(id, { content: [{ type: "text", text: "Error: " + (e && e.message || String(e)) }], isError: true }));
    }
  }
  return json(rpcErr(id, -32601, `Method not found: ${method}`));
}

/* ----------------------------------------------------------------- landing */
const CSS = `:root{--bg:#0b0e14;--panel:#111725;--border:#1e2636;--text:#e6edf3;--muted:#8b98a9;--accent:#4ade80;--accent2:#22d3ee}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.6}
a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1000px;margin:0 auto;padding:0 20px}
header{position:sticky;top:0;z-index:50;background:#0b0e14;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:18px;padding:12px 20px}
.logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:19px}.logo svg{display:block}
nav{display:flex;gap:16px;margin-left:auto;flex-wrap:wrap;font-size:14px}nav a{color:var(--muted)}nav a:hover{color:var(--text)}
.hero{padding:64px 0 32px}.hero h1{font-size:44px;line-height:1.1;margin:0 0 14px}.hero .accent{color:var(--accent)}
.sub{font-size:19px;color:var(--muted);max-width:640px}
.section{padding:28px 0;border-top:1px solid var(--border)}
.grid{display:grid;grid-template-columns:1fr;gap:16px}@media(min-width:760px){.grid{grid-template-columns:1fr 1fr}}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;min-width:0}
.card h3{margin:0 0 6px;font-size:16px}.card code{color:var(--accent);font-size:13px}.card p{margin:6px 0 0;color:var(--muted);font-size:14px}
.cmd{display:flex;align-items:center;gap:8px;background:#0a0d13;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:14px 0;overflow-x:auto}
.cmd code{font:13px/1.5 ui-monospace,Menlo,monospace;color:var(--text);white-space:nowrap}
.tiers{display:grid;grid-template-columns:1fr;gap:14px}@media(min-width:760px){.tiers{grid-template-columns:1fr 1fr 1fr}}
.tier{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px}.tier b{font-size:18px}.tier span{display:block;color:var(--muted);font-size:14px;margin-top:4px}
.btn{display:inline-block;background:var(--accent);color:#06210f;font-weight:700;padding:10px 18px;border-radius:8px;margin-top:8px}
footer{border-top:1px solid var(--border);padding:32px 20px;color:var(--muted);font-size:14px;text-align:center}`;
const MARK = `<svg width="26" height="26" viewBox="-34 -34 68 68" style="vertical-align:-4px"><g stroke="#4ade80" stroke-width="5" fill="none" stroke-linejoin="round"><polygon points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15"/></g><g fill="#4ade80"><circle cx="0" cy="-12" r="6"/><circle cx="-11" cy="8" r="6"/><circle cx="11" cy="8" r="6"/></g></svg>`;

function landing(host) {
  const ep = `https://${host}/mcp`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weather &amp; Geo Intel MCP — US weather & hazards for your AI agent | Datakoot</title>
<meta name="description" content="Keyless MCP server giving AI agents live US weather forecasts, current conditions, active NWS alerts, recent USGS earthquakes, elevation and address geocoding. No API keys.">
<style>${CSS}</style></head><body>
<header><a href="https://datakoot.com/" style="color:inherit"><div class="logo">${MARK}Data<span style="color:var(--accent)">koot</span></div></a>
<nav><a href="https://datakoot.com/">Datakoot</a><a href="#tools">Tools</a><a href="#start">Quick start</a><a href="#pricing">Pricing</a><a href="https://github.com/datakoot">GitHub</a></nav></header>
<div class="wrap">
<section class="hero"><h1>Give your agent a <span class="accent">window on the ground</span>.</h1>
<p class="sub">Weather &amp; Geo Intel serves live US forecasts, current conditions and active alerts from the National Weather Service, plus recent earthquakes and elevation from USGS and US address geocoding. All from keyless US-government feeds. No API keys.</p></section>
<section class="section" id="tools"><h2>Tools</h2><div class="grid">
<div class="card"><h3><code>geocode</code></h3><p>US address &rarr; latitude/longitude.</p></div>
<div class="card"><h3><code>weather_forecast</code></h3><p>Multi-day or hourly NWS forecast.</p></div>
<div class="card"><h3><code>weather_current</code></h3><p>Latest observed conditions.</p></div>
<div class="card"><h3><code>weather_alerts</code></h3><p>Active warnings by US state.</p></div>
<div class="card"><h3><code>earthquakes</code></h3><p>Recent quakes (USGS), by area.</p></div>
<div class="card"><h3><code>elevation</code></h3><p>Ground elevation at a point.</p></div>
</div></section>
<section class="section" id="start"><h2>Quick start</h2>
<p class="sub">One line, no key. Works with Claude, Cursor, and any MCP client.</p>
<div class="cmd"><code>claude mcp add --transport http weather-intel ${ep}</code></div>
<p style="color:var(--muted);font-size:14px">Or point any MCP client at <code>${ep}</code></p></section>
<section class="section" id="pricing"><h2>Pricing</h2><div class="tiers">
<div class="tier"><b>Free</b><span>100 calls / day</span><span>Every tool, no key.</span></div>
<div class="tier"><b>$15/mo · Pro</b><span>10,000 calls / month</span><span>1 seat · one key unlocks all nine Datakoot servers · then $5 per 1,000, capped at $100.</span><a class="btn" href="${CHECKOUT}">Upgrade</a></div>
<div class="tier"><b>$49/mo · Team</b><span>50,000 calls / month</span><span>Up to 5 seats · then $5 per 1,000.</span><a class="btn" href="${CHECKOUT}">Upgrade</a></div>
</div></section>
</div>
<footer><a href="https://datakoot.com/" style="color:inherit">Datakoot</a> — infrastructure for the agent economy · <a href="https://github.com/datakoot">GitHub</a> · Data: NWS/NOAA, USGS, US Census Bureau (all US public domain)</footer>
</body></html>`;
}

/* ------------------------------------------------------------------ router */
export default {
  async fetch(request, env) {
    if (DK_SALT === null) DK_SALT = env.IP_SALT || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname.endsWith("/.well-known/owners.json")) return json({ $schema: "https://verifymcp.io/schemas/owners.json", owners: ["hello@datakoot.com"] });
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      if (request.method === "POST") return handleMCP(request, env);
      return json({ error: "POST JSON-RPC to this endpoint (MCP streamable HTTP)" }, 405);
    }
    if (url.pathname === "/health") return json({ ok: true, server: SERVER });
    if (url.pathname === "/" || url.pathname === "") return new Response(landing(url.host), { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
    return new Response("Not found", { status: 404, headers: CORS });
  },
};


/* ==================== Datakoot call metering (D1) =========================
 * Supersedes the older KV gate above, which is now unused.
 *
 * KV caches reads at the edge and is eventually consistent, so a
 * read-modify-write counter loses increments under any real concurrency —
 * measured against production on 2026-08-29: seven consecutive calls moved
 * the counter by three, and once moved it backwards. D1 does the read, the
 * increment and the return in ONE statement inside ONE transaction, so no
 * increment can be lost. Proven on security-intel in production the same day:
 * 731 calls fired, 731 counted, and every call past 100 refused — no leaks,
 * no false refusals.
 *
 * Binding QUOTA_DB -> database "datakoot-quota", table:
 *   quota(k TEXT PRIMARY KEY, period TEXT NOT NULL,
 *         n INTEGER NOT NULL, updated INTEGER NOT NULL DEFAULT 0)
 * One row per caller, reused across periods, so the table grows with the
 * number of distinct callers rather than with time.
 *
 * dkGate() returns { allowed, ok, pro, remaining, limit, message, headers, meta }.
 * `ok` mirrors `allowed`; `pro` is true whenever the call is not metered against
 * the free allowance, so a caller-facing meter line reads correctly either way.
 * ========================================================================= */
const DK_FREE_LIMIT = 100;        // anonymous, keyless, per UTC day
const DK_PRO_INCLUDED = 10000;    // calls included in Pro each month
const DK_OVERAGE_PER = 1000;      // then $5 per 1,000
const DK_CHECKOUT = "https://buy.polar.sh/polar_cl_Q9y3qLrNbtsssN3w5m8SK56oNcruwrmxLEPnd34oAZf";
const DK_POLAR_ORG = "7f455043-0b15-4a1c-b7a0-9c06c9f3b95e";
const DK_BUMP_SQL =
  "INSERT INTO quota (k, period, n, updated) VALUES (?1, ?2, 1, ?3) " +
  "ON CONFLICT(k) DO UPDATE SET " +
  "n = CASE WHEN quota.period = excluded.period THEN quota.n + 1 ELSE 1 END, " +
  "period = excluded.period, updated = excluded.updated RETURNING n";

async function dkBump(env, k, period) {
  const row = await env.QUOTA_DB.prepare(DK_BUMP_SQL).bind(k, period, Math.floor(Date.now() / 1000)).first();
  const n = row && row.n;
  if (typeof n !== "number") throw new Error("quota: no row returned");
    await dkDaily(env, k, period);
  return n;
}

/* Identify a caller without storing an identity.
 *
 * This is an HMAC, not a plain hash, and the key is a 256-bit secret held only
 * in the Worker's environment (IP_SALT). That distinction matters: a plain
 * SHA-256 of an IPv4 address is reversible by anyone who has the code, because
 * there are only 4.3 billion addresses to try. Keyed, it is not reversible
 * without the secret — which is never stored beside the data it protects.
 *
 * If IP_SALT is ever unset the function still works, unkeyed, so a missing
 * secret degrades privacy rather than taking the service down.
 */
let DK_SALT = null, DK_KEY = null;
async function dkMacKey() {
  if (!DK_KEY) {
    DK_KEY = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(DK_SALT || "dk1-unsalted"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  return DK_KEY;
}
async function dkSha96(s) {
  const b = await crypto.subtle.sign("HMAC", await dkMacKey(), new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* Headers so a developer can watch the meter instead of guessing. */
function dkHeaders(limit, remaining) {
  if (limit == null) return {};
  const t = new Date();
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining == null ? limit : remaining),
    "X-RateLimit-Reset": String(Math.floor(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1) / 1000)),
  };
}

/* Unmetered: a valid Pro key, or metering that could not run. Never blocked. */
const DK_OPEN = { allowed: true, ok: true, pro: true, remaining: null, limit: null, message: "", headers: {}, meta: "" };

async function dkGate(request, env) {
  let key = (request.headers.get("Authorization") || "").trim();
  if (key.toLowerCase().indexOf("bearer ") === 0) key = key.slice(7).trim();
  if (!key) key = (request.headers.get("X-Datakoot-Key") || "").trim();

  if (key) {
    let pro = false;
    if (env.RL) { try { if ((await env.RL.get("pk:" + (await dkSha96("dk1:" + key)))) === "1") pro = true; } catch (e) {} }
    if (!pro) {
      try {
        const vr = await fetch("https://api.polar.sh/v1/customer-portal/license-keys/validate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, organization_id: DK_POLAR_ORG }),
        });
        if (vr.ok) { const _pd = await vr.json().catch(() => null); pro = !!(_pd && (!("status" in _pd) || _pd.status === "granted")); if (pro && env.RL) { try { await env.RL.put("pk:" + (await dkSha96("dk1:" + key)), "1", { expirationTtl: 3600 }); } catch (e) {} } }
      } catch (e) { /* Polar unreachable: fall through to the invalid-key branch */ }
    }
    if (!pro) {
      // A key that does not validate used to fall silently back to the free
      // tier, so a paying customer with a typo looked throttled for no reason.
      return { allowed: false, ok: false, pro: false, remaining: 0, limit: DK_FREE_LIMIT, meta: "",
        headers: dkHeaders(DK_FREE_LIMIT, 0),
        message: "That Datakoot API key was not recognised. Check it at https://datakoot.com/pricing, or remove the Authorization header to use the free tier (" + DK_FREE_LIMIT + " calls/day, no signup)." };
    }
    // Pro is metered but never blocked: overage is billed, not refused.
    if (env.QUOTA_DB) {
      try { await dkBump(env, "pro:" + (await dkSha96("dk1:" + key)), new Date().toISOString().slice(0, 7)); }
      catch (e) { console.error("QUOTA error (pro):", e && e.message); }
    }
    return DK_OPEN;
  }

  if (!env.QUOTA_DB) {
    // Fail OPEN so a misconfiguration never takes the API down — but say so.
    console.error("DATAKOOT METERING DISABLED: env.QUOTA_DB is not bound");
    return DK_OPEN;
  }
  let n;
  try {
    n = await dkBump(env, "ip:" + (await dkSha96("dk1:" + (request.headers.get("CF-Connecting-IP") || "anon"))), new Date().toISOString().slice(0, 10));
  } catch (e) {
    console.error("DATAKOOT METERING ERROR, failing open:", e && e.message);
    return DK_OPEN;
  }
  // The Nth call writes n = N, so call DK_FREE_LIMIT is the last one allowed
  // and call DK_FREE_LIMIT + 1 is the first one refused.
  if (n > DK_FREE_LIMIT) {
    return { allowed: false, ok: false, pro: false, remaining: 0, limit: DK_FREE_LIMIT, meta: "",
      headers: dkHeaders(DK_FREE_LIMIT, 0),
      message: "Daily free limit reached (" + DK_FREE_LIMIT + " calls). It resets at 00:00 UTC. Datakoot Pro includes " + DK_PRO_INCLUDED.toLocaleString() + " calls a month across all nine servers for $15, then $5 per " + DK_OVERAGE_PER.toLocaleString() + " — " + DK_CHECKOUT };
  }
  const left = DK_FREE_LIMIT - n;
  return { allowed: true, ok: true, pro: false, remaining: left, limit: DK_FREE_LIMIT, message: "",
    headers: dkHeaders(DK_FREE_LIMIT, left), meta: "\n\n(" + left + " free calls left today)" };
}

/* MCP protocol negotiation.
 *
 * Echo back the version the client asked for when we speak it, otherwise answer
 * with the newest one we do. These servers answered a hardcoded "2024-11-05" to
 * every client, which meant no client could rely on structuredContent or
 * outputSchema — both introduced in 2025-06-18. Same list and same behaviour as
 * base-intel and domain-intel, which already did this correctly.
 */
const DK_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
function dkProto(params) {
  const want = params && params.protocolVersion;
  return DK_PROTOCOL_VERSIONS.indexOf(want) !== -1 ? want : DK_PROTOCOL_VERSIONS[0];
}

/* Retention analytics.
 *
 * `quota` keeps ONE row per caller and overwrites it when the day rolls over,
 * so it can only ever show a caller's most recent active day. That makes the
 * most valuable question — did anyone come back tomorrow? — structurally
 * unanswerable. `daily` keeps one row per caller PER DAY instead.
 *
 * It stores exactly what `quota` stores: the same keyed, non-reversible caller
 * identifier, a date, a count. No queries, no addresses, nothing new about
 * anyone. The 04:17 retention job prunes it on the same 90-day clock, so the
 * privacy policy stays true.
 *
 * Wrapped so it can never break a caller's request: if this write fails the
 * call still succeeds and metering is unaffected. It is analytics, not billing.
 */
const DK_DAILY_SQL =
  "INSERT INTO daily (k, period, n, updated) VALUES (?1, ?2, 1, ?3) " +
  "ON CONFLICT(k, period) DO UPDATE SET n = daily.n + 1, updated = excluded.updated";
async function dkDaily(env, k, period) {
  try {
    await env.QUOTA_DB.prepare(DK_DAILY_SQL)
      .bind(k, period, Math.floor(Date.now() / 1000)).run();
  } catch (e) { /* never let analytics break a paying or free call */ }
}