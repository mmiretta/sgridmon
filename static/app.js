'use strict';

// ── Global fetch wrapper: any 401 means session is gone → redirect to login ──
let _redirectingToLogin = false;
const _origFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  const resp = await _origFetch(input, init);
  if (resp.status === 401 && !_redirectingToLogin) {
    const url = typeof input === 'string' ? input : input.url;
    // Don't redirect on the auth endpoints themselves (login form handles its own errors)
    if (!url.includes('/api/auth/')) {
      _redirectingToLogin = true;
      location.href = '/login.html';
    }
  }
  return resp;
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  graph: null,
  snapshot: null,
  graphNodes: [],   // nodes passed to force-graph (real + virtual site anchors)
  graphLinks: [],   // links passed to force-graph
  openCases: {},    // node_id -> open case count
  selectedNodeId: null,
  nodeCases: [],
  ws: null,
  layout: 6,
  chartRange: '24h',
  connectivity: null,
  traffic: null,
  storage: null,
  acks: {},          // alert_name -> {id, acknowledged_at, ...}
  searchHighlight: new Set(),
  currentUser: null,
};

// ── Health colours ────────────────────────────────────────────────────────────
function healthColor(health) {
  switch (health) {
    case 'ok':       return '#3fb950';
    case 'warning':  return '#f0883e';
    case 'critical': return '#f85149';
    default:         return '#8b949e';
  }
}

// ── Node type short labels ────────────────────────────────────────────────────
function nodeTypeLabel(type) {
  switch (type) {
    case 'adminNode':      return 'ADM';
    case 'storageNode':    return 'STR';
    case 'gatewayNode':    return 'GTW';
    case 'apiGatewayNode': return 'GTW';
    case 'archiveNode':    return 'ARC';
    default:               return type ? type.slice(0, 3).toUpperCase() : 'NOD';
  }
}

// ── Build graph data from snapshot ───────────────────────────────────────────
function buildGraphData(snapshot) {
  const nodes = [];
  const links = [];

  for (const site of snapshot.sites) {
    nodes.push({
      id: 'site:' + site.id, __type: 'site',
      siteId: site.id, siteName: site.name, health: site.health, name: site.name,
    });
  }
  for (const node of snapshot.nodes) {
    nodes.push({ ...node, __type: 'node' });
    links.push({ source: node.id, target: 'site:' + node.siteId, __virtual: true });
  }
  for (const link of snapshot.links) {
    links.push({
      source: 'site:' + link.source, target: 'site:' + link.target,
      weight: link.weight, __virtual: false,
    });
  }
  return { nodes, links };
}

// L6: site anchors are VISIBLE hubs; node→hub links are visible (star topology)
function buildL6GraphData(snapshot) {
  const nodes = [];
  const links = [];

  for (const site of snapshot.sites) {
    nodes.push({
      id: 'site:' + site.id, __type: 'site', __hub: true,
      siteId: site.id, siteName: site.name, health: site.health, name: site.name,
    });
  }
  for (const node of snapshot.nodes) {
    nodes.push({ ...node, __type: 'node' });
    links.push({ source: node.id, target: 'site:' + node.siteId, __hub: true, __virtual: false });
  }
  for (const link of snapshot.links) {
    links.push({
      source: 'site:' + link.source, target: 'site:' + link.target,
      weight: link.weight, __virtual: false, __intersite: true,
    });
  }
  return { nodes, links };
}

// ── Acknowledgement helpers ───────────────────────────────────────────────────
function isAcked(alert) {
  return !!state.acks?.[alert.name];
}

function unackedAlerts(node) {
  return (node.alerts || []).filter(a => !isAcked(a));
}

function unackedCount(node) {
  return unackedAlerts(node).length;
}

// ── Health rank helper ────────────────────────────────────────────────────────
function healthRank(h) {
  return { critical: 3, warning: 2, unknown: 1, ok: 0 }[h] ?? 0;
}

// ── Per-pair throughput inference ─────────────────────────────────────────────
// Uses ONLY the grid network (eth0), which is the inter-node/inter-site path.
// Client traffic (eth2, S3 API) is excluded so external load doesn't pollute
// the inter-site flow estimate.
//
// With exactly 3 sites and per-site grid totals, assuming symmetric inter-site
// traffic, solve the linear system:
//   grid_out[A] = pair(A,B) + pair(A,C)
//   grid_out[B] = pair(A,B) + pair(B,C)
//   grid_out[C] = pair(A,C) + pair(B,C)
// → pair(A,B) = (grid_out[A] + grid_out[B] - grid_out[C]) / 2
function pairThroughput(siteAId, siteBId) {
  const sites = state.traffic?.sites;
  if (!sites) return 0;
  const ids = Object.keys(sites);
  if (ids.length !== 3) {
    const a = sites[siteAId], b = sites[siteBId];
    return ((a?.grid_out_per_sec || 0) + (b?.grid_out_per_sec || 0)) / 2;
  }
  const cId = ids.find(id => id !== siteAId && id !== siteBId);
  const oa = sites[siteAId]?.grid_out_per_sec || 0;
  const ob = sites[siteBId]?.grid_out_per_sec || 0;
  const oc = sites[cId]?.grid_out_per_sec     || 0;
  const ia = sites[siteAId]?.grid_in_per_sec  || 0;
  const ib = sites[siteBId]?.grid_in_per_sec  || 0;
  const ic = sites[cId]?.grid_in_per_sec      || 0;
  const fromOut = Math.max(0, (oa + ob - oc) / 2);
  const fromIn  = Math.max(0, (ia + ib - ic) / 2);
  return (fromOut + fromIn) / 2;
}

// ── Throughput formatting ─────────────────────────────────────────────────────
function fmtBps(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1) return '0';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let n = bytesPerSec, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n >= 100 ? `${n.toFixed(0)} ${units[i]}` : `${n.toFixed(1)} ${units[i]}`;
}

function throughputColor(bps) {
  // Above 5 GB/s = hot, 1 GB/s = warm, 100 MB/s = cool, otherwise neutral
  if (!bps) return '#484f58';
  if (bps > 5e9)  return '#f85149';
  if (bps > 1e9)  return '#f0883e';
  if (bps > 1e8)  return '#e3b341';
  if (bps > 1e6)  return '#3fb950';
  return '#7d8590';
}

// ── Graph init ────────────────────────────────────────────────────────────────
function initGraph() {
  const container = document.getElementById('graph-container');

  state.graph = ForceGraph()(container)
    .autoPauseRedraw(false)   // keep rendering every frame for particle animation
    .backgroundColor('#0d1117')
    .nodeId('id')
    .linkSource('source')
    .linkTarget('target')
    // Node rendering
    .nodeCanvasObject((node, ctx, scale) => drawNode(node, ctx, scale))
    .nodePointerAreaPaint((node, color, ctx) => {
      if (node.__type === 'site') {
        if (!node.__hub) return;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 26, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, 10, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    })
    // Link rendering
    .linkVisibility(link => !link.__virtual)
    .linkWidth(link => link.__intersite ? 2.5 : link.__hub ? 0.6 : (link.weight || 1) * 1.5)
    .linkColor(link => {
      if (link.__hub)     return 'rgba(48,54,61,0.5)';
      if (link.__virtual) return '#30363d';
      const src = typeof link.source === 'object' ? link.source : null;
      const tgt = typeof link.target === 'object' ? link.target : null;
      if (!src || !tgt) return '#484f58';
      return throughputColor(pairThroughput(src.siteId, tgt.siteId));
    })
    .linkCanvasObjectMode(link => (!link.__virtual && !link.__hub) ? 'after' : undefined)
    .linkCanvasObject((link, ctx, scale) => {
      const src = typeof link.source === 'object' ? link.source : null;
      const tgt = typeof link.target === 'object' ? link.target : null;
      if (!src || !tgt || src.x === undefined || tgt.x === undefined) return;

      drawTrafficParticles(link, src, tgt, ctx, scale);

      const bps = pairThroughput(src.siteId, tgt.siteId);
      if (!bps) return;

      // Single label at midpoint with the inferred per-pair throughput
      const mx = (src.x + tgt.x) / 2;
      const my = (src.y + tgt.y) / 2;
      const label = `↔ ${fmtBps(bps)}`;
      const color = throughputColor(bps);
      const fs = Math.max(5, 9 / scale);

      ctx.save();
      ctx.font = `700 ${fs}px monospace`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(13,17,23,0.92)';
      ctx.fillRect(mx - tw / 2 - 4, my - fs / 2 - 3, tw + 8, fs + 6);
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my);
      ctx.restore();
    })
    // Interactions
    .onNodeClick(onNodeClick)
    .onBackgroundClick(closePanel)
    // Frame hooks — dispatch by layout
    .onRenderFramePre((ctx, scale) => {
      if (state.layout === 1 || state.layout === 2 || state.layout === 3) drawSiteBackgrounds(ctx, scale);
      else if (state.layout === 4) drawHealthRowBg(ctx, scale);
    });

  // Tune forces for the default layout (L6 — site mesh topology)
  state.graph.d3Force('charge').strength(-60);
  state.graph.d3Force('link')
    .distance(l => l.__intersite ? 350 : l.__hub ? 80 : 40)
    .strength(l => l.__intersite ? 0.15 : l.__hub ? 0.6 : 0.4);
}

// ── Site background bubbles ───────────────────────────────────────────────────
function drawSiteBackgrounds(ctx, scale) {
  if (!state.snapshot) return;
  const PADDING = 28;

  for (const site of state.snapshot.sites) {
    const members = state.graphNodes.filter(
      n => n.__type === 'node' && n.siteId === site.id && n.x !== undefined
    );
    if (members.length === 0) continue;

    const xs = members.map(n => n.x);
    const ys = members.map(n => n.y);
    const minX = Math.min(...xs) - PADDING;
    const maxX = Math.max(...xs) + PADDING;
    const minY = Math.min(...ys) - PADDING;
    const maxY = Math.max(...ys) + PADDING;
    const w = maxX - minX;
    const h = maxY - minY;
    const r = 14;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(minX + r, minY);
    ctx.lineTo(maxX - r, minY);
    ctx.arcTo(maxX, minY, maxX, minY + r, r);
    ctx.lineTo(maxX, maxY - r);
    ctx.arcTo(maxX, maxY, maxX - r, maxY, r);
    ctx.lineTo(minX + r, maxY);
    ctx.arcTo(minX, maxY, minX, maxY - r, r);
    ctx.lineTo(minX, minY + r);
    ctx.arcTo(minX, minY, minX + r, minY, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(33, 38, 45, 0.45)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(48, 54, 61, 0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Site label + storage %
    const fontSize = Math.max(10, 13 / scale);
    ctx.font = `600 ${fontSize}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const storageData = state.storage?.sites?.[site.id];
    const pct = storageData?.used_pct;
    const pctStr = pct != null ? `  ${pct.toFixed(1)}%` : '';
    const labelColor = pct >= 90 ? '#f85149' : pct >= 70 ? '#f0883e' : 'rgba(125,133,144,0.9)';
    ctx.fillStyle = labelColor;
    ctx.fillText(site.name + pctStr, (minX + maxX) / 2, minY - 4);
    ctx.restore();
  }
}

// ── Site hub node (L6 only) ───────────────────────────────────────────────────
function storageColor(pct) {
  if (pct === null || pct === undefined) return '#484f58';
  if (pct >= 90) return '#f85149';
  if (pct >= 70) return '#f0883e';
  return '#3fb950';
}

function drawSiteHub(node, ctx, scale) {
  const R = 26;
  const storage = state.storage?.sites?.[node.siteId];
  const pct = storage?.used_pct ?? null;
  const arcColor = storageColor(pct);

  ctx.save();

  // Background fill
  ctx.beginPath();
  ctx.arc(node.x, node.y, R, 0, 2 * Math.PI);
  ctx.fillStyle = '#161b22';
  ctx.fill();

  // Storage usage arc (clockwise from 12 o'clock)
  if (pct !== null) {
    const start = -Math.PI / 2;
    const end   = start + (2 * Math.PI * pct / 100);

    // Faint filled sector
    ctx.beginPath();
    ctx.moveTo(node.x, node.y);
    ctx.arc(node.x, node.y, R - 1, start, end);
    ctx.closePath();
    ctx.fillStyle = arcColor + '22';
    ctx.fill();

    // Arc stroke on the rim
    ctx.beginPath();
    ctx.arc(node.x, node.y, R - 1, start, end);
    ctx.strokeStyle = arcColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Outer ring
  ctx.beginPath();
  ctx.arc(node.x, node.y, R, 0, 2 * Math.PI);
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Site name
  const fs = Math.max(5, 10 / scale);
  ctx.font = `700 ${fs}px -apple-system, sans-serif`;
  ctx.fillStyle = '#e6edf3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const yOffset = pct !== null ? -fs * 0.7 : 0;
  ctx.fillText(node.siteName, node.x, node.y + yOffset);

  // Percentage label
  if (pct !== null) {
    const pfs = Math.max(4, 9 / scale);
    ctx.font = `700 ${pfs}px monospace`;
    ctx.fillStyle = arcColor;
    ctx.fillText(`${pct.toFixed(1)}%`, node.x, node.y + fs * 0.6);
  }

  // Client-network throughput shown below the hub, split by direction.
  // ingest  = client_in  (S3 PUT — data arriving INTO the grid)
  // retrieve = client_out (S3 GET — data going OUT of the grid)
  // Always show ingest/retrieve so it's clear S3 is present (even at 0 MB/s).
  // Skip only if we have no traffic data for the site at all.
  const tr = state.traffic?.sites?.[node.siteId];
  if (tr) {
    const ingestBps   = tr.client_in_per_sec  || 0;
    const retrieveBps = tr.client_out_per_sec || 0;
    const cfs = Math.max(4, 8 / scale);
    ctx.font = `700 ${cfs}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let y = node.y + R + 4;
    ctx.fillStyle = '#3fb950';   // green = ingest (data flowing in)
    ctx.fillText(`S3 ↓ ingest ${fmtBps(ingestBps)}`, node.x, y);
    y += cfs + 2;
    ctx.fillStyle = '#f0883e';   // orange = retrieve (data flowing out)
    ctx.fillText(`S3 ↑ retrieve ${fmtBps(retrieveBps)}`, node.x, y);
  }

  ctx.restore();
}

// ── Node canvas drawing ───────────────────────────────────────────────────────
function drawNode(node, ctx, scale) {
  if (node.__type === 'site') {
    if (node.__hub) drawSiteHub(node, ctx, scale);
    return;
  }

  const R = 9;
  const hasOpenCase = (state.openCases[node.id] || 0) > 0;
  const effectiveAlertCount = unackedCount(node);
  const allAcked = node.alertCount > 0 && effectiveAlertCount === 0;
  const hasAlertNoCase = effectiveAlertCount > 0 && !hasOpenCase;
  // If the node has no live (non-acked) alerts and is not disconnected, paint it green.
  const displayHealth = (effectiveAlertCount === 0 && node.health !== 'unknown') ? 'ok' : node.health;
  const color = healthColor(displayHealth);

  ctx.save();

  // Search highlight: expanding ring animation
  if (state.searchHighlight.has(node.id)) {
    const t = Date.now() / 400;
    const pulse = (Math.sin(t) + 1) / 2;
    ctx.beginPath();
    ctx.arc(node.x, node.y, R + 6 + pulse * 8, 0, 2 * Math.PI);
    ctx.strokeStyle = '#e3b341';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#e3b341';
    ctx.shadowBlur = 12 + pulse * 10;
    ctx.globalAlpha = 0.6 + pulse * 0.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  // Pulsing glow ring: alert present but no open case
  if (hasAlertNoCase) {
    const t = Date.now() / 700;
    const pulse = (Math.sin(t) + 1) / 2;
    const outerR = R + 5 + pulse * 5;
    // Dim yellow ring if all alerts acknowledged, urgent red/orange if not
    const ringColor = allAcked ? '#e3b341'
      : node.health === 'critical' ? '#f85149' : '#f0883e';
    ctx.beginPath();
    ctx.arc(node.x, node.y, outerR, 0, 2 * Math.PI);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = ringColor;
    ctx.shadowBlur = 6 + pulse * 10;
    ctx.globalAlpha = 0.4 + pulse * 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  // Glow for critical
  if (displayHealth === 'critical') {
    ctx.shadowColor = '#f85149';
    ctx.shadowBlur = 8;
  }

  // Fill
  ctx.beginPath();
  ctx.arc(node.x, node.y, R, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowBlur = 0;

  // Dashed ring if open case exists
  if (hasOpenCase) {
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#f0883e';
    ctx.beginPath();
    ctx.arc(node.x, node.y, R + 3.5, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Disconnected: dim with X
  if (!node.isConnected) {
    ctx.fillStyle = 'rgba(13,17,23,0.55)';
    ctx.beginPath();
    ctx.arc(node.x, node.y, R, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.shadowBlur = 0;

  // Inner label: storage % if available, else type code
  const innerFontSize = Math.max(4, 5.5 / scale);
  ctx.font = `700 ${innerFontSize}px monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const innerLabel = (typeof node.storagePct === 'number')
    ? `${Math.round(node.storagePct)}%`
    : nodeTypeLabel(node.type);
  ctx.fillText(innerLabel, node.x, node.y);

  // Node name label below
  const labelSize = Math.max(5, 9 / scale);
  ctx.font = `${labelSize}px -apple-system, sans-serif`;
  ctx.fillStyle = '#e6edf3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(node.name, node.x, node.y + R + 3);

  // Alert count badge — only counts non-acknowledged alerts
  if (effectiveAlertCount > 0) {
    const bx = node.x + R - 2;
    const by = node.y - R + 2;
    const br = Math.max(3, 4 / scale);
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, 2 * Math.PI);
    ctx.fillStyle = displayHealth === 'critical' ? '#f85149' : '#f0883e';
    ctx.fill();
    if (br > 2.5) {
      const badgeFontSize = Math.max(3, br * 1.1);
      ctx.font = `700 ${badgeFontSize}px monospace`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(effectiveAlertCount > 9 ? '9+' : String(effectiveAlertCount), bx, by);
    }
  }

  ctx.restore();
}

// ── Layout switching ──────────────────────────────────────────────────────────
function _rebuildGraphData() {
  if (!state.snapshot) return;
  const { nodes, links } = state.layout === 6
    ? buildL6GraphData(state.snapshot)
    : buildGraphData(state.snapshot);
  state.graphNodes = nodes;
  state.graphLinks = links;
}

function setLayout(n) {
  const wasL6 = state.layout === 6;
  state.layout = n;
  const sel = el('layout-select');
  if (sel) sel.value = String(n);

  // Rebuild graph data when crossing the L6 boundary (different link structure)
  if (wasL6 !== (n === 6)) _rebuildGraphData();

  if (n === 1) {
    state.graphNodes.forEach(node => { node.fx = undefined; node.fy = undefined; });
    state.graph.d3Force('charge').strength(-120);
    state.graph.d3Force('link').distance(l => l.__virtual ? 40 : 220).strength(l => l.__virtual ? 0.4 : 0.2);
    state.graph.graphData({ nodes: [...state.graphNodes], links: [...state.graphLinks] });
    state.graph.d3ReheatSimulation();
  } else if (n === 2) {
    applyRadialLayout();
    setTimeout(() => state.graph.zoomToFit(600, 60), 50);
  } else if (n === 3) {
    applyColumnLayout();
    setTimeout(() => state.graph.zoomToFit(600, 60), 50);
  } else if (n === 4) {
    applyHealthRowsLayout();
    setTimeout(() => state.graph.zoomToFit(600, 60), 50);
  } else if (n === 5) {
    applyDenseLayout();
    setTimeout(() => state.graph.zoomToFit(600, 60), 50);
  } else if (n === 6) {
    state.graphNodes.forEach(node => { node.fx = undefined; node.fy = undefined; });
    // Tune forces: hub links cluster nodes tightly within their site
    state.graph.d3Force('charge').strength(-60);
    state.graph.d3Force('link')
      .distance(l => l.__intersite ? 350 : l.__hub ? 80 : 40)
      .strength(l => l.__intersite ? 0.15 : l.__hub ? 0.6 : 0.4);
    state.graph.graphData({ nodes: [...state.graphNodes], links: [...state.graphLinks] });
    state.graph.d3ReheatSimulation();
  }
}

function applyRadialLayout() {
  if (!state.snapshot) return;
  const W = state.graph.width();
  const H = state.graph.height();
  const cx = W / 2;
  const cy = H / 2;
  const sites = state.snapshot.sites;

  // Place sites in a circle (or triangle for 3 sites)
  const siteR = Math.min(W, H) * 0.30;
  const sitePos = {};
  sites.forEach((site, i) => {
    const angle = (2 * Math.PI * i / sites.length) - Math.PI / 2;
    sitePos[site.id] = { x: cx + siteR * Math.cos(angle), y: cy + siteR * Math.sin(angle) };
  });

  // Pin virtual site anchor nodes
  state.graphNodes.forEach(n => {
    if (n.__type === 'site') {
      const p = sitePos[n.siteId];
      if (p) { n.fx = p.x; n.fy = p.y; }
    }
  });

  // Group real nodes by site
  const bySite = {};
  state.graphNodes.filter(n => n.__type === 'node').forEach(n => {
    (bySite[n.siteId] = bySite[n.siteId] || []).push(n);
  });

  // Arrange nodes in rings around their site center
  sites.forEach(site => {
    const members = bySite[site.id] || [];
    const sp = sitePos[site.id];
    if (!sp || !members.length) return;

    if (members.length === 1) {
      members[0].fx = sp.x;
      members[0].fy = sp.y + 50;
      return;
    }

    // Multiple rings if many nodes
    const RING_MAX = 12;
    let placed = 0;
    let ring = 0;
    while (placed < members.length) {
      const count = ring === 0
        ? Math.min(RING_MAX, members.length)
        : Math.min(RING_MAX + ring * 8, members.length - placed);
      const r = 55 + ring * 45;
      for (let i = 0; i < count && placed < members.length; i++, placed++) {
        const angle = (2 * Math.PI * i / count) - Math.PI / 2;
        members[placed].fx = sp.x + r * Math.cos(angle);
        members[placed].fy = sp.y + r * Math.sin(angle);
      }
      ring++;
    }
  });

  state.graph.graphData({ nodes: [...state.graphNodes], links: [...state.graphLinks] });
}

// ── L3: Site columns ──────────────────────────────────────────────────────────
// Sites arranged left→right, nodes in a grid below each site label.
// Within each site: sorted by health severity (critical first).
function applyColumnLayout() {
  if (!state.snapshot) return;
  const sites = state.snapshot.sites;
  const bySite = {};
  state.graphNodes.filter(n => n.__type === 'node').forEach(n => {
    (bySite[n.siteId] = bySite[n.siteId] || []).push(n);
  });
  Object.values(bySite).forEach(arr =>
    arr.sort((a, b) => healthRank(b.health) - healthRank(a.health) || a.name.localeCompare(b.name))
  );

  const maxNodes = Math.max(...sites.map(s => (bySite[s.id] || []).length));
  const COLS_PER_SITE = Math.ceil(Math.sqrt(maxNodes));
  const SPACING = 30;
  const COL_GAP = COLS_PER_SITE * SPACING + 60;

  const totalW = sites.length * COL_GAP;
  const startX = -totalW / 2 + COL_GAP / 2;

  sites.forEach((site, si) => {
    const cx = startX + si * COL_GAP;
    const siteNode = state.graphNodes.find(n => n.__type === 'site' && n.siteId === site.id);
    if (siteNode) { siteNode.fx = cx; siteNode.fy = -200; }

    (bySite[site.id] || []).forEach((node, i) => {
      const col = i % COLS_PER_SITE;
      const row = Math.floor(i / COLS_PER_SITE);
      node.fx = cx + (col - (COLS_PER_SITE - 1) / 2) * SPACING;
      node.fy = -140 + row * SPACING;
    });
  });

  state.graph.graphData({ nodes: [...state.graphNodes], links: [...state.graphLinks] });
}

// ── L4: Health rows (NOC view) ────────────────────────────────────────────────
// Nodes arranged in horizontal rows by health severity.
// Within each row: sorted by site, then name.
const HEALTH_ROW_Y = { critical: -240, warning: -80, unknown: 80, ok: 240 };

function applyHealthRowsLayout() {
  if (!state.snapshot) return;

  // Hide virtual site anchors off-screen
  state.graphNodes.filter(n => n.__type === 'site').forEach(n => {
    n.fx = -9999; n.fy = -9999;
  });

  const byHealth = { critical: [], warning: [], unknown: [], ok: [] };
  state.graphNodes.filter(n => n.__type === 'node').forEach(n => {
    (byHealth[n.health] = byHealth[n.health] || []).push(n);
  });

  const SPACING = 28;
  Object.entries(byHealth).forEach(([health, nodes]) => {
    if (!nodes.length) return;
    nodes.sort((a, b) => a.siteId.localeCompare(b.siteId) || a.name.localeCompare(b.name));
    const totalW = (nodes.length - 1) * SPACING;
    nodes.forEach((node, i) => {
      node.fx = -totalW / 2 + i * SPACING;
      node.fy = HEALTH_ROW_Y[health] ?? 0;
    });
  });

  state.graph.graphData({ nodes: [...state.graphNodes], links: [...state.graphLinks] });
}

// Canvas background for L4: coloured stripe + label per health row
function drawHealthRowBg(ctx, scale) {
  const stripes = [
    { health: 'critical', color: 'rgba(248,81,73,0.07)',   label: 'CRITICAL', lc: '#f85149' },
    { health: 'warning',  color: 'rgba(240,136,62,0.07)',  label: 'WARNING',  lc: '#f0883e' },
    { health: 'unknown',  color: 'rgba(139,148,158,0.07)', label: 'UNKNOWN',  lc: '#8b949e' },
    { health: 'ok',       color: 'rgba(63,185,80,0.07)',   label: 'OK',       lc: '#3fb950' },
  ];
  const ROW_H = 60;

  stripes.forEach(({ health, color, label, lc }) => {
    const nodes = state.graphNodes.filter(n => n.__type === 'node' && n.health === health && n.fx !== -9999);
    if (!nodes.length) return;
    const xs = nodes.map(n => n.fx ?? n.x ?? 0);
    const y = HEALTH_ROW_Y[health];
    const minX = Math.min(...xs) - 24;
    const maxX = Math.max(...xs) + 24;

    ctx.fillStyle = color;
    ctx.fillRect(minX, y - ROW_H / 2, maxX - minX, ROW_H);

    const fs = Math.max(6, 10 / scale);
    ctx.font = `700 ${fs}px -apple-system, sans-serif`;
    ctx.fillStyle = lc;
    ctx.globalAlpha = 0.8;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, minX - 6, y);
    ctx.globalAlpha = 1;
  });
}

// ── L5: Dense grid ────────────────────────────────────────────────────────────
// All nodes in a compact grid, sorted by site → health severity → name.
// Site boundaries drawn as faint vertical separators in drawSiteBackgrounds.
function applyDenseLayout() {
  if (!state.snapshot) return;

  state.graphNodes.filter(n => n.__type === 'site').forEach(n => {
    n.fx = -9999; n.fy = -9999;
  });

  const real = state.graphNodes.filter(n => n.__type === 'node');
  real.sort((a, b) =>
    a.siteName.localeCompare(b.siteName) ||
    healthRank(b.health) - healthRank(a.health) ||
    a.name.localeCompare(b.name)
  );

  const N = real.length;
  const COLS = Math.ceil(Math.sqrt(N * 1.6));
  const SPACING = 26;
  const offsetX = -((COLS - 1) * SPACING) / 2;
  const ROWS = Math.ceil(N / COLS);
  const offsetY = -((ROWS - 1) * SPACING) / 2;

  real.forEach((node, i) => {
    node.fx = offsetX + (i % COLS) * SPACING;
    node.fy = offsetY + Math.floor(i / COLS) * SPACING;
  });

  state.graph.graphData({ nodes: [...state.graphNodes], links: [...state.graphLinks] });
}

// ── Refresh graph data ────────────────────────────────────────────────────────
// Fields that change on each poll (health, alerts) — updated in-place.
const NODE_LIVE_FIELDS = ['health','alertCount','alerts','services','isConnected','isPrimaryAdmin','type','storagePct','fqdn','ip','hardware'];

function applySnapshot(snapshot) {
  state.snapshot = snapshot;

  const prevNodeIds = new Set(state.graphNodes.filter(n => n.__type === 'node').map(n => n.id));
  const newNodeIds  = new Set(snapshot.nodes.map(n => n.id));
  const structureChanged =
    prevNodeIds.size !== newNodeIds.size ||
    snapshot.sites.length !== state.graphNodes.filter(n => n.__type === 'site').length ||
    [...newNodeIds].some(id => !prevNodeIds.has(id));

  if (!structureChanged) {
    // ── Fast path: only update live fields in-place, never touch the simulation ──
    const newDataMap = new Map(snapshot.nodes.map(n => [n.id, n]));
    state.graphNodes.forEach(gn => {
      if (gn.__type !== 'node') return;
      const nd = newDataMap.get(gn.id);
      if (!nd) return;
      NODE_LIVE_FIELDS.forEach(f => { gn[f] = nd[f]; });
    });
    // L4 buckets re-sort nodes by health — reapply without reheat
    if (state.layout === 4) applyHealthRowsLayout();
  } else {
    // ── Slow path: full rebuild, preserving positions ──
    const { nodes, links } = state.layout === 6
      ? buildL6GraphData(snapshot)
      : buildGraphData(snapshot);

    const posMap = new Map(state.graphNodes.map(n => [n.id, n]));
    nodes.forEach(n => {
      const prev = posMap.get(n.id);
      if (!prev) return;
      if (prev.x  !== undefined) { n.x = prev.x;   n.y = prev.y;   }
      if (prev.vx !== undefined) { n.vx = prev.vx;  n.vy = prev.vy; }
      if (prev.fx !== undefined) { n.fx = prev.fx;  n.fy = prev.fy; }
    });

    state.graphNodes = nodes;
    state.graphLinks = links;
    state.graph.graphData({ nodes: [...nodes], links: [...links] });

    if      (state.layout === 2) applyRadialLayout();
    else if (state.layout === 3) applyColumnLayout();
    else if (state.layout === 4) applyHealthRowsLayout();
    else if (state.layout === 5) applyDenseLayout();
  }

  updateStats();
}

function updateStats() {
  if (!state.snapshot) return;
  const { nodes, sites } = state.snapshot;

  el('stat-nodes').textContent = nodes.length;
  el('stat-sites').textContent = sites.length;

  // Alerts badge: only count non-acknowledged alerts
  buildAlertsList();
  const unackedTotal = _allAlerts.filter(a => !state.acks?.[a.name]).length;
  el('alerts-dropdown-count').textContent = unackedTotal;
  el('alerts-dropdown-btn').classList.toggle('has-alerts', unackedTotal > 0);

  // Topbar health dot — based on unacked alerts only
  const hasUnackedCritical = nodes.some(n =>
    n.health === 'critical' && unackedAlerts(n).length > 0
  );
  el('ws-dot').className = 'status-dot ' + (
    hasUnackedCritical ? 'critical' : unackedTotal === 0 ? 'ok' : 'warning'
  );
}

// ── Alerts dropdown ───────────────────────────────────────────────────────────
const SEV_RANK = { critical: 3, major: 2, minor: 1, notice: 0 };
let _alertFilter = 'all';
let _allAlerts   = [];
let _alertGroups = [];   // [{name, severity, nodes[], ack?}]

function buildAlertsList() {
  if (!state.snapshot) return;
  _allAlerts = [];
  state.snapshot.nodes.forEach(node => {
    (node.alerts || []).forEach(a => _allAlerts.push({
      ...a, nodeName: node.name, siteName: node.siteName, nodeId: node.id,
    }));
  });
  _allAlerts.sort((a, b) =>
    (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) ||
    new Date(b.triggeredAt) - new Date(a.triggeredAt)
  );

  // Group by alert name
  const byName = new Map();
  _allAlerts.forEach(a => {
    if (!byName.has(a.name)) byName.set(a.name, { name: a.name, severity: a.severity, nodes: [] });
    byName.get(a.name).nodes.push(a);
  });
  // Sort groups by max severity
  _alertGroups = [...byName.values()].sort((a, b) =>
    (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0)
  );
}

async function loadAcks() {
  try {
    state.acks = await fetch('/api/acks').then(r => r.json());
    if (state.snapshot) updateStats();
  } catch (_) {}
}

async function ackAlert(alertName) {
  await fetch('/api/acks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alert_name: alertName }),
  });
  await loadAcks();
  _renderAlertGroups();
  updateStats();
  // Refresh open node panel so its alerts reflect the new ack state
  if (state.selectedNodeId) refreshPanel(state.selectedNodeId);
}

async function unackAlert(ackId) {
  await fetch(`/api/acks/${ackId}`, { method: 'DELETE' });
  await loadAcks();
  _renderAlertGroups();
  updateStats();
  if (state.selectedNodeId) refreshPanel(state.selectedNodeId);
}

function renderAlertsDropdown() {
  if (!state.snapshot) return;
  buildAlertsList();
  el('alerts-dropdown-count').textContent = _allAlerts.length;
  el('alerts-dropdown-btn').classList.toggle('has-alerts', _allAlerts.length > 0);
  _renderAlertGroups();
}

function _renderAlertGroups() {
  const filtered = _alertFilter === 'all'
    ? _alertGroups
    : _alertGroups
        .map(g => ({ ...g, nodes: g.nodes.filter(n => n.severity === _alertFilter) }))
        .filter(g => g.nodes.length > 0);

  el('alerts-dd-title').textContent =
    `${_allAlerts.length} alerts · ${filtered.length} type${filtered.length !== 1 ? 's' : ''}` +
    (_alertFilter !== 'all' ? ` · ${_alertFilter}` : '');

  const list = el('alerts-dropdown-list');

  if (!filtered.length) {
    list.innerHTML = '<div class="dd-empty">No alerts for this filter</div>';
    return;
  }

  const unacked = filtered.filter(g => !state.acks?.[g.name]);
  const acked   = filtered.filter(g =>  state.acks?.[g.name]);

  // Build DOM directly — no inline onclick, use data attributes + event delegation
  list.innerHTML = '';

  const renderGroup = (g, isAcked) => {
    const ack = state.acks?.[g.name];
    const sev = g.severity || 'notice';

    // <details> gives native expand/collapse — no JS toggle needed
    const wrap = document.createElement('details');
    wrap.className = 'alert-group';

    const summary = document.createElement('summary');
    summary.className = 'alert-group-header';
    summary.innerHTML = `
      <span class="alert-group-sev ${sev}"></span>
      <span class="alert-group-name${isAcked ? ' acked' : ''}" title="${escHtml(g.name)}">${escHtml(g.name)}</span>
      <span class="alert-group-meta">
        ${isAcked ? '<span class="ack-badge">✓ ACK</span>' : ''}
        <span class="alert-group-count">${g.nodes.length} node${g.nodes.length !== 1 ? 's' : ''}</span>
        <span class="chevron">›</span>
      </span>`;

    const body = document.createElement('div');
    body.className = 'alert-group-body';

    const chips = document.createElement('div');
    chips.className = 'alert-node-chips';
    g.nodes.forEach(n => {
      const chip = document.createElement('span');
      chip.className = 'alert-node-chip';
      chip.innerHTML = `<span class="chip-dot" style="background:${healthColor(n.health||'warning')}"></span>${escHtml(n.nodeName)}`;
      chip.addEventListener('click', e => {
        e.stopPropagation();
        el('alerts-dropdown').classList.add('hidden');
        jumpToNode(n.nodeId);
      });
      chips.appendChild(chip);
    });

    const actions = document.createElement('div');
    actions.className = 'alert-group-actions';
    if (isAcked) {
      const info = document.createElement('span');
      info.className = 'ack-info';
      info.textContent = `Acked ${new Date(ack.acknowledged_at).toLocaleDateString()}`;
      const btn = document.createElement('button');
      btn.className = 'btn-unack';
      btn.textContent = 'Unacknowledge';
      btn.addEventListener('click', e => { e.stopPropagation(); unackAlert(ack.id); });
      actions.append(info, btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn-ack';
      btn.textContent = 'Acknowledge';
      btn.addEventListener('click', e => { e.stopPropagation(); ackAlert(g.name); });
      actions.appendChild(btn);
    }

    body.append(chips, actions);
    wrap.append(summary, body);
    return wrap;
  };

  unacked.forEach(g => list.appendChild(renderGroup(g, false)));

  if (acked.length) {
    const sep = document.createElement('div');
    sep.style.cssText = 'font-size:10px;color:var(--muted);padding:6px 12px;border-top:1px solid var(--border);';
    sep.textContent = `ACKNOWLEDGED (${acked.length})`;
    list.appendChild(sep);
    acked.forEach(g => list.appendChild(renderGroup(g, true)));
  }
}

// ── Load graph data ───────────────────────────────────────────────────────────
async function loadGraph() {
  try {
    const resp = await fetch('/api/graph');
    const snapshot = await resp.json();
    if (snapshot.nodes) applySnapshot(snapshot);
  } catch (e) {
    showToast('Failed to load graph data');
  }
}

// ── Traffic particles ─────────────────────────────────────────────────────────
function drawTrafficParticles(link, src, tgt, ctx, scale) {
  const sites = state.traffic?.sites;
  if (!sites) return;

  const srcData = sites[src.siteId];
  const tgtData = sites[tgt.siteId];
  if (!srcData && !tgtData) return;

  const outRate = srcData?.bytes_out_per_sec || 0;  // src → tgt
  const inRate  = tgtData?.bytes_out_per_sec || 0;  // tgt → src

  // Particle count: log scale — 10MB/s→1, 100MB/s→2, 1GB/s→3, 10GB/s→4…
  const nOut = Math.min(6, Math.max(0, Math.floor(Math.log10(outRate / 1e6 + 1))));
  const nIn  = Math.min(6, Math.max(0, Math.floor(Math.log10(inRate  / 1e6 + 1))));
  if (nOut + nIn === 0) return;

  const dx = tgt.x - src.x;
  const dy = tgt.y - src.y;
  const t = Date.now() / 2500;
  const PR = Math.max(1.2, 2.5 / scale);

  ctx.save();

  // src → tgt  (blue)
  for (let i = 0; i < nOut; i++) {
    const p = (t + i / Math.max(nOut, 1)) % 1;
    ctx.beginPath();
    ctx.arc(src.x + dx * p, src.y + dy * p, PR, 0, 2 * Math.PI);
    ctx.fillStyle = '#388bfd';
    ctx.fill();
  }

  // tgt → src  (green)
  for (let i = 0; i < nIn; i++) {
    const p = (t + i / Math.max(nIn, 1)) % 1;
    ctx.beginPath();
    ctx.arc(tgt.x - dx * p, tgt.y - dy * p, PR, 0, 2 * Math.PI);
    ctx.fillStyle = '#3fb950';
    ctx.fill();
  }

  ctx.restore();
}

async function loadConnectivity() {
  try {
    state.connectivity = await fetch('/api/connectivity').then(r => r.json());
  } catch (_) {}
}

async function loadTraffic() {
  try {
    state.traffic = await fetch('/api/traffic').then(r => r.json());
  } catch (_) {}
}

// ── Left charts panel ─────────────────────────────────────────────────────────
const CHART_COLORS_BY_SITE = {
  // Match the colors used in the graph
};
const CHART_SERIES_PALETTE = ['#3fb950', '#f0883e', '#58a6ff', '#bc8cff', '#f85149', '#e3b341', '#79c0ff'];

function _colorForSite(name, idx) {
  // Reuse site palette already defined for graph rendering if present
  if (typeof SITE_PALETTE !== 'undefined' && SITE_PALETTE[name]) return SITE_PALETTE[name];
  return CHART_SERIES_PALETTE[idx % CHART_SERIES_PALETTE.length];
}

function _fmtRate(bps) {
  if (!bps || bps < 1) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let n = bps, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n >= 100 ? `${n.toFixed(0)} ${units[i]}` : `${n.toFixed(1)} ${units[i]}`;
}

function _fmtCount(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

// Plotted chart registry — used by the crosshair/tooltip mousemove handler.
// Each canvas remembers its last draw context (series, scaling fns, options).
const _chartRegistry = new WeakMap();

function _formatTimeAxis(t, rangeSecs) {
  const d = new Date(t * 1000);
  // For ranges ≤ 24h show HH:MM. For longer, show day + HH.
  if (rangeSecs <= 86400) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleDateString([], { weekday: 'short' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', hour12: false });
}

function _xTickCount(W) {
  if (W < 180) return 3;
  if (W < 280) return 4;
  return 5;
}

/**
 * Draw a multi-series line chart on a canvas (Grafana-style).
 *   series: [{ label, color, points: [[t,v],...] }, ...]
 *   opts: { yFormat, yMin?, yMax?, fill?, rangeSecs }
 */
function drawLineChart(canvas, series, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Aggregate domain
  let tMin = Infinity, tMax = -Infinity;
  let vMin = opts.yMin ?? 0, vMax = -Infinity;
  series.forEach(s => {
    s.points.forEach(([t, v]) => {
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      if (v > vMax) vMax = v;
    });
  });
  if (!isFinite(tMin) || !isFinite(vMax)) {
    ctx.fillStyle = '#6e7681';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('no data', W / 2, H / 2);
    _chartRegistry.set(canvas, null);
    return;
  }
  if (opts.yMax != null) {
    vMax = opts.yMax;
  } else {
    if (vMax === vMin) vMax = vMin + 1;
    vMax += (vMax - vMin) * 0.1;
  }

  // Axes / grid
  const PAD_L = 42, PAD_R = 6, PAD_T = 6, PAD_B = 16;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const xAt = t => PAD_L + ((t - tMin) / (tMax - tMin)) * plotW;
  const yAt = v => PAD_T + (1 - (v - vMin) / (vMax - vMin)) * plotH;

  // Plot area background (subtle Grafana panel feel)
  ctx.fillStyle = 'rgba(22,27,34,.4)';
  ctx.fillRect(PAD_L, PAD_T, plotW, plotH);

  // Y grid + labels (4 ticks for finer detail)
  const yTicks = 4;
  ctx.strokeStyle = 'rgba(48,54,61,.4)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8b949e';
  ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= yTicks; i++) {
    const v = vMin + (vMax - vMin) * (i / yTicks);
    const y = yAt(v);
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(W - PAD_R, y);
    ctx.stroke();
    ctx.fillText(opts.yFormat ? opts.yFormat(v) : v.toFixed(0), PAD_L - 4, y);
  }

  // X grid + labels (4-5 ticks based on width)
  const xTicks = _xTickCount(plotW);
  const rangeSecs = opts.rangeSecs || (tMax - tMin);
  ctx.strokeStyle = 'rgba(48,54,61,.25)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  for (let i = 0; i <= xTicks; i++) {
    const t = tMin + (tMax - tMin) * (i / xTicks);
    const x = xAt(t);
    ctx.beginPath();
    ctx.moveTo(x, PAD_T);
    ctx.lineTo(x, PAD_T + plotH);
    ctx.stroke();
    ctx.fillText(_formatTimeAxis(t, rangeSecs), x, H - 2);
  }

  // Plot border
  ctx.strokeStyle = 'rgba(48,54,61,.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD_L + 0.5, PAD_T + 0.5, plotW - 1, plotH - 1);

  // Series
  series.forEach(s => {
    if (!s.points.length) return;
    // Fill underneath first (so lines sit on top)
    if (opts.fill) {
      ctx.beginPath();
      ctx.moveTo(xAt(s.points[0][0]), yAt(vMin));
      s.points.forEach(([t, v]) => ctx.lineTo(xAt(t), yAt(v)));
      ctx.lineTo(xAt(s.points[s.points.length - 1][0]), yAt(vMin));
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
      grad.addColorStop(0, s.color + '40');
      grad.addColorStop(1, s.color + '08');
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    s.points.forEach(([t, v], i) => {
      const x = xAt(t), y = yAt(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  // Stash render state so the crosshair handler can use it
  _chartRegistry.set(canvas, {
    series, opts, tMin, tMax, vMin, vMax,
    PAD_L, PAD_R, PAD_T, PAD_B, plotW, plotH, W, H, xAt, yAt,
  });
}

// ── Crosshair + tooltip (shared across all chart canvases) ──
function _bindChartCrosshair(canvas) {
  const tooltip = el('chart-tooltip');
  canvas.addEventListener('mousemove', evt => {
    const st = _chartRegistry.get(canvas);
    if (!st) return;
    const rect = canvas.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    if (px < st.PAD_L || px > st.PAD_L + st.plotW) {
      _redrawIfNeeded(canvas);
      tooltip.classList.add('hidden');
      return;
    }
    // Convert pixel x → time
    const t = st.tMin + ((px - st.PAD_L) / st.plotW) * (st.tMax - st.tMin);
    // Snap each series to nearest point
    const rows = st.series.map(s => {
      if (!s.points.length) return null;
      let best = s.points[0], bestDt = Math.abs(s.points[0][0] - t);
      for (const p of s.points) {
        const dt = Math.abs(p[0] - t);
        if (dt < bestDt) { best = p; bestDt = dt; }
      }
      return { label: s.label, color: s.color, t: best[0], v: best[1] };
    }).filter(Boolean);

    // Redraw the chart (clears old crosshair) then draw new crosshair
    drawLineChart(canvas, st.series, st.opts);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Vertical line
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(px, st.PAD_T);
    ctx.lineTo(px, st.PAD_T + st.plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    // Markers at each series intersection
    rows.forEach(r => {
      const cx = st.xAt(r.t), cy = st.yAt(r.v);
      ctx.fillStyle = r.color;
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0d1117';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Tooltip content
    const fmt = st.opts.yFormat || (v => v.toFixed(2));
    const tStr = new Date(rows[0].t * 1000).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    tooltip.innerHTML =
      `<div class="tt-time">${tStr}</div>` +
      rows.map(r =>
        `<div class="tt-row"><span class="tt-label" style="--series-color:${r.color}">${escHtml(r.label)}</span>` +
        `<span class="tt-val">${fmt(r.v)}</span></div>`
      ).join('');
    tooltip.classList.remove('hidden');
    // Position to the right of cursor, clamp inside viewport
    const ttW = tooltip.offsetWidth, ttH = tooltip.offsetHeight;
    let tx = evt.clientX + 14;
    let ty = evt.clientY + 14;
    if (tx + ttW > window.innerWidth - 8)  tx = evt.clientX - ttW - 14;
    if (ty + ttH > window.innerHeight - 8) ty = evt.clientY - ttH - 14;
    tooltip.style.left = tx + 'px';
    tooltip.style.top  = ty + 'px';
  });
  canvas.addEventListener('mouseleave', () => {
    tooltip.classList.add('hidden');
    _redrawIfNeeded(canvas);
  });
}

function _redrawIfNeeded(canvas) {
  const st = _chartRegistry.get(canvas);
  if (st) drawLineChart(canvas, st.series, st.opts);
}

function _setLegend(elId, series, yFmt) {
  const html = series.map(s => {
    const last = s.points.length ? s.points[s.points.length - 1][1] : 0;
    return `<span class="lg" style="--series-color:${s.color}">${escHtml(s.label)} <strong style="color:${s.color}">${yFmt(last)}</strong></span>`;
  }).join('');
  el(elId).innerHTML = html;
}

function _currentValue(seriesArr) {
  if (!seriesArr || !seriesArr.length) return 0;
  return seriesArr[seriesArr.length - 1][1] || 0;
}

async function loadCharts() {
  const range = state.chartRange || '24h';
  try {
    const data = await fetch('/api/charts?range=' + encodeURIComponent(range))
      .then(r => r.json());
    if (data.error) {
      el('charts-status').textContent = 'error';
      return;
    }
    state.lastCharts = data;
    renderCharts(data);
    const t = new Date(data.fetched_at * 1000);
    el('charts-status').textContent = `· upd ${t.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
  } catch (e) {
    el('charts-status').textContent = 'offline';
  }
}

function setChartRange(range) {
  state.chartRange = range;
  document.querySelectorAll('#charts-range-bar button').forEach(b =>
    b.classList.toggle('active', b.dataset.range === range));
  loadCharts();
}

function renderCharts(d) {
  const R = d.range_seconds || 86400;

  // 1) S3 ingest by site
  const ingestSites = Object.keys(d.ingest_by_site || {}).sort();
  const ingestSeries = ingestSites.map((name, i) => ({
    label: name,
    color: _colorForSite(name, i),
    points: d.ingest_by_site[name],
  }));
  drawLineChart(el('chart-ingest-site'), ingestSeries,
    { yFormat: _fmtRate, fill: true, rangeSecs: R });
  _setLegend('legend-ingest-site', ingestSeries, _fmtRate);
  el('now-ingest-site').textContent =
    _fmtRate(ingestSeries.reduce((s, x) => s + _currentValue(x.points), 0));

  // 2) S3 retrieve by site
  const retrieveSites = Object.keys(d.retrieve_by_site || {}).sort();
  const retrieveSeries = retrieveSites.map((name, i) => ({
    label: name,
    color: _colorForSite(name, i),
    points: d.retrieve_by_site[name],
  }));
  drawLineChart(el('chart-retrieve-site'), retrieveSeries,
    { yFormat: _fmtRate, fill: true, rangeSecs: R });
  _setLegend('legend-retrieve-site', retrieveSeries, _fmtRate);
  el('now-retrieve-site').textContent =
    _fmtRate(retrieveSeries.reduce((s, x) => s + _currentValue(x.points), 0));

  // 3) ILM queue (total / client / background)
  const ilmSeries = [
    { label: 'total',      color: '#f85149', points: d.ilm_total      || [] },
    { label: 'client',     color: '#f0883e', points: d.ilm_client     || [] },
    { label: 'background', color: '#58a6ff', points: d.ilm_background || [] },
  ];
  drawLineChart(el('chart-ilm'), ilmSeries, { yFormat: _fmtCount, rangeSecs: R });
  _setLegend('legend-ilm', ilmSeries, _fmtCount);
  el('now-ilm').textContent = _fmtCount(_currentValue(d.ilm_total));

  // 4) Grid total ingest / retrieve
  const totalSeries = [
    { label: 'ingest',   color: '#3fb950', points: d.ingest_total   || [] },
    { label: 'retrieve', color: '#f0883e', points: d.retrieve_total || [] },
  ];
  drawLineChart(el('chart-total'), totalSeries,
    { yFormat: _fmtRate, fill: true, rangeSecs: R });
  _setLegend('legend-total', totalSeries, _fmtRate);
  const totIng = _currentValue(d.ingest_total);
  const totRet = _currentValue(d.retrieve_total);
  el('now-total').textContent = `↓${_fmtRate(totIng)}  ↑${_fmtRate(totRet)}`;

  // 5) Cassandra reaper · repaired % by keyspace
  const KEYSPACE_COLOR = {
    storagegrid: '#58a6ff',
    reaper_db:   '#bc8cff',
    s3_batch:    '#f0883e',
  };
  const keyspaces = Object.keys(d.reaper_by_keyspace || {}).sort();
  const reaperSeries = keyspaces.map((name, i) => ({
    label: name,
    color: KEYSPACE_COLOR[name] || CHART_SERIES_PALETTE[i % CHART_SERIES_PALETTE.length],
    points: d.reaper_by_keyspace[name],
  }));
  drawLineChart(el('chart-reaper'), reaperSeries, {
    yFormat: v => v.toFixed(0) + '%',
    yMin: 0, yMax: 105, rangeSecs: R,
  });
  _setLegend('legend-reaper', reaperSeries, v => v.toFixed(1) + '%');
  // "now" shows the worst keyspace right now
  const worstNow = reaperSeries.reduce(
    (min, s) => Math.min(min, _currentValue(s.points) || 100),
    100,
  );
  const reaperColor =
    worstNow >= 100 ? '#3fb950' :
    worstNow >= 90  ? '#f0883e' : '#f85149';
  el('now-reaper').innerHTML =
    `<span style="color:${reaperColor}">${worstNow.toFixed(1)}%</span>`;
}

function toggleChartsPanel(forceCollapse) {
  const body = document.body;
  if (forceCollapse === true) body.classList.add('charts-collapsed');
  else if (forceCollapse === false) body.classList.remove('charts-collapsed');
  else body.classList.toggle('charts-collapsed');
  // Notify graph to refit
  if (state.graph) {
    setTimeout(() => state.graph.zoomToFit(400, 60), 300);
  }
}

async function loadStorage() {
  try {
    const data = await fetch('/api/storage').then(r => r.json());
    if (data.sites && Object.keys(data.sites).length > 0) {
      state.storage = data;
      updateStorageStat();
    } else {
      setTimeout(loadStorage, 8000);   // retry until data is ready
    }
  } catch (_) {
    setTimeout(loadStorage, 8000);
  }
}

function updateStorageStat() {
  const sites = Object.values(state.storage?.sites || {});
  if (!sites.length) return;
  const worst = sites.reduce((a, b) => (a.used_pct > b.used_pct ? a : b));
  const el_ = el('stat-storage');
  if (!el_) return;
  el_.textContent = `${worst.name} ${worst.used_pct.toFixed(1)}%`;
  el_.className = 'val' + (worst.used_pct >= 90 ? ' red' : worst.used_pct >= 70 ? ' orange' : '');
}

async function loadOpenCases() {
  try {
    const [summary, all] = await Promise.all([
      fetch('/api/cases/open-summary').then(r => r.json()),
      fetch('/api/cases?status=open').then(r => r.json()),
    ]);
    state.openCases = summary;
    renderCasesDropdown(all);
    updateStats();
    // No graphData call needed: node canvas redraws per-frame reading state.openCases
  } catch (_) {}
}

function renderCasesDropdown(cases) {
  const btn = el('cases-dropdown-btn');
  const countEl = el('cases-dropdown-count');
  const list = el('cases-dropdown-list');

  countEl.textContent = cases.length;
  btn.classList.toggle('has-cases', cases.length > 0);

  if (!cases.length) {
    list.innerHTML = '<div class="dd-empty">No open cases</div>';
    return;
  }

  list.innerHTML = cases.map((c, i) => {
    const date = new Date(c.opened_at).toLocaleDateString();
    const refHtml = c.case_ref ? `<span class="dd-case-ref">${escHtml(c.case_ref)}</span>` : '';
    return `
      <div class="dd-case-item" data-node-id="${escHtml(c.node_id)}" onclick="jumpToNode('${escHtml(c.node_id)}')">
        <div class="dd-case-row1">
          <span class="dd-case-num">#${i + 1}</span>
          ${refHtml}
          <span class="dd-case-title">${escHtml(c.title)}</span>
        </div>
        <div class="dd-case-meta">
          <span class="dd-case-node">${escHtml(c.node_name)}</span>
          <span>${escHtml(c.site_name || '')}</span>
          <span>${date}</span>
        </div>
      </div>`;
  }).join('');
}

function jumpToNode(nodeId) {
  el('cases-dropdown').classList.add('hidden');
  const node = state.snapshot?.nodes.find(n => n.id === nodeId);
  if (!node) return;
  // Center graph on node then open panel
  const gn = state.graphNodes.find(n => n.id === nodeId);
  if (gn && gn.x !== undefined) {
    state.graph.centerAt(gn.x, gn.y, 500);
    state.graph.zoom(2, 500);
  }
  setTimeout(() => openPanel(node), 520);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    el('ws-dot').className = 'status-dot ok';
    el('ws-label').textContent = 'live';
  };

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') {
      applySnapshot(msg.data);
      // Refresh panel if open
      if (state.selectedNodeId) refreshPanel(state.selectedNodeId);
    } else if (msg.type === 'error') {
      el('ws-dot').className = 'status-dot warning';
      el('ws-label').textContent = 'poll error';
      showToast('StorageGRID poll error: ' + msg.message);
    }
  };

  ws.onclose = () => {
    el('ws-dot').className = 'status-dot';
    el('ws-label').textContent = 'reconnecting…';
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();
}

// ── Node click ────────────────────────────────────────────────────────────────
function onNodeClick(node) {
  if (node.__type === 'site') return;
  openPanel(node);
}

// ── Panel ─────────────────────────────────────────────────────────────────────
async function openPanel(node) {
  state.selectedNodeId = node.id;
  el('panel-node-name').textContent = node.name;
  const stMeta = (typeof node.storagePct === 'number') ? ` · ${node.storagePct}% used` : '';
  el('panel-node-meta').textContent = `${node.siteName} · ${nodeTypeLabel(node.type)}${stMeta}`;

  // FQDN + IP
  const ipBox = el('panel-node-ip');
  if (node.fqdn || node.ip) {
    ipBox.style.display = 'flex';
    ipBox.innerHTML = '';
    if (node.fqdn) {
      const span = document.createElement('span');
      span.className = 'copyable';
      span.title = 'Click to copy FQDN';
      span.textContent = node.fqdn;
      span.addEventListener('click', () => {
        navigator.clipboard?.writeText(node.fqdn);
        showToast('FQDN copied');
      });
      ipBox.appendChild(span);
    }
    if (node.ip) {
      const span = document.createElement('span');
      span.className = 'copyable';
      span.title = 'Click to copy IP';
      span.textContent = node.ip;
      span.addEventListener('click', () => {
        navigator.clipboard?.writeText(node.ip);
        showToast('IP copied');
      });
      ipBox.appendChild(span);
    }
  } else {
    ipBox.style.display = 'none';
  }

  const badge = el('panel-health-badge');
  badge.textContent = node.health;
  badge.className = 'health-badge ' + (node.health || 'unknown');

  el('services-list').innerHTML = '<span class="empty-msg">Loading…</span>';
  el('node-panel').classList.add('open');

  // Reset cases form
  el('new-case-form').style.display = 'none';
  el('closed-cases-list').style.display = 'none';
  el('btn-history-toggle').textContent = 'Show closed cases';

  renderHardware(node.hardware);
  renderPanelAlerts(node.alerts || []);
  renderServices(node.services || []);
  loadNodeNotes(node);
  await loadNodeCases(node);
}

function renderHardware(hw) {
  const section = el('section-hardware');
  if (!hw || Object.keys(hw).length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  const rows = [];
  if (hw.model) {
    rows.push(`<div class="hw-row"><span class="label">Model</span><span class="value"><span class="hw-model">${escHtml(hw.model)}</span></span></div>`);
  }
  if (hw.vendor)             rows.push(`<div class="hw-row"><span class="label">Vendor</span><span class="value">${escHtml(hw.vendor)}</span></div>`);
  if (hw.board_serial)       rows.push(`<div class="hw-row"><span class="label">Board S/N</span><span class="value">${escHtml(hw.board_serial)}</span></div>`);
  if (hw.storage_chassis_serial) rows.push(`<div class="hw-row"><span class="label">Storage S/N</span><span class="value">${escHtml(hw.storage_chassis_serial)}</span></div>`);
  if (hw.bios_version)       rows.push(`<div class="hw-row"><span class="label">BIOS</span><span class="value">${escHtml(hw.bios_version)}</span></div>`);
  if (typeof hw.shelf_count === 'number') rows.push(`<div class="hw-row"><span class="label">Shelves</span><span class="value">${hw.shelf_count}</span></div>`);
  if (hw.storage_controller_firmware) rows.push(`<div class="hw-row"><span class="label">Controller FW (A)</span><span class="value">${escHtml(hw.storage_controller_firmware)}</span></div>`);
  if (hw.storage_controller_os_version) rows.push(`<div class="hw-row"><span class="label">SANtricity OS</span><span class="value">${escHtml(hw.storage_controller_os_version)}</span></div>`);
  if (hw.storage_controller_nvsram) rows.push(`<div class="hw-row"><span class="label">NVSRAM</span><span class="value">${escHtml(hw.storage_controller_nvsram)}</span></div>`);
  el('hardware-info').innerHTML = rows.join('') || '<span class="empty-msg">No hardware data available</span>';
}

function refreshPanel(nodeId) {
  if (!state.snapshot) return;
  const node = state.snapshot.nodes.find(n => n.id === nodeId);
  if (node) openPanel(node);
}

function closePanel() {
  el('node-panel').classList.remove('open');
  state.selectedNodeId = null;
}

function renderPanelAlerts(alerts) {
  const section = el('section-alerts');
  if (!alerts.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  const active = alerts.filter(a => !isAcked(a));
  const acked  = alerts.filter(a => isAcked(a));

  const renderAlert = (a, ackedFlag) => {
    const sev = a.severity || 'notice';
    const time = a.triggeredAt ? new Date(a.triggeredAt).toLocaleString() : '';
    const svcBadge = a.service ? `<span class="alert-sev ${sev}" style="font-size:10px">${escHtml(a.service)}</span>` : '';
    const ackBadge = ackedFlag ? '<span class="ack-badge" style="margin-left:6px">✓ ACK</span>' : '';
    return `
      <div class="panel-alert-item${ackedFlag ? ' acked' : ''}">
        <div class="panel-alert-name">
          <span class="alert-sev ${sev}">${sev}</span>
          ${escHtml(a.name)}${svcBadge}${ackBadge}
        </div>
        ${a.summary ? `<div class="panel-alert-summary">${escHtml(a.summary)}</div>` : ''}
        ${a.recommendedActions ? `<div class="panel-alert-actions">${escHtml(a.recommendedActions)}</div>` : ''}
        ${time ? `<div class="panel-alert-time">Since ${time}</div>` : ''}
      </div>`;
  };

  let html = '';
  if (active.length) html += active.map(a => renderAlert(a, false)).join('');
  if (acked.length) {
    html += `<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;padding:8px 0 4px;border-top:1px solid var(--border);margin-top:6px">Acknowledged (${acked.length})</div>`;
    html += acked.map(a => renderAlert(a, true)).join('');
  }
  el('panel-alerts-list').innerHTML = html;

  // Update section title to reflect counts
  const titleEl = section.querySelector('.panel-section-title');
  if (titleEl) {
    titleEl.textContent = active.length
      ? `Active Alerts (${active.length}${acked.length ? ` · ${acked.length} acked` : ''})`
      : `Acknowledged Alerts (${acked.length})`;
  }
}

function renderServices(services) {
  if (!services.length) {
    el('services-list').innerHTML = '<span class="empty-msg">No service data</span>';
    return;
  }
  el('services-list').innerHTML = services.map(s => `
    <div class="service-item">
      <div class="service-dot ${s.health || 'unknown'}"></div>
      <span class="service-name">${escHtml(s.name)}</span>
      <span class="service-health">${s.health || 'unknown'}</span>
    </div>
  `).join('');
}

// ── Cases ─────────────────────────────────────────────────────────────────────
async function loadNodeCases(node) {
  try {
    const resp = await fetch(`/api/nodes/${encodeURIComponent(node.id)}/cases`);
    state.nodeCases = await resp.json();
    renderCases(node);
  } catch (_) {
    el('open-cases-list').innerHTML = '<span class="empty-msg">Failed to load cases</span>';
  }
}

function renderCases(node) {
  const open = state.nodeCases.filter(c => c.status === 'open');
  const closed = state.nodeCases.filter(c => c.status === 'closed');

  el('open-cases-list').innerHTML = open.length
    ? open.map(c => caseHtml(c, node)).join('')
    : '<span class="empty-msg">No open cases</span>';

  el('closed-cases-list').innerHTML = closed.length
    ? closed.map(c => caseHtml(c, node)).join('')
    : '<span class="empty-msg">No closed cases</span>';

  // Update open case indicator
  state.openCases[node.id] = open.length;
  updateStats();
  state.graph.graphData({ nodes: [...state.graphNodes], links: [...state.graphLinks] });
}

function caseHtml(c, node) {
  const date = new Date(c.opened_at).toLocaleDateString();
  const closedDate = c.closed_at ? new Date(c.closed_at).toLocaleDateString() : null;
  const refHtml = c.case_ref ? `<span class="case-ref">${escHtml(c.case_ref)}</span>` : '';
  const descHtml = c.description ? `<div class="case-desc">${escHtml(c.description)}</div>` : '';
  const dateStr = c.status === 'closed' && closedDate ? `Closed ${closedDate}` : `Opened ${date}`;

  const actions = c.status === 'open'
    ? `<button class="close-btn" onclick="closeCase(${c.id})">Mark closed</button>
       <button class="del-btn" onclick="deleteCase(${c.id})">Delete</button>`
    : `<button class="del-btn" onclick="deleteCase(${c.id})">Delete</button>`;

  const addNoteForm = c.status === 'open' ? `
    <div class="case-add-note">
      <textarea id="note-input-${c.id}" placeholder="Add a note…" rows="2"></textarea>
      <button onclick="addNote(${c.id})">Add</button>
    </div>` : '';

  return `
    <div class="case-item ${c.status}" id="case-${c.id}">
      <div class="case-header">
        ${refHtml}
        <span class="case-title">${escHtml(c.title)}</span>
      </div>
      <div class="case-date">${dateStr}</div>
      ${descHtml}
      <div class="case-actions">${actions}</div>
      <div class="case-notes-section">
        <button class="case-notes-toggle" onclick="toggleCaseNotes(${c.id}, this)">
          ▶ Notes <span id="note-count-${c.id}"></span>
        </button>
        <div id="case-notes-${c.id}" style="display:none">
          <div class="case-notes-list" id="notes-list-${c.id}"></div>
          ${addNoteForm}
        </div>
      </div>
    </div>`;
}

// ── Node-level notes ──────────────────────────────────────────────────────────
async function loadNodeNotes(node) {
  const list = el('node-notes-list');
  if (!list) return;
  try {
    const notes = await fetch(`/api/nodes/${encodeURIComponent(node.id)}/notes`).then(r => r.json());
    if (!notes.length) {
      list.innerHTML = '<span class="empty-msg">No notes yet</span>';
      return;
    }
    list.innerHTML = notes.map(n => {
      const dt = new Date(n.created_at);
      return `
        <div class="case-note-item">
          <div class="case-note-meta">
            <div class="case-note-author">${escHtml(n.author)}</div>
            <div>${dt.toLocaleDateString()}</div>
            <div>${dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
          </div>
          <div class="case-note-content">${escHtml(n.content)}</div>
          <button class="case-note-del" title="Delete" onclick="deleteNodeNote(${n.id})">✕</button>
        </div>`;
    }).join('');
  } catch (_) {
    list.innerHTML = '<span class="empty-msg">Failed to load notes</span>';
  }
}

async function addNodeNote() {
  const input = el('node-note-input');
  const content = input.value.trim();
  if (!content) return;
  const node = state.snapshot?.nodes.find(n => n.id === state.selectedNodeId);
  if (!node) return;
  await fetch(`/api/nodes/${encodeURIComponent(node.id)}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node_name: node.name, content }),
  });
  input.value = '';
  await loadNodeNotes(node);
}

async function deleteNodeNote(noteId) {
  await fetch(`/api/nodes/notes/${noteId}`, { method: 'DELETE' });
  const node = state.snapshot?.nodes.find(n => n.id === state.selectedNodeId);
  if (node) await loadNodeNotes(node);
}

async function toggleCaseNotes(caseId, btn) {
  const container = document.getElementById(`case-notes-${caseId}`);
  const isHidden = container.style.display === 'none';
  container.style.display = isHidden ? 'block' : 'none';
  btn.textContent = (isHidden ? '▼' : '▶') + ' Notes ';
  const countSpan = document.createElement('span');
  countSpan.id = `note-count-${caseId}`;
  btn.appendChild(countSpan);
  if (isHidden) await loadNotes(caseId);
}

async function loadNotes(caseId) {
  const list = document.getElementById(`notes-list-${caseId}`);
  if (!list) return;
  try {
    const notes = await fetch(`/api/cases/${caseId}/notes`).then(r => r.json());
    const countEl = document.getElementById(`note-count-${caseId}`);
    if (countEl) countEl.textContent = notes.length ? `(${notes.length})` : '';
    if (!notes.length) {
      list.innerHTML = '<div class="empty-msg" style="padding:4px 0">No notes yet</div>';
      return;
    }
    list.innerHTML = notes.map(n => {
      const dt = new Date(n.created_at);
      return `
        <div class="case-note-item" id="note-${n.id}">
          <div class="case-note-meta">
            <div class="case-note-author">${escHtml(n.author)}</div>
            <div>${dt.toLocaleDateString()}</div>
            <div>${dt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
          </div>
          <div class="case-note-content">${escHtml(n.content)}</div>
          <button class="case-note-del" title="Delete" onclick="deleteNote(${n.id}, ${caseId})">✕</button>
        </div>`;
    }).join('');
  } catch (_) {
    list.innerHTML = '<div class="empty-msg">Error loading notes</div>';
  }
}

async function addNote(caseId) {
  const input = document.getElementById(`note-input-${caseId}`);
  if (!input || !input.value.trim()) return;
  await fetch(`/api/cases/${caseId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: input.value.trim() }),
  });
  input.value = '';
  await loadNotes(caseId);
}

async function deleteNote(noteId, caseId) {
  await fetch(`/api/cases/notes/${noteId}`, { method: 'DELETE' });
  await loadNotes(caseId);
}

async function closeCase(caseId) {
  await fetch(`/api/cases/${caseId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'closed' }),
  });
  const node = state.snapshot?.nodes.find(n => n.id === state.selectedNodeId);
  if (node) await loadNodeCases(node);
  loadOpenCases();
  showToast('Case closed');
}

async function deleteCase(caseId) {
  await fetch(`/api/cases/${caseId}`, { method: 'DELETE' });
  const node = state.snapshot?.nodes.find(n => n.id === state.selectedNodeId);
  if (node) await loadNodeCases(node);
  loadOpenCases();
  showToast('Case deleted');
}

// ── Alert modal ───────────────────────────────────────────────────────────────
function openAlertModal(node) {
  el('alert-modal-title').textContent = `Alerts — ${node.name}`;
  const alerts = node.alerts || [];
  el('alert-list').innerHTML = alerts.map(a => {
    const sev = a.severity || 'notice';
    const name = a.name || 'Unknown alert';
    const summary = a.summary || '';
    const actions = a.recommendedActions || '';
    const svcBadge = a.service ? `<span style="font-size:10px;color:var(--muted);margin-left:6px">service: ${escHtml(a.service)}</span>` : '';
    const time = a.triggeredAt ? new Date(a.triggeredAt).toLocaleString() : '';
    return `
      <div class="alert-item ${sev}">
        <div class="alert-name">
          <span class="alert-sev ${sev}">${sev}</span>${escHtml(name)}${svcBadge}
        </div>
        ${summary ? `<div class="alert-summary">${escHtml(summary)}</div>` : ''}
        ${actions ? `<div class="alert-summary" style="margin-top:4px;color:var(--text)">${escHtml(actions)}</div>` : ''}
        ${time ? `<div class="alert-time">Since ${time}</div>` : ''}
      </div>`;
  }).join('') || '<span class="empty-msg">No alert details available</span>';

  el('alert-modal').classList.remove('hidden');
  el('overlay').classList.add('active');
}

function closeAlertModal() {
  el('alert-modal').classList.add('hidden');
  el('overlay').classList.remove('active');
}

// ── Search ────────────────────────────────────────────────────────────────────
function initSearch() {
  const input = el('search-input');
  const results = el('search-results');
  let focusIdx = -1;

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    state.searchHighlight.clear();
    if (!q) { results.classList.add('hidden'); return; }

    const matches = (state.snapshot?.nodes || [])
      .filter(n => n.name.toLowerCase().includes(q))
      .slice(0, 10);

    if (!matches.length) { results.classList.add('hidden'); return; }

    focusIdx = -1;
    results.innerHTML = matches.map((n, i) => `
      <div class="search-item" data-idx="${i}" data-id="${escHtml(n.id)}">
        <div class="search-item-name">
          <span class="search-item-health" style="background:${healthColor(n.health)}"></span>
          ${escHtml(n.name)}
        </div>
        <div class="search-item-meta">${escHtml(n.siteName)} · ${nodeTypeLabel(n.type)}</div>
      </div>`).join('');
    results.classList.remove('hidden');

    results.querySelectorAll('.search-item').forEach(item => {
      item.addEventListener('click', () => {
        selectSearchResult(item.dataset.id);
        input.value = '';
        results.classList.add('hidden');
        state.searchHighlight.clear();
      });
    });
  });

  input.addEventListener('keydown', e => {
    const items = results.querySelectorAll('.search-item');
    if (e.key === 'ArrowDown') {
      focusIdx = Math.min(focusIdx + 1, items.length - 1);
      items.forEach((it, i) => it.classList.toggle('focused', i === focusIdx));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      focusIdx = Math.max(focusIdx - 1, 0);
      items.forEach((it, i) => it.classList.toggle('focused', i === focusIdx));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      const target = focusIdx >= 0 ? items[focusIdx] : items[0];
      if (target) {
        selectSearchResult(target.dataset.id);
        input.value = '';
        results.classList.add('hidden');
        state.searchHighlight.clear();
      }
    } else if (e.key === 'Escape') {
      results.classList.add('hidden');
      state.searchHighlight.clear();
      input.blur();
    }
  });

  document.addEventListener('click', e => {
    if (!el('search-wrap').contains(e.target)) {
      results.classList.add('hidden');
      state.searchHighlight.clear();
    }
  });
}

function selectSearchResult(nodeId) {
  const node = state.snapshot?.nodes.find(n => n.id === nodeId);
  if (!node) return;

  // Highlight the node with a pulsing ring
  state.searchHighlight.clear();
  state.searchHighlight.add(nodeId);

  // Navigate: center on node
  const gn = state.graphNodes.find(n => n.id === nodeId);
  if (gn?.x !== undefined) {
    state.graph.centerAt(gn.x, gn.y, 500);
    state.graph.zoom(3, 500);
  }

  // Open panel after zoom
  setTimeout(() => openPanel(node), 520);

  // Remove highlight after a few seconds
  setTimeout(() => state.searchHighlight.delete(nodeId), 4000);
}

// ── Tenants storage ───────────────────────────────────────────────────────────
let _tenantsData = null;
let _tenantsSort = { col: 'data_bytes', dir: 'desc' };

function fmtBytes(b) {
  if (!b || b < 1) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = b, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n >= 100 ? `${n.toFixed(0)} ${units[i]}` : `${n.toFixed(1)} ${units[i]}`;
}

// EC overhead factor — physical storage = logical data × this.
// Depends on your ILM policy (e.g. 6+3 erasure coding → 9/6 = 1.5). Set server-side
// with EC_OVERHEAD and delivered through /api/meta.
let EC_OVERHEAD = 1.5;

async function loadMeta() {
  try {
    const m = await fetch('/api/meta').then(r => r.json());
    if (typeof m.ec_overhead === 'number' && m.ec_overhead > 0) EC_OVERHEAD = m.ec_overhead;
    if (m.demo) el('demo-badge').classList.remove('hidden');
  } catch (_) {}
}

function _buildTenantHeader() {
  const cols = [
    { key: 'rank',         label: '#' },
    { key: 'name',         label: 'Tenant' },
    { key: 'data_bytes',   label: 'Logical' },
    { key: 'physical',     label: `Physical (×${EC_OVERHEAD})` },
    { key: 'object_count', label: 'Objects' },
    { key: 'quota_bytes',  label: 'Quota' },
    { key: 'usage_pct',    label: '% Used' },
    { key: 'trend',        label: 'growth' },
  ];
  const row = el('tenants-thead-row');
  row.innerHTML = cols.map(c => `<th data-sort="${c.key}">${escHtml(c.label)}</th>`).join('');
  row.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (_tenantsSort.col === col) _tenantsSort.dir = _tenantsSort.dir === 'asc' ? 'desc' : 'asc';
      else { _tenantsSort.col = col; _tenantsSort.dir = 'desc'; }
      renderTenants();
    });
  });
}

// Tenant history cache (Phase 1: data from Prometheus)
let _tenantHistory = null;       // { history: { tid: [[t,v],...] } }
let _expandedTenantId = null;    // currently-expanded row, if any

async function loadTenantHistory(range = '6h') {
  try {
    const d = await fetch('/api/tenants/history?range=' + encodeURIComponent(range))
      .then(r => r.json());
    _tenantHistory = d;
    return d;
  } catch (e) {
    return null;
  }
}

async function loadPollStatus() {
  try {
    const s = await fetch('/api/tenants/buckets/status').then(r => r.json());
    const elS = el('tenants-poll-status');
    if (!elS) return;
    if (s.running) {
      elS.innerHTML = `<span style="color:#58a6ff">⟳ polling buckets…</span>`;
      return;
    }
    if (!s.last_run_finished) {
      elS.innerHTML = `<span style="color:var(--muted)">bucket poll: pending</span>`;
      return;
    }
    const finished = new Date(s.last_run_finished);
    const now = new Date();
    const minsAgo = Math.round((now - finished) / 60000);
    const nextEst = new Date(s.next_run_est);
    const minsUntil = Math.round((nextEst - now) / 60000);
    elS.innerHTML =
      `bucket poll: <strong>${s.tenants_polled}t/${s.buckets_recorded}b</strong> ` +
      `· ${minsAgo}m ago · next in ${Math.max(0, minsUntil)}m`;
  } catch (_) {}
}

// Draw a tiny sparkline in a 100×24 canvas
function drawSparkline(canvas, points, color) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width || 100, H = rect.height || 22;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!points || points.length < 2) {
    ctx.fillStyle = '#6e7681';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('no data', W / 2, H / 2);
    return;
  }
  let vMin = Infinity, vMax = -Infinity;
  points.forEach(p => { if (p[1] < vMin) vMin = p[1]; if (p[1] > vMax) vMax = p[1]; });
  // Flat series → draw a clear dashed horizontal line so the user knows it IS rendered
  if (vMax - vMin < 1) {
    ctx.strokeStyle = '#444c56';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(2, H / 2);
    ctx.lineTo(W - 2, H / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const tMin = points[0][0], tMax = points[points.length - 1][0];
  const pad = 2;
  const xAt = t => pad + ((t - tMin) / (tMax - tMin)) * (W - 2 * pad);
  const yAt = v => pad + (1 - (v - vMin) / (vMax - vMin)) * (H - 2 * pad);

  // Fill
  ctx.beginPath();
  ctx.moveTo(xAt(tMin), yAt(vMin));
  points.forEach(p => ctx.lineTo(xAt(p[0]), yAt(p[1])));
  ctx.lineTo(xAt(tMax), yAt(vMin));
  ctx.closePath();
  ctx.fillStyle = color + '30';
  ctx.fill();

  // Line
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xAt(p[0]), y = yAt(p[1]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function _growthDelta(points) {
  if (!points || points.length < 2) return null;
  const first = points[0][1];
  const last = points[points.length - 1][1];
  return { abs: last - first, pct: first > 0 ? ((last - first) / first) * 100 : null };
}

async function openTenants() {
  el('tenants-modal').classList.remove('hidden');
  el('overlay').classList.add('active');
  el('tenants-search').value = '';
  _expandedTenantId = null;
  _tenantHistoryRange = '30d';   // StorageGRID recalcs usage every several days; only 30d shows real movement
  _buildTenantHeader();
  const colspan = 8;
  el('tenants-tbody').innerHTML =
    `<tr><td colspan="${colspan}" style="padding:20px;text-align:center;color:var(--muted)">Loading…</td></tr>`;
  try {
    const [tenantData] = await Promise.all([
      fetch('/api/tenants').then(r => r.json()),
      loadTenantHistory(_tenantHistoryRange),
      loadPollStatus(),
    ]);
    _tenantsData = tenantData;
    renderTenants();
  } catch (e) {
    el('tenants-tbody').innerHTML =
      `<tr><td colspan="${colspan}" style="padding:20px;text-align:center;color:var(--red)">Failed to load tenants</td></tr>`;
  }
}

function closeTenants() {
  el('tenants-modal').classList.add('hidden');
  el('overlay').classList.remove('active');
}

function _tenantSortValue(t, col) {
  if (col === 'rank')        return 0;
  if (col === 'name')        return t.name;
  if (col === 'data_bytes')  return t.data_bytes || 0;
  if (col === 'physical')    return (t.data_bytes || 0) * EC_OVERHEAD;
  if (col === 'object_count')return t.object_count || 0;
  if (col === 'quota_bytes') return t.quota_bytes || 0;
  if (col === 'usage_pct')   return t.usage_pct ?? -Infinity;
  if (col === 'trend') {
    const pts = _tenantHistory?.history?.[t.id];
    const d = _growthDelta(pts);
    return d ? d.abs : -Infinity;   // sort by absolute byte growth
  }
  return 0;
}

function renderTenants() {
  if (!_tenantsData) return;
  if (el('tenants-thead-row').children.length !== 8) _buildTenantHeader();

  el('tenants-count').textContent = `(${_tenantsData.count})`;
  const filter = (el('tenants-search').value || '').toLowerCase().trim();
  let rows = (_tenantsData.tenants || []).slice();
  if (filter) {
    rows = rows.filter(t =>
      (t.name || '').toLowerCase().includes(filter) ||
      (t.id   || '').toLowerCase().includes(filter)
    );
  }
  rows.sort((a, b) => {
    const av = _tenantSortValue(a, _tenantsSort.col);
    const bv = _tenantSortValue(b, _tenantsSort.col);
    if (typeof av === 'number' && typeof bv === 'number') {
      return _tenantsSort.dir === 'asc' ? av - bv : bv - av;
    }
    return _tenantsSort.dir === 'asc'
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  document.querySelectorAll('#tenants-table thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === _tenantsSort.col) th.classList.add('sort-' + _tenantsSort.dir);
  });

  el('tenants-tbody').innerHTML = rows.map((t, i) => {
    const pct = t.usage_pct !== null && t.usage_pct !== undefined
      ? `<span style="color:${t.usage_pct >= 90 ? '#f85149' : t.usage_pct >= 70 ? '#f0883e' : '#3fb950'}">${t.usage_pct}%</span>`
      : '<span style="color:var(--muted)">no quota</span>';
    const logical  = t.data_bytes || 0;
    const physical = logical * EC_OVERHEAD;
    const pts = _tenantHistory?.history?.[t.id] || [];
    const delta = _growthDelta(pts);
    const isStable = !delta || Math.abs(delta.abs) < 1e6;
    const trendColor = isStable ? '#6e7681' :
      delta.abs > 0 ? '#f0883e' : '#3fb950';
    const deltaTxt = isStable
      ? '<span style="color:#6e7681;font-style:italic">stable</span>'
      : (delta.abs > 0 ? '+' : '−') + fmtBytes(Math.abs(delta.abs));
    const isExpanded = _expandedTenantId === t.id;
    const rowClass = isExpanded ? 'tenant-row expanded' : 'tenant-row';
    const detail = isExpanded ? `
      <tr class="tenant-expanded-row"><td colspan="8">
        <div class="tenant-expanded">
          <div class="te-chart-title">${escHtml(t.name)} · usage history
            <span class="te-range-bar">
              ${['1h','6h','24h','7d','30d'].map(r =>
                `<button data-range="${r}" class="${(_tenantHistoryRange||'6h')===r?'active':''}">${r}</button>`).join('')}
            </span>
          </div>
          <canvas id="te-chart-${escHtml(t.id)}" class="te-chart-canvas"></canvas>
          <div class="te-buckets-wrap" id="te-buckets-${escHtml(t.id)}">
            <div style="color:var(--muted);font-size:11px;padding:6px">Bucket-level history: phase 2 (DB-backed snapshots).</div>
          </div>
        </div>
      </td></tr>` : '';
    return `<tr class="${rowClass}" data-tid="${escHtml(t.id)}">
      <td class="rank">${i + 1}</td>
      <td><div class="tenant-name">${escHtml(t.name)}</div><div class="tenant-id">${escHtml(t.id)}</div></td>
      <td class="num">${fmtBytes(logical)}</td>
      <td class="num" style="color:var(--muted)">${fmtBytes(physical)}</td>
      <td class="num">${(t.object_count || 0).toLocaleString()}</td>
      <td class="num">${t.quota_bytes > 0 ? fmtBytes(t.quota_bytes) : '—'}</td>
      <td class="num">${pct}</td>
      <td class="num trend-cell">
        <canvas class="tenant-spark" data-tid="${escHtml(t.id)}"></canvas>
        <div class="trend-delta" style="color:${trendColor}">${deltaTxt}</div>
      </td>
    </tr>${detail}`;
  }).join('');

  // Draw sparklines
  document.querySelectorAll('canvas.tenant-spark').forEach(cv => {
    const tid = cv.dataset.tid;
    const pts = _tenantHistory?.history?.[tid] || [];
    const d = _growthDelta(pts);
    const color = !d || Math.abs(d.abs) < 1e6 ? '#8b949e' :
                  d.abs > 0 ? '#f0883e' : '#3fb950';
    drawSparkline(cv, pts, color);
  });

  // Draw expanded chart, if any
  if (_expandedTenantId) {
    const canvas = el(`te-chart-${_expandedTenantId}`);
    if (canvas) {
      const pts = _tenantHistory?.history?.[_expandedTenantId] || [];
      const series = [{ label: 'Logical', color: '#58a6ff', points: pts }];
      drawLineChart(canvas, series, {
        yFormat: fmtBytes,
        fill: true,
        rangeSecs: _tenantHistory?.range_seconds || 21600,
      });
      _bindChartCrosshair(canvas);
    }
    // Wire the range bar inside the expanded row
    document.querySelectorAll('.te-range-bar button').forEach(b => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        _tenantHistoryRange = b.dataset.range;
        await loadTenantHistory(_tenantHistoryRange);
        renderTenants();
      });
    });
    // Load bucket data (Phase 2) once per expansion
    loadAndRenderBuckets(_expandedTenantId);
  }

  // Row click to expand/collapse (ignore clicks on sort headers, search, etc)
  document.querySelectorAll('tr.tenant-row').forEach(tr => {
    tr.addEventListener('click', e => {
      // Don't toggle when clicking inside the range bar
      if (e.target.closest('.te-range-bar')) return;
      const tid = tr.dataset.tid;
      _expandedTenantId = (_expandedTenantId === tid) ? null : tid;
      renderTenants();
    });
  });
}

let _tenantHistoryRange = '6h';
let _bucketRange = '30d';
let _bucketSort = { col: 'size', dir: 'desc' };   // size | growth | objects | name
let _expandedBucket = null;       // bucket name expanded in the current tenant
const _bucketCache = new Map();   // tenant_id → last bucket payload

async function loadAndRenderBuckets(tenantId) {
  const wrap = el(`te-buckets-${tenantId}`);
  if (!wrap) return;
  _expandedBucket = null;  // reset when reloading
  wrap.innerHTML = `<div style="color:var(--muted);font-size:11px;padding:8px">Loading buckets…</div>`;
  try {
    const data = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/buckets?range=${encodeURIComponent(_bucketRange)}`
    ).then(r => r.json());
    _bucketCache.set(tenantId, data);
    renderBuckets(tenantId, data);
  } catch (e) {
    wrap.innerHTML = `<div style="color:var(--red);font-size:11px;padding:8px">Failed to load buckets.</div>`;
  }
}

function _bucketSortValue(b, hist, col) {
  switch (col) {
    case 'name':    return b.name;
    case 'size':    return b.data_bytes || 0;
    case 'objects': return b.object_count || 0;
    case 'growth': {
      const pts = hist[b.name] || [];
      const d = _growthDelta(pts);
      return d ? d.abs : -Infinity;
    }
  }
  return 0;
}

function _sortIndicator(col) {
  if (_bucketSort.col !== col) return '';
  return _bucketSort.dir === 'asc' ? ' ↑' : ' ↓';
}

function renderBuckets(tenantId, data) {
  const wrap = el(`te-buckets-${tenantId}`);
  if (!wrap) return;
  const buckets = data.latest || [];
  const history = data.history || {};
  const snapCount = data.snapshot_count || 0;
  const calc = data.calculation_time;

  const headerBar = `
    <div class="te-buckets-header">
      <span class="te-buckets-title">Buckets${buckets.length ? ' ('+buckets.length+')':''}</span>
      <span class="te-buckets-meta">
        ${snapCount} snapshot${snapCount===1?'':'s'}
        ${calc ? ` · grid calc: ${new Date(calc).toLocaleString()}` : ''}
      </span>
      <span class="te-bucket-range-bar">
        ${['6h','24h','7d','30d','90d'].map(r =>
          `<button data-range="${r}" class="${_bucketRange===r?'active':''}">${r}</button>`).join('')}
      </span>
      <button class="te-refresh-btn" data-tid="${escHtml(tenantId)}">⟳ Refresh now</button>
    </div>`;

  if (!buckets.length) {
    wrap.innerHTML = headerBar +
      `<div style="padding:14px;color:var(--muted);font-size:11px">
         No bucket snapshots stored yet. Background poll runs every 2 h — click "Refresh now" to fetch immediately.
       </div>`;
    _wireBucketControls(tenantId);
    return;
  }

  // Sort buckets
  const sorted = buckets.slice().sort((a, b) => {
    const av = _bucketSortValue(a, history, _bucketSort.col);
    const bv = _bucketSortValue(b, history, _bucketSort.col);
    if (typeof av === 'number' && typeof bv === 'number') {
      return _bucketSort.dir === 'asc' ? av - bv : bv - av;
    }
    return _bucketSort.dir === 'asc'
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  const rows = sorted.map(b => {
    const pts = history[b.name] || [];
    const delta = _growthDelta(pts);
    const isStable = !delta || Math.abs(delta.abs) < 1e6;
    const trendColor = isStable ? '#6e7681' :
      delta.abs > 0 ? '#f0883e' : '#3fb950';
    const deltaTxt = isStable
      ? '<span style="color:#6e7681;font-style:italic">stable</span>'
      : (delta.abs > 0 ? '+' : '−') + fmtBytes(Math.abs(delta.abs));
    const expanded = _expandedBucket === b.name;
    const detail = expanded ? `
      <tr class="bucket-expanded-row"><td colspan="5">
        <div class="bucket-detail">
          <div class="te-chart-title">${escHtml(b.name)} · usage history</div>
          <canvas id="bucket-chart-${b.name.replace(/[^a-zA-Z0-9]/g,'_')}" class="te-chart-canvas"></canvas>
        </div>
      </td></tr>` : '';
    return `<tr class="bucket-row ${expanded?'expanded':''}" data-bucket="${escHtml(b.name)}">
      <td class="bucket-name">${escHtml(b.name)}</td>
      <td class="num">${fmtBytes(b.data_bytes || 0)}</td>
      <td class="num">${(b.object_count || 0).toLocaleString()}</td>
      <td><canvas class="bucket-spark" data-bucket="${escHtml(b.name)}"></canvas></td>
      <td class="num" style="color:${trendColor};font-weight:700">${deltaTxt}</td>
    </tr>${detail}`;
  }).join('');

  wrap.innerHTML = headerBar + `
    <table class="te-buckets-table">
      <thead><tr>
        <th data-bsort="name">Bucket${_sortIndicator('name')}</th>
        <th data-bsort="size" class="num">Size${_sortIndicator('size')}</th>
        <th data-bsort="objects" class="num">Objects${_sortIndicator('objects')}</th>
        <th>Trend</th>
        <th data-bsort="growth" class="num">Δ${_sortIndicator('growth')}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // Draw bucket sparklines
  wrap.querySelectorAll('canvas.bucket-spark').forEach(cv => {
    const name = cv.dataset.bucket;
    const pts = history[name] || [];
    const delta = _growthDelta(pts);
    const color = !delta || Math.abs(delta.abs) < 1e6 ? '#8b949e' :
      delta.abs > 0 ? '#f0883e' : '#3fb950';
    drawSparkline(cv, pts, color);
  });

  // Draw expanded bucket chart, if any
  if (_expandedBucket) {
    const canvas = el('bucket-chart-' + _expandedBucket.replace(/[^a-zA-Z0-9]/g,'_'));
    if (canvas) {
      const pts = history[_expandedBucket] || [];
      const series = [{ label: _expandedBucket, color: '#bc8cff', points: pts }];
      const rangeMap = {'6h':21600,'24h':86400,'7d':604800,'30d':2592000,'90d':7776000};
      drawLineChart(canvas, series, {
        yFormat: fmtBytes, fill: true,
        rangeSecs: rangeMap[_bucketRange] || 2592000,
      });
      _bindChartCrosshair(canvas);
    }
  }

  _wireBucketControls(tenantId);
}

function _wireBucketControls(tenantId) {
  const wrap = el(`te-buckets-${tenantId}`);
  if (!wrap) return;
  // Range bar
  wrap.querySelectorAll('.te-bucket-range-bar button').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      _bucketRange = b.dataset.range;
      loadAndRenderBuckets(tenantId);
    });
  });
  // Refresh button
  wrap.querySelectorAll('.te-refresh-btn').forEach(b => {
    b.addEventListener('click', async e => {
      e.stopPropagation();
      b.disabled = true;
      b.textContent = 'Refreshing…';
      try {
        await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/buckets/refresh`,
          { method: 'POST' });
        await loadAndRenderBuckets(tenantId);
      } catch (_) {
        b.textContent = 'Failed';
        setTimeout(() => { b.disabled = false; b.textContent = '⟳ Refresh now'; }, 2000);
      }
    });
  });
  // Sortable headers
  wrap.querySelectorAll('th[data-bsort]').forEach(th => {
    th.addEventListener('click', e => {
      e.stopPropagation();
      const col = th.dataset.bsort;
      if (_bucketSort.col === col) _bucketSort.dir = _bucketSort.dir === 'asc' ? 'desc' : 'asc';
      else { _bucketSort.col = col; _bucketSort.dir = 'desc'; }
      renderBuckets(tenantId, _bucketCache.get(tenantId));
    });
  });
  // Bucket row click → expand/collapse detail chart
  wrap.querySelectorAll('tr.bucket-row').forEach(tr => {
    tr.addEventListener('click', e => {
      e.stopPropagation();   // don't collapse the tenant row
      const name = tr.dataset.bucket;
      _expandedBucket = (_expandedBucket === name) ? null : name;
      renderBuckets(tenantId, _bucketCache.get(tenantId));
    });
  });
}

function exportTenantsCSV() {
  if (!_tenantsData) return;
  const rows = (_tenantsData.tenants || []).slice();
  rows.sort((a, b) => (b.data_bytes || 0) - (a.data_bytes || 0));
  const csvCell = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = ['Rank','Tenant','Tenant ID','Logical (bytes)',`Physical x${EC_OVERHEAD} (bytes)`,
                   'Objects','Quota (bytes)','% Used'];
  const lines = [headers.join(',')];
  rows.forEach((t, i) => {
    const logical = t.data_bytes || 0;
    lines.push([
      i + 1, t.name, t.id, logical, Math.round(logical * EC_OVERHEAD),
      t.object_count || 0, t.quota_bytes || 0, t.usage_pct ?? '',
    ].map(csvCell).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `sgridmon-tenants-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Hardware inventory ────────────────────────────────────────────────────────
let _invSort = { col: 'siteName', dir: 'asc' };

const INV_COLS = [
  { key: 'siteName',       label: 'Site' },
  { key: 'name',           label: 'Node' },
  { key: 'type',           label: 'Type' },
  { key: 'health',         label: 'Health' },
  { key: 'connected',      label: 'State' },
  { key: 'storagePct',     label: 'Used %' },
  { key: 'alertCount',     label: 'Alerts' },
  { key: 'model',          label: 'Model' },
  { key: 'boardSerial',    label: 'Board S/N' },
  { key: 'storageSerial',  label: 'Storage S/N' },
  { key: 'bios',           label: 'BIOS' },
  { key: 'shelves',        label: 'Shelves' },
  { key: 'ctrlFw',         label: 'Controller FW (A)' },
  { key: 'sansOs',         label: 'SANtricity OS' },
  { key: 'nvsram',         label: 'NVSRAM' },
  { key: 'fqdn',           label: 'FQDN' },
  { key: 'ip',             label: 'IP' },
];

function nodeToInvRow(n) {
  const hw = n.hardware || {};
  return {
    siteName:      n.siteName || '',
    name:          n.name || '',
    type:          nodeTypeLabel(n.type),
    health:        n.health || '',
    connected:     n.isConnected ? 'connected' : 'disconnected',
    storagePct:    typeof n.storagePct === 'number' ? n.storagePct : '',
    alertCount:    n.alertCount || 0,
    model:         hw.model || '',
    boardSerial:   hw.board_serial || '',
    storageSerial: hw.storage_chassis_serial || '',
    bios:          hw.bios_version || '',
    shelves:       typeof hw.shelf_count === 'number' ? hw.shelf_count : '',
    ctrlFw:        hw.storage_controller_firmware || '',
    sansOs:        hw.storage_controller_os_version || '',
    nvsram:        hw.storage_controller_nvsram || '',
    fqdn:          n.fqdn || '',
    ip:            n.ip || '',
  };
}

function openInventory() {
  el('inventory-modal').classList.remove('hidden');
  el('overlay').classList.add('active');
  el('inv-search').value = '';
  renderInventory();
}

function closeInventory() {
  el('inventory-modal').classList.add('hidden');
  el('overlay').classList.remove('active');
}

function renderInventory() {
  const tbody = el('inventory-tbody');
  if (!state.snapshot?.nodes?.length) {
    tbody.innerHTML = `<tr><td colspan="${INV_COLS.length}" style="padding:20px;text-align:center;color:var(--muted)">No nodes loaded yet — wait for the first poll cycle</td></tr>`;
    return;
  }
  const filter = (el('inv-search').value || '').toLowerCase().trim();
  let rows = state.snapshot.nodes.map(nodeToInvRow);
  if (filter) {
    rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(filter)));
  }
  rows.sort((a, b) => {
    const av = a[_invSort.col];
    const bv = b[_invSort.col];
    const aN = (av === '' || av == null) ? -Infinity : av;
    const bN = (bv === '' || bv == null) ? -Infinity : bv;
    if (typeof aN === 'number' && typeof bN === 'number') {
      return _invSort.dir === 'asc' ? aN - bN : bN - aN;
    }
    return _invSort.dir === 'asc'
      ? String(av ?? '').localeCompare(String(bv ?? ''))
      : String(bv ?? '').localeCompare(String(av ?? ''));
  });

  // Update header sort indicators
  document.querySelectorAll('#inventory-table thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === _invSort.col) th.classList.add('sort-' + _invSort.dir);
  });

  tbody.innerHTML = rows.map(r => {
    const siteIdx = (state.snapshot.sites || []).findIndex(s => s.name === r.siteName);
    const siteCls = siteIdx >= 0 ? `site-c${siteIdx % 6}` : '';
    const healthBadge = r.health
      ? `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;background:${healthColor(r.health)}33;color:${healthColor(r.health)}">${escHtml(r.health)}</span>`
      : '';
    const stateBadge = r.connected === 'connected'
      ? '<span style="color:#3fb950">●</span> connected'
      : '<span style="color:#8b949e">○</span> disconnected';
    const usedPct = r.storagePct === '' ? '' :
      `<span style="color:${r.storagePct >= 90 ? '#f85149' : r.storagePct >= 70 ? '#f0883e' : '#3fb950'}">${r.storagePct}%</span>`;
    const alerts = r.alertCount > 0
      ? `<span style="color:#f0883e;font-weight:700">${r.alertCount}</span>`
      : '<span style="color:var(--muted)">0</span>';
    return `<tr class="${siteCls}">
      <td>${escHtml(r.siteName)}</td>
      <td><strong>${escHtml(r.name)}</strong></td>
      <td>${escHtml(r.type)}</td>
      <td>${healthBadge}</td>
      <td>${stateBadge}</td>
      <td style="text-align:right">${usedPct}</td>
      <td style="text-align:right">${alerts}</td>
      <td>${escHtml(r.model)}</td>
      <td>${escHtml(r.boardSerial)}</td>
      <td>${escHtml(r.storageSerial)}</td>
      <td>${escHtml(r.bios)}</td>
      <td style="text-align:right">${escHtml(String(r.shelves))}</td>
      <td>${escHtml(r.ctrlFw)}</td>
      <td>${escHtml(r.sansOs)}</td>
      <td>${escHtml(r.nvsram)}</td>
      <td>${escHtml(r.fqdn)}</td>
      <td>${escHtml(r.ip)}</td>
    </tr>`;
  }).join('');
}

function exportInventoryCSV() {
  if (!state.snapshot?.nodes) return;
  const rows = state.snapshot.nodes.map(nodeToInvRow);
  rows.sort((a, b) => a.siteName.localeCompare(b.siteName) || a.name.localeCompare(b.name));

  const csvCell = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [INV_COLS.map(c => c.label).join(',')];
  for (const r of rows) {
    lines.push(INV_COLS.map(c => csvCell(r[c.key])).join(','));
  }
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `sgridmon-inventory-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Authentication / user menu ───────────────────────────────────────────────
async function loadCurrentUser() {
  try {
    const r = await fetch('/api/auth/me').then(r => r.json());
    if (!r.authenticated) {
      location.href = '/login.html';
      return;
    }
    state.currentUser = r;
    el('user-menu-email').textContent = r.email;
    el('user-menu-info-email').textContent = r.email;
    el('user-menu-info-role').textContent = r.role;
    if (r.role === 'admin') {
      el('user-menu-manage').style.display = 'block';
      el('settings-btn').style.display = 'flex';
    }
  } catch (_) {
    location.href = '/login.html';
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
}

// ── Change password modal ────────────────────────────────────────────────────
function openChangePassword() {
  el('user-menu').classList.add('hidden');
  ['pwd-current', 'pwd-new', 'pwd-confirm'].forEach(id => el(id).value = '');
  el('pwd-error').style.display = 'none';
  el('pwd-modal').classList.remove('hidden');
  el('overlay').classList.add('active');
  setTimeout(() => el('pwd-current').focus(), 50);
}

function closeChangePassword() {
  el('pwd-modal').classList.add('hidden');
  el('overlay').classList.remove('active');
}

async function submitChangePassword() {
  const current = el('pwd-current').value;
  const newPwd  = el('pwd-new').value;
  const confirm = el('pwd-confirm').value;
  const errEl = el('pwd-error');
  errEl.style.display = 'none';

  if (newPwd.length < 8) {
    errEl.textContent = 'New password must be at least 8 characters';
    errEl.style.display = 'block'; return;
  }
  if (newPwd !== confirm) {
    errEl.textContent = "Passwords don't match";
    errEl.style.display = 'block'; return;
  }

  const r = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: current, new_password: newPwd }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    errEl.textContent = data.detail || 'Failed to update password';
    errEl.style.display = 'block';
    return;
  }
  closeChangePassword();
  showToast('Password updated');
}

// ── Settings modal (configuration + user management) ─────────────────────────
const SETTINGS_LABELS = {
  SGRID_URL: 'Admin Node URL',
  SGRID_USER: 'User',
  SGRID_PASS: 'Password',
  SGRID_API_VERSION: 'API version',
  SGRID_VERIFY_TLS: 'Verify TLS certificate',
  SGRID_CA_BUNDLE: 'CA bundle path',
  SGRID_PROXY: 'Proxy',
  SGRIDMON_DEMO: 'Demo mode',
  POLL_INTERVAL: 'Topology / health poll (s)',
  METRICS_INTERVAL: 'Metrics poll (s)',
  BUCKET_POLL_INTERVAL: 'Bucket usage poll (s)',
  BUCKET_RETENTION_DAYS: 'Bucket history retention (days)',
  EC_OVERHEAD: 'Physical / logical ratio',
  SECRET_KEY: 'Session signing key',
  SESSION_COOKIE_SECURE: 'Secure session cookie (HTTPS)',
};
let _settings = null;

function openSettings(tab = 'config') {
  el('user-menu').classList.add('hidden');
  el('users-modal').classList.remove('hidden');
  el('overlay').classList.add('active');
  showSettingsTab(tab);
}

// Kept for existing callers (user menu "Manage users").
function openUserManagement() { openSettings('users'); }

function closeUserManagement() {
  el('users-modal').classList.add('hidden');
  el('overlay').classList.remove('active');
}

function showSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  el('settings-pane-config').classList.toggle('hidden', tab !== 'config');
  el('settings-pane-users').classList.toggle('hidden', tab !== 'users');
  if (tab === 'users') loadUsers();
  else loadSettings();
}

function setSettingsStatus(msg, kind = '') {
  const s = el('settings-status');
  s.className = 'settings-status' + (kind ? ' ' + kind : '');
  s.textContent = msg || '';
}

async function loadSettings() {
  const form = el('settings-form');
  setSettingsStatus('');
  form.innerHTML = '<div class="empty-msg" style="padding:14px">Loading…</div>';
  try {
    const r = await fetch('/api/settings');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
    _settings = await r.json();
    renderSettings();
  } catch (e) {
    form.innerHTML = `<div class="empty-msg" style="padding:14px">Failed to load settings (${escHtml(e.message)})</div>`;
  }
}

function settingsInput(f) {
  const id = 'set-' + f.key;
  const wrap = document.createElement('div');
  wrap.className = 'settings-field' + (f.type === 'bool' ? ' bool' : '');

  const label = document.createElement('label');
  label.htmlFor = id;
  label.innerHTML = `<span>${escHtml(SETTINGS_LABELS[f.key] || f.key)}</span>` +
    `<code>${escHtml(f.key)}</code>` +
    (f.restart_required ? '<span class="settings-badge" title="Applied after restarting the container">restart</span>' : '') +
    (f.restart_pending ? '<span class="settings-badge warn" title="Saved but not active yet">pending restart</span>' : '');

  let input;
  if (f.type === 'bool') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!f.value;
  } else {
    input = document.createElement('input');
    input.type = f.type === 'secret' ? 'password'
      : (f.type === 'int' || f.type === 'float') ? 'number' : 'text';
    if (f.type === 'int') { input.min = '1'; input.step = '1'; }
    if (f.type === 'float') { input.min = '0'; input.step = '0.1'; }
    if (f.type === 'secret') {
      input.value = '';
      input.autocomplete = 'new-password';
      input.placeholder = f.set ? '•••••••• (set; leave empty to keep)' : 'not set';
    } else {
      input.value = f.value ?? '';
      if (f.default !== null && f.default !== '' && f.default !== undefined)
        input.placeholder = String(f.default);
    }
  }
  input.id = id;
  input.dataset.key = f.key;
  input.dataset.type = f.type;
  input.className = 'settings-input';

  const help = document.createElement('div');
  help.className = 'settings-help';
  help.textContent = f.description;

  if (f.type === 'bool') {
    const row = document.createElement('div');
    row.className = 'settings-bool-row';
    row.append(input, label);
    wrap.append(row, help);
  } else {
    wrap.append(label, input, help);
  }
  return wrap;
}

function renderDatabaseSection(db) {
  const sec = document.createElement('fieldset');
  sec.className = 'settings-group';
  const ext = db.external || {};
  sec.innerHTML = `
    <legend>Database <span class="settings-badge" title="Applied after restarting the container">restart</span>
      ${db.restart_pending ? '<span class="settings-badge warn">pending restart</span>' : ''}</legend>
    <label class="settings-radio">
      <input type="radio" name="db-mode" value="bundled">
      <div>
        <div class="settings-radio-title">Bundled PostgreSQL <span class="settings-rec">recommended</span></div>
        <div class="settings-help">The <code>db</code> container (postgres:16-alpine) started by docker compose,
          data in the <code>pgdata</code> volume. URL from ${db.bundled_from_env ? 'the environment' : 'the built-in default'}:
          <code>${escHtml(db.bundled_url)}</code></div>
      </div>
    </label>
    <label class="settings-radio">
      <input type="radio" name="db-mode" value="external">
      <div>
        <div class="settings-radio-title">External PostgreSQL</div>
        <div class="settings-help">An existing PostgreSQL server. Tables are created on start-up; data is not migrated.</div>
      </div>
    </label>
    <div class="settings-db-ext" id="settings-db-ext">
      <div class="settings-grid">
        <div class="settings-field"><label for="db-host"><span>Host</span></label>
          <input class="settings-input" id="db-host" type="text" placeholder="postgres.example.com"></div>
        <div class="settings-field"><label for="db-port"><span>Port</span></label>
          <input class="settings-input" id="db-port" type="number" min="1" max="65535" placeholder="5432"></div>
        <div class="settings-field"><label for="db-name"><span>Database</span></label>
          <input class="settings-input" id="db-name" type="text" placeholder="sgridmon"></div>
        <div class="settings-field"><label for="db-user"><span>User</span></label>
          <input class="settings-input" id="db-user" type="text" placeholder="sgridmon"></div>
        <div class="settings-field"><label for="db-pass"><span>Password</span></label>
          <input class="settings-input" id="db-pass" type="password" autocomplete="new-password"></div>
      </div>
    </div>
    <div class="settings-inline-actions">
      <button class="btn-secondary" id="btn-settings-test-db" type="button">Test database</button>
      <span id="settings-db-result" class="settings-status"></span>
    </div>`;
  sec.querySelector(`input[name="db-mode"][value="${db.mode}"]`).checked = true;
  sec.querySelector('#db-host').value = ext.host || '';
  sec.querySelector('#db-port').value = ext.port || 5432;
  sec.querySelector('#db-name').value = ext.database || 'sgridmon';
  sec.querySelector('#db-user').value = ext.user || '';
  sec.querySelector('#db-pass').placeholder = ext.password_set ? '•••••••• (set; leave empty to keep)' : '';
  const sync = () => {
    const external = sec.querySelector('input[name="db-mode"]:checked').value === 'external';
    sec.querySelector('#settings-db-ext').classList.toggle('hidden', !external);
  };
  sec.querySelectorAll('input[name="db-mode"]').forEach(r => r.addEventListener('change', sync));
  sync();
  sec.querySelector('#btn-settings-test-db').addEventListener('click', testDatabaseSettings);
  return sec;
}

function renderSettings() {
  const form = el('settings-form');
  form.innerHTML = '';
  const info = document.createElement('div');
  info.className = 'settings-info';
  info.innerHTML = `Stored in <code>${escHtml(_settings.config_path)}</code>. ` +
    'Values here override environment variables. Changes are applied immediately, ' +
    'except those marked <span class="settings-badge">restart</span>.';
  form.appendChild(info);

  _settings.groups.forEach(g => {
    if (g.name === 'Database') return;
    const sec = document.createElement('fieldset');
    sec.className = 'settings-group';
    const legend = document.createElement('legend');
    legend.textContent = g.name;
    sec.appendChild(legend);
    const grid = document.createElement('div');
    grid.className = 'settings-grid';
    g.fields.forEach(f => grid.appendChild(settingsInput(f)));
    sec.appendChild(grid);
    form.appendChild(sec);
  });
  form.appendChild(renderDatabaseSection(_settings.database));
}

function collectSettings() {
  const values = {};
  document.querySelectorAll('#settings-form .settings-input[data-key]').forEach(inp => {
    values[inp.dataset.key] = inp.dataset.type === 'bool' ? inp.checked : inp.value.trim();
  });
  return { values, database: collectDatabase() };
}

function collectDatabase() {
  const mode = (document.querySelector('input[name="db-mode"]:checked') || {}).value || 'bundled';
  return {
    mode,
    host: el('db-host').value.trim(),
    port: parseInt(el('db-port').value, 10) || 5432,
    database: el('db-name').value.trim(),
    user: el('db-user').value.trim(),
    password: el('db-pass').value,
  };
}

async function saveSettings() {
  if (!_settings) return;
  const btn = el('btn-settings-save');
  btn.disabled = true;
  setSettingsStatus('Saving…');
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectSettings()),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
    _settings = data;
    renderSettings();
    if (data.restart_required && data.restart_required.length) {
      setSettingsStatus(`Saved. Restart the container to apply: ${data.restart_required.join(', ')} ` +
        '(docker compose restart app).', 'warn');
    } else if (data.changed && data.changed.length) {
      setSettingsStatus(`Saved and applied: ${data.changed.join(', ')}.`, 'ok');
    } else {
      setSettingsStatus('Saved. No changes.', 'ok');
    }
    showToast('Settings saved');
  } catch (e) {
    setSettingsStatus(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function testStorageGridSettings() {
  const btn = el('btn-settings-test');
  btn.disabled = true;
  setSettingsStatus('Connecting to StorageGRID…');
  try {
    const r = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: collectSettings().values }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
    setSettingsStatus(data.message, data.ok ? 'ok' : 'err');
  } catch (e) {
    setSettingsStatus(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function testDatabaseSettings() {
  const out = el('settings-db-result');
  const btn = el('btn-settings-test-db');
  btn.disabled = true;
  out.className = 'settings-status';
  out.textContent = 'Connecting…';
  try {
    const r = await fetch('/api/settings/test-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectDatabase()),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
    out.className = 'settings-status ' + (data.ok ? 'ok' : 'err');
    out.textContent = data.message;
  } catch (e) {
    out.className = 'settings-status err';
    out.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function loadUsers() {
  const list = el('users-list');
  list.innerHTML = '<div class="empty-msg" style="padding:14px">Loading…</div>';
  try {
    const users = await fetch('/api/users').then(r => r.json());
    list.innerHTML = '';
    users.forEach(u => list.appendChild(userRow(u)));
  } catch (_) {
    list.innerHTML = '<div class="empty-msg" style="padding:14px">Failed to load</div>';
  }
}

function userRow(u) {
  const row = document.createElement('div');
  row.className = 'user-row' + (u.is_active ? '' : ' inactive');
  const isMe = state.currentUser && u.id === state.currentUser.id;

  const emailDiv = document.createElement('div');
  emailDiv.className = 'user-row-email';
  emailDiv.textContent = u.email;
  if (isMe) {
    const span = document.createElement('span');
    span.className = 'you';
    span.textContent = '(you)';
    emailDiv.appendChild(span);
  }

  const metaDiv = document.createElement('div');
  metaDiv.className = 'user-row-meta';
  metaDiv.textContent = u.last_login_at
    ? `last login ${new Date(u.last_login_at).toLocaleDateString()}`
    : 'never logged in';

  const roleSelect = document.createElement('select');
  ['admin', 'viewer'].forEach(r => {
    const o = document.createElement('option');
    o.value = r; o.textContent = r;
    if (r === u.role) o.selected = true;
    roleSelect.appendChild(o);
  });
  roleSelect.addEventListener('change', async () => {
    await fetch(`/api/users/${u.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: roleSelect.value }),
    });
    showToast('Role updated');
  });

  const actions = document.createElement('div');
  actions.className = 'user-row-actions';

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = u.is_active ? 'Disable' : 'Enable';
  toggleBtn.disabled = isMe && u.is_active;
  toggleBtn.addEventListener('click', async () => {
    await fetch(`/api/users/${u.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !u.is_active }),
    });
    await loadUsers();
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset pwd';
  resetBtn.addEventListener('click', async () => {
    const p = prompt(`New password for ${u.email}`);
    if (!p) return;
    await fetch(`/api/users/${u.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: p }),
    });
    showToast('Password updated');
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'del';
  delBtn.textContent = 'Delete';
  delBtn.disabled = isMe;
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete user ${u.email}?`)) return;
    await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
    await loadUsers();
  });

  actions.append(toggleBtn, resetBtn, delBtn);
  row.append(emailDiv, metaDiv, roleSelect, actions);
  return row;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _toastTimer;
function showToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Wire up events ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadCurrentUser();   // redirects to /login.html if not authenticated
  await loadMeta();

  initGraph();
  await loadGraph();
  loadOpenCases();
  loadConnectivity();
  loadTraffic();
  loadStorage();
  loadAcks();
  loadCharts();
  setInterval(loadConnectivity, 60_000);
  setInterval(loadTraffic, 30_000);
  setInterval(loadStorage, 60_000);
  setInterval(loadCharts, 60_000);
  window.addEventListener('resize', () => { if (state.lastCharts) renderCharts(state.lastCharts); });
  connectWS();
  initSearch();

  el('layout-select').addEventListener('change', e => setLayout(+e.target.value));

  el('alerts-dropdown-btn').addEventListener('click', e => {
    e.stopPropagation();
    el('cases-dropdown').classList.add('hidden');
    el('alerts-dropdown').classList.toggle('hidden');
    if (!el('alerts-dropdown').classList.contains('hidden')) renderAlertsDropdown();
  });

  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      _alertFilter = tab.dataset.sev;
      _renderAlertGroups();
    });
  });

  el('cases-dropdown-btn').addEventListener('click', e => {
    e.stopPropagation();
    el('alerts-dropdown').classList.add('hidden');
    el('cases-dropdown').classList.toggle('hidden');
  });

  document.addEventListener('click', e => {
    if (!el('alerts-dropdown-wrap').contains(e.target))
      el('alerts-dropdown').classList.add('hidden');
    if (!el('cases-dropdown-wrap').contains(e.target))
      el('cases-dropdown').classList.add('hidden');
  });

  el('panel-close').addEventListener('click', closePanel);
  el('node-note-add').addEventListener('click', addNodeNote);
  el('alert-modal-close').addEventListener('click', closeAlertModal);
  el('alert-modal-ok').addEventListener('click', closeAlertModal);
  el('overlay').addEventListener('click', () => {
    closeAlertModal();
    closeInventory();
    closeTenants();
    closeUserManagement();
    closeChangePassword();
    el('about-modal').classList.add('hidden');
  });

  el('btn-add-case').addEventListener('click', () => {
    el('new-case-form').style.display = 'block';
    el('case-title').focus();
  });

  el('btn-case-cancel').addEventListener('click', () => {
    el('new-case-form').style.display = 'none';
    el('case-title').value = '';
    el('case-ref').value = '';
    el('case-desc').value = '';
  });

  el('btn-case-save').addEventListener('click', async () => {
    const title = el('case-title').value.trim();
    if (!title) { showToast('Title is required'); return; }
    const node = state.snapshot?.nodes.find(n => n.id === state.selectedNodeId);
    if (!node) return;

    await fetch('/api/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node_id: node.id,
        node_name: node.name,
        site_name: node.siteName,
        case_ref: el('case-ref').value.trim() || null,
        title,
        description: el('case-desc').value.trim() || null,
      }),
    });

    el('btn-case-cancel').click();
    await loadNodeCases(node);
    loadOpenCases();
    showToast('Case created');
  });

  el('btn-history-toggle').addEventListener('click', () => {
    const list = el('closed-cases-list');
    const hidden = list.style.display === 'none';
    list.style.display = hidden ? 'block' : 'none';
    el('btn-history-toggle').textContent = hidden ? 'Hide closed cases' : 'Show closed cases';
  });

  // ── User menu ──
  el('user-menu-btn').addEventListener('click', e => {
    e.stopPropagation();
    el('user-menu').classList.toggle('hidden');
  });
  el('user-menu-logout').addEventListener('click', logout);
  el('user-menu-manage').addEventListener('click', openUserManagement);
  el('user-menu-change-pwd').addEventListener('click', openChangePassword);
  el('users-modal-close').addEventListener('click', closeUserManagement);
  el('settings-btn').addEventListener('click', () => openSettings('config'));
  document.querySelectorAll('.settings-tab').forEach(b =>
    b.addEventListener('click', () => showSettingsTab(b.dataset.tab)));
  el('btn-settings-save').addEventListener('click', saveSettings);
  el('btn-settings-test').addEventListener('click', testStorageGridSettings);
  el('inventory-btn').addEventListener('click', openInventory);
  el('inv-modal-close').addEventListener('click', closeInventory);
  el('inv-export').addEventListener('click', exportInventoryCSV);
  el('inv-search').addEventListener('input', renderInventory);
  document.querySelectorAll('#inventory-table thead th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (_invSort.col === col) _invSort.dir = _invSort.dir === 'asc' ? 'desc' : 'asc';
      else { _invSort.col = col; _invSort.dir = 'asc'; }
      renderInventory();
    });
  });

  el('about-btn').addEventListener('click', () => {
    el('about-modal').classList.remove('hidden');
    el('overlay').classList.add('active');
  });
  el('about-modal-close').addEventListener('click', () => {
    el('about-modal').classList.add('hidden');
    el('overlay').classList.remove('active');
  });

  el('charts-toggle').addEventListener('click', () => toggleChartsPanel(true));
  el('charts-show').addEventListener('click', () => {
    toggleChartsPanel(false);
    setTimeout(() => state.lastCharts && renderCharts(state.lastCharts), 280);
  });
  // Range selector
  document.querySelectorAll('#charts-range-bar button').forEach(b => {
    b.addEventListener('click', () => setChartRange(b.dataset.range));
  });
  // Bind crosshair / tooltip on all chart canvases
  ['chart-ingest-site','chart-retrieve-site','chart-ilm','chart-total','chart-reaper']
    .forEach(id => _bindChartCrosshair(el(id)));

  el('tenants-btn').addEventListener('click', openTenants);
  el('tenants-modal-close').addEventListener('click', closeTenants);
  el('tenants-export').addEventListener('click', exportTenantsCSV);
  el('tenants-search').addEventListener('input', renderTenants);
  // Header click handlers are bound dynamically in _buildTenantHeader()
  el('pwd-modal-close').addEventListener('click', closeChangePassword);
  el('btn-pwd-cancel').addEventListener('click', closeChangePassword);
  el('btn-pwd-save').addEventListener('click', submitChangePassword);

  document.addEventListener('click', e => {
    if (!el('user-menu-wrap').contains(e.target))
      el('user-menu').classList.add('hidden');
  });

  el('btn-add-user').addEventListener('click', async () => {
    const email = el('new-user-email').value.trim();
    const password = el('new-user-pass').value;
    const role = el('new-user-role').value;
    if (!email || !password) { showToast('Email and password required'); return; }
    const r = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, role }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      showToast(data.detail || 'Failed to create user');
      return;
    }
    el('new-user-email').value = '';
    el('new-user-pass').value = '';
    await loadUsers();
    showToast('User created');
  });
});
