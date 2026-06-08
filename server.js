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

  // 1ª llamada: AEMET devuelve una URL de descarga
  const r1   = await fetch(`https://opendata.aemet.es/opendata/api/maestro/municipios/?api_key=${AEMET_KEY}`);
  const j1   = await r1.json();
  // 2ª llamada: descargamos los datos reales
  const r2   = await fetch(j1.datos);
  municipiosCache = await r2.json();
  return municipiosCache;
}

/* ─────────────────────────────────────────
   Haversine: distancia en km entre dos puntos
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
   Traducción estado_cielo AEMET → WMO aprox.
   (para reutilizar los iconos del widget)
───────────────────────────────────────── */
function estadoToWMO(valor) {
  const v = parseInt(valor);
  // https://www.aemet.es/es/eltiempo/prediccion/espana/ayuda
  if (v === 11 || v === 11n)           return 0;  // Despejado
  if (v >= 12 && v <= 14)              return 1;  // Poco nublado
  if (v >= 15 && v <= 16)              return 2;  // Intervalos nubosos
  if (v === 17 || v === 23 || v === 24) return 3; // Nublado
  if (v === 43 || v === 44)            return 45; // Niebla
  if (v >= 51 && v <= 53)              return 61; // Lluvia ligera
  if (v >= 54 && v <= 56)              return 63; // Lluvia moderada
  if (v >= 60 && v <= 62)              return 80; // Chubascos
  if (v >= 71 && v <= 73)              return 71; // Nevada
  if (v >= 80 && v <= 82)              return 95; // Tormenta
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

    const codMunicipio = muni.id.replace('id', ''); // e.g. "id28092" → "28092"

    // 2. Predicción diaria del municipio (doble llamada AEMET)
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

    // 3. Extraer datos del día de hoy (índice 0) y los 3 siguientes
    const hoy  = pred[0];
    const hora = new Date().getHours();

    // Temperatura actual: buscamos el periodo horario más cercano
    let tempActual = null;
    if (hoy.temperatura?.dato) {
      const datos = hoy.temperatura.dato;
      // Buscar el dato cuya hora sea la más próxima a la actual
      let mejorDiff = Infinity;
      for (const d of datos) {
        const diff = Math.abs(parseInt(d.hora) - hora);
        if (diff < mejorDiff) { mejorDiff = diff; tempActual = d.value; }
      }
    }
    // Fallback a media de max+min
    if (tempActual === null) {
      const mx = parseFloat(hoy.temperatura?.maxima);
      const mn = parseFloat(hoy.temperatura?.minima);
      tempActual = isNaN(mx) || isNaN(mn) ? null : (mx + mn) / 2;
    }

    // Estado cielo actual (periodo más cercano a la hora actual)
    let estadoActual = '11'; // despejado por defecto
    if (hoy.estadoCielo) {
      const datos = hoy.estadoCielo;
      let mejorDiff = Infinity;
      for (const d of datos) {
        if (!d.value || d.value === '') continue;
        const diff = Math.abs(parseInt(d.periodo || d.hora || 0) - hora);
        if (diff < mejorDiff) { mejorDiff = diff; estadoActual = d.value; }
      }
    }

    const esNoche = hora < 7 || hora >= 21;

    // Previsión 3 días siguientes
    const forecast = [];
    for (let i = 1; i <= 3; i++) {
      const dia = pred[i];
      if (!dia) break;
      // Estado cielo: tomar el valor del mediodía (periodo 1300 o similar)
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

    // 4. Respuesta limpia
    res.json({
      city:    muni.nombre,
      temp:    tempActual,
      tempMax: parseFloat(hoy.temperatura?.maxima) || null,
      tempMin: parseFloat(hoy.temperatura?.minima) || null,
      code:    estadoToWMO(estadoActual),
      isNight: esNoche,
      forecast,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno', detalle: err.message });
  }
});

/* ─────────────────────────────────────────
   Health check
───────────────────────────────────────── */
app.get('/', (req, res) => res.json({ status: 'ok', service: 'aemet-proxy' }));

app.listen(PORT, () => console.log(`aemet-proxy escuchando en puerto ${PORT}`));
