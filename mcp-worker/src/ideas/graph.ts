// Pure graph assembly + serialisation for export_idea_map. The tool
// handler does the SQL; everything here is deterministic and unit-tested.

import { LINK_TYPE_INFO, legend, type LinkType } from './linkTypes';
import { truncateChars } from './text';

export type MapIdea = {
  id: string;
  title: string;
  kind: 'unit' | 'synthesis';
  intent: string | null;
  status: string;
  captured_at: string;
  tags: string[];
};

export type MapArtifact = {
  id: string;
  title: string;
  url: string | null;
  published_at: string | null;
  type: string | null;
};

export type MapLink = {
  id: string;
  source_idea_id: string;
  target_idea_id: string | null;
  target_artifact_id: string | null;
  link_type: LinkType;
  status: 'accepted' | 'proposed';
  rationale: string;
};

export type Territory = 'territory' | 'adjacent' | 'frontier';

export type MapNode = {
  id: string;
  node_type: 'idea' | 'synthesis' | 'output';
  label: string;
  status: string | null;
  kind: string | null;
  intent: string | null;
  captured_at: string | null;
  tags: string[];
  degree: number;
  pending_degree: number;
  // Connected component over accepted idea↔idea links (ranked by size,
  // 1 = largest). Output nodes take the component of an idea they link to.
  component: number;
  component_size: number;
  territory: Territory | null;
  url: string | null;
  published_at: string | null;
};

export type MapEdge = {
  id: string;
  source: string;
  target: string;
  type: LinkType;
  directed: boolean;
  status: 'accepted' | 'proposed';
  rationale: string;
};

export type IdeaMap = {
  format: 'idea-map/v1';
  generated_at: string;
  filters: Record<string, unknown>;
  stats: { nodes: number; edges: number; components: number; orphans: number };
  truncated: boolean;
  omitted_count: number;
  nodes: MapNode[];
  edges: MapEdge[];
  legend: {
    link_types: ReturnType<typeof legend>;
    statuses: string[];
    territory: Record<Territory, string>;
  };
};

export type BuildOptions = {
  focus_idea_id?: string;
  depth: number;
  include_outputs: boolean;
  include_pending: boolean;
  include_isolated: boolean;
  max_nodes: number;
  generated_at: string;
  filters: Record<string, unknown>;
};

const TERRITORY_LEGEND: Record<Territory, string> = {
  territory: 'has an accepted `became` link: the idea turned into a published output',
  adjacent: 'has an accepted `revisits` link but no `became`',
  frontier: 'no output yet',
};

function targetOf(l: MapLink): string {
  return (l.target_idea_id ?? l.target_artifact_id) as string;
}

