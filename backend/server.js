import express from 'express';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import cron from 'node-cron';
import cors from 'cors';
import { fileURLToPath } from 'url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// Data storage
const DATA_DIR = path.join(__dirname, 'data');
const METRICS_FILE = path.join(DATA_DIR, 'sync-metrics.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// API Configuration
const API_BASE = 'https://gds.kupos.com/api/v2/konnect_gds_sync';
const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjkiLCJzY3AiOiJ1c2VyIiwiYXVkIjpudWxsLCJpYXQiOjE3NTYxNTMyOTIsImV4cCI6MTc3MTkzMTc2OCwianRpIjoiZTRhMWI4YmEtNjZjOC00N2Q1LWIyOWQtNWQ3ZWYxNmNjYTJhIn0.MFXifUXdvxIWNhGE3tpO8bARU2tJEAGvW_OOmZY2svQ',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*'
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// In-memory cache to track unique IDs
let processedIds = new Set();

// Load existing data on startup
function loadExistingData() {
  if (fs.existsSync(METRICS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
      // Load all processed IDs to avoid duplicates
      data.forEach(entry => {
        if (entry.registros && Array.isArray(entry.registros)) {
          entry.registros.forEach(record => {
            processedIds.add(record.id);
          });
        }
      });
    } catch (error) {
      console.error('Error loading existing data:', error);
    }
  }
}

// Save metrics data
function saveMetrics(entry) {
  let data = [];
  if (fs.existsSync(METRICS_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    } catch (error) {
      console.error('Error reading metrics file:', error);
    }
  }
  
  data.push(entry);
  
  try {
    fs.writeFileSync(METRICS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving metrics:', error);
  }
}

// Fetch and store status data
async function fetchAndStoreStatus(status) {
  try {
    const url = `${API_BASE}?status=${status}`;
    const response = await fetch(url, { headers: HEADERS });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    const audits = data?.data?.audits || [];
    
    // Filter out duplicates based on ID
    const uniqueAudits = audits.filter(item => {
      if (!processedIds.has(item.id)) {
        processedIds.add(item.id);
        return true;
      }
      return false;
    });
    
    // Count by operator
    const operatorCounts = {};
    uniqueAudits.forEach(audit => {
      const operator = audit.travel_name || 'Unknown';
      operatorCounts[operator] = (operatorCounts[operator] || 0) + 1;
    });
    
    const entry = {
      timestamp: new Date().toISOString(),
      status,
      count: uniqueAudits.length,
      totalCount: audits.length,
      operatorCounts,
      registros: uniqueAudits.map(item => ({
        id: item.id,
        travel_name: item.travel_name || 'Unknown',
        action_name: item.action_name || '',
        travel_date: item.travel_date || '',
        source: item.source || '',
        created_at: item.created_at || '',
        ...item
      }))
    };
    
    if (uniqueAudits.length > 0) {
      saveMetrics(entry);
      console.log(`[${new Date().toISOString()}] Saved ${uniqueAudits.length} new ${status} records`);
    }
    
    return entry;
  } catch (error) {
    console.error(`Error fetching ${status}:`, error.message);
    return null;
  }
}

// Initialize data loading
loadExistingData();

// Cron job: every 10 seconds
cron.schedule('*/10 * * * * *', async () => {
  await fetchAndStoreStatus('not_processed');
  await fetchAndStoreStatus('failed');
  // 'synced' solo debe consultarse manualmente
  // get_queue_size is handled by its own endpoint, but you can prefetch/cache if needed
});

// API Routes

// Get dashboard data
app.get('/api/dashboard', async (req, res) => {
  try {
    // Get current status from APIs
    const notProcessed = await fetchAndStoreStatus('not_processed');
    const failed = await fetchAndStoreStatus('failed');
    
    // Get historical data
    let historicalData = [];
    if (fs.existsSync(METRICS_FILE)) {
      historicalData = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    }
    
    // Calculate metrics
    const last24Hours = historicalData.filter(entry => {
      const entryTime = new Date(entry.timestamp);
      const now = new Date();
      return (now - entryTime) <= 24 * 60 * 60 * 1000;
    });
    
    const metrics = {
      current: {
        notProcessed: notProcessed?.count || 0,
        failed: failed?.count || 0,
        operators: {
          ...notProcessed?.operatorCounts || {},
          ...failed?.operatorCounts || {}
        }
      },
      historical: last24Hours,
      totalRecords: historicalData.length
    };
    
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching dashboard data', details: error.message });
  }
});

// Get specific status records
app.get('/api/records/:status', async (req, res) => {
  try {
    const { status } = req.params;
    const url = `${API_BASE}?status=${status}`;
    const response = await fetch(url, { headers: HEADERS });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching records', details: error.message });
  }
});

// Get queue status
app.get('/api/queue/status', async (req, res) => {
  try {
    const response = await fetch(`${API_BASE}/get_queue_size`, {
      headers: {
        ...HEADERS,
        'Cookie': '_kp_gds_session=...' // Add your session cookie here
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching queue status', details: error.message });
  }
});

// Clear queue
app.post('/api/queue/clear', async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty IDs array' });
    }
    
    const response = await fetch(`${API_BASE}/retrigger_cron_async`, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Cookie': '_kp_gds_session=...' // Add your session cookie here
      },
      body: JSON.stringify({ ids })
    });
    
    const result = await response.json();
    
    if (response.ok) {
      res.json({ success: true, result });
    } else {
      res.status(500).json({ success: false, error: 'Queue clear failed', details: result });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error clearing queue', details: error.message });
  }
});

// Resync single record
app.post('/api/resync', async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: 'Missing ID' });
    }
    
    const response = await fetch(`${API_BASE}/retrigger_sync`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ id })
    });
    
    const result = await response.json();
    
    if (response.ok) {
      res.json({ success: true, result });
    } else {
      res.status(500).json({ success: false, error: 'Resync failed', details: result });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error resyncing record', details: error.message });
  }
});

