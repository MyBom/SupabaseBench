// bench.js
// Usage: node bench.js <SUPABASE_URL> <SUPABASE_ANON_KEY> <CLIENT_COUNT>
// Example: node bench.js http://192.168.0.50:8000 your_anon_key 1000

import { createClient } from '@supabase/supabase-js';

const [,, SUPABASE_URL, SUPABASE_KEY, CLIENT_COUNT_ARG] = process.argv;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Usage: node bench.js <SUPABASE_URL> <SUPABASE_ANON_KEY> <CLIENT_COUNT>");
  process.exit(1);
}
const CLIENT_COUNT = parseInt(CLIENT_COUNT_ARG || '1000', 10);

const stats = {
  sent: 0,
  received: 0,
  latencies: [], // ms
  errors: 0,
};

function makeId(i) {
  return `client-${i}`;
}

async function run() {
  console.log(`Starting benchmark: ${CLIENT_COUNT} clients => ${SUPABASE_URL}`);

  const clients = new Array(CLIENT_COUNT);

  // Shared back-end URL/key — each client is its own supabase client
  for (let i = 0; i < CLIENT_COUNT; i++) {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { params: { apikey: SUPABASE_KEY } } });
    const myId = makeId(i);

    // subscribe to changes on table 'bench'
    const chan = sb.channel('public:bench')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bench' }, payload => {
        // payload: { eventType, new: {...}, old: {...} }
        // Only process events about this client's id
        try {
          const rec = payload?.new;
          if (rec && rec.id === myId && rec._bench_sent_ts) {
            const sendTs = parseInt(rec._bench_sent_ts, 10);
            const rtt = Date.now() - sendTs;
            stats.received++;
            stats.latencies.push(rtt);
          }
        } catch (e) {
          stats.errors++;
        }
      })
      .subscribe(async status => {
        // console.debug('sub status', status);
      });

    clients[i] = { sb, id: myId };

    // create initial row (so each client has its row)
    try {
      await sb.from('bench').upsert({ id: myId, value: 'init', _bench_sent_ts: Date.now().toString() });
    } catch (e) {
      console.error('initial upsert error', e);
      stats.errors++;
    }
  }

  console.log('All clients created and subscribed.');

  // Do periodic updates: every 1000ms, each client upserts its row with timestamp
  setInterval(async () => {
    const start = Date.now();
    for (let i = 0; i < CLIENT_COUNT; i++) {
      const { sb, id } = clients[i];
      const sendTs = Date.now();
      // store the send timestamp in a transient column _bench_sent_ts (text)
      // Note: if your table doesn't have this column, Postgres will ignore it unless you added column.
      // So we rely on the DB storing/echoing it in the event payload. If not, you can measure roundtrip differently.
      try {
        await sb.from('bench').upsert({ id, value: `v${sendTs}`, _bench_sent_ts: sendTs.toString() });
        stats.sent++;
      } catch (e) {
        stats.errors++;
      }
    }
    // print intermediate stats occasionally
    if (stats.sent % (CLIENT_COUNT * 5) === 0) {
      printSummary();
    }
  }, 10000);

  // small periodic summary
  setInterval(() => printSummary(), 15000);
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = Array.from(arr).sort((a,b)=>a-b);
  const idx = Math.floor((p/100) * sorted.length);
  return sorted[Math.min(idx, sorted.length-1)];
}

function printSummary() {
  const lat = stats.latencies;
  const avg = lat.length ? (lat.reduce((a,b)=>a+b,0)/lat.length).toFixed(1) : '-';
  const min = lat.length ? Math.min(...lat) : '-';
  const max = lat.length ? Math.max(...lat) : '-';
  const p95 = pct(lat, 95);
  console.log(`SENT:${stats.sent} RECV:${stats.received} ERR:${stats.errors} | avg:${avg}ms min:${min}ms max:${max}ms p95:${p95}ms samples:${lat.length}`);
}

run().catch(e=>{ console.error(e); process.exit(1); });