// Build the map from ideas (already status/since-filtered), the links
// among them (accepted + proposed), and the artifacts those links point at.
export function buildIdeaMap(
  ideas: MapIdea[],
  links: MapLink[],
  artifacts: MapArtifact[],
  opts: BuildOptions,
): IdeaMap {
  const ideaById = new Map(ideas.map((i) => [i.id, i]));
  const artifactById = new Map(artifacts.map((a) => [a.id, a]));

  // Only links whose endpoints are in the candidate set are usable.
  const usable = links.filter((l) => {
    if (!ideaById.has(l.source_idea_id)) return false;
    if (l.target_idea_id) return ideaById.has(l.target_idea_id);
    return opts.include_outputs && !!l.target_artifact_id && artifactById.has(l.target_artifact_id);
  });
  const visibleLinks = opts.include_pending ? usable : usable.filter((l) => l.status === 'accepted');

  // Degrees over every link whose idea endpoints are candidates — output
  // links count even when outputs are hidden, so degree (and therefore
  // orphan status) doesn't change with include_outputs.
  const degree = new Map<string, number>();
  const pendingDegree = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const l of links) {
    if (!ideaById.has(l.source_idea_id)) continue;
    if (l.target_idea_id && !ideaById.has(l.target_idea_id)) continue;
    const m = l.status === 'accepted' ? degree : pendingDegree;
    bump(m, l.source_idea_id);
    bump(m, targetOf(l));
  }

  // Territory from accepted output links (regardless of include_outputs).
  const territory = new Map<string, Territory>();
  for (const l of links) {
    if (l.status !== 'accepted') continue;
    if (l.link_type === 'became') territory.set(l.source_idea_id, 'territory');
    else if (l.link_type === 'revisits' && territory.get(l.source_idea_id) !== 'territory') {
      territory.set(l.source_idea_id, 'adjacent');
    }
  }

  // Candidate node ids: all ideas + artifacts referenced by usable links.
  const candidateArtifacts = new Set<string>();
  if (opts.include_outputs) {
    for (const l of visibleLinks) if (l.target_artifact_id) candidateArtifacts.add(l.target_artifact_id);
  }

  // Adjacency over visible links (undirected for traversal).
  const adj = new Map<string, string[]>();
  const addAdj = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(b);
  };
  for (const l of visibleLinks) {
    addAdj(l.source_idea_id, targetOf(l));
    addAdj(targetOf(l), l.source_idea_id);
  }

  // Ordered list of node ids to keep (before max_nodes truncation).
  let ordered: string[];
  if (opts.focus_idea_id && ideaById.has(opts.focus_idea_id)) {
    ordered = [];
    const seen = new Set<string>([opts.focus_idea_id]);
    let frontier = [opts.focus_idea_id];
    ordered.push(opts.focus_idea_id);
    for (let d = 0; d < opts.depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        // Outputs are leaves: expanding through a popular episode would
        // pull in every unrelated idea that also links to it.
        if (!ideaById.has(id)) continue;
        const neighbours = [...(adj.get(id) ?? [])].sort(
          (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b),
        );
        for (const n of neighbours) {
          if (seen.has(n)) continue;
          if (!ideaById.has(n) && !candidateArtifacts.has(n)) continue;
          seen.add(n);
          ordered.push(n);
          next.push(n);
        }
      }
      frontier = next;
    }
  } else {
    const ideaIds = ideas
      .filter((i) => opts.include_isolated || (adj.get(i.id)?.length ?? 0) > 0)
      .sort(
        (a, b) =>
          (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
          b.captured_at.localeCompare(a.captured_at) ||
          a.id.localeCompare(b.id),
      )
      .map((i) => i.id);
    const artifactIds = [...candidateArtifacts].sort(
      (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b),
    );
    ordered = [...ideaIds, ...artifactIds];
  }

  // Truncate. Without a focus, keep ideas first, then only artifacts that
  // still connect to a kept idea.
  let kept = ordered.slice(0, opts.max_nodes);
  let keptSet = new Set(kept);
  if (!opts.focus_idea_id) {
    const keptIdeas = kept.filter((id) => ideaById.has(id));
    const keptIdeaSet = new Set(keptIdeas);
    const room = opts.max_nodes - keptIdeas.length;
    const linkedArtifacts = ordered
      .filter((id) => artifactById.has(id))
      .filter((id) => (adj.get(id) ?? []).some((n) => keptIdeaSet.has(n)))
      .slice(0, Math.max(0, room));
    kept = [...keptIdeas, ...linkedArtifacts];
    keptSet = new Set(kept);
  }
  const omitted = ordered.length - kept.length;

  const edges: MapEdge[] = visibleLinks
    .filter((l) => keptSet.has(l.source_idea_id) && keptSet.has(targetOf(l)))
    .map((l) => ({
      id: l.id,
      source: l.source_idea_id,
      target: targetOf(l),
      type: l.link_type,
      directed: LINK_TYPE_INFO[l.link_type].directed,
      status: l.status,
      rationale: l.rationale,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Connected components over ACCEPTED idea↔idea edges among kept ideas.
  const keptIdeas = kept.filter((id) => ideaById.has(id));
  const parent = new Map<string, string>(keptIdeas.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const e of edges) {
    if (e.status !== 'accepted' || !parent.has(e.source) || !parent.has(e.target)) continue;
    const ra = find(e.source);
    const rb = find(e.target);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of keptIdeas) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(id);
  }
  const ranked = [...groups.values()].sort(
    (a, b) => b.length - a.length || [...a].sort()[0].localeCompare([...b].sort()[0]),
  );
  const componentOf = new Map<string, { id: number; size: number }>();
  ranked.forEach((members, i) => {
    for (const m of members) componentOf.set(m, { id: i + 1, size: members.length });
  });
  // An output joins the (best-ranked) component of an idea that links to it.
  for (const id of kept) {
    if (ideaById.has(id)) continue;
    const linked = edges
      .filter((e) => e.target === id && componentOf.has(e.source))
      .map((e) => componentOf.get(e.source)!)
      .sort((a, b) => a.id - b.id);
    componentOf.set(id, linked[0] ?? { id: 0, size: 0 });
  }

  const nodes: MapNode[] = kept.map((id) => {
    const comp = componentOf.get(id)!;
    const idea = ideaById.get(id);
    if (idea) {
      return {
        id,
        node_type: idea.kind === 'synthesis' ? 'synthesis' : 'idea',
        label: idea.title,
        status: idea.status,
        kind: idea.kind,
        intent: idea.intent,
        captured_at: idea.captured_at,
        tags: idea.tags,
        degree: degree.get(id) ?? 0,
        pending_degree: pendingDegree.get(id) ?? 0,
        component: comp.id,
        component_size: comp.size,
        territory: territory.get(id) ?? 'frontier',
        url: null,
        published_at: null,
      };
    }
    const a = artifactById.get(id)!;
    return {
      id,
      node_type: 'output',
      label: a.title,
      status: null,
      kind: a.type,
      intent: null,
      captured_at: null,
      tags: [],
      degree: degree.get(id) ?? 0,
      pending_degree: pendingDegree.get(id) ?? 0,
      component: comp.id,
      component_size: comp.size,
      territory: null,
      url: a.url,
      published_at: a.published_at,
    };
  });


  return {
    format: 'idea-map/v1',
    generated_at: opts.generated_at,
    filters: opts.filters,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      components: ranked.length,
      // Ideas with no accepted link of any kind (same as list_ideas unlinked).
      orphans: nodes.filter((n) => n.node_type !== 'output' && n.degree === 0).length,
    },
    truncated: omitted > 0,
    omitted_count: omitted,
    nodes,
    edges,
    legend: {
      link_types: legend(),
      statuses: ['parked', 'exploring', 'used', 'composted'],
      territory: TERRITORY_LEGEND,
    },
  };
}

// ── GraphML ───────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s
    // XML 1.0 forbids most C0 controls, U+FFFE/U+FFFF and lone surrogates.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const NODE_KEYS: Array<[keyof MapNode, string]> = [
  ['label', 'string'],
  ['node_type', 'string'],
  ['status', 'string'],
  ['kind', 'string'],
  ['intent', 'string'],
  ['captured_at', 'string'],
  ['tags', 'string'],
  ['degree', 'int'],
  ['pending_degree', 'int'],
  ['component', 'int'],
  ['component_size', 'int'],
  ['territory', 'string'],
  ['url', 'string'],
  ['published_at', 'string'],
];

const EDGE_KEYS: Array<[keyof MapEdge, string]> = [
  ['type', 'string'],
  ['status', 'string'],
  ['rationale', 'string'],
  ['directed', 'boolean'],
];

export function toGraphML(map: IdeaMap): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns">');
  for (const [k, t] of NODE_KEYS) {
    lines.push(`  <key id="n_${k}" for="node" attr.name="${k}" attr.type="${t}"/>`);
  }
  for (const [k, t] of EDGE_KEYS) {
    lines.push(`  <key id="e_${k}" for="edge" attr.name="${k}" attr.type="${t}"/>`);
  }
  lines.push('  <graph id="idea-map" edgedefault="directed">');
  for (const n of map.nodes) {
    lines.push(`    <node id="${xmlEscape(n.id)}">`);
    for (const [k] of NODE_KEYS) {
      const v = n[k];
      if (v === null || v === undefined) continue;
      const s = Array.isArray(v) ? v.join(', ') : String(v);
      if (Array.isArray(v) && v.length === 0) continue;
      lines.push(`      <data key="n_${k}">${xmlEscape(s)}</data>`);
    }
    lines.push('    </node>');
  }
  // Symmetric links carry directed=false in the e_directed data key rather
  // than a per-edge XML attribute: mixed graphs break common readers
  // (networkx refuses them).
  for (const e of map.edges) {
    lines.push(`    <edge id="${xmlEscape(e.id)}" source="${xmlEscape(e.source)}" target="${xmlEscape(e.target)}">`);
    for (const [k] of EDGE_KEYS) {
      lines.push(`      <data key="e_${k}">${xmlEscape(String(e[k]))}</data>`);
    }
    lines.push('    </edge>');
  }
  lines.push('  </graph>');
  lines.push('</graphml>');
  return lines.join('\n');
}

