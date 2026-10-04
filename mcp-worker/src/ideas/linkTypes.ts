// Link vocabulary for the Idea Parking Lot. Mirrors the CHECK enum and
// constraints in migrations/019_idea_parking_lot.sql — keep them in sync.

export const LINK_TYPES = [
  'builds_on',
  'example_of',
  'part_of',
  'tension_with',
  'same_mechanism',
  'combines_with',
  'related',
  'became',
  'revisits',
] as const;

export type LinkType = (typeof LINK_TYPES)[number];

export const LINK_STATUSES = ['proposed', 'accepted', 'rejected', 'withdrawn', 'retracted'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

type LinkTypeInfo = {
  directed: boolean;
  // What the target must be: any idea, a synthesis, or a public_artifact.
  target: 'idea' | 'synthesis' | 'artifact';
  meaning: string;
};

export const LINK_TYPE_INFO: Record<LinkType, LinkTypeInfo> = {
  builds_on: { directed: true, target: 'idea', meaning: 'A extends, refines or depends on B' },
  example_of: { directed: true, target: 'idea', meaning: "A is a concrete instance of B's general claim" },
  part_of: { directed: true, target: 'synthesis', meaning: 'A is a component of synthesis B' },
  tension_with: { directed: false, target: 'idea', meaning: 'A and B pull against or contradict each other' },
  same_mechanism: {
    directed: false,
    target: 'idea',
    meaning: 'A and B share a structural mechanism across different domains (analogy / bridge)',
  },
  combines_with: { directed: false, target: 'idea', meaning: 'A and B could fuse into something bigger' },
  related: { directed: false, target: 'idea', meaning: 'Fallback when nothing more specific fits; rationale says why' },
  became: { directed: true, target: 'artifact', meaning: 'The idea turned into this published output (territory)' },
  revisits: {
    directed: true,
    target: 'artifact',
    meaning: 'The idea retreads ground an earlier published output already covered',
  },
};

export function isSymmetric(type: LinkType): boolean {
  return !LINK_TYPE_INFO[type].directed;
}

export function targetsArtifact(type: LinkType): boolean {
  return LINK_TYPE_INFO[type].target === 'artifact';
}

// Endpoint rule check (shape only — ownership and synthesis kind are
// checked against the DB). Returns an error message or null.
export function endpointError(
  type: LinkType,
  target: { target_idea_id?: string | null; target_artifact_id?: string | null },
): string | null {
  const hasIdea = !!target.target_idea_id;
  const hasArtifact = !!target.target_artifact_id;
  if (hasIdea === hasArtifact) {
    return 'exactly one of target_idea_id / target_artifact_id is required';
  }
  if (targetsArtifact(type) && !hasArtifact) {
    return `${type} links must target a public_artifact (target_artifact_id)`;
  }
  if (!targetsArtifact(type) && !hasIdea) {
    return `${type} links must target an idea (target_idea_id)`;
  }
  return null;
}

// Symmetric types are stored with the smaller uuid as source (CHECK
// idea_link_symmetric_canonical). Lower-case hex uuid strings compare in
// the same order as PostgreSQL's bytewise uuid comparison.
export function canonicalPair(
  type: LinkType,
  source: string,
  target: string,
): { source: string; target: string; swapped: boolean } {
  const s = source.toLowerCase();
  const t = target.toLowerCase();
  if (isSymmetric(type) && s > t) return { source: t, target: s, swapped: true };
  return { source: s, target: t, swapped: false };
}

export function legend() {
  return LINK_TYPES.map((type) => ({
    type,
    directed: LINK_TYPE_INFO[type].directed,
    target: LINK_TYPE_INFO[type].target,
    meaning: LINK_TYPE_INFO[type].meaning,
  }));
}
