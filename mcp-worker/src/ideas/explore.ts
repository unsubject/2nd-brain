// Pure assembly for explore_topic ("what do I have on X?"): seeds from the
// hybrid search, expanded over links up to `depth` hops, returned grouped
// by connected component with every link's display label and gloss. The
// handler does the SQL; everything here is deterministic.

import { linkLabel, type LinkType } from './linkTypes';

export type ExploreSeed = { id: string; title: string; similarity: number | null; match: string[] };
export type ExploreIdea = { id: string; title: string; status: string; kind: string; inbox: boolean };
export type ExploreLink = {
  id: string;
  source_idea_id: string;
  target_idea_id: string | null;
  target_artifact_id: string | null;
  link_type: LinkType;
  status: 'accepted' | 'proposed';
  rationale: string;
};
export type ExploreArtifact = { id: string; title: string; url: string | null };

export type ExploreResult = {
  seeds: ExploreSeed[];
  clusters: Array<{
    name: string;
    ideas: Array<{ id: string; title: string; status: string; kind: string; is_seed: boolean; inbox: boolean }>;
    links: Array<{
      source_id: string;
      source_title: string;
      link_type: LinkType;
      label: string;
      target_id: string;
      target_title: string;
      gloss: string;
      status: 'accepted' | 'proposed';
    }>;
  }>;
  outputs: Array<{
    id: string;
    title: string;
    url: string | null;
    link_type: LinkType;
    label: string;
    idea_id: string;
    status: 'accepted' | 'proposed';
  }>;
  truncated: boolean;
};

// `ideas` and `links` may cover more than `depth` hops (the handler loads
// generously); only what the BFS reaches from the seeds is returned.
// Outputs are leaves: they never connect two ideas.
export function buildExplore(
  seeds: ExploreSeed[],
  ideas: ExploreIdea[],
  links: ExploreLink[],
  artifacts: ExploreArtifact[],
  opts: { depth: number; max_ideas: number },
): ExploreResult {
  const ideaById = new Map(ideas.map((i) => [i.id, i]));
  const artifactById = new Map(artifacts.map((a) => [a.id, a]));
  const ideaLinks = links.filter(
    (l) => l.target_idea_id && ideaById.has(l.source_idea_id) && ideaById.has(l.target_idea_id),
  );

  // Neighbours: accepted links before proposals, then by id.
  const adj = new Map<string, Array<{ id: string; accepted: boolean }>>();
  const addAdj = (a: string, b: string, accepted: boolean) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push({ id: b, accepted });
  };
  for (const l of ideaLinks) {
    addAdj(l.source_idea_id, l.target_idea_id!, l.status === 'accepted');
    addAdj(l.target_idea_id!, l.source_idea_id, l.status === 'accepted');
  }
  for (const list of adj.values()) {
    list.sort((a, b) => Number(b.accepted) - Number(a.accepted) || a.id.localeCompare(b.id));
  }

  // BFS from every seed at once, best-ranked seed first.
  const seedIds = [...new Set(seeds.map((s) => s.id))].filter((id) => ideaById.has(id));
  const order: string[] = [...seedIds];
  const seen = new Set(order);
  let frontier = [...order];
  for (let d = 0; d < opts.depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        order.push(n.id);
        next.push(n.id);
      }
    }
    frontier = next;
  }
  const kept = order.slice(0, opts.max_ideas);
  const rank = new Map(kept.map((id, i) => [id, i]));
  const keptLinks = ideaLinks
    .filter((l) => rank.has(l.source_idea_id) && rank.has(l.target_idea_id!))
    .sort(
      (a, b) =>
        Number(b.status === 'accepted') - Number(a.status === 'accepted') ||
        Math.min(rank.get(a.source_idea_id)!, rank.get(a.target_idea_id!)!) -
          Math.min(rank.get(b.source_idea_id)!, rank.get(b.target_idea_id!)!) ||
        a.id.localeCompare(b.id),
    );

  // Connected components over the returned links.
  const parent = new Map(kept.map((id) => [id, id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const l of keptLinks) {
    const a = find(l.source_idea_id);
    const b = find(l.target_idea_id!);
    if (a !== b) parent.set(b, a);
  }
  // Groups (and their members) in BFS order: the best seed's group first.
  const groups = new Map<string, string[]>();
  for (const id of kept) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(id);
  }

  const seedSet = new Set(seedIds);
  const clusters = [...groups.values()].map((members) => {
    const memberSet = new Set(members);
    const links = keptLinks.filter((l) => memberSet.has(l.source_idea_id));
    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(l.source_idea_id, (degree.get(l.source_idea_id) ?? 0) + 1);
      degree.set(l.target_idea_id!, (degree.get(l.target_idea_id!) ?? 0) + 1);
    }
    // Named after its highest-degree member; ties go to the better-ranked one.
    const top = [...members].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || rank.get(a)! - rank.get(b)!)[0];
    return {
      name: ideaById.get(top)!.title,
      ideas: members.map((id) => {
        const i = ideaById.get(id)!;
        return { id, title: i.title, status: i.status, kind: i.kind, is_seed: seedSet.has(id), inbox: i.inbox };
      }),
      links: links.map((l) => ({
        source_id: l.source_idea_id,
        source_title: ideaById.get(l.source_idea_id)!.title,
        link_type: l.link_type,
        label: linkLabel(l.link_type),
        target_id: l.target_idea_id!,
        target_title: ideaById.get(l.target_idea_id!)!.title,
        gloss: l.rationale,
        status: l.status,
      })),
    };
  });

  const outputs = links
    .filter((l) => l.target_artifact_id && rank.has(l.source_idea_id) && artifactById.has(l.target_artifact_id))
    .sort(
      (a, b) =>
        rank.get(a.source_idea_id)! - rank.get(b.source_idea_id)! ||
        Number(b.status === 'accepted') - Number(a.status === 'accepted') ||
        a.id.localeCompare(b.id),
    )
    .map((l) => {
      const a = artifactById.get(l.target_artifact_id!)!;
      return {
        id: a.id,
        title: a.title,
        url: a.url,
        link_type: l.link_type,
        label: linkLabel(l.link_type),
        idea_id: l.source_idea_id,
        status: l.status,
      };
    });

  return {
    seeds: seeds.filter((s) => rank.has(s.id)),
    clusters,
    outputs,
    truncated: order.length > kept.length,
  };
}
