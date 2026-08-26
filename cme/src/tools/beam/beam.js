import { upsertObject } from '../../core/document/project-document.js';
import { distance } from '../../core/geometry/vector.js';

export const BEAM_TYPE = 'beam';
export const BEAM_SCHEMA_VERSION = 3;
export const BEAM_STOCK_LENGTHS_FEET = Object.freeze([8, 10, 12, 16, 20]);
export const BEAM_SIZE_PRESETS = Object.freeze([
  { id: '4x6', widthInches: 4, depthInches: 6, plyCount: 1, construction: 'solid', equivalentPreset: '2-2x6', label: '4×6 PT · review' },
  { id: '4x8', widthInches: 4, depthInches: 8, plyCount: 1, construction: 'solid', equivalentPreset: '2-2x8', label: '4×8 PT · review' },
  { id: '4x10', widthInches: 4, depthInches: 10, plyCount: 1, construction: 'solid', equivalentPreset: '2-2x10', label: '4×10 PT · review' },
  { id: '4x12', widthInches: 4, depthInches: 12, plyCount: 1, construction: 'solid', equivalentPreset: '2-2x12', label: '4×12 PT · review' },
  ...[2, 3].flatMap((plyCount) => [6, 8, 10, 12].map((depthInches) => ({
    id: `${plyCount}-2x${depthInches}`,
    widthInches: plyCount * 2,
    depthInches,
    plyCount,
    construction: 'built-up',
    equivalentPreset: null,
    label: `(${plyCount}) 2×${depthInches} PT`,
  }))),
]);
const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const point = (value) => ({ x: Number(value?.x), y: Number(value?.y) });

const beamLength = (beam) => {
  const stored = Number(beam?.computed?.lengthInches);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const measured = distance(point(beam?.start), point(beam?.end));
  return Number.isFinite(measured) ? measured : 0;
};

function resolveEndpoints(start, end) {
  const first = point(start);
  const second = point(end);
  if (![first.x, first.y, second.x, second.y].every(Number.isFinite)) throw new Error('A beam requires two valid points.');
  if (distance(first, second) < 1e-6) throw new Error('Beam endpoints must be different.');
  return { start: first, end: second };
}

export function normalizeBeamMaterial(value = {}, legacySize = '') {
  const customLabel = String(value?.customLabel ?? legacySize ?? '').trim();
  const widthInches = Number(value?.widthInches);
  const depthInches = Number(value?.depthInches);
  const preset = BEAM_SIZE_PRESETS.find((entry) => entry.id === value?.preset)
    ?? BEAM_SIZE_PRESETS.find((entry) => entry.construction === 'solid' && entry.widthInches === widthInches && entry.depthInches === depthInches);
  if (value?.preset === 'custom' || (!preset && customLabel)) {
    return { preset: 'custom', widthInches: null, depthInches: null, plyCount: 1, construction: 'custom', equivalentPreset: null, treatment: String(value?.treatment ?? 'PT').trim() || 'PT', customLabel };
  }
  const selected = preset ?? BEAM_SIZE_PRESETS[0];
  return { preset: selected.id, widthInches: selected.widthInches, depthInches: selected.depthInches, plyCount: selected.plyCount, construction: selected.construction, equivalentPreset: selected.equivalentPreset, treatment: String(value?.treatment ?? 'PT').trim() || 'PT', customLabel: '' };
}

export function beamMaterialLabel(material, legacySize = '') {
  const normalized = normalizeBeamMaterial(material, legacySize);
  if (normalized.preset === 'custom') return normalized.customLabel || `Custom beam · ${normalized.treatment}`;
  const preset = BEAM_SIZE_PRESETS.find((entry) => entry.id === normalized.preset);
  return preset?.construction === 'built-up' ? `(${preset.plyCount}) 2×${preset.depthInches} ${normalized.treatment}` : `${normalized.widthInches}×${normalized.depthInches} ${normalized.treatment}`;
}

function comparePlans(a, b) {
  if (!b) return -1;
  if (a.length !== b.length) return a.length - b.length;
  const aSpread = Math.max(...a) - Math.min(...a);
  const bSpread = Math.max(...b) - Math.min(...b);
  if (aSpread !== bSpread) return aSpread - bSpread;
  return [...b].sort((x, y) => y - x).join(',').localeCompare([...a].sort((x, y) => y - x).join(','));
}

