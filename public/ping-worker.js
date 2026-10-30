// Tanz Probe High-Precision Off-Thread Ping Worker
// Performs network latency testing and statistical analysis off the main UI thread.

self.onmessage = async function(e) {
  const { action, url, count, intervalMs } = e.data;

  if (action === 'startContinuousPing') {
    const samples = [];
    const targetCount = count || 100;
    const delay = intervalMs || 60;

    for (let i = 0; i < targetCount; i++) {
      const start = performance.now();
      let latency = -1;
      let success = false;

      try {
        const fetchUrl = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now() + '_' + i;
        const res = await fetch(fetchUrl, {
          method: 'GET',
          cache: 'no-store',
          mode: 'no-cors'
        });
        latency = Math.max(0.1, performance.now() - start);
        success = true;
      } catch (err) {
        latency = -1;
        success = false;
      }

      if (success) {
        samples.push(latency);
      }

      // Compute rolling statistics
      let min = samples.length ? Math.min(...samples) : 0;
      let max = samples.length ? Math.max(...samples) : 0;
      let sum = samples.reduce((a, b) => a + b, 0);
      let avg = samples.length ? (sum / samples.length) : 0;

      self.postMessage({
        type: 'sample',
        index: i + 1,
        total: targetCount,
        latency: success ? Math.round(latency * 10) / 10 : -1,
        stats: {
          min: Math.round(min * 10) / 10,
          max: Math.round(max * 10) / 10,
          avg: Math.round(avg * 10) / 10,
          lossRate: Math.round(((i + 1 - samples.length) / (i + 1)) * 100)
        }
      });

      if (i < targetCount - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    }

    self.postMessage({ type: 'done', sampleCount: samples.length });
  }
};
