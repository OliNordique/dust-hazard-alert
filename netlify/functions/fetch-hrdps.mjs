/**
 * fetch-hrdps.mjs
 * GitHub Actions scheduled job — runs 4x/day after each HRDPS run
 * Scrapes GeoMet WCS HRDPS-WEonG 2.5km layers for wind, humidity, precip
 * Stores each reading in Supabase table: weather_readings
 *
 * Confirmed working layers (2026-05):
 *   HRDPS-WEonG_2.5km_WindSpeed   → wind speed [m/s]
 *   HRDPS-WEonG_2.5km_WindDir     → wind direction [°]
 *   HRDPS-WEonG_2.5km_DewPointTemp → dew point [°C]
 *   HRDPS-WEonG_2.5km_AirTemp     → air temp [°C] (for RH calc)
 *   HRDPS-WEonG_2.5km_Precip-Prob → precip probability [%]
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const SITE_LAT     = parseFloat(process.env.SITE_LAT || "54.805");
const SITE_LON     = parseFloat(process.env.SITE_LON || "-66.82");

const GEOMET = "https://geo.weather.gc.ca/geomet";
const DELTA  = 0.03;

const LAYERS = {
  WSPD: "HRDPS-WEonG_2.5km_WindSpeed",
  WDIR: "HRDPS-WEonG_2.5km_WindDir",
  DWPT: "HRDPS-WEonG_2.5km_DewPointTemp",
  TAIR: "HRDPS-WEonG_2.5km_AirTemp",
  PPRB: "HRDPS-WEonG_2.5km_Precip-Prob",
};

function parseSinglePixelGeoTiff(buffer) {
  const view = new DataView(buffer);
  const le = view.getUint16(0) === 0x4949;
  const ifdOffset = view.getUint32(4, le);
  const entryCount = view.getUint16(ifdOffset, le);
  let bps = 32, sf = 3, stripOffset = null, w = null, h = null;
  for (let i = 0; i < entryCount; i++) {
    const base = ifdOffset + 2 + i * 12;
    const tag  = view.getUint16(base, le);
    if (tag === 256) w           = view.getUint32(base + 8, le);
    if (tag === 257) h           = view.getUint32(base + 8, le);
    if (tag === 258) bps         = view.getUint16(base + 8, le);
    if (tag === 273) stripOffset = view.getUint32(base + 8, le);
    if (tag === 339) sf          = view.getUint16(base + 8, le);
  }
  if (stripOffset === null) throw new Error("GeoTIFF: no StripOffsets tag");
  const pixelSize = bps === 64 ? 8 : 4;
  const totalPixels = (w || 1) * (h || 1);
  const centerIdx = Math.floor(totalPixels / 2);
  const offset = stripOffset + centerIdx * pixelSize;
  if (bps === 64 && sf === 3) return view.getFloat64(offset, le);
  return view.getFloat32(offset, le);
}

async function fetchLayer(layerId) {
  const url = [
    `${GEOMET}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage`,
    `&COVERAGEID=${layerId}`,
    `&SUBSETTINGCRS=EPSG:4326`,
    `&SUBSET=x(${SITE_LON - DELTA},${SITE_LON + DELTA})`,
    `&SUBSET=y(${SITE_LAT - DELTA},${SITE_LAT + DELTA})`,
    `&FORMAT=image/tiff`,
  ].join("");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GeoMet ${layerId} HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const first = new Uint8Array(buffer, 0, 1);
  if (first[0] === 60) {
    const text = new TextDecoder().decode(buffer.slice(0, 200));
    throw new Error(`XML error: ${text}`);
  }
  return parseSinglePixelGeoTiff(buffer);
}

function dewPointToRH(tempC, dewPointC) {
  const a = 17.625, b = 243.04;
  const rh = 100 * Math.exp((a * dewPointC) / (b + dewPointC)) /
                   Math.exp((a * tempC) / (b + tempC));
  return Math.min(100, Math.max(0, Math.round(rh)));
}

async function fetchOpenMeteoFallback() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${SITE_LAT}&longitude=${SITE_LON}&hourly=windspeed_10m,winddirection_10m,relativehumidity_2m,precipitation&windspeed_unit=ms&past_days=0&forecast_days=1&timezone=UTC`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  const now = Date.now();
  let idx = 0, minDiff = Infinity;
  data.hourly.time.forEach((t, i) => {
    const diff = Math.abs(new Date(t + 'Z').getTime() - now);
    if (diff < minDiff) { minDiff = diff; idx = i; }
  });
  return {
    source: "open-meteo-fallback", timestamp: new Date().toISOString(),
    lat: SITE_LAT, lon: SITE_LON,
    wind_speed_ms:   data.hourly.windspeed_10m[idx],
    wind_speed_kmh:  Math.round(data.hourly.windspeed_10m[idx] * 3.6 * 10) / 10,
    wind_dir_deg:    data.hourly.winddirection_10m[idx],
    humidity_pct:    data.hourly.relativehumidity_2m[idx],
    precip_prob_pct: null, dew_point_c: null, air_temp_c: null,
  };
}

async function main() {
  console.log(`[fetch-hrdps] Starting at ${new Date().toISOString()}`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  let reading;
  try {
    const [wspd, wdir, dwpt, tair, pprb] = await Promise.all([
      fetchLayer(LAYERS.WSPD), fetchLayer(LAYERS.WDIR),
      fetchLayer(LAYERS.DWPT), fetchLayer(LAYERS.TAIR), fetchLayer(LAYERS.PPRB),
    ]);
    const windSpeedKmh = Math.round(wspd * 3.6 * 10) / 10;
    const humidity = dewPointToRH(tair, dwpt);
    console.log(`[fetch-hrdps] HRDPS OK — Wind: ${windSpeedKmh}km/h ${Math.round(wdir)}° | RH: ${humidity}% | PrecipProb: ${Math.round(pprb)}%`);
    reading = {
      source: "hrdps-weong-2.5km", timestamp: new Date().toISOString(),
      lat: SITE_LAT, lon: SITE_LON,
      wind_speed_ms:   Math.round(wspd * 100) / 100,
      wind_speed_kmh:  windSpeedKmh,
      wind_dir_deg:    Math.round(wdir),
      humidity_pct:    humidity,
      precip_prob_pct: Math.round(pprb),
      dew_point_c:     Math.round(dwpt * 10) / 10,
      air_temp_c:      Math.round(tair * 10) / 10,
    };
  } catch (e) {
    console.warn(`[fetch-hrdps] HRDPS failed: ${e.message} — using fallback`);
    try {
      reading = await fetchOpenMeteoFallback();
    } catch (e2) {
      console.error(`[fetch-hrdps] Both failed: ${e2.message}`);
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
