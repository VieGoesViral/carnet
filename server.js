require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/estimate-kcal', async (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom du plat manquant.' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Clé API non configurée sur le serveur.' });

  const prompt = `Tu es un nutritionniste. Donne une estimation du nombre de calories (kcal) pour une portion normale de : "${name}". Réponds UNIQUEMENT avec un nombre entier, sans texte ni unité.`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    if (!r.ok) {
      const errText = await r.text();
      console.error('Gemini API error:', errText);
      return res.status(502).json({ error: 'Erreur lors de l\'appel à l\'IA.' });
    }

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

app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