/** Plans one drawn beam independently. Offcuts are never silently shared between beams. */
export function planBeamStock(lengthInches, stockLengths = BEAM_STOCK_LENGTHS_FEET) {
  const requiredFeet = Math.max(0, Number(lengthInches) || 0) / 12;
  if (!requiredFeet) return { requiredFeet: 0, purchasedFeet: 0, wasteFeet: 0, pieces: [], byLength: [] };
  const lengths = [...new Set(stockLengths.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  if (!lengths.length) throw new Error('At least one standard beam stock length is required.');
  const start = Math.ceil(requiredFeet);
  const limit = start + Math.max(...lengths);
  const plans = Array(limit + 1).fill(null);
  plans[0] = [];
  for (let total = 1; total <= limit; total += 1) {
    lengths.forEach((stock) => {
      const previous = plans[total - stock];
      if (!previous) return;
      const candidate = [...previous, stock].sort((a, b) => a - b);
      if (comparePlans(candidate, plans[total]) < 0) plans[total] = candidate;
    });
  }
  let pieces = null;
  let purchasedFeet = start;
  while (purchasedFeet <= limit && !pieces) pieces = plans[purchasedFeet++];
  purchasedFeet -= 1;
  if (!pieces) throw new Error('A standard beam stock plan could not be created.');
  const byLength = lengths.map((lengthFeet) => ({ lengthFeet, quantity: pieces.filter((piece) => piece === lengthFeet).length })).filter((entry) => entry.quantity);
  return { requiredFeet, purchasedFeet, wasteFeet: purchasedFeet - requiredFeet, pieces, byLength };
}

export function createBeam({ start, end, size, material, name } = {}, idFactory = defaultId) {
  const endpoints = resolveEndpoints(start, end);
  const normalizedMaterial = normalizeBeamMaterial(material, size);
  return {
    type: BEAM_TYPE,
    schemaVersion: BEAM_SCHEMA_VERSION,
    id: idFactory('beam'),
    name: name ?? 'Beam',
    ...endpoints,
    material: normalizedMaterial,
    size: beamMaterialLabel(normalizedMaterial),
    computed: { lengthInches: distance(endpoints.start, endpoints.end) },
    lifecycle: { phase: 'established', revision: 1 },
  };
}

export function addBeam(document, beam) {
  if (beam?.type !== BEAM_TYPE) throw new Error('A beam construction object is required.');
  return upsertObject(document, beam);
}

export function updateBeam(document, beamId, patch = {}) {
  const beam = getBeams(document).find((object) => object.id === beamId);
  if (!beam) throw new Error('Beam was not found.');
  const endpoints = resolveEndpoints(patch.start ?? beam.start, patch.end ?? beam.end);
  const material = patch.material === undefined ? normalizeBeamMaterial(beam.material, beam.size) : normalizeBeamMaterial(patch.material);
  return upsertObject(document, {
    ...beam,
    ...endpoints,
    schemaVersion: BEAM_SCHEMA_VERSION,
    name: patch.name === undefined ? beam.name : String(patch.name ?? 'Beam'),
    material,
    size: beamMaterialLabel(material),
    computed: { ...beam.computed, lengthInches: distance(endpoints.start, endpoints.end) },
    lifecycle: { ...beam.lifecycle, revision: (beam.lifecycle?.revision ?? 1) + 1 },
  });
}

export function removeBeam(document, beamId) {
  return { ...document, updatedAt: new Date().toISOString(), objects: document.objects.filter((object) => !(object.type === BEAM_TYPE && object.id === beamId)) };
}

export function getBeams(document) {
  return document.objects.filter((object) => object.type === BEAM_TYPE);
}

export function describeTakeoff(document) {
  const groups = new Map();
  const beams = getBeams(document);
  beams.forEach((beam) => {
    const material = normalizeBeamMaterial(beam.material, beam.size);
    const materialLabel = beamMaterialLabel(material);
    const materialKey = material.preset === 'custom' ? `custom-${materialLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : material.preset;
    planBeamStock(beamLength(beam)).byLength.forEach(({ lengthFeet, quantity }) => {
      const key = `${materialKey}:${lengthFeet}`;
      const current = groups.get(key) ?? { quantity: 0, sourceObjectIds: [], materialLabel, engineeringReview: material.construction !== 'built-up' };
      current.quantity += quantity * (material.construction === 'built-up' ? material.plyCount : 1);
      current.sourceObjectIds.push(beam.id);
      groups.set(key, current);
    });
  });
  return [...groups.entries()].map(([key, group]) => {
    const split = key.lastIndexOf(':');
    const materialKey = key.slice(0, split);
    const lengthFeet = Number(key.slice(split + 1));
    return {
      kind: 'count',
      id: `auto:framing:beam:${materialKey}:${lengthFeet}`,
      category: 'framing',
      description: `${group.materialLabel} beam`,
      specification: `${lengthFeet} ft stock${group.materialLabel.startsWith('(') ? ' · individual plies' : ''}`,
      quantity: group.quantity,
      stockLengthFeet: lengthFeet,
      sourceObjectIds: [...new Set(group.sourceObjectIds)],
      confidence: group.engineeringReview ? 'review' : 'calculated',
    };
  });
}
