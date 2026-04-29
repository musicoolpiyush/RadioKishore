const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const USERNAME = '_MusiCoolPiyush_';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory cache ──
let cache = {
  recordings: [],
  lastFetched: null,
  isFetching: false,
  totalFetched: 0,
  done: false,
};

// ── Fetch one page from Smule ──
async function fetchPage(offset) {
  const url = `https://www.smule.com/s/profile/recordings/${USERNAME}?offset=${offset}&type=recording`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/javascript, */*',
      'Referer': `https://www.smule.com/${USERNAME}`,
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Parse a raw Smule performance into our clean format ──
function parsePerformance(p) {
  const isInvite = p.type === 'ensemble';
  const performers = p.other_performers || [];
  const partners = performers.map(q => q.handle).filter(h => h && h !== USERNAME);

  return {
    key: p.key,
    title: p.title || 'Untitled',
    coverUrl: p.cover_url || (p.song_info && p.song_info.cover_url) || '',
    webUrl: `https://www.smule.com/recording/${p.key}`,
    plays: p.stats?.total_listens || 0,
    loves: p.stats?.total_loves || 0,
    joins: p.child_count || 0,
    type: partners.length > 0 ? 'duet' : (isInvite ? 'invite' : 'solo'),
    partners,
    createdAt: p.created_at || '',
    year: p.created_at ? p.created_at.substring(0, 4) : 'Unknown',
  };
}

// ── Background fetcher — pages through ALL recordings ──
async function fetchAllInBackground() {
  if (cache.isFetching) return;
  cache.isFetching = true;
  cache.done = false;

  let offset = 0;
  let pageCount = 0;

  console.log(`🎙️ Starting background fetch for ${USERNAME}...`);

  while (true) {
    try {
      const data = await fetchPage(offset);
      const list = data.list || data.performances || [];

      if (!list.length) {
        console.log(`✅ Done! Fetched ${cache.recordings.length} recordings.`);
        break;
      }

      const parsed = list.map(parsePerformance);
      cache.recordings.push(...parsed);
      cache.totalFetched = cache.recordings.length;
      pageCount++;

      console.log(`📦 Page ${pageCount} | offset ${offset} | total so far: ${cache.recordings.length}`);

      const nextOffset = data.next_offset;
      if (nextOffset === -1 || nextOffset === undefined || nextOffset === null) {
        console.log(`✅ Done! Fetched ${cache.recordings.length} recordings total.`);
        break;
      }

      offset = nextOffset;

      // Be polite to Smule — wait 300ms between requests
      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      console.error(`❌ Error at offset ${offset}:`, err.message);
      // Wait 5 seconds and retry once
      await new Promise(r => setTimeout(r, 5000));
      try {
        const data = await fetchPage(offset);
        const list = data.list || data.performances || [];
        if (list.length) {
          cache.recordings.push(...list.map(parsePerformance));
          cache.totalFetched = cache.recordings.length;
          offset = data.next_offset;
        } else break;
      } catch (e2) {
        console.error('❌ Retry failed, stopping.', e2.message);
        break;
      }
    }
  }

  cache.lastFetched = new Date().toISOString();
  cache.isFetching = false;
  cache.done = true;
}

// ── API: get recordings (paginated from our cache) ──
app.get('/api/recordings', (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 50;
  const start = page * limit;
  const slice = cache.recordings.slice(start, start + limit);

  res.json({
    recordings: slice,
    total: cache.recordings.length,
    page,
    hasMore: start + limit < cache.recordings.length,
    isFetching: cache.isFetching,
    done: cache.done,
    lastFetched: cache.lastFetched,
  });
});

// ── API: get stats ──
app.get('/api/stats', (req, res) => {
  const recs = cache.recordings;

  // Partner frequency
  const partnerCount = {};
  recs.forEach(r => {
    r.partners.forEach(p => {
      partnerCount[p] = (partnerCount[p] || 0) + 1;
    });
  });

  const topPartners = Object.entries(partnerCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([handle, count]) => ({ handle, count }));

  // Year breakdown
  const yearCount = {};
  recs.forEach(r => {
    yearCount[r.year] = (yearCount[r.year] || 0) + 1;
  });

  // Type breakdown
  const solos = recs.filter(r => r.type === 'solo').length;
  const duets = recs.filter(r => r.type === 'duet').length;
  const invites = recs.filter(r => r.type === 'invite').length;

  const totalLoves = recs.reduce((a, r) => a + r.loves, 0);
  const totalPlays = recs.reduce((a, r) => a + r.plays, 0);
  const totalJoins = recs.reduce((a, r) => a + r.joins, 0);

  const topSongs = [...recs].sort((a, b) => b.loves - a.loves).slice(0, 10);

  res.json({
    total: recs.length,
    solos, duets, invites,
    totalLoves, totalPlays, totalJoins,
    topPartners,
    yearBreakdown: yearCount,
    topSongs,
    isFetching: cache.isFetching,
    done: cache.done,
  });
});

// ── API: force refresh ──
app.post('/api/refresh', (req, res) => {
  if (cache.isFetching) {
    return res.json({ message: 'Already fetching...' });
  }
  cache.recordings = [];
  cache.done = false;
  fetchAllInBackground();
  res.json({ message: 'Refresh started!' });
});

// ── API: status ──
app.get('/api/status', (req, res) => {
  res.json({
    total: cache.recordings.length,
    isFetching: cache.isFetching,
    done: cache.done,
    lastFetched: cache.lastFetched,
  });
});

// ── Serve frontend for all other routes ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ──
app.listen(PORT, () => {
  console.log(`🎵 RadioKishore server running on port ${PORT}`);
  // Auto-start fetching on boot
  fetchAllInBackground();
});
