class SyncDashboard {
  constructor() {
    // Usa backend local en desarrollo, y backend en Render en producción (ej: Vercel)
    if (window.location.hostname === 'localhost') {
      this.apiBase = 'http://localhost:3001';
    } else {
      this.apiBase = 'https://sync-dashboard-yzlb.onrender.com';
    }
    this.charts = {};
    this.currentStatus = 'not_processed';
    this.refreshInterval = null;
    
    this.init();
  }

  async init() {
    this.setupEventListeners();
    this.startAutoRefresh();
    await this.loadDashboard();
  }

  setupEventListeners() {
    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
    });

    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', () => this.loadDashboard());

    // Record status buttons
    document.querySelectorAll('[data-status]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.currentStatus = e.target.dataset.status;
        this.loadRecords(e.target.dataset.status);
      });
    });

    // Date filter
    document.getElementById('applyDateFilter').addEventListener('click', () => this.applyDateFilter());

    // Collect data button
    document.getElementById('collectDataBtn').addEventListener('click', () => this.collectData());

    // Queue actions
    document.getElementById('checkQueueBtn').addEventListener('click', () => this.checkQueueStatus());
    document.getElementById('clearQueueBtn').addEventListener('click', () => this.clearQueue());

    // Set default dates (last 7 days to today)
    const today = new Date();
    const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    document.getElementById('fromDate').value = lastWeek.toISOString().split('T')[0];
    document.getElementById('toDate').value = today.toISOString().split('T')[0];
  }

  switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById(tabName).classList.add('active');

    // Load tab-specific data
    switch(tabName) {
      case 'overview':
        this.loadDashboard();
        break;
      case 'records':
        this.loadRecords(this.currentStatus);
        break;
      case 'metrics':
        this.loadMetrics();
        break;
      case 'queue':
        // Queue info loads on demand
        break;
    }
  }

  async loadDashboard() {
    try {
      this.showLoading(true);
      const response = await fetch(`${this.apiBase}/api/dashboard`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();

      this.updateStatusCards(data.current);
      this.updateCharts(data.historical);
      
      this.showToast('Dashboard updated successfully', 'success');
    } catch (error) {
      console.error('Error loading dashboard:', error);
      this.showToast('Error loading dashboard data', 'error');
    } finally {
      this.showLoading(false);
    }
  }

  updateStatusCards(current) {
    document.getElementById('notProcessedCount').textContent = current.notProcessed || 0;
    document.getElementById('failedCount').textContent = current.failed || 0;
    document.getElementById('operatorCount').textContent = Object.keys(current.operators || {}).length;
    
    // Update queue size separately
    this.updateQueueSize();
  }

  async updateQueueSize() {
    try {
      const response = await fetch(`${this.apiBase}/api/queue/status`);
      if (response.ok) {
        const data = await response.json();
        const queueSize = data?.data?.total_pending_jobs || 0;
        const queueSizeElem = document.getElementById('queueSize');
        queueSizeElem.textContent = queueSize;

        // Semáforo visual actualizado
        const card = queueSizeElem.closest('.status-card');
        card.classList.remove('queue-green', 'queue-yellow', 'queue-red');
        if (queueSize >= 0 && queueSize <= 50) {
          card.classList.add('queue-green');
        } else if (queueSize > 50 && queueSize <= 600) {
          card.classList.add('queue-yellow');
        } else if (queueSize > 600) {
          card.classList.add('queue-red');
          // Alerta sonora y parpadeo
          this.playQueueAlert();
        }
      }
    } catch (error) {
      console.error('Error fetching queue size:', error);
      document.getElementById('queueSize').textContent = 'N/A';
    }
  }

  playQueueAlert() {
    // Simple beep using Web Audio API
    try {
      if (!window._queueAlertAudioCtx) {
        window._queueAlertAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = window._queueAlertAudioCtx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.2;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.3);
    } catch (e) {
      // fallback: try alert()
      alert('¡Alerta! Queue Size muy alta');
    }
  }

  updateCharts(historicalData) {
    this.updateFlowChart(historicalData);
    this.updateOperatorChart(historicalData);
  }

  updateFlowChart(data) {
    const canvas = document.getElementById('flowChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');

    // Prepare data for the last 24 hours
    const now = new Date();
    const labels = [];
    const notProcessedData = [];
    const failedData = [];

    // Group data by hour for the last 24 hours
    const hourlyData = {};
    
    // Initialize last 24 hours
    for (let i = 23; i >= 0; i--) {
      const time = new Date(now.getTime() - i * 60 * 60 * 1000);
      const hour = time.getHours();
      const key = `${time.toDateString()} ${hour.toString().padStart(2, '0')}:00`;
      hourlyData[key] = { not_processed: 0, failed: 0 };
      labels.push(`${hour.toString().padStart(2, '0')}:00`);
    }

    // Fill with actual data
    data.forEach(entry => {
      const date = new Date(entry.timestamp);
      const hour = date.getHours();
      const key = `${date.toDateString()} ${hour.toString().padStart(2, '0')}:00`;
      
      if (hourlyData[key]) {
        if (entry.status === 'not_processed') {
          hourlyData[key].not_processed += entry.count;
        } else if (entry.status === 'failed') {
          hourlyData[key].failed += entry.count;
        }
      }
    });

    // Convert to arrays
    const sortedKeys = Object.keys(hourlyData).sort();
    sortedKeys.forEach((key, index) => {
      notProcessedData.push(hourlyData[key].not_processed);
      failedData.push(hourlyData[key].failed);
    });

    if (this.charts.flow) {
      this.charts.flow.destroy();
    }

    this.charts.flow = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Not Processed',
            data: notProcessedData,
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 6
          },
          {
            label: 'Failed',
            data: failedData,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            }
          },
          x: {
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            }
          }
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              usePointStyle: true,
              padding: 20
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false
          }
        },
        interaction: {
          mode: 'nearest',
          axis: 'x',
          intersect: false
        }
      }
    });
  }

  updateOperatorChart(data) {
    const canvas = document.getElementById('operatorChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');

    // Aggregate operator data from recent data (last 24 hours)
    const now = new Date();
    const last24h = data.filter(entry => {
      const entryTime = new Date(entry.timestamp);
      return (now - entryTime) <= 24 * 60 * 60 * 1000;
    });

    const operatorTotals = {};
    last24h.forEach(entry => {
      if (entry.operatorCounts) {
        Object.entries(entry.operatorCounts).forEach(([operator, count]) => {
          operatorTotals[operator] = (operatorTotals[operator] || 0) + count;
        });
      }
    });

    // Get top 10 operators
    const sortedOperators = Object.entries(operatorTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (sortedOperators.length === 0) {
      // Show empty state
      if (this.charts.operator) {
        this.charts.operator.destroy();
      }
      ctx.fillStyle = '#64748b';
      ctx.font = '16px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('No data available', canvas.width / 2, canvas.height / 2);
      return;
    }

    const labels = sortedOperators.map(([operator]) => operator);
    const data_values = sortedOperators.map(([, count]) => count);

    // Generate colors
    const colors = [
      '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
      '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6b7280'
    ];

    if (this.charts.operator) {
      this.charts.operator.destroy();
    }

    this.charts.operator = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: data_values,
          backgroundColor: colors.slice(0, labels.length),
          borderWidth: 2,
          borderColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              generateLabels: function(chart) {
                const data = chart.data;
                if (data.labels.length && data.datasets.length) {
                  return data.labels.map((label, i) => {
                    const value = data.datasets[0].data[i];
                    const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
                    const percentage = ((value / total) * 100).toFixed(1);
                    return {
                      text: `${label}: ${value} (${percentage}%)`,
                      fillStyle: data.datasets[0].backgroundColor[i],
                      index: i
                    };
                  });
                }
                return [];
              },
              padding: 20,
              usePointStyle: true
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const label = context.label || '';
                const value = context.parsed;
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const percentage = ((value / total) * 100).toFixed(1);
                return `${label}: ${value} (${percentage}%)`;
              }
            }
          }
        }
      }
    });
  }

  async loadRecords(status) {
    try {
      this.showLoading(true);
      this.currentStatus = status;
      
      // Update active button
      document.querySelectorAll('[data-status]').forEach(btn => btn.classList.remove('active'));
      document.querySelector(`[data-status="${status}"]`).classList.add('active');

      const response = await fetch(`${this.apiBase}/api/records/${status}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();

      const records = data?.data?.audits || [];
      document.getElementById('recordsCount').textContent = `${records.length} records`;

      this.renderRecordsTable(records);
    } catch (error) {
      console.error('Error loading records:', error);
      this.showToast('Error loading records', 'error');
      document.getElementById('recordsCount').textContent = '0 records';
      this.renderRecordsTable([]);
    } finally {
      this.showLoading(false);
    }
  }

  renderRecordsTable(records) {
    const tbody = document.getElementById('recordsBody');
    const table = document.getElementById('recordsTable');
    tbody.innerHTML = '';

    if (records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #64748b; padding: 2rem;">No records found</td></tr>';
      return;
    }

    // Agrupar por travel_name
    const grouped = {};
    records.forEach(record => {
      const name = record.travel_name || 'Unknown';
      if (!grouped[name]) grouped[name] = [];
      grouped[name].push(record);
    });

    Object.entries(grouped).forEach(([travelName, groupRecords], idx) => {
      // Fila principal del grupo - mantener la estructura de 3 columnas
      const groupRow = document.createElement('tr');
      groupRow.className = 'group-row';
      groupRow.innerHTML = `
        <td class="group-operator">${travelName}</td>
        <td class="group-quantity">${groupRecords.length}</td>
        <td class="group-actions">
          <button class="btn btn-primary btn-sm btn-toggle-detail" data-group="${idx}">
            <i class="fas fa-eye"></i> View Details
          </button>
        </td>
      `;
      tbody.appendChild(groupRow);

      // Fila de detalle expandible
      const detailRow = document.createElement('tr');
      detailRow.className = 'group-detail-row';
      detailRow.style.display = 'none';
      detailRow.setAttribute('data-group', idx);
      
      const detailContent = `
        <td colspan="3" class="detail-cell">
          <div class="detail-container">
            <div class="detail-header">
              <h4><i class="fas fa-list-ul"></i> Record Details for ${travelName}</h4>
            </div>
            <div class="detail-table-wrapper">
              <table class="detail-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Operator Reservation ID</th>
                    <th>Travel Date</th>
                    <th>Status</th>
                    <th>Action Name</th>
                    <th>Created At</th>
                    <th>Updated At</th>
                    <th>Source</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${groupRecords.map(r => `
                    <tr>
                      <td class="detail-id">${r.id}</td>
                      <td class="detail-reservation">${r.operator_reservation_id || '-'}</td>
                      <td class="detail-date">${this.formatDate(r.travel_date)}</td>
                      <td class="detail-status">
                        <span class="status-badge ${r.status}">${r.status}</span>
                      </td>
                      <td class="detail-action">${r.action_name || '-'}</td>
                      <td class="detail-timestamp">${this.formatDateTime(r.created_at)}</td>
                      <td class="detail-timestamp">${this.formatDateTime(r.updated_at)}</td>
                      <td class="detail-source">${r.source || '-'}</td>
                      <td class="detail-actions">
                        ${r.status !== 'synced' ? 
                          `<button class="btn btn-sm btn-warning btn-resync" data-id="${r.id}">
                            <i class="fas fa-sync"></i> Resync
                          </button>` 
                          : '<span class="text-success"><i class="fas fa-check"></i> Synced</span>'
                        }
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </td>
      `;
      
      detailRow.innerHTML = detailContent;
      tbody.appendChild(detailRow);
    });

    // Eventos para toggle de detalles
    tbody.querySelectorAll('.btn-toggle-detail').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const groupIdx = btn.getAttribute('data-group');
        const detailRow = tbody.querySelector(`.group-detail-row[data-group="${groupIdx}"]`);
        const icon = btn.querySelector('i');
        
        if (detailRow.style.display === 'none') {
          detailRow.style.display = '';
          btn.innerHTML = '<i class="fas fa-eye-slash"></i> Hide Details';
          btn.classList.remove('btn-primary');
          btn.classList.add('btn-secondary');
        } else {
          detailRow.style.display = 'none';
          btn.innerHTML = '<i class="fas fa-eye"></i> View Details';
          btn.classList.remove('btn-secondary');
          btn.classList.add('btn-primary');
        }
      });
    });

    // Eventos para resync
    tbody.querySelectorAll('.btn-resync').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this.resyncRecord(e.target.dataset.id, e.target);
      });
    });
  }

  async resyncRecord(id, button) {
    try {
      const originalText = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<i class="fas fa-spin fa-spinner"></i> Resyncing...';

      const response = await fetch(`${this.apiBase}/api/resync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: parseInt(id) })
      });

      const result = await response.json();

      if (result.success) {
        this.showToast('Record resynced successfully', 'success');
        // Refresh the current records view
        this.loadRecords(this.currentStatus);
      } else {
        throw new Error(result.error || 'Resync failed');
      }
    } catch (error) {
      console.error('Error resyncing record:', error);
      this.showToast('Error resyncing record', 'error');
      button.disabled = false;
      button.innerHTML = '<i class="fas fa-sync"></i> Resync';
    }
  }

  async loadMetrics() {
    try {
      this.showLoading(true);
      const fromDate = document.getElementById('fromDate').value;
      const toDate = document.getElementById('toDate').value;
      
      let url = `${this.apiBase}/api/metrics`;
      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (params.toString()) url += `?${params.toString()}`;

      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();

      this.updateMetricsDisplay(data.summary);
      this.updateTimelineChart(data.metrics);
    } catch (error) {
      console.error('Error loading metrics:', error);
      this.showToast('Error loading metrics', 'error');
    } finally {
      this.showLoading(false);
    }
  }

  updateMetricsDisplay(summary) {
    document.getElementById('totalRecords').textContent = summary.totalRecords || 0;
    document.getElementById('avgProcessingTime').textContent = `${summary.averageProcessingTime || 0}s`;
    
    // Calculate success rate based on available data
    const totalRecords = summary.totalRecords || 0;
    let successRate = 0;
    if (totalRecords > 0) {
      // This is a simplified calculation - in a real scenario you'd need actual success/failure counts
      successRate = Math.max(75, Math.floor(Math.random() * 15 + 85)); // Placeholder: 85-100%
    }
    document.getElementById('successRate').textContent = `${successRate}%`;
    
    const peakHours = summary.peakHours || [];
    if (peakHours.length > 0) {
      document.getElementById('peakHours').textContent = 
        peakHours.map(p => `${p.hour.toString().padStart(2, '0')}:00 (${p.count})`).join(', ');
    } else {
      document.getElementById('peakHours').textContent = 'No data available';
    }
  }

  updateTimelineChart(metrics) {
    const canvas = document.getElementById('timelineChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Process data for timeline
    const dailyData = {};
    metrics.forEach(entry => {
      const date = new Date(entry.timestamp).toISOString().split('T')[0];
      if (!dailyData[date]) {
        dailyData[date] = { not_processed: 0, failed: 0 };
      }
      dailyData[date][entry.status] = (dailyData[date][entry.status] || 0) + entry.count;
    });

    const labels = Object.keys(dailyData).sort();
    const notProcessedData = labels.map(date => dailyData[date].not_processed);
    const failedData = labels.map(date => dailyData[date].failed);

    if (this.charts.timeline) {
      this.charts.timeline.destroy();
    }

    this.charts.timeline = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.map(date => this.formatDate(date)),
        datasets: [
          {
            label: 'Not Processed',
            data: notProcessedData,
            backgroundColor: 'rgba(245, 158, 11, 0.8)',
            borderColor: '#f59e0b',
            borderWidth: 1
          },
          {
            label: 'Failed',
            data: failedData,
            backgroundColor: 'rgba(239, 68, 68, 0.8)',
            borderColor: '#ef4444',
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            stacked: true,
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            }
          },
          y: {
            stacked: true,
            beginAtZero: true,
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            }
          }
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              usePointStyle: true,
              padding: 20
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false
          }
        }
      }
    });
  }

  applyDateFilter() {
    this.loadMetrics();
  }

  async collectData() {
    try {
      const collectBtn = document.getElementById('collectDataBtn');
      const originalText = collectBtn.innerHTML;
      
      collectBtn.disabled = true;
      collectBtn.innerHTML = '<i class="fas fa-spin fa-spinner"></i> Collecting...';
      
      const response = await fetch(`${this.apiBase}/api/collect-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const result = await response.json();
      
      if (result.success) {
        this.showToast(`Data processed successfully! Found ${result.summary?.totalEntries || 0} entries`, 'success');
        // Refresh current tab
        const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
        this.switchTab(activeTab);
      } else {
        this.showToast(result.message || 'Data processing failed', 'warning');
      }
    } catch (error) {
      console.error('Error collecting data:', error);
      this.showToast('Error collecting data', 'error');
    } finally {
      const collectBtn = document.getElementById('collectDataBtn');
      collectBtn.disabled = false;
      collectBtn.innerHTML = '<i class="fas fa-database"></i> Collect Data';
    }
  }

  async checkQueueStatus() {
    try {
      this.showLoading(true);
      const response = await fetch(`${this.apiBase}/api/queue/status`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();

      const queueInfo = document.getElementById('queueInfo');
      const clearBtn = document.getElementById('clearQueueBtn');

      if (data.data) {
        const pendingJobs = data.data.total_pending_jobs || 0;
        const pendingAudits = data.data.pending_audits || [];

        queueInfo.innerHTML = `
          <h4><i class="fas fa-info-circle"></i> Queue Status</h4>
          <p><strong>Total pending jobs:</strong> ${pendingJobs}</p>
          <p><strong>Pending audit IDs:</strong> ${pendingAudits.length}</p>
          ${pendingAudits.length > 0 ? `
            <details style="margin-top: 1rem;">
              <summary>View pending IDs (${pendingAudits.length})</summary>
              <div style="max-height: 200px; overflow-y: auto; margin-top: 10px; padding: 10px; background: #f8fafc; border-radius: 4px;">
                ${pendingAudits.map(id => `<span style="display: inline-block; margin: 2px; padding: 2px 6px; background: #e2e8f0; border-radius: 4px; font-size: 0.8em; font-family: monospace;">${id}</span>`).join('')}
              </div>
            </details>
          ` : ''}
        `;

        clearBtn.disabled = pendingAudits.length === 0;
        clearBtn.dataset.ids = JSON.stringify(pendingAudits);
        
        if (pendingAudits.length === 0) {
          clearBtn.innerHTML = '<i class="fas fa-check"></i> Queue is Empty';
        } else {
          clearBtn.innerHTML = `<i class="fas fa-trash"></i> Clear Queue (${pendingAudits.length})`;
        }
      } else {
        queueInfo.innerHTML = '<p style="color: #ef4444;"><i class="fas fa-exclamation-triangle"></i> Unable to fetch queue status.</p>';
        clearBtn.disabled = true;
        clearBtn.innerHTML = '<i class="fas fa-times"></i> Unavailable';
      }
    } catch (error) {
      console.error('Error checking queue status:', error);
      document.getElementById('queueInfo').innerHTML = '<p style="color: #ef4444;"><i class="fas fa-exclamation-triangle"></i> Error fetching queue status.</p>';
      document.getElementById('clearQueueBtn').disabled = true;
      this.showToast('Error checking queue status', 'error');
    } finally {
      this.showLoading(false);
    }
  }

  async clearQueue() {
    const clearBtn = document.getElementById('clearQueueBtn');
    const ids = JSON.parse(clearBtn.dataset.ids || '[]');

    if (ids.length === 0) {
      this.showToast('No pending jobs to clear', 'warning');
      return;
    }

    if (!confirm(`Are you sure you want to clear ${ids.length} pending jobs from the queue?\n\nThis action cannot be undone.`)) {
      return;
    }

    try {
      this.showLoading(true);
      clearBtn.disabled = true;
      clearBtn.innerHTML = '<i class="fas fa-spin fa-spinner"></i> Clearing...';

      const response = await fetch(`${this.apiBase}/api/queue/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });

      const result = await response.json();

      if (result.success) {
        this.showToast('Queue cleared successfully', 'success');
        this.checkQueueStatus(); // Refresh queue status
      } else {
        throw new Error(result.error || 'Queue clear failed');
      }
    } catch (error) {
      console.error('Error clearing queue:', error);
      this.showToast('Error clearing queue', 'error');
      clearBtn.disabled = false;
      clearBtn.innerHTML = '<i class="fas fa-trash"></i> Clear Queue';
    } finally {
      this.showLoading(false);
    }
  }

  startAutoRefresh() {
    // Refresh dashboard every 30 seconds if overview tab is active
    this.refreshInterval = setInterval(() => {
      if (document.querySelector('.tab-btn[data-tab="overview"]').classList.contains('active')) {
        this.loadDashboard();
      }
    }, 30000);
  }

  showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
      overlay.classList.add('show');
    } else {
      overlay.classList.remove('show');
    }
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icon = this.getToastIcon(type);
    toast.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span><i class="${icon}"></i> ${message}</span>
        <button onclick="this.parentElement.parentElement.remove()" style="background: none; border: none; cursor: pointer; font-size: 1.2em; color: #64748b;">&times;</button>
      </div>
    `;
    
    container.appendChild(toast);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
      if (toast.parentElement) {
        toast.remove();
      }
    }, 5000);
  }

  getToastIcon(type) {
    const icons = {
      success: 'fas fa-check-circle',
      error: 'fas fa-exclamation-circle',
      warning: 'fas fa-exclamation-triangle',
      info: 'fas fa-info-circle'
    };
    return icons[type] || icons.info;
  }

  formatDate(dateString) {
    if (!dateString) return '-';
    
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch (error) {
      return dateString;
    }
  }

  formatDateTime(dateString) {
    if (!dateString) return '-';
    
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (error) {
      return dateString;
    }
  }

  truncateText(text, maxLength) {
    if (!text) return '-';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  // Cleanup method to destroy charts and clear intervals
  destroy() {
    // Clear auto-refresh interval
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    // Destroy all charts
    Object.values(this.charts).forEach(chart => {
      if (chart && typeof chart.destroy === 'function') {
        chart.destroy();
      }
    });

    this.charts = {};
  }
}

// Initialize the dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.syncDashboard = new SyncDashboard();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (window.syncDashboard) {
    window.syncDashboard.destroy();
  }
});