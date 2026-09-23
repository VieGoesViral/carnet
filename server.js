require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(express.json());
app.use(express.static(__dirname));

async function callGemini(body) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
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

app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
