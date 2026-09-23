require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

app.use(express.json());
app.use(express.static(__dirname));

// ---------- Stockage utilisateur (Upstash Redis) ----------
async function redisCmd(parts) {
  const r = await fetch(`${REDIS_URL}/${parts.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!r.ok) throw new Error('Erreur Redis: ' + (await r.text()));
  const data = await r.json();
  return data.result;
}
async function kvGet(key) {
  const raw = await redisCmd(['get', key]);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function kvSet(key, value) {
  await redisCmd(['set', key, JSON.stringify(value)]);
}

function sanitizePseudo(raw) {
  return (raw || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

function requireRedis(req, res, next) {
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Stockage non configuré sur le serveur.' });
  next();
}

app.post('/api/login', requireRedis, (req, res) => {
  const pseudo = sanitizePseudo(req.body && req.body.pseudo);
  if (!pseudo) return res.status(400).json({ error: 'Pseudo invalide.' });
  res.json({ pseudo });
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function keyFor(pseudo, key) {
  if (key === 'profile') return `u:${pseudo}:profile`;
  const m = /^day:(\d{4}-\d{2}-\d{2})$/.exec(key);
  if (m) return `u:${pseudo}:day:${m[1]}`;
  return null;
}

app.get('/api/kv/:pseudo/:key', requireRedis, async (req, res) => {
  const pseudo = sanitizePseudo(req.params.pseudo);
  const redisKey = keyFor(pseudo, req.params.key);
  if (!pseudo || !redisKey) return res.status(400).json({ error: 'Requête invalide.' });
  try {
    const value = await kvGet(redisKey);
    res.json({ value });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur de lecture.' });
  }
});

app.put('/api/kv/:pseudo/:key', requireRedis, async (req, res) => {
  const pseudo = sanitizePseudo(req.params.pseudo);
  const redisKey = keyFor(pseudo, req.params.key);
  if (!pseudo || !redisKey) return res.status(400).json({ error: 'Requête invalide.' });
  try {
    await kvSet(redisKey, req.body ? req.body.value : null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur d\'écriture.' });
  }
});

app.get('/api/week/:pseudo/:end', requireRedis, async (req, res) => {
  const pseudo = sanitizePseudo(req.params.pseudo);
  const end = req.params.end;
  if (!pseudo || !DATE_RE.test(end)) return res.status(400).json({ error: 'Requête invalide.' });
  try {
    const endDate = new Date(end + 'T00:00:00Z');
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(endDate);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const values = await Promise.all(dates.map(d => kvGet(`u:${pseudo}:day:${d}`)));
    const out = {};
    dates.forEach((d, i) => { if (values[i]) out[d] = values[i]; });
    res.json({ days: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur de lecture.' });
  }
});

async function callGemini(body) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (r.ok) return r;
    lastErr = await r.text();
    if (r.status !== 503) break;
    await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
  }
  console.error('Gemini API error:', lastErr);
  return null;
}

app.post('/api/estimate-kcal', async (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom du plat manquant.' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Clé API non configurée sur le serveur.' });

  const prompt = `Tu es un nutritionniste. Donne une estimation du nombre de calories (kcal) pour une portion normale de : "${name}". Réponds UNIQUEMENT avec un nombre entier, sans texte ni unité.`;

  try {
    const r = await callGemini({ contents: [{ parts: [{ text: prompt }] }] });
    if (!r) return res.status(502).json({ error: 'Erreur lors de l\'appel à l\'IA.' });

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const kcal = parseInt(text.replace(/[^\d]/g, ''), 10);

    if (!Number.isFinite(kcal) || kcal <= 0) {
      return res.status(502).json({ error: 'Réponse IA invalide.' });
    }

    res.json({ kcal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

const ACTIVITY_TYPES = ['pas', 'course', 'salle', 'marche', 'velo', 'natation', 'autre'];
const MOMENTS = ['Petit-déj', 'Déjeuner', 'Dîner', 'Collation'];

app.post('/api/journal-parse', async (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Texte vide.' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Clé API non configurée sur le serveur.' });

  const prompt = `Tu es l'assistant d'un carnet de suivi calorique. L'utilisateur décrit librement, en français, ce qu'il a mangé et/ou fait comme activité physique. Extrait chaque élément distinct et réponds STRICTEMENT avec un JSON (rien d'autre, pas de markdown) au format :
{"items":[
  {"kind":"meal","moment":"Petit-déj|Déjeuner|Dîner|Collation","name":"...","kcal":123},
  {"kind":"activity","type":"pas|course|salle|marche|velo|natation|autre","label":"...","steps":0,"dur":0,"dist":0,"kcal":0}
]}
Règles :
- "kind" vaut "meal" pour un aliment/repas, "activity" pour du sport/de l'exercice.
- Pour un repas, estime un nombre de kcal réaliste pour une portion normale ; choisis "moment" selon le contexte (par défaut "Collation" si inconnu).
- Pour une activité, choisis le "type" le plus proche parmi la liste, remplis steps/dur (minutes)/dist (km) si mentionnés, sinon laisse à 0. Ne remplis "kcal" pour une activité que si aucune autre info (durée/distance/pas) n'est disponible pour l'estimer ; sinon laisse kcal à 0. "label" uniquement utile si type="autre" (nom de l'activité).
- N'invente pas d'éléments qui ne sont pas mentionnés.
- Si le texte est incompréhensible ou vide de sens, renvoie {"items":[]}.

Texte de l'utilisateur : "${text}"`;

  try {
    const r = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });
    if (!r) return res.status(502).json({ error: 'Erreur lors de l\'appel à l\'IA.' });

    const data = await r.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return res.status(502).json({ error: 'Réponse IA invalide.' }); }

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const clean = items.map(it => {
      if (it.kind === 'meal') {
        const kcal = parseInt(it.kcal, 10);
        const name = (it.name || '').toString().trim();
        if (!name || !Number.isFinite(kcal) || kcal <= 0) return null;
        const moment = MOMENTS.includes(it.moment) ? it.moment : 'Collation';
        return { kind: 'meal', moment, name, kcal };
      }
      if (it.kind === 'activity') {
        const type = ACTIVITY_TYPES.includes(it.type) ? it.type : 'autre';
        const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };
        return {
          kind: 'activity',
          type,
          label: (it.label || '').toString().trim(),
          steps: num(it.steps),
          dur: num(it.dur),
          dist: num(it.dist),
          kcal: num(it.kcal)
        };
      }
      return null;
    }).filter(Boolean);

    res.json({ items: clean });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.post('/api/coach-analysis', async (req, res) => {
  const { meals, acts, goal, bmr } = req.body || {};
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Clé API non configurée sur le serveur.' });
  if ((!Array.isArray(meals) || !meals.length) && (!Array.isArray(acts) || !acts.length)) {
    return res.status(400).json({ error: 'Aucune donnée à analyser.' });
  }

  const mealsList = (meals || []).map(m => `- ${m.moment}: ${m.name} (${m.kcal} kcal)`).join('\n') || 'Aucun repas enregistré.';
  const actsList = (acts || []).map(a => {
    const parts = [];
    if (a.steps) parts.push(`${a.steps} pas`);
    if (a.dur) parts.push(`${a.dur} min`);
    if (a.dist) parts.push(`${a.dist} km`);
    const label = a.name || a.type;
    return `- ${label}${parts.length ? ' (' + parts.join(', ') + ')' : ''} : ${a.kcal || 0} kcal brûlées`;
  }).join('\n') || 'Aucune activité enregistrée.';

  const prompt = `Prompt Coach Sportif : tu es un coach sportif et nutritionnel bienveillant, jamais culpabilisant. Voici le journal de la journée d'un utilisateur.

Repas :
${mealsList}

Activités :
${actsList}

${goal ? `Objectif de l'utilisateur : ${goal} kcal mangées/jour.` : ''}
${bmr ? `Métabolisme de base estimé : ${bmr} kcal/jour.` : ''}

Rédige une courte analyse (4 à 6 phrases, en français, tutoiement, ton motivant) qui :
1. Résume l'équilibre de la journée (alimentation vs dépense physique).
2. Relève un point positif.
3. Donne un conseil concret et réaliste pour la suite de la journée ou pour demain.
Ne liste pas les repas un par un, fais une vraie synthèse. Pas de markdown, texte brut uniquement.`;

  try {
    const r = await callGemini({ contents: [{ parts: [{ text: prompt }] }] });
    if (!r) return res.status(502).json({ error: 'Erreur lors de l\'appel à l\'IA.' });

    const data = await r.json();
    const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (!text) return res.status(502).json({ error: 'Réponse IA vide.' });

    res.json({ analysis: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
