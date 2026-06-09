const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;
const AEMET_KEY = process.env.AEMET_API_KEY;

app.use(cors());

/* ─────────────────────────────────────────
   Caché de municipios (se carga una vez)
───────────────────────────────────────── */
let municipiosCache = null;

async function getMunicipios() {
  if (municipiosCache) return municipiosCache;
  const r1 = await fetch(`https://opendata.aemet.es/opendata/api/maestro/municipios/?api_key=${AEMET_KEY}`);
  const j1 = await r1.json();
  const r2 = await fetch(j1.datos);
  municipiosCache = await r2.json();
  return municipiosCache;
}

/* ─────────────────────────────────────────
   Caché de predicciones (10 minutos por municipio)
───────────────────────────────────────── */
const weatherCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos en ms

function getCached(key) {
  const entry = weatherCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { weatherCache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  weatherCache.set(key, { ts: Date.now(), data });
}

/* ─────────────────────────────────────────
   Haversine: distancia en km
───────────────────────────────────────── */
function haversine(lat1, lon1, lat2, lon2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dL/2)**2 +
             Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ─────────────────────────────────────────
   Municipio más cercano a lat/lon
───────────────────────────────────────── */
function municipioCercano(municipios, lat, lon) {
  let mejor = null, distMin = Infinity;
  for (const m of municipios) {
    const mLat = parseFloat(m.latitud_dec);
    const mLon = parseFloat(m.longitud_dec);
    if (isNaN(mLat) || isNaN(mLon)) continue;
    const d = haversine(lat, lon, mLat, mLon);
    if (d < distMin) { distMin = d; mejor = m; }
  }
  return mejor;
}

/* ─────────────────────────────────────────
   Traducción estado_cielo AEMET → WMO
───────────────────────────────────────── */
function estadoToWMO(valor) {
  const v = parseInt(valor);
  if (v === 11)                            return 0;  // Despejado
  if (v >= 12 && v <= 14)                  return 1;  // Poco nublado
  if (v >= 15 && v <= 16)                  return 2;  // Intervalos nubosos
  if (v === 17 || v === 23 || v === 24)    return 3;  // Nublado
  if (v === 43 || v === 44)                return 45; // Niebla
  if (v >= 51 && v <= 53)                  return 61; // Lluvia ligera
  if (v >= 54 && v <= 56)                  return 63; // Lluvia moderada
  if (v >= 60 && v <= 62)                  return 80; // Chubascos
  if (v >= 71 && v <= 73)                  return 71; // Nevada
  if (v >= 80 && v <= 82)                  return 95; // Tormenta
  return 0;
}

/* ─────────────────────────────────────────
   Endpoint principal: GET /weather?lat=XX&lon=YY
───────────────────────────────────────── */
app.get('/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'Parámetros lat y lon requeridos' });
  }

  try {
    // 1. Municipio más cercano
    const municipios = await getMunicipios();
    const muni       = municipioCercano(municipios, lat, lon);
    if (!muni) return res.status(500).json({ error: 'No se encontró municipio' });

    const codMunicipio = muni.id.replace('id', '');

    // 2. Comprobar caché antes de llamar a AEMET
    const cached = getCached(codMunicipio);
    if (cached) {
      console.log(`[cache] ${muni.nombre} (${codMunicipio})`);
      return res.json(cached);
    }

    // 3. Predicción diaria del municipio (doble llamada AEMET)
    console.log(`[aemet] ${muni.nombre} (${codMunicipio})`);
    const p1  = await fetch(
      `https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/diaria/${codMunicipio}/?api_key=${AEMET_KEY}`
    );
    const pj1 = await p1.json();
    if (!pj1.datos) return res.status(500).json({ error: 'AEMET no devolvió datos', detalle: pj1 });

    const p2  = await fetch(pj1.datos);
    const pj2 = await p2.json();

    const pred = pj2[0]?.prediccion?.dia;
    if (!pred || pred.length === 0) {
      return res.status(500).json({ error: 'Sin datos de predicción' });
    }

    // 4. Extraer datos
    const hoy  = pred[0];
    const hora = new Date().getHours();

    let tempActual = null;
    if (hoy.temperatura?.dato) {
      let mejorDiff = Infinity;
      for (const d of hoy.temperatura.dato) {
        const diff = Math.abs(parseInt(d.hora) - hora);
        if (diff < mejorDiff) { mejorDiff = diff; tempActual = d.value; }
      }
    }
    if (tempActual === null) {
      const mx = parseFloat(hoy.temperatura?.maxima);
      const mn = parseFloat(hoy.temperatura?.minima);
      tempActual = isNaN(mx) || isNaN(mn) ? null : Math.round((mx + mn) / 2);
    }

    let estadoActual = '11';
    if (hoy.estadoCielo) {
      let mejorDiff = Infinity;
      for (const d of hoy.estadoCielo) {
        if (!d.value || d.value === '') continue;
        const diff = Math.abs(parseInt(d.periodo || d.hora || 0) - hora);
        if (diff < mejorDiff) { mejorDiff = diff; estadoActual = d.value; }
      }
    }

    const esNoche = hora < 7 || hora >= 21;

    const forecast = [];
    for (let i = 1; i <= 3; i++) {
      const dia = pred[i];
      if (!dia) break;
      let estado = '11';
      if (dia.estadoCielo && dia.estadoCielo.length > 0) {
        const medio = dia.estadoCielo.find(d => d.periodo === '1218' || d.periodo === '0018');
        estado = medio?.value || dia.estadoCielo[0]?.value || '11';
      }
      forecast.push({
        tempMax: parseFloat(dia.temperatura?.maxima) || null,
        tempMin: parseFloat(dia.temperatura?.minima) || null,
        code:    estadoToWMO(estado),
      });
    }

    // 5. Construir respuesta y guardar en caché
    const result = {
      city:    muni.nombre,
      temp:    tempActual,
      tempMax: parseFloat(hoy.temperatura?.maxima) || null,
      tempMin: parseFloat(hoy.temperatura?.minima) || null,
      code:    estadoToWMO(estadoActual),
      isNight: esNoche,
      forecast,
    };

    setCache(codMunicipio, result);
    res.json(result);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno', detalle: err.message });
  }
});

/* ─────────────────────────────────────────
   Health check
───────────────────────────────────────── */
app.get('/', (req, res) => res.json({ status: 'ok', service: 'aemet-proxy', cached: weatherCache.size }));

app.listen(PORT, () => console.log(`aemet-proxy escuchando en puerto ${PORT}`));
