const express = require('express');
const router = express.Router();
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');

const credentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
);

const auth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

router.post('/', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const response = await axios.post(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        input: { text },
        voice: { languageCode: 'en-US', name: 'en-US-Journey-F' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95, pitch: 0 },
      },
      { headers: { Authorization: `Bearer ${token.token}` } }
    );

    res.json({ audioContent: response.data.audioContent });
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: 'TTS failed' });
  }
});

module.exports = router;
