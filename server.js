const express = require('express');
const path = require('path');
const { crawlProduct } = require('./crawler');

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(express.json());

// API endpoint to trigger crawling
app.get('/api/crawl', async (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Product ID is required' });
  }

  console.log(`\n>>> STARTING CRAWL FOR ID: ${id} <<<`);

  try {
    const data = await crawlProduct(id);
    res.json(data);
  } catch (error) {
    console.error('Crawl failed:', error);
    res.status(500).json({ error: 'Internal server error during crawling' });
  }
});

app.listen(PORT, () => {
  console.log(`
=========================================
 CRAWLER SERVER RUNNING AT:
 http://localhost:${PORT}
=========================================
  `);
});
