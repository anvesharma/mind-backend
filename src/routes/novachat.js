const express = require('express');
const router = express.Router();
const axios = require('axios');

router.post('/', async (req, res) => {
  try {
    const { messages, system } = req.body;
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        messages: [
          { role: 'system', content: system },
          ...messages
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        }
      }
    );
    const reply = response.data.choices[0].message.content;
    res.json({ content: [{ text: reply }] });
  } catch (err) {
    console.error('Nova chat error:', err.message);
    res.status(500).json({ error: 'Chat failed' });
  }
});

module.exports = router;
