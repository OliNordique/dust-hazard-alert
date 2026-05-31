/**
 * fetch-hrdps.mjs
 * GitHub Actions scheduled job — runs 4x/day after each HRDPS run
 * Scrapes GeoMet WCS for wind, humidity, precip at the configured site location
 * Stores each reading in Supabase table: weather_readings
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const SITE_LAT     = parseFloat(process.env.SITE_LAT || "54.805");
const SITE_LON     = parseFloat(process.env.SITE_LON || "-66.82");

const GEOMET = "https://geo.weather.gc.ca/geomet";

const LAYERS = {
  UU: "HRDPS.CONTINENTAL_UU",
  VV: "HRDPS.CONTINENTAL_VV",
  HR: "HRDPS.CONTINENTAL_HR",
  PR: "HRDPS.CONTINENTAL_PR",
  NT: "HRDPS.CONTINENTAL_NT",
};

async function fetchLayer(layerId) {
  const delta = 0.02;
  const url = [
    `${GEOMET}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage`,
    `&COVERAGEID=${layerId}`,
    `&SUBSETTINGCRS=EPSG:4326`,
    `&SUBSET=x(${SITE_LON - delta},${SITE_LON + delta})`,
    `&SUBSET=y(${SITE_LAT - delta},${SITE_LAT + delta})`,
    `&FORMAT=image/tiff`,
  ].join("");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GeoMet ${layerId} HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  return parseSinglePixelGeoTiff(buffer);
}

function parseSinglePixelGeoTiff(buffer) {
  const view = new DataView(buffer);
  const byteOrder = view.getUint16(0);
  const le = byteOrder === 0x4949;
  const ifdOffset = view.getUint32(4, le);
  const entryCount = view.getUint16(ifdOffset, le);
  let bitsPerSample = 32, sampleFormat = 3, stripOffset = null;
  for (let i = 0; i < entryCount; i++) {
    const base = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(base, le);
    if (tag === 258) bitsPerSample = view.getUint16(base + 8, le);
    if (tag === 339) sampleFormat  = view.getUint16(base + 8, le);
    if (tag === 273) stripOffset   = view.getUint32(base + 8, le);
  }
  if (stripOffset === null) throw new Error("GeoTIFF: no StripOffsets tag");
  if (bitsPerSample === 64 && sampleFormat === 3) return view.getFloat64(stripOffset, le);
  return view.getFloat32(stripOffset, le);
}

function uvToWindSpeedDir(u, v) {
  const speedKmh = Math.sqrt(u * u + v * v) * 3.6;
  let dirDeg = Math.atan2(-u, -v) * (180 / Math.PI);
  if (dirDeg < 0) dirDeg += 360;
  return { speedKmh, dirDeg };
}

async function fetchOpenMeteoFallback() {
  const url = [
    `https://api.open-meteo.com/v1/forecast`,
    `?latitude=${SITE_LAT}&longitude=${SITE_LON}`,
    `&hourly=windspeed_10m,winddirection_10m,relativehumidity_2m,precipitation`,
    `&windspeed_unit=kmh&past_days=7&forecast_days=1&timezone=UTC`,
  ].join("");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  const idx = data.hourly.time.length - 1;
  return {
    source: "open-meteo-fallback",
    timestamp: data.hourly.time[idx],
    wind_speed_kmh: data.hourly.windspeed_10m[idx],
    wind_dir_deg:   data.hourly.winddirection_10m[idx],
    humidity_pct:   data.hourly.relativehumidity_2m[idx],
    precip_mm_h:    data.hourly.precipitation[idx],
    snow_depth_m: null, u_ms: null, v_ms: null,
  };
}

async function main() {
  console.log(`[fetch-hrdps] Starting at ${new Date().toISOString()}`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  let reading;

  try {
    const [u, v, hr, pr, nt] = await Promise.all([
      fetchLayer(LAYERS.UU), fetchLayer(LAYERS.VV), fetchLayer(LAYERS.HR),
      fetchLayer(LAYERS.PR), fetchLayer(LAYERS.NT),
    ]);
    const { speedKmh, dirDeg } = uvToWindSpeedDir(u, v);
    reading = {
      source: "hrdps", timestamp: new Date().toISOString(),
      lat: SITE_LAT, lon: SITE_LON,
      wind_speed_kmh: Math.round(speedKmh * 10) / 10,
      wind_dir_deg:   Math.round(dirDeg),
      humidity_pct:   Math.round(hr),
      precip_mm_h:    Math.round(pr * 3600 * 100) / 100,
      snow_depth_m:   Math.round(nt * 1000) / 1000,
      u_ms: Math.round(u * 100) / 100,
      v_ms: Math.round(v * 100) / 100,
    };
    console.log("[fetch-hrdps] HRDPS OK:", reading);
  } catch (e) {
    console.warn("[fetch-hrdps] HRDPS failed, fallback:", e.message);
    try {
      reading = await fetchOpenMeteoFallback();
      reading.lat = SITE_LAT; reading.lon = SITE_LON;
      console.log("[fetch-hrdps] Fallback OK:", reading);
    } catch (e2) {
      console.error("[fetch-hrdps] Both failed:", e2.message);
      process.exit(1);
    }
  }

  const { error } = await supabase.from("weather_readings").insert([reading]);
  if (error) { console.error("[fetch-hrdps] Supabase error:", error); process.exit(1); }

  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("weather_readings").delete().lt("timestamp", cutoff);

  console.log("[fetch-hrdps] Done.");
}

main();
