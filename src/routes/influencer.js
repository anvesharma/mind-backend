const express = require('express');
const router  = express.Router();
const pool    = require('../db');

router.post('/', async (req, res) => {
  const {
    name, email, phone, company, linkedin,
    contact_name, contact_email, contact_company, contact_phone, contact_linkedin
  } = req.body;

  if (!name || !email || !phone || !company || !contact_name || !contact_email || !contact_company) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await pool.query(
      `INSERT INTO influencer_applications
        (name, email, phone, company, linkedin, contact_name, contact_email, contact_company, contact_phone, contact_linkedin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [name, email, phone, company, linkedin || null,
       contact_name, contact_email, contact_company, contact_phone || null, contact_linkedin || null]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Influencer application error:', err);
    res.status(500).json({ error: 'Failed to save application' });
  }
});

module.exports = router;