// ── Mermaid ───────────────────────────────────────────────────────────

export const MERMAID_MAX_NODES = 150;
// Mermaid refuses to render more than 500 edges by default (maxEdges).
export const MERMAID_MAX_EDGES = 500;

const MERMAID_ENTITIES: Record<string, string> = {
  '#': '#35;',
  '"': '#quot;',
  '&': '#38;',
  '<': '#60;',
  '>': '#62;',
  '`': '#96;',
  '%': '#37;',
};

// Labels go inside ["…"]: flatten, truncate by code point, then encode the
// characters Mermaid would treat as markup (one pass, so '#' is never
// double-encoded).
export function mermaidLabel(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (!flat) return '(untitled)';
  return truncateChars(flat, max).replace(/[#"&<>`%]/g, (c) => MERMAID_ENTITIES[c]);
}

export function toMermaid(map: IdeaMap): string {
  const idFor = new Map<string, string>();
  map.nodes.forEach((n, i) => idFor.set(n.id, `n${i + 1}`));
  const lines: string[] = ['flowchart LR'];
  for (const n of map.nodes) {
    const id = idFor.get(n.id)!;
    const label = mermaidLabel(n.label);
    if (n.node_type === 'synthesis') lines.push(`  ${id}{{"${label}"}}`);
    else if (n.node_type === 'output') lines.push(`  ${id}(["${label}"])`);
    else lines.push(`  ${id}["${label}"]`);
  }
  // Accepted edges first, so a cap drops proposals before decisions.
  const edges = [...map.edges].sort((x, y) => (x.status === y.status ? 0 : x.status === 'accepted' ? -1 : 1));
  for (const e of edges.slice(0, MERMAID_MAX_EDGES)) {
    const a = idFor.get(e.source);
    const b = idFor.get(e.target);
    if (!a || !b) continue;
    if (e.status === 'proposed') {
      lines.push(e.directed ? `  ${a} -.->|${e.type}?| ${b}` : `  ${a} -.-|${e.type}?| ${b}`);
    } else {
      lines.push(e.directed ? `  ${a} -->|${e.type}| ${b}` : `  ${a} ---|${e.type}| ${b}`);
    }
  }
  lines.push('  classDef frontier fill:#eef4ff,stroke:#4a6fa5');
  lines.push('  classDef adjacent fill:#fff6e0,stroke:#b8860b');
  lines.push('  classDef territory fill:#e6f5e9,stroke:#2e7d32');
  lines.push('  classDef output fill:#f3e8ff,stroke:#6a3d9a');
  lines.push('  classDef composted fill:#eeeeee,stroke:#999999,color:#666666');
  const byClass = new Map<string, string[]>();
  for (const n of map.nodes) {
    const cls =
      n.node_type === 'output' ? 'output' : n.status === 'composted' ? 'composted' : (n.territory ?? 'frontier');
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls)!.push(idFor.get(n.id)!);
  }
  for (const [cls, ids] of byClass) lines.push(`  class ${ids.join(',')} ${cls}`);
  return lines.join('\n');
}