// Force data collection (useful for testing)
app.post('/api/collect-data', async (req, res) => {
  try {
    const results = await Promise.all([
      fetchAndStoreStatus('not_processed'),
      fetchAndStoreStatus('failed'),
      fetchAndStoreStatus('synced')
    ]);
    
    res.json({
      success: true,
      message: 'Data collection completed',
      results: results.filter(r => r !== null)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error collecting data', details: error.message });
  }
});

// Get metrics for charts
app.get('/api/metrics', (req, res) => {
  try {
    if (!fs.existsSync(METRICS_FILE)) {
      return res.json({ 
        metrics: [], 
        summary: {
          totalRecords: 0,
          averageProcessingTime: 0,
          peakHours: [],
          uniqueOperators: 0
        }
      });
    }
    
    const data = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    const { from, to } = req.query;
    
    let filteredData = data;
    
    // Apply date filters
    if (from || to) {
      filteredData = data.filter(entry => {
        const entryDate = new Date(entry.timestamp);
        if (from && entryDate < new Date(from)) return false;
        if (to && entryDate > new Date(to)) return false;
        return true;
      });
    }
    
    // Calculate comprehensive summary metrics
    const summary = calculateComprehensiveSummary(filteredData);
    
    res.json({ metrics: filteredData, summary });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching metrics', details: error.message });
  }
});

// Enhanced summary calculation
function calculateComprehensiveSummary(data) {
  if (data.length === 0) {
    return {
      totalRecords: 0,
      averageProcessingTime: 0,
      peakHours: [],
      uniqueOperators: 0,
      statusBreakdown: {},
      totalProcessedItems: 0
    };
  }

  // Status breakdown
  const statusBreakdown = {};
  let totalProcessedItems = 0;
  const allOperators = new Set();
  
  data.forEach(entry => {
    statusBreakdown[entry.status] = (statusBreakdown[entry.status] || 0) + entry.count;
    totalProcessedItems += entry.count;
    
    if (entry.operatorCounts) {
      Object.keys(entry.operatorCounts).forEach(op => allOperators.add(op));
    }
  });

  return {
    totalRecords: data.length,
    totalProcessedItems,
    statusBreakdown,
    uniqueOperators: allOperators.size,
    averageProcessingTime: calculateAverageProcessingTime(data),
    peakHours: calculatePeakHours(data)
  };
}

// Helper functions
function calculateAverageProcessingTime(data) {
  // Calculate based on available data - average time between records
  if (data.length < 2) return 0;
  
  const times = data.map(entry => new Date(entry.timestamp).getTime());
  times.sort((a, b) => a - b);
  
  let totalDiff = 0;
  for (let i = 1; i < times.length; i++) {
    totalDiff += times[i] - times[i - 1];
  }
  
  const avgMilliseconds = totalDiff / (times.length - 1);
  return Math.round(avgMilliseconds / 1000); // Return in seconds
}

function calculatePeakHours(data) {
  const hourCounts = {};
  data.forEach(entry => {
    const hour = new Date(entry.timestamp).getHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + entry.count;
  });
  
  return Object.entries(hourCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour, count]) => ({ hour: parseInt(hour), count }));
}

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Cron job started - monitoring every 30 seconds');
});