// Pure renderer: an idea-map/v1 map as ONE self-contained interactive HTML
// page (refocus decision D5) that any assistant can hand over as a file.
//
// Safety contract (test/ideas.html.test.ts):
// - no network: a CSP meta allows only inline script and style, and the
//   page has no external script, stylesheet, image or font. Output URLs
//   become plain <a href> links (http/https only), built at runtime;
// - user text (titles, glosses, cluster names) lives only in the JSON data
//   block, with '<', '>', '&', U+2028 and U+2029 escaped and lone
//   surrogates stripped, and the script renders it with textContent only.

import { LINK_TYPES, LINK_TYPE_INFO, type LinkType } from './linkTypes';
import type { IdeaMap } from './graph';

// Cluster colours: the validated eight-slot categorical palette (light and
// dark steps); clusters past the eighth, singletons and unlinked outputs
// are grey.
const PALETTE_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const PALETTE_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const HTML_COLOURED_CLUSTERS = PALETTE_LIGHT.length;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE, '');
}

// JSON for a <script type="application/json"> block: nothing in it can
// close the element or open a comment, and it parses with JSON.parse.
export function scriptJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function httpUrl(u: string | null): string | undefined {
  if (!u) return undefined;
  const s = stripLoneSurrogates(u.trim());
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : undefined;
}

// FNV-1a: a stable 32-bit seed per id for the client-side layout.
export function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export type HtmlNode = {
  n: string; // label
  y: 0 | 1 | 2; // idea | synthesis | output
  c: number; // cluster id (0 = none)
  s?: string; // idea status
  t: number; // appears at (ms): captured_at, or an output's published_at
  i?: 1; // in the inbox
  p?: number; // promoted at (ms)
  d: number; // accepted degree
  u?: string; // output URL (http/https only)
  h: number; // layout seed
};

export type HtmlEdge = {
  a: number; // source node index
  b: number; // target node index
  y: number; // index into types
  p?: 1; // proposed
  g: string; // gloss (rationale)
  t: number; // appears at (ms): decided_at (accepted) or proposed_at
};

export type HtmlPayload = {
  generated_at: string;
  from: number;
  to: number;
  truncated: boolean;
  omitted: number;
  clusters: Array<{ id: number; name: string; size: number }>;
  types: Array<{ label: string; directed: boolean; meaning: string }>;
  nodes: HtmlNode[];
  edges: HtmlEdge[];
};

// The compact data the page embeds. Times are epoch ms; the slider runs
// from the earliest captured_at to generated_at.
export function htmlPayload(map: IdeaMap): HtmlPayload {
  const to = ms(map.generated_at) ?? 0;
  const index = new Map(map.nodes.map((n, i) => [n.id, i]));
  const used = new Set(map.edges.map((e) => e.type));
  const typeList = LINK_TYPES.filter((t) => used.has(t));
  const typeIndex = new Map<LinkType, number>(typeList.map((t, i) => [t, i]));

  // Clamped to generated_at: park_idea accepts a captured_at up to an hour ahead.
  const at = (t: number | null) => Math.min(to, t ?? to);
  const edgeTime = (e: IdeaMap['edges'][number]) =>
    at(e.status === 'accepted' ? (ms(e.decided_at) ?? ms(e.proposed_at)) : ms(e.proposed_at));
  const ideaTimes = map.nodes.filter((n) => n.node_type !== 'output').map((n) => at(ms(n.captured_at)));
  const from = Math.min(to, ...ideaTimes);

  const nodes: HtmlNode[] = map.nodes.map((n) => {
    const base = { n: stripLoneSurrogates(n.label), c: n.cluster, d: n.degree, h: idHash(n.id) };
    if (n.node_type === 'output') {
      // An output appears when it was published; failing that, with its
      // first link.
      const linked = map.edges.filter((e) => e.target === n.id).map(edgeTime);
      const t = at(ms(n.published_at) ?? (linked.length > 0 ? Math.min(...linked) : to));
      const u = httpUrl(n.url);
      return { ...base, y: 2, t, ...(u ? { u } : {}) };
    }
    const p = ms(n.promoted_at);
    return {
      ...base,
      y: n.node_type === 'synthesis' ? 1 : 0,
      s: n.status ?? undefined,
      t: at(ms(n.captured_at)),
      ...(n.inbox ? { i: 1 as const } : {}),
      ...(p !== null ? { p } : {}),
    };
  });

  const edges: HtmlEdge[] = map.edges
    .filter((e) => index.has(e.source) && index.has(e.target))
    .map((e) => ({
      a: index.get(e.source)!,
      b: index.get(e.target)!,
      y: typeIndex.get(e.type)!,
      ...(e.status === 'proposed' ? { p: 1 as const } : {}),
      g: stripLoneSurrogates(e.rationale),
      t: edgeTime(e),
    }));

  return {
    generated_at: map.generated_at,
    from,
    to,
    truncated: map.truncated,
    omitted: map.omitted_count,
    clusters: map.clusters.map((c) => ({ id: c.id, name: stripLoneSurrogates(c.name), size: c.size })),
    types: typeList.map((t) => ({ label: LINK_TYPE_INFO[t].label, directed: LINK_TYPE_INFO[t].directed, meaning: LINK_TYPE_INFO[t].meaning })),
    nodes,
    edges,
  };
}

export function htmlFilename(map: IdeaMap): string {
  return `idea-map-${map.generated_at.slice(0, 10)}.html`;
}

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const paletteVars = (p: string[]) => p.map((c, i) => `--c${i + 1}:${c};`).join('');

const STYLE = `
:root{color-scheme:light;--bg:#fcfcfb;--panel:#f3f2ef;--ink:#0b0b0b;--ink2:#52514e;--edge:#a3a29c;--hl:#0b0b0b;--grey:#b9b8b2;--ring:#fcfcfb;--star:#c98500;${paletteVars(PALETTE_LIGHT)}}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#1a1a19;--panel:#262624;--ink:#ffffff;--ink2:#c3c2b7;--edge:#5f5e59;--hl:#ffffff;--grey:#6b6a65;--ring:#1a1a19;--star:#eda100;${paletteVars(PALETTE_DARK)}}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","PingFang HK","Microsoft JhengHei",sans-serif}
body{padding:0 16px 24px;max-width:1200px;margin:0 auto;overflow-x:hidden}
header{padding:16px 0 8px}
h1{font-size:20px;margin:0}
.sub{color:var(--ink2);margin:2px 0 0}
.trunc{margin:6px 0 0;padding:6px 10px;background:var(--panel);border-radius:6px;color:var(--ink2)}
.controls{display:flex;align-items:center;gap:10px;padding:8px 0;flex-wrap:wrap}
.controls input[type=range]{flex:1 1 160px;min-width:0}
.controls output{color:var(--ink2);font-variant-numeric:tabular-nums;flex:1 1 100%}
button{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--edge);border-radius:6px;padding:4px 10px;cursor:pointer}
.wrap{position:relative;border:1px solid var(--panel);border-radius:8px;overflow:hidden;background:var(--bg)}
svg#map{display:block;width:100%;height:min(72vh,760px);touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab}
svg#map:active{cursor:grabbing}
.e line{stroke:var(--edge);stroke-width:1.2;vector-effect:non-scaling-stroke;fill:none}
.e.pr line{stroke-dasharray:5 4}
.e.hl line{stroke:var(--hl);stroke-width:2}
.n .sh{stroke:var(--ring);stroke-width:1.5;vector-effect:non-scaling-stroke}
.n.cmp .sh{opacity:.35}
.n.hl .sh{stroke:var(--hl);stroke-width:2.5}
.n text{fill:var(--ink);paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round;pointer-events:none}
.n .mn{display:none}
#map.zin .n .mn{display:inline}
.fade .n:not(.hl),.fade .e:not(.hl){opacity:.18}
.badge{fill:var(--ink);stroke:var(--bg);stroke-width:1;vector-effect:non-scaling-stroke}
.star{fill:var(--star);stroke:var(--bg);stroke-width:1;vector-effect:non-scaling-stroke}
.arr{fill:var(--edge)}
${PALETTE_LIGHT.map((_, i) => `.c${i + 1} .sh{fill:var(--c${i + 1})}`).join('')}
.cg .sh{fill:var(--grey)}
#tip{position:absolute;max-width:min(320px,80%);background:var(--panel);color:var(--ink);border:1px solid var(--edge);border-radius:6px;padding:6px 8px;font-size:13px;pointer-events:none;overflow-wrap:anywhere;box-shadow:0 2px 8px rgba(0,0,0,.15)}
#tip .gl{color:var(--ink2);margin-top:2px}
#sheet{position:fixed;left:16px;right:16px;bottom:0;max-width:640px;margin:0 auto;max-height:60vh;overflow:auto;background:var(--panel);border:1px solid var(--edge);border-bottom:0;border-radius:12px 12px 0 0;padding:12px 16px 16px;box-shadow:0 -4px 16px rgba(0,0,0,.2);overflow-wrap:anywhere}
#sheet h2{font-size:17px;margin:0 32px 4px 0}
#sheet .meta{color:var(--ink2);font-size:13px;margin:0 0 8px}
#sheet ul{list-style:none;margin:0;padding:0}
#sheet li{padding:6px 0;border-top:1px solid var(--edge)}
#sheet .lab{font-weight:600}
#sheet .gl{color:var(--ink2);font-size:13px}
#sheet .oth{background:none;border:0;padding:0;color:var(--ink);text-decoration:underline;text-align:left;font:inherit}
#sheet .x{position:absolute;right:12px;top:10px}
a{color:var(--c1)}
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px 24px;padding:12px 0}
.legend h3{font-size:14px;margin:0 0 4px}
.legend ul{list-style:none;margin:0;padding:0}
.legend li{display:flex;gap:8px;align-items:baseline;padding:2px 0;overflow-wrap:anywhere;min-width:0}
.legend .sw{flex:0 0 12px;height:12px;border-radius:3px;display:inline-block;transform:translateY(1px)}
.legend .mut{color:var(--ink2)}
.legend svg{flex:0 0 28px;overflow:visible}
.legend .lab{font-weight:600;white-space:nowrap}
.lg{fill:var(--grey)}
.lgc{fill:var(--grey);opacity:.35}
details{padding:4px 0}
details li{overflow-wrap:anywhere}
`;

// Client script. Plain ES2017, no template literals (this file embeds it
// verbatim), no markup strings, and user text only via textContent.
const SCRIPT = String.raw`
(function () {
  'use strict';
  var D = JSON.parse(document.getElementById('map-data').textContent);
  var svg = document.getElementById('map');
  var NS = svg.namespaceURI;
  var vp = document.getElementById('vp');
  var tip = document.getElementById('tip');
  var sheet = document.getElementById('sheet');
  var N = D.nodes.length;
  var COLOURED = ${HTML_COLOURED_CLUSTERS};
  var clusterSize = {};
  D.clusters.forEach(function (c) { clusterSize[c.id] = c.size; });
  var clusterName = {};
  D.clusters.forEach(function (c) { clusterName[c.id] = c.name; });
  function coloured(c) { return c >= 1 && c <= COLOURED && (clusterSize[c] || 0) >= 2; }
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, text, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function cut(s, n) { var a = Array.from(s.replace(/\s+/g, ' ').trim()); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('') || '(untitled)'; }
  function day(t) { return new Date(t).toISOString().slice(0, 10); }
  function count(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function radius(n) { return n.y === 2 ? 6 : 5 + Math.min(9, Math.sqrt(n.d) * 2.5); }

  // ── deterministic layout (force simulation seeded from ids) ──
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var X = new Float64Array(N), Y = new Float64Array(N), VX = new Float64Array(N), VY = new Float64Array(N), R = new Float64Array(N);
  var anchors = {};
  var rank = 0;
  D.clusters.slice().sort(function (a, b) { return a.id - b.id; }).forEach(function (c) {
    var r = 190 * Math.sqrt(rank), ang = rank * 2.399963;
    anchors[c.id] = [r * Math.cos(ang), r * Math.sin(ang)];
    rank++;
  });
  var outer = 190 * Math.sqrt(rank + 1) + 40;
  var deg = new Float64Array(N);
  D.edges.forEach(function (e) { deg[e.a]++; deg[e.b]++; });
  D.nodes.forEach(function (n, i) {
    var rnd = rng(n.h), a = anchors[n.c];
    R[i] = radius(n);
    if (a) { X[i] = a[0] + (rnd() - 0.5) * 80; Y[i] = a[1] + (rnd() - 0.5) * 80; }
    else { var ang = rnd() * 2 * Math.PI, rr = outer * (0.6 + rnd() * 0.5); X[i] = rr * Math.cos(ang); Y[i] = rr * Math.sin(ang); }
  });
  var ticks = N > 400 ? 160 : 300, alpha = 1, decay = 1 - Math.pow(0.001, 1 / ticks);
  for (var tick = 0; tick < ticks; tick++) {
    for (var i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var dx = X[i] - X[j], dy = Y[i] - Y[j], l = dx * dx + dy * dy;
        if (l > 90000) continue;
        if (l < 1) { dx = 1; dy = 0; l = 1; }
        var w = 140 * alpha / l;
        VX[i] += dx * w; VY[i] += dy * w; VX[j] -= dx * w; VY[j] -= dy * w;
        var min = R[i] + R[j] + 4;
        if (l < min * min) {
          var d = Math.sqrt(l), push = (min - d) / d * 0.25;
          X[i] += dx * push; Y[i] += dy * push; X[j] -= dx * push; Y[j] -= dy * push;
        }
      }
    }
    D.edges.forEach(function (e) {
      var dx = X[e.b] + VX[e.b] - X[e.a] - VX[e.a], dy = Y[e.b] + VY[e.b] - Y[e.a] - VY[e.a];
      var l = Math.sqrt(dx * dx + dy * dy) || 1, s = (e.p ? 0.3 : 1) / Math.max(1, Math.min(deg[e.a], deg[e.b]));
      var k = (l - 55) / l * alpha * s * 0.6;
      VX[e.b] -= dx * k; VY[e.b] -= dy * k; VX[e.a] += dx * k; VY[e.a] += dy * k;
    });
    for (i = 0; i < N; i++) {
      var a = anchors[D.nodes[i].c];
      if (a) { VX[i] += (a[0] - X[i]) * 0.035 * alpha; VY[i] += (a[1] - Y[i]) * 0.035 * alpha; }
      else { VX[i] -= X[i] * 0.03 * alpha; VY[i] -= Y[i] * 0.03 * alpha; }
      VX[i] *= 0.6; VY[i] *= 0.6; X[i] += VX[i]; Y[i] += VY[i];
    }
    alpha -= alpha * decay;
  }
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (i = 0; i < N; i++) {
    minX = Math.min(minX, X[i] - R[i]); maxX = Math.max(maxX, X[i] + R[i]);
    minY = Math.min(minY, Y[i] - R[i]); maxY = Math.max(maxY, Y[i] + R[i]);
  }
  if (!N) { minX = minY = -100; maxX = maxY = 100; }
  // A tiny map keeps a minimum frame so its nodes don't fill the screen.
  var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  minX = Math.min(minX, cx - 180); maxX = Math.max(maxX, cx + 180);
  minY = Math.min(minY, cy - 180); maxY = Math.max(maxY, cy + 180);
  var pad = 60;
  svg.setAttribute('viewBox', [minX - pad, minY - pad, maxX - minX + 2 * pad, maxY - minY + 2 * pad].join(' '));

  // ── drawing ──
  var defs = el('defs', {}, svg);
  var mk = el('marker', { id: 'arr', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', markerUnits: 'userSpaceOnUse', orient: 'auto' }, defs);
  el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arr' }, mk);
  var gE = el('g', {}, vp), gN = el('g', {}, vp);
  var adj = D.nodes.map(function () { return []; });
  var edgeEls = D.edges.map(function (e, k) {
    adj[e.a].push(k); adj[e.b].push(k);
    var g = el('g', { class: 'e' + (e.p ? ' pr' : '') }, gE);
    var dx = X[e.b] - X[e.a], dy = Y[e.b] - Y[e.a], l = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / l, uy = dy / l, ra = R[e.a] + 1, rb = R[e.b] + (D.types[e.y].directed ? 3 : 1);
    var line = el('line', { x1: X[e.a] + ux * ra, y1: Y[e.a] + uy * ra, x2: X[e.b] - ux * rb, y2: Y[e.b] - uy * rb }, g);
    if (D.types[e.y].directed) line.setAttribute('marker-end', 'url(#arr)');
    return g;
  });
  function hexagon(r) {
    var p = [];
    for (var k = 0; k < 6; k++) { var a = Math.PI / 6 + k * Math.PI / 3; p.push((r * Math.cos(a)).toFixed(2) + ',' + (r * Math.sin(a)).toFixed(2)); }
    return p.join(' ');
  }
  var hubs = {};
  D.nodes.map(function (n, i) { return i; })
    .filter(function (i) { return D.nodes[i].d >= 3; })
    .sort(function (a, b) { return D.nodes[b].d - D.nodes[a].d || a - b; })
    .slice(0, 12)
    .forEach(function (i) { hubs[i] = true; });
  var nodeEls = D.nodes.map(function (n, i) {
    var cls = 'n ' + (coloured(n.c) ? 'c' + n.c : 'cg') + (n.s === 'composted' ? ' cmp' : '');
    var g = el('g', { class: cls, transform: 'translate(' + X[i].toFixed(2) + ',' + Y[i].toFixed(2) + ')' }, gN);
    var r = R[i], sh;
    if (n.y === 1) sh = el('polygon', { points: hexagon(r * 1.15) }, g);
    else if (n.y === 2) sh = el('rect', { x: -r, y: -r, width: 2 * r, height: 2 * r, rx: 2.5 }, g);
    else sh = el('circle', { r: r }, g);
    sh.setAttribute('class', 'sh');
    var star = null;
    if (n.i) el('circle', { class: 'badge', cx: r * 0.75, cy: -r * 0.75, r: 2.6 }, g);
    if (n.p) {
      star = el('polygon', { class: 'star', points: '0,-5 1.5,-1.5 5,-1.5 2.2,0.8 3.2,4.5 0,2.3 -3.2,4.5 -2.2,0.8 -5,-1.5 -1.5,-1.5' }, g);
      star.setAttribute('transform', 'translate(' + (-r * 0.8).toFixed(2) + ',' + (-r * 0.8).toFixed(2) + ')');
    }
    // Labels for each cluster's namesake and the biggest hubs; the rest
    // once zoomed in.
    var major = hubs[i] || (n.y !== 2 && clusterName[n.c] === n.n);
    var t = el('text', { x: r + 3, y: 4, class: major ? '' : 'mn' }, g);
    t.textContent = cut(n.n, 32);
    return { g: g, star: star };
  });

  // ── zoom and pan ──
  var view = { x: 0, y: 0, k: 1 };
  function baseScale() { var ctm = svg.getScreenCTM(); return ctm ? ctm.a : 1; }
  function apply() {
    vp.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
    var s = baseScale() * view.k;
    vp.style.fontSize = (12 / s).toFixed(3) + 'px';
    svg.classList.toggle('zin', s >= 1.6);
  }
  function svgPoint(cx, cy) {
    var ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    var p = new DOMPoint(cx, cy).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }
  function zoomAt(c, f) {
    var k = Math.max(0.3, Math.min(12, view.k * f));
    f = k / view.k;
    view.x = c.x - f * (c.x - view.x); view.y = c.y - f * (c.y - view.y); view.k = k;
    apply();
  }
  function toLayout(p) { return { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k }; }

  // ── as-of slider ──
  var slider = document.getElementById('asof');
  var asofOut = document.getElementById('asof-label');
  var T = D.to;
  function nodeOn(i) { return D.nodes[i].t <= T; }
  function edgeOn(k) { var e = D.edges[k]; return e.t <= T && nodeOn(e.a) && nodeOn(e.b); }
  function setT(t) {
    T = t;
    var ideas = 0, links = 0;
    D.nodes.forEach(function (n, i) {
      var on = nodeOn(i);
      nodeEls[i].g.style.display = on ? '' : 'none';
      if (nodeEls[i].star) nodeEls[i].star.style.display = n.p <= T ? '' : 'none';
      if (on && n.y !== 2) ideas++;
    });
    D.edges.forEach(function (e, k) {
      var on = edgeOn(k);
      edgeEls[k].style.display = on ? '' : 'none';
      if (on) links++;
    });
    asofOut.textContent = count(ideas, 'idea', 'ideas') + ' · ' + count(links, 'link', 'links') + ' as of ' + day(T);
    if (selected !== null) {
      if (nodeOn(selected)) { highlight(selected); renderSheet(selected); } else openSheet(null);
    }
  }
  var playBtn = document.getElementById('play');
  var playing = null;
  function stop() { if (playing) cancelAnimationFrame(playing); playing = null; playBtn.textContent = '▶ Play'; }
  playBtn.addEventListener('click', function () {
    if (playing) { stop(); return; }
    var start = Number(slider.value) >= D.to ? D.from : Number(slider.value);
    var t0 = null, span = Math.max(1, D.to - D.from), dur = 12000 * (D.to - start) / span + 1;
    playBtn.textContent = '❚❚ Pause';
    function step(now) {
      if (t0 === null) t0 = now;
      var t = Math.min(D.to, start + (now - t0) / dur * (D.to - start));
      slider.value = String(t);
      setT(t);
      if (t < D.to) playing = requestAnimationFrame(step); else stop();
    }
    playing = requestAnimationFrame(step);
  });
  slider.addEventListener('input', function () { stop(); setT(Number(slider.value)); });
  if (D.to <= D.from) { slider.disabled = true; playBtn.disabled = true; }

  // ── hit testing, tooltips and the node sheet ──
  function hit(p) {
    var s = baseScale() * view.k, best = null, bd = Infinity;
    for (var i = 0; i < N; i++) {
      if (!nodeOn(i)) continue;
      var dx = X[i] - p.x, dy = Y[i] - p.y, d = Math.sqrt(dx * dx + dy * dy) - R[i];
      if (d < bd) { bd = d; best = i; }
    }
    if (best !== null && bd <= 14 / s) return { node: best };
    var be = null, bed = Infinity;
    D.edges.forEach(function (e, k) {
      if (!edgeOn(k)) return;
      var ax = X[e.a], ay = Y[e.a], bx = X[e.b], by = Y[e.b], vx = bx - ax, vy = by - ay;
      var l2 = vx * vx + vy * vy || 1, u = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.y - ay) * vy) / l2));
      var dx = ax + u * vx - p.x, dy = ay + u * vy - p.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < bed) { bed = d; be = k; }
    });
    if (be !== null && bed <= 10 / s) return { edge: be };
    return null;
  }
  function relation(e) { return D.types[e.y].label + (e.p ? ' (proposed)' : ''); }
  function showTip(target, cx, cy) {
    tip.textContent = '';
    if (target.node !== undefined) {
      var n = D.nodes[target.node];
      h('div', '', n.n, tip);
      var bits = [];
      if (n.y === 1) bits.push('synthesis'); else if (n.y === 2) bits.push('output');
      if (n.s && n.s !== 'parked') bits.push(n.s);
      if (n.i) bits.push('inbox');
      if (n.p && n.p <= T) bits.push('promoted');
      if (bits.length) h('div', 'gl', bits.join(' · '), tip);
    } else {
      var e = D.edges[target.edge];
      h('div', '', cut(D.nodes[e.a].n, 40) + ' —' + relation(e) + (D.types[e.y].directed ? '→ ' : '— ') + cut(D.nodes[e.b].n, 40), tip);
      h('div', 'gl', e.g, tip);
    }
    tip.hidden = false;
    var box = svg.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    var x = Math.min(Math.max(4, cx - box.left + 12), box.width - tw - 4), y = cy - box.top + 14;
    if (y + th > box.height - 4) y = Math.max(4, cy - box.top - th - 10);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tip.hidden = true; }
  var selected = null;
  function highlight(i) {
    svg.classList.toggle('fade', i !== null);
    nodeEls.forEach(function (x) { x.g.classList.remove('hl'); });
    edgeEls.forEach(function (x) { x.classList.remove('hl'); });
    if (i === null) return;
    nodeEls[i].g.classList.add('hl');
    adj[i].forEach(function (k) {
      if (!edgeOn(k)) return;
      edgeEls[k].classList.add('hl');
      var e = D.edges[k];
      nodeEls[e.a === i ? e.b : e.a].g.classList.add('hl');
    });
  }
  function renderSheet(i) {
    var n = D.nodes[i];
    sheet.textContent = '';
    var close = h('button', 'x', '✕', sheet);
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { openSheet(null); });
    h('h2', '', n.n, sheet);
    var meta = [n.y === 1 ? 'synthesis' : n.y === 2 ? 'output' : 'idea'];
    if (n.s) meta.push(n.s);
    if (clusterSize[n.c] >= 2) meta.push('cluster: ' + cut(clusterName[n.c] || '', 40));
    meta.push((n.y === 2 ? 'on the map from ' : 'captured ') + day(n.t));
    if (n.i) meta.push('in the inbox');
    if (n.p && n.p <= T) meta.push('promoted ' + day(n.p));
    h('p', 'meta', meta.join(' · '), sheet);
    if (n.u) {
      var p = h('p', '', null, sheet), a = h('a', '', 'Open the published piece', p);
      a.href = n.u; a.target = '_blank'; a.rel = 'noopener noreferrer';
    }
    var ks = adj[i].filter(edgeOn);
    if (!ks.length) { h('p', 'meta', 'No links as of ' + day(T) + '.', sheet); return; }
    var ul = h('ul', '', null, sheet);
    ks.forEach(function (k) {
      var e = D.edges[k], other = e.a === i ? e.b : e.a, incoming = D.types[e.y].directed && e.b === i;
      var li = h('li', '', null, ul);
      h('span', 'lab', relation(e) + (incoming ? ' ← ' : ' → '), li);
      var b = h('button', 'oth', D.nodes[other].n, li);
      b.addEventListener('click', function () { openSheet(other); });
      h('div', 'gl', e.g, li);
    });
  }
  function openSheet(i) {
    selected = i;
    highlight(i);
    if (i === null) { sheet.hidden = true; return; }
    renderSheet(i);
    sheet.hidden = false;
    sheet.scrollTop = 0;
  }
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { openSheet(null); hideTip(); } });

  var pointers = new Map(), moved = 0, pinch = null, pinned = false;
  svg.addEventListener('pointerdown', function (ev) {
    svg.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 1) moved = 0;
    pinch = null;
  });
  svg.addEventListener('pointermove', function (ev) {
    var prev = pointers.get(ev.pointerId);
    if (!prev) {
      if (ev.pointerType === 'mouse' && !pinned) {
        var t = hit(toLayout(svgPoint(ev.clientX, ev.clientY)));
        if (t) showTip(t, ev.clientX, ev.clientY); else hideTip();
      }
      return;
    }
    var cur = { x: ev.clientX, y: ev.clientY };
    moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
    if (pointers.size === 1) {
      var a = svgPoint(prev.x, prev.y), b = svgPoint(cur.x, cur.y);
      view.x += b.x - a.x; view.y += b.y - a.y;
      apply();
    } else if (pointers.size === 2) {
      var ps = [];
      pointers.forEach(function (v, id) { ps.push(id === ev.pointerId ? cur : v); });
      var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      var mid = svgPoint((ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2);
      if (pinch) {
        view.x += mid.x - pinch.mid.x; view.y += mid.y - pinch.mid.y;
        zoomAt(mid, d / (pinch.d || d));
      }
      pinch = { d: d, mid: mid };
    }
    pointers.set(ev.pointerId, cur);
  });
  function up(ev) {
    var was = pointers.size;
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (ev.type !== 'pointerup' || was !== 1 || moved > 8) return;
    var t = hit(toLayout(svgPoint(ev.clientX, ev.clientY)));
    if (t && t.node !== undefined) { pinned = false; hideTip(); openSheet(t.node); }
    else if (t) { pinned = true; showTip(t, ev.clientX, ev.clientY); }
    else { pinned = false; hideTip(); openSheet(null); }
  }
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
  svg.addEventListener('pointerleave', function (ev) { if (ev.pointerType === 'mouse' && !pinned) hideTip(); });
  svg.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    zoomAt(svgPoint(ev.clientX, ev.clientY), Math.exp(-ev.deltaY * 0.001));
  }, { passive: false });
  document.getElementById('fit').addEventListener('click', function () { view = { x: 0, y: 0, k: 1 }; apply(); });
  window.addEventListener('resize', apply);

  // ── header and legend ──
  var ideaCount = D.nodes.filter(function (n) { return n.y !== 2; }).length;
  document.getElementById('sub').textContent = count(ideaCount, 'idea', 'ideas') + ' · ' + count(D.edges.length, 'link', 'links') + ' · generated ' + day(D.to);
  if (D.truncated) {
    var tr = document.getElementById('trunc');
    tr.textContent = 'Truncated: ' + D.omitted + ' more ' + (D.omitted === 1 ? 'node was' : 'nodes were') + ' left out (max_nodes). The best-connected ideas are shown.';
    tr.hidden = false;
  }
  var lc = document.getElementById('legend-clusters');
  var shown = 0, rest = 0;
  D.clusters.forEach(function (c) {
    if (!coloured(c.id)) { rest++; return; }
    shown++;
    var li = h('li', '', null, lc), sw = h('span', 'sw', null, li);
    sw.style.background = 'var(--c' + c.id + ')';
    h('span', '', cut(c.name, 60), li);
    h('span', 'mut', '(' + c.size + ')', li);
  });
  var grey = h('li', '', null, lc);
  h('span', 'sw', null, grey).style.background = 'var(--grey)';
  h('span', 'mut', (rest ? rest + ' smaller ' + (rest === 1 ? 'cluster' : 'clusters') + ' and ' : '') + 'unlinked ideas', grey);
  if (!shown) h('li', 'mut', 'No clusters yet: clusters form as links are accepted.', lc);
  var lt = document.getElementById('legend-types');
  D.types.forEach(function (t) {
    var li = h('li', '', null, lt);
    h('span', 'lab', t.label + (t.directed ? ' →' : ' —'), li);
    h('span', 'mut', t.meaning, li);
  });
  if (!D.types.length) h('li', 'mut', 'No links yet.', lt);

  var list = document.getElementById('list');
  list.addEventListener('toggle', function () {
    if (!list.open || list.dataset.done) return;
    list.dataset.done = '1';
    var groups = {};
    D.nodes.forEach(function (n, i) { if (n.y !== 2) (groups[n.c] = groups[n.c] || []).push(i); });
    D.clusters.forEach(function (c) {
      h('h3', '', cut(c.name, 80) + ' (' + c.size + ')', list);
      var ul = h('ul', '', null, list);
      (groups[c.id] || []).forEach(function (i) { h('li', '', D.nodes[i].n, ul); });
    });
    var single = D.nodes.filter(function (n) { return n.y !== 2 && !(clusterSize[n.c] >= 2); });
    if (single.length) {
      h('h3', '', 'Not in a cluster (' + single.length + ')', list);
      var ul = h('ul', '', null, list);
      single.forEach(function (n) { h('li', '', n.n, ul); });
    }
  });

  apply();
  setT(D.to);
})();
`;

export function toHtml(map: IdeaMap): string {
  const data = htmlPayload(map);
  const date = map.generated_at.slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>Idea map ${date}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Idea map</h1>
<p class="sub" id="sub"></p>
<p class="trunc" id="trunc" hidden></p>
</header>
<div class="controls">
<button type="button" id="play">&#9654; Play</button>
<input type="range" id="asof" min="${data.from}" max="${data.to}" step="any" value="${data.to}" aria-label="Show the map as of a date">
<button type="button" id="fit">Fit</button>
<output id="asof-label" for="asof"></output>
</div>
<div class="wrap">
<svg id="map" role="img" aria-label="Idea map: tap a node for its links, tap a line for its gloss; drag to pan, pinch or scroll to zoom"><g id="vp"></g></svg>
<div id="tip" hidden></div>
</div>
<section class="legend" aria-label="Legend">
<div><h3>Clusters</h3><ul id="legend-clusters"></ul></div>
<div><h3>Links</h3><ul id="legend-types"></ul>
<ul><li><svg width="28" height="10" aria-hidden="true"><line x1="0" y1="5" x2="28" y2="5" stroke="currentColor" stroke-dasharray="5 4"/></svg><span class="mut">dashed: proposed, not yet accepted</span></li></ul></div>
<div><h3>Nodes</h3><ul>
<li><svg width="28" height="14" aria-hidden="true"><circle cx="14" cy="7" r="6" class="lg"/></svg><span>idea</span></li>
<li><svg width="28" height="14" aria-hidden="true"><polygon points="20,7 17,12.2 11,12.2 8,7 11,1.8 17,1.8" class="lg"/></svg><span>synthesis</span></li>
<li><svg width="28" height="14" aria-hidden="true"><rect x="8" y="1" width="12" height="12" rx="2.5" class="lg"/></svg><span>published output</span></li>
<li><svg width="28" height="14" aria-hidden="true"><circle cx="14" cy="7" r="6" class="lg"/><circle class="badge" cx="18.5" cy="2.5" r="2.6"/></svg><span>dot: in the inbox (not yet reviewed)</span></li>
<li><svg width="28" height="14" aria-hidden="true"><polygon class="star" transform="translate(14,7)" points="0,-5 1.5,-1.5 5,-1.5 2.2,0.8 3.2,4.5 0,2.3 -3.2,4.5 -2.2,0.8 -5,-1.5 -1.5,-1.5"/></svg><span>star: promoted to Subjects</span></li>
<li><svg width="28" height="14" aria-hidden="true"><circle cx="14" cy="7" r="6" class="lgc"/></svg><span>faded: composted</span></li>
</ul></div>
</section>
<details id="list"><summary>Clusters as a list</summary></details>
<aside id="sheet" hidden></aside>
<script type="application/json" id="map-data">${scriptJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
