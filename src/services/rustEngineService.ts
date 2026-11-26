/**
 * Core Engine Bridge & Methodological Critique Service (TypeScript)
 * Centralizes shared domain interfaces and deterministic PRISMA 2020 / Cochrane validation rules.
 */

import { queryPubMedLive } from './pubmedApi';
import { searchNcbiMesh, AtomicConceptInput } from './meshDatabase';

export interface PubMedArticle {
  pmid: string;
  title: string;
  authors: string;
  source: string;
  pubDate: string;
  doi: string | null;
  abstract: string;
  meshHeadings: string[];
  publicationTypes?: readonly string[];
  url: string;
}

export interface StratifiedTitleSample {
  readonly top: readonly string[];
  readonly middle: readonly string[];
  readonly tail: readonly string[];
}

export interface PubMedResponse {
  count: number;
  queryTranslation: string;
  articles: PubMedArticle[];
  idList?: readonly string[];
  stratifiedSample?: StratifiedTitleSample;
  error: string | null;
}

export interface MeshDescriptorItem {
  descriptor: string;
  meshId: string;
  noExp?: boolean;
  isMajor?: boolean;
  qualifiers?: string[];
  allowedSubheadings?: string[];
  treeNumbers?: string[];
  isPharmacologicalSubstance?: boolean;
}

export interface MeshDetails {
  descriptor: string;
  meshId: string;
  entryTerms: string[];
  descriptors?: MeshDescriptorItem[];
  truncationTerms?: string[];
  scopeNote?: string;
  allowedSubheadings?: string[];
  treeNumbers?: string[];
  isPharmacologicalSubstance?: boolean;
  unresolvedMeshTerms?: readonly string[];
}

export type PicoAxisRoleRust =
  | 'pathology_outcome'
  | 'drug_inn_list'
  | 'therapeutic_class'
  | 'generic_intervention'
  | 'population'
  | 'comparator'
  | 'exclusion';

export interface MeshDescriptorNodeRust {
  readonly descriptor: string;
  readonly meshId: string;
  readonly allowedSubheadings?: readonly string[];
  readonly selectedSubheadings?: readonly string[];
  readonly treeNumbers?: readonly string[];
  readonly isPharmacologicalSubstance?: boolean;
  readonly noExp?: boolean;
  readonly isMajor?: boolean;
}

export interface AxisCompilationInputRust {
  readonly axisRole: PicoAxisRoleRust;
  readonly impliedSubheadings?: readonly string[];
  readonly descriptors: readonly MeshDescriptorNodeRust[];
  readonly entryTerms: readonly string[];
  readonly rawClinicalTokens?: readonly string[];
  readonly customTruncations?: readonly string[];
}

export interface CompiledAxisOutputRust {
  readonly pubmedClause: string;
  readonly embaseClause: string;
  readonly centralClause: string;
  readonly meshTermsEmitted: readonly string[];
  readonly twTermsEmitted: readonly string[];
  readonly truncationsEmitted: readonly string[];
  readonly tiabTermsEmitted: readonly string[];
  readonly prunedBySubsumption: readonly string[];
  readonly rejectedByArity: readonly string[];
}

export interface ArityFilterResultRust {
  readonly acceptedTwClauses: readonly string[];
  readonly acceptedRawTerms: readonly string[];
  readonly rejectedTerms: readonly string[];
}

const RE_INN_MONO = /^[a-z]{4,25}$/;
const RE_INN_ACID = /^[a-z]{4,20}\s+acid$/;
const RE_ALPHA_TOKEN = /[a-z]{4,}/g;
const RE_NLM_INVERTED_COMMA = /^([^,]+),\s*(.+)$/;

const NON_CLINICAL_STEMS = new Set<string>([
  'disease', 'diseases', 'disorder', 'disorders', 'syndrome', 'syndromes',
  'secondary', 'chemically', 'induced', 'adverse', 'effect', 'effects',
  'reaction', 'reactions', 'related', 'agent', 'agents', 'therapy',
  'therapies', 'treatment', 'treatments', 'acute', 'chronic', 'idiopathic',
  'symptomatic', 'experimental', 'human', 'humans', 'animal', 'animals',
  'side', 'with', 'without', 'from', 'type', 'types',
  'problem', 'problems', 'based', 'learning', 'solving', 'curriculum', 'curricula',
  'health', 'healthcare', 'care', 'clinical', 'system', 'systems', 'trial', 'trials',
  'outcome', 'outcomes', 'personnel', 'provider', 'providers', 'worker', 'workers',
  'professional', 'professionals', 'student', 'students', 'education', 'educational',
  'practice', 'practices', 'service', 'services', 'program', 'programs',
  'management', 'method', 'methods', 'study', 'studies', 'patient', 'patients',
  'group', 'groups', 'model', 'models', 'level', 'levels', 'factor', 'factors',
  'process', 'processes', 'control', 'controls', 'active', 'experiential',
  'continuing', 'development', 'staff', 'intervention', 'interventions',
  'medical', 'medicine', 'general', 'primary', 'traditional', 'standard', 'usual', 'routine',
]);

function normalizeMonolexicalBaseStem(word: string): string {
  if (
    word.length >= 6 &&
    word.endsWith('s') &&
    !word.endsWith('ss') &&
    !word.endsWith('is') &&
    !word.endsWith('us')
  ) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * 1. Filtre d'Arité Lexicale (`[tw]`) — Miroir exact de `filter_inn_arity_tw` (Rust/WASM)
 */
export function filterInnArityTwRust(candidates: readonly string[]): ArityFilterResultRust {
  const seen = new Set<string>();
  const acceptedTwClauses: string[] = [];
  const acceptedRawTerms: string[] = [];
  const rejectedTerms: string[] = [];

  for (const raw of candidates) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;

    const commaMatch = RE_NLM_INVERTED_COMMA.exec(normalized);
    let candidate = normalized;
    if (commaMatch) {
      const head = commaMatch[1].trim();
      const tail = commaMatch[2].trim();
      if (head === 'acid' && !tail.includes(' ')) {
        candidate = `${tail} ${head}`;
      }
    }

    if (RE_INN_MONO.test(candidate)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        acceptedTwClauses.push(`${candidate}[tw]`);
        acceptedRawTerms.push(candidate);
      }
    } else if (RE_INN_ACID.test(candidate)) {
      const collapsed = candidate.replace(/\s+/g, ' ');
      if (!seen.has(collapsed)) {
        seen.add(collapsed);
        acceptedTwClauses.push(`"${collapsed}"[tw]`);
        acceptedRawTerms.push(collapsed);
      }
    } else {
      rejectedTerms.push(raw.trim());
    }
  }

  return { acceptedTwClauses, acceptedRawTerms, rejectedTerms };
}

/**
 * 2. Dominance Dérivationnelle des Troncatures — Miroir exact de `compute_derivational_stems` (Rust/WASM)
 */
export function computeDerivationalStemsRust(
  descriptors: readonly MeshDescriptorNodeRust[],
  entryTerms: readonly string[],
  customTruncations: readonly string[] = []
): string[] {
  const allTokens: string[] = [];
  const monolexicalTokens: string[] = [];

  for (const d of descriptors) {
    const lower = d.descriptor.trim().toLowerCase();
    const matches = lower.match(RE_ALPHA_TOKEN) ?? [];
    if (matches.length === 1 && !lower.includes(' ') && !lower.includes('-')) {
      const tok = matches[0];
      if (!NON_CLINICAL_STEMS.has(tok)) {
        monolexicalTokens.push(tok);
      }
    }
    for (const tok of matches) {
      if (!NON_CLINICAL_STEMS.has(tok)) {
        allTokens.push(tok);
      }
    }
  }

  for (const entry of entryTerms) {
    const lower = entry.trim().toLowerCase();
    const matches = lower.match(RE_ALPHA_TOKEN) ?? [];
    if (matches.length === 1 && !lower.includes(' ') && !lower.includes('-')) {
      const tok = matches[0];
      if (!NON_CLINICAL_STEMS.has(tok)) {
        monolexicalTokens.push(tok);
      }
    }
    for (const tok of matches) {
      if (!NON_CLINICAL_STEMS.has(tok)) {
        allTokens.push(tok);
      }
    }
  }

  const derivedStems: string[] = [];
  const baseStems: string[] = [];

  for (const tok of allTokens) {
    if (tok.length >= 8 && (tok.endsWith('ism') || tok.endsWith('isms'))) {
      const stem = tok.endsWith('isms') ? tok.slice(0, -2) : tok.slice(0, -1);
      if (stem.length >= 5 && !NON_CLINICAL_STEMS.has(stem) && !derivedStems.includes(stem)) {
        derivedStems.push(stem);
      }
      continue;
    }
    if (tok.length >= 8 && (tok.endsWith('ian') || tok.endsWith('ians'))) {
      const stem = tok.endsWith('ians') ? tok.slice(0, -1) : tok;
      if (stem.length >= 5 && !NON_CLINICAL_STEMS.has(stem) && !derivedStems.includes(stem)) {
        derivedStems.push(stem);
      }
      continue;
    }
    if (tok.length >= 8 && (tok.endsWith('oid') || tok.endsWith('oids'))) {
      const stem = tok.endsWith('oids') ? tok.slice(0, -1) : tok;
      if (stem.length >= 5 && !NON_CLINICAL_STEMS.has(stem) && !derivedStems.includes(stem)) {
        derivedStems.push(stem);
      }
      continue;
    }
  }

  for (const mono of monolexicalTokens) {
    if (
      mono.endsWith('ism') ||
      mono.endsWith('isms') ||
      mono.endsWith('ian') ||
      mono.endsWith('ians') ||
      mono.endsWith('oid') ||
      mono.endsWith('oids')
    ) {
      continue;
    }
    const stem = normalizeMonolexicalBaseStem(mono);
    if (stem.length >= 5 && !NON_CLINICAL_STEMS.has(stem) && !baseStems.includes(stem)) {
      baseStems.push(stem);
    }
  }

  for (const custom of customTruncations) {
    const clean = custom.trim().replace(/\*+$/, '').toLowerCase();
    if (
      clean.length >= 5 &&
      /^[a-z]+$/.test(clean) &&
      !NON_CLINICAL_STEMS.has(clean) &&
      !derivedStems.includes(clean) &&
      !baseStems.includes(clean)
    ) {
      if (clean.endsWith('is') || clean.endsWith('ian') || clean.endsWith('oid')) {
        derivedStems.push(clean);
      } else {
        baseStems.push(clean);
      }
    }
  }

  // Tri morphologique canonique : substantifs nosologiques (-is) > adjectifs (-ian) > (-oid)
  derivedStems.sort((a, b) => {
    const rank = (s: string) => (s.endsWith('is') ? 0 : s.endsWith('ian') ? 1 : 2);
    return rank(a) - rank(b);
  });

  const activeStems: string[] = [...derivedStems];

  const hasSyndromicContext = descriptors.some((d) => {
    const low = d.descriptor.toLowerCase();
    return (
      low.includes(', secondary') ||
      low.includes('disorders') ||
      low.includes('syndrome') ||
      (d.selectedSubheadings ?? []).some((s) => s.toLowerCase() === 'chemically induced')
    );
  });

  for (const bStem of baseStems) {
    const isDominated = derivedStems.some(
      (dStem) =>
        dStem.startsWith(bStem) &&
        dStem.length > bStem.length &&
        dStem.length - bStem.length <= 5
    );
    if (!isDominated && (!hasSyndromicContext || derivedStems.length === 0)) {
      if (!activeStems.includes(bStem)) {
        activeStems.push(bStem);
      }
    }
  }

  // Déduplication par préfixe : si une troncature plus courte `other*` englobe `stem*`,
  // supprimer la variante plus longue (ex: `mortal*` absorbe `mortality*`, `mortalitie*`, `mortalities*`).
  const deduplicatedStems: string[] = [];
  for (const stem of activeStems) {
    if (deduplicatedStems.includes(stem)) continue;
    const subsumedByShorter = activeStems.some(
      (other) => other.length < stem.length && stem.startsWith(other)
    );
    if (!subsumedByShorter) {
      deduplicatedStems.push(stem);
    }
  }

  return deduplicatedStems;
}

export function normalizeNlmEntryForTiabRust(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const commaMatch = RE_NLM_INVERTED_COMMA.exec(trimmed);
  if (commaMatch) {
    const head = commaMatch[1].trim();
    const tail = commaMatch[2].trim();
    if (head && tail && !tail.includes(',')) {
      return `${tail} ${head}`;
    }
  }
  return trimmed;
}

const RE_IUPAC_LOCANT = /\d+[a-z]?-[a-z]|[a-z]-\d+-|\(\d+[a-z]?\)|-\(\(/i;
const RE_LAB_CODE_SHORT = /^[a-z]{2,5}[-\s]?(?:\d{3,}|\d{2,}[-\s]\d{2,})[a-z0-9-\s]*$/i;

export function isIupacOrLabCodeTerm(phrase: string): boolean {
  const trimmed = phrase.trim();
  if (!trimmed) return false;
  const openParens = (trimmed.match(/\(/g) || []).length;
  const closeParens = (trimmed.match(/\)/g) || []).length;
  if (openParens !== closeParens || trimmed.includes('[') || trimmed.includes(']')) {
    return true;
  }
  if (RE_IUPAC_LOCANT.test(trimmed)) return true;
  if (RE_LAB_CODE_SHORT.test(trimmed)) return true;
  const digitCount = (trimmed.match(/\d/g) || []).length;
  const hyphenCount = (trimmed.match(/-/g) || []).length;
  if ((digitCount >= 2 && hyphenCount >= 2) || (openParens > 0 && digitCount >= 1)) {
    return true;
  }
  if (trimmed.length > 60 && (digitCount >= 1 || hyphenCount >= 3)) {
    return true;
  }
  return false;
}

/**
 * 3. Subsomption Préfixielle Booléenne ($A \lor (A \land B) \equiv A$) — Miroir exact de `prune_by_prefix_subsumption`
 */
export function pruneByPrefixSubsumptionRust(
  candidatePhrases: readonly string[],
  activeStems: readonly string[]
): { retained: string[]; pruned: string[] } {
  const retained: string[] = [];
  const pruned: string[] = [];
  const seen = new Set<string>();

  for (const raw of candidatePhrases) {
    const normalized = normalizeNlmEntryForTiabRust(raw);
    if (!normalized || normalized.includes(',')) continue;
    if (isIupacOrLabCodeTerm(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const words = normalized.split(/[^a-z]+/).filter(Boolean);
    const isSubsumed = words.some((word) =>
      activeStems.some((stem) => stem.length >= 5 && word.startsWith(stem))
    );

    if (isSubsumed) {
      pruned.push(normalized);
    } else {
      retained.push(normalized);
    }
  }

  return { retained, pruned };
}

function normalizeSubheadingComparisonKey(subheading: string): string {
  return subheading
    .trim()
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ');
}

function resolveActiveSubheadingsRust(
  node: MeshDescriptorNodeRust,
  impliedSubheadings: readonly string[]
): string[] {
  const combined: string[] = [];
  const seenKeys = new Set<string>();
  for (const sh of node.selectedSubheadings ?? []) {
    const key = normalizeSubheadingComparisonKey(sh);
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      combined.push(key);
    }
  }
  for (const sh of impliedSubheadings) {
    const key = normalizeSubheadingComparisonKey(sh);
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      combined.push(key);
    }
  }
  const allowed = node.allowedSubheadings ?? [];
  if (allowed.length === 0) return combined;
  const allowedSet = new Set(allowed.map((s) => normalizeSubheadingComparisonKey(s)));
  return combined.filter((sh) => allowedSet.has(sh));
}

function subheadingToCentralCodeRust(subheading: string): string {
  switch (normalizeSubheadingComparisonKey(subheading)) {
    case 'chemically induced': return 'CI';
    case 'adverse effects': return 'AE';
    case 'drug therapy': return 'DT';
    case 'therapy': return 'TH';
    case 'toxicity': return 'TO';
    case 'poisoning': return 'PO';
    case 'pharmacology': return 'PD';
    case 'pharmacokinetics': return 'PK';
    case 'etiology': return 'ET';
    case 'diagnosis': return 'DI';
    case 'prevention and control': return 'PC';
    case 'epidemiology': return 'EP';
    case 'mortality': return 'MO';
    case 'complications': return 'CO';
    default: return 'CI';
  }
}

const PHARMACOLOGICAL_CLASS_HEADING_RE = /\b(?:agents|drugs|inhibitors|antagonists|agonists|blockers|stimulants|depressants|therapeutics|preparations|compounds|derivatives|hormones|antibiotics|analgesics|anesthetics|vaccines|receptors|enzymes|analogues|analogs)\b/i;

function isPharmacologicalClassNodeRust(
  node: MeshDescriptorNodeRust,
  allNodes: readonly MeshDescriptorNodeRust[]
): boolean {
  const hasD27Tree = (node.treeNumbers ?? []).some((tn) =>
    tn.trim().toUpperCase().startsWith('D27')
  );
  if (hasD27Tree) return true;
  if (PHARMACOLOGICAL_CLASS_HEADING_RE.test(node.descriptor)) return true;
  return (
    node.isPharmacologicalSubstance === false &&
    allNodes.some((other) => other.isPharmacologicalSubstance === true)
  );
}

/**
 * 4. Compilation Algébrique d'un Axe PICO/PECO — Miroir exact de `compile_axis_block_rust`
 */
export function compileAxisBlockRust(input: AxisCompilationInputRust): CompiledAxisOutputRust {
  const hasPharmacologicalClass = input.descriptors.some((d) =>
    isPharmacologicalClassNodeRust(d, input.descriptors)
  );
  const isDrugList =
    !hasPharmacologicalClass &&
    (input.axisRole === 'drug_inn_list' ||
      (input.descriptors.length > 1 &&
        input.descriptors.every((d) => Boolean(d.isPharmacologicalSubstance))));

  if (isDrugList) {
    const allCandidates: string[] = [];
    for (const d of input.descriptors) allCandidates.push(d.descriptor);
    for (const raw of input.rawClinicalTokens ?? []) allCandidates.push(raw);
    for (const entry of input.entryTerms) allCandidates.push(entry);

    const arity = filterInnArityTwRust(allCandidates);
    const pubmedClause =
      arity.acceptedTwClauses.length > 0 ? `(${arity.acceptedTwClauses.join(' OR ')})` : '';
    const embaseTerms = arity.acceptedRawTerms.map((t) => `'${t}':ti,ab,kw,de`);
    const embaseClause = embaseTerms.length > 0 ? `(${embaseTerms.join(' OR ')})` : '';
    const centralTerms = arity.acceptedRawTerms.map((t) =>
      t.includes(' ') ? `"${t}":ti,ab,kw` : `${t}:ti,ab,kw`
    );
    const centralClause = centralTerms.length > 0 ? `(${centralTerms.join(' OR ')})` : '';

    return {
      pubmedClause,
      embaseClause,
      centralClause,
      meshTermsEmitted: [],
      twTermsEmitted: arity.acceptedTwClauses,
      truncationsEmitted: [],
      tiabTermsEmitted: [],
      prunedBySubsumption: [],
      rejectedByArity: arity.rejectedTerms,
    };
  }

  const meshTermsEmitted: string[] = [];
  const embaseParts: string[] = [];
  const centralParts: string[] = [];
  const seenMesh = new Set<string>();
  const seenEmbase = new Set<string>();

  for (const node of input.descriptors) {
    const descClean = node.descriptor.trim();
    if (!descClean || !node.meshId.trim()) continue;
    const tag = node.isMajor
      ? node.noExp
        ? '[Majr:NoExp]'
        : '[Majr]'
      : node.noExp
        ? '[Mesh:NoExp]'
        : '[Mesh]';

    const activeSh = resolveActiveSubheadingsRust(node, input.impliedSubheadings ?? []);
    if (activeSh.length === 0) {
      const formatted = `"${descClean}"${tag}`;
      if (!seenMesh.has(formatted)) {
        seenMesh.add(formatted);
        meshTermsEmitted.push(formatted);
        const embaseTerm = `'${descClean.toLowerCase()}'/${node.noExp ? 'de' : 'exp'}`;
        if (!seenEmbase.has(embaseTerm)) {
          seenEmbase.add(embaseTerm);
          embaseParts.push(embaseTerm);
        }
        centralParts.push(`[mh ${node.noExp ? '^' : ''}"${descClean}"]`);
      }
    } else {
      for (const sh of activeSh) {
        const formatted = `"${descClean}/${sh}"${tag}`;
        if (!seenMesh.has(formatted)) {
          seenMesh.add(formatted);
          meshTermsEmitted.push(formatted);
          const embaseTerm = `'${descClean.toLowerCase()}'/${node.noExp ? 'de' : 'exp'}`;
          if (!seenEmbase.has(embaseTerm)) {
            seenEmbase.add(embaseTerm);
            embaseParts.push(embaseTerm);
          }
          centralParts.push(
            `[mh ${node.noExp ? '^' : ''}"${descClean}"/${subheadingToCentralCodeRust(sh)}]`
          );
        }
      }
    }
  }

  // Garantir que les molécules individuelles présentes dans un axe mixte (classe D27 + DCI)
  // restent également émises en variantes [tiab]/[tw] en plus du [Mesh] de la classe.
  const effectiveEntryTerms: string[] = [...input.entryTerms];
  const seenEntryLower = new Set(effectiveEntryTerms.map((t) => t.trim().toLowerCase()));
  for (const node of input.descriptors) {
    if (node.isPharmacologicalSubstance) {
      const lowerName = node.descriptor.trim().toLowerCase();
      if (lowerName && !seenEntryLower.has(lowerName)) {
        seenEntryLower.add(lowerName);
        effectiveEntryTerms.push(lowerName);
      }
    }
  }

  const activeStems = computeDerivationalStemsRust(
    input.descriptors,
    effectiveEntryTerms,
    input.customTruncations ?? []
  );

  const truncationsEmitted = activeStems.map((stem) => `${stem}*[tiab]`);
  for (const stem of activeStems) {
    embaseParts.push(`'${stem}*':ti,ab,kw,de`);
    centralParts.push(`${stem}*:ti,ab,kw`);
  }

  const { retained, pruned } = pruneByPrefixSubsumptionRust(effectiveEntryTerms, activeStems);
  const tiabTermsEmitted = retained.map((p) => `"${p}"[tiab]`);
  for (const p of retained) {
    embaseParts.push(`'${p}':ti,ab,kw,de`);
    centralParts.push(`"${p}":ti,ab,kw`);
  }

  const allPubmedParts = [...meshTermsEmitted, ...truncationsEmitted, ...tiabTermsEmitted];

  return {
    pubmedClause: allPubmedParts.length > 0 ? `(${allPubmedParts.join(' OR ')})` : '',
    embaseClause: embaseParts.length > 0 ? `(${embaseParts.join(' OR ')})` : '',
    centralClause: centralParts.length > 0 ? `(${centralParts.join(' OR ')})` : '',
    meshTermsEmitted,
    twTermsEmitted: [],
    truncationsEmitted,
    tiabTermsEmitted,
    prunedBySubsumption: pruned,
    rejectedByArity: [],
  };
}

export type PressStatusLevel = 'compliant' | 'needs_refinement' | 'revision_required';

export interface PressCriterionScore {
  readonly id:
    | 'mesh_coverage'
    | 'input_terms_coverage'
    | 'syntax_integrity'
    | 'pubmed_volume'
    | 'cochrane_c_not';
  readonly label: string;
  readonly score: number;
  readonly maxScore: number;
  readonly status: 'ok' | 'warning' | 'penalty';
  readonly detail: string;
}

export interface PressAuditBlockInput {
  readonly picoType: 'P' | 'I' | 'C' | 'O' | 'NOT';
  readonly originalText?: string;
  readonly descriptors: ReadonlyArray<{ readonly meshId: string }>;
}

export interface PressAuditInput {
  readonly pubmedQuery: string;
  readonly embaseQuery: string;
  readonly cochraneQuery: string;
  readonly blocks: readonly PressAuditBlockInput[];
  readonly activeCoreAxesCount: number;
  readonly articleCount: number;
  readonly totalSynonyms: number;
  readonly hasActiveComparator: boolean;
  readonly hasActiveNot: boolean;
  readonly hasStrictHumansFilter?: boolean;
  readonly activeUserAxes?: ReadonlyArray<{
    readonly picoType: 'P' | 'I' | 'C' | 'O' | 'NOT';
    readonly text: string;
  }>;
}

export type AuditObservationSeverity = 'ok' | 'info' | 'warning';

export interface AuditObservationItem {
  readonly severity: AuditObservationSeverity;
  readonly text: string;
}

export type AuditObservationEntry = string | AuditObservationItem;

const LEADING_OBSERVATION_EMOJI_RE = /^(?:(?:✅|⚠️|⚠|❌|🔴|💡)[\uFE0F\s]*)+/u;

export function stripLeadingObservationEmojis(text: string): string {
  return text.replace(LEADING_OBSERVATION_EMOJI_RE, '').trim();
}

export function normalizeAuditObservation(entry: unknown): AuditObservationItem | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    const isWarning = trimmed.includes('⚠️') || trimmed.includes('⚠') || trimmed.includes('🔴') || trimmed.includes('❌');
    const isInfo = !isWarning && trimmed.includes('💡');
    const cleanText = stripLeadingObservationEmojis(trimmed);
    return cleanText ? { severity: isWarning ? 'warning' : isInfo ? 'info' : 'ok', text: cleanText } : null;
  }

  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    const rawText = typeof record.text === 'string' ? record.text.trim() : '';
    if (!rawText) return null;
    const rawSeverity = typeof record.severity === 'string' ? record.severity.toLowerCase().trim() : '';
    let severity: AuditObservationSeverity;
    if (
      rawSeverity === 'warning' ||
      rawSeverity === 'warn' ||
      rawSeverity === 'alert' ||
      rawSeverity === 'error' ||
      rawSeverity === 'penalty' ||
      rawSeverity === 'high' ||
      rawSeverity === 'moderate' ||
      rawSeverity === 'medium'
    ) {
      severity = 'warning';
    } else if (rawSeverity === 'info' || rawSeverity === 'note' || rawSeverity === 'notice' || rawSeverity === 'suggestion') {
      severity = 'info';
    } else if (rawSeverity === 'ok' || rawSeverity === 'pass') {
      severity = 'ok';
    } else {
      severity =
        rawText.includes('⚠️') || rawText.includes('⚠') || rawText.includes('🔴') || rawText.includes('❌')
          ? 'warning'
          : rawText.includes('💡')
            ? 'info'
            : 'ok';
    }
    const cleanText = stripLeadingObservationEmojis(rawText);
    return cleanText ? { severity, text: cleanText } : null;
  }

  return null;
}

export function normalizeAuditObservations(entries: unknown): AuditObservationItem[] {
  if (!Array.isArray(entries)) return [];
  const normalized: AuditObservationItem[] = [];
  for (const entry of entries) {
    const item = normalizeAuditObservation(entry);
    if (item) normalized.push(item);
  }
  return normalized;
}

export interface CritiqueReport {
  score: number;
  observations: AuditObservationEntry[];
  recommendations: string[];
  pressBreakdown?: readonly PressCriterionScore[];
  pressStatus?: PressStatusLevel;
  pressAlertCount?: number;
  source?: 'gemini' | 'openai' | 'anthropic' | 'rules';
  evaluatorModel?: string;
  auditError?: string;
}

export type LegacyCritiqueReport = Omit<CritiqueReport, 'observations'> & {
  observations: string[];
};

export async function queryPubMedRust(query: string, options: { maxResults?: number; sort?: string } = {}): Promise<PubMedResponse> {
  return await queryPubMedLive(query, options);
}

export async function searchMeshRust(
  term: string,
  targetAxis?: 'P' | 'I' | 'C' | 'O' | 'NOT',
  englishHints?: readonly string[],
  atomicConcepts?: readonly AtomicConceptInput[]
): Promise<MeshDetails | null> {
  return await searchNcbiMesh(term, targetAxis, englishHints, atomicConcepts);
}

/**
 * Évalue la qualité méthodologique d'une équation documentaire selon les critères universels PRISMA 2020 & Cochrane
 */
export function evaluateCritiqueRust(
  count: number,
  totalSynonyms: number,
  descriptors: string[] = [],
  pico?: { p?: string; i?: string; c?: string; o?: string }
): LegacyCritiqueReport {
  let score = 95;
  const observations: string[] = [];
  const recommendations: string[] = [];

  // 1. Richesse synonymique et couverture lexicale
  if (totalSynonyms > 0 && totalSynonyms < 3 && count < 50) {
    score -= 5;
    observations.push(`⚠️ Couverture synonymique restreinte (${totalSynonyms} terme(s) d'entrée).`);
    recommendations.push("Enrichissez les synonymes en texte libre [TiAb] pour capter les études récemment publiées non encore indexées.");
  }

  // 2. Recommandation Méthodologique Cochrane sur le groupe Comparateur (C)
  if (pico?.c && count < 25) {
    observations.push("💡 Conseil Méthodologique Cochrane : L'inclusion d'un groupe comparateur strict (C) en AND dans l'équation est la cause fréquente de silence documentaire.");
    recommendations.push("Désactivez temporairement le comparateur dans l'équation de recherche et évaluez-le lors du dépouillement.");
  }

  // 3. Volumétrie bibliographique (Standards PRISMA 2020)
  if (count === 0) {
    score -= 40;
    observations.push("🔴 Aucun article trouvé sur PubMed. La combinaison booléenne est trop restrictive ou contient une contrainte bloquante.");
    recommendations.push("Désactivez temporairement le bloc Comparaison (C) ou repassez en mode Revue Systématique.");
  } else if (count < 15) {
    score -= 5;
    observations.push(`⚠️ Volume très restreint (${count.toLocaleString()} article${count > 1 ? 's' : ''}). Risque de silence documentaire (omission d'études éligibles).`);
    recommendations.push("💡 Conseil Cochrane : Désactivez le filtre Comparateur (C) ou Outcome (O) dans l'équation booléenne.");
  } else if (count > 20000) {
    score -= 15;
    observations.push(`⚠️ Volume très élevé (${count.toLocaleString()} articles). Risque de bruit bibliographique.`);
    recommendations.push("Activez des filtres restrictifs ou précisez la population/intervention pour affiner votre revue systématique.");
  } else {
    observations.push(`✅ Volume optimal (${count.toLocaleString()} articles) pour une revue de littérature.`);
  }

  if (descriptors.length > 0) {
    observations.push(`✅ Descripteurs MeSH vérifiés (${descriptors.length}) : ${descriptors.slice(0, 4).join(', ')}${descriptors.length > 4 ? '...' : ''}.`);
  }

  return { 
    score: Math.max(score, 40), 
    observations, 
    recommendations,
    source: 'rules',
    evaluatorModel: 'Règles PRISMA (Déterministe)'
  };
}

function collectSyntaxDefectsForPress(
  pubmedQuery: string,
  embaseQuery: string,
  cochraneQuery: string
): string[] {
  const defects: string[] = [];
  const queries: Array<{ readonly label: string; readonly value: string }> = [
    { label: 'PubMed', value: pubmedQuery },
    { label: 'Embase', value: embaseQuery },
    { label: 'CENTRAL', value: cochraneQuery }
  ];

  for (const q of queries) {
    if (!q.value.trim()) {
      defects.push(`${q.label} : équation vide`);
      continue;
    }
    const open = (q.value.match(/\(/g) || []).length;
    const close = (q.value.match(/\)/g) || []).length;
    if (open !== close) {
      defects.push(`${q.label} : parenthèses déséquilibrées (${open}/${close})`);
    }
  }

  if (pubmedQuery.trim()) {
    const pubQuotes = (pubmedQuery.match(/"/g) || []).length;
    if (pubQuotes % 2 !== 0) {
      defects.push('PubMed : nombre impair de guillemets');
    }
    if (pubmedQuery.includes('""')) {
      defects.push('PubMed : guillemets doublés ""');
    }
    if (/\[[^\]]+\]\[[^\]]+\]/.test(pubmedQuery)) {
      defects.push('PubMed : balises doublées');
    }
    if (/(?:^|[\s(])[a-z]{1,4}\*\[/i.test(pubmedQuery)) {
      defects.push('PubMed : troncature trop courte (< 5 car.)');
    }
    if (/"[^"]+,[^"]+"\[tiab\]/i.test(pubmedQuery)) {
      defects.push('PubMed : virgule inversée dans [tiab]');
    }
    if (/^\s*(?:AND|OR)\b|\b(?:AND|OR)\s*$/i.test(pubmedQuery)) {
      defects.push('PubMed : opérateur booléen orphelin');
    }
  }

  return defects;
}

const INPUT_TERM_NOISE_WORDS = new Set<string>([
  'adulte', 'adultes', 'patient', 'patients', 'sujet', 'sujets', 'femme', 'femmes',
  'homme', 'hommes', 'population', 'populations', 'inhibiteur', 'inhibiteurs',
  'traitement', 'traitements', 'prise', 'charge',
  'standard', 'standards', 'absence', 'exposition', 'placebo', 'variation', 'variations',
  'etude', 'etudes', 'chronique', 'chroniques', 'aigue', 'aigues', 'secondaire',
  'secondaires', 'primaire', 'primaires', 'maladie', 'maladies', 'syndrome', 'syndromes',
  'trouble', 'troubles', 'risque', 'risques', 'survenue', 'facteur', 'facteurs',
  'forme', 'formes', 'severe', 'severes', 'modere', 'moderee', 'efficacite', 'securite',
  'tolerance', 'evaluation', 'critere', 'criteres', 'jugement', 'principal', 'principale',
  'corporel', 'corporelle', 'restriction',
  'prevention', 'controle', 'induit', 'induite', 'induits', 'induites', 'chimiquement',
  'association', 'associe', 'associee', 'associes', 'associees', 'comparaison', 'compare',
  'severity', 'severe', 'moderate', 'moderately', 'mild', 'acute', 'chronic', 'stable',
  'unstable', 'active', 'inactive', 'primary', 'secondary', 'general', 'overall', 'total',
  'major', 'minor', 'recurrent', 'refractory', 'valvular', 'nonvalvular', 'randomise',
  'randomises', 'randomisee', 'randomisees', 'randomized', 'clinical', 'clinicale'
]);

const INN_OR_COGNATE_SUFFIX_RE = /(?:ine|ines|ol|ols|ide|ides|ate|ates|mab|mabs|nib|nibs|vir|virs|stat|stats|pril|sartan|dipine|zine|mycine|cilline|prazole|gliptine|gliflozine|glutide|lukast|triptan|coxib|pamine)$/i;

export function extractInnLikeTokens(text: string): string[] {
  if (!text || !text.trim()) return [];
  const rawTokens = text
    .split(/[\s,;()/'’"-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 6);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const tok of rawTokens) {
    const norm = normalizeAsciiLower(tok);
    if (!/^[a-z]+$/.test(norm) || INPUT_TERM_NOISE_WORDS.has(norm)) continue;
    if (INN_OR_COGNATE_SUFFIX_RE.test(norm) && !seen.has(norm)) {
      seen.add(norm);
      found.push(tok);
    }
  }
  return found;
}

function normalizeAsciiLower(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Détecte de façon algorithmique (zéro dictionnaire médical en dur) les termes significatifs
 * saisis par l'utilisateur (notamment les molécules DCI en `-ine`, `-ol`, etc. ou clauses non couvertes)
 * absents de l'équation PubMed finale.
 */
export function findMissingUserTermsInQuery(
  activeUserAxes: ReadonlyArray<{ readonly picoType: 'P' | 'I' | 'C' | 'O' | 'NOT'; readonly text: string }>,
  blocks: readonly PressAuditBlockInput[],
  pubmedQuery: string
): string[] {
  const normalizedQuery = normalizeAsciiLower(pubmedQuery);
  const missing: string[] = [];

  for (const axis of activeUserAxes) {
    if (!axis.text || !axis.text.trim()) continue;
    const rawClauses = axis.text
      .split(/[,;()]|\s+(?:ou|or|et|and)\s+/i)
      .map((c) => c.trim())
      .filter((c) => c.length > 2);

    const blockForAxis = blocks.find((b) => b.picoType === axis.picoType);
    const resolvedDescriptorsCount = blockForAxis ? blockForAxis.descriptors.length : 0;

    for (const clause of rawClauses) {
      const tokens = clause
        .split(/[\s/'’"-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 6);

      const meaningfulTokens = tokens.filter((tok) => {
        const norm = normalizeAsciiLower(tok);
        return /^[a-z]+$/.test(norm) && !INPUT_TERM_NOISE_WORDS.has(norm);
      });

      if (meaningfulTokens.length === 0) continue;

      const clauseMatchedInQuery = meaningfulTokens.some((tok) => {
        const stem = normalizeAsciiLower(tok).slice(0, 5);
        return stem.length >= 5 && normalizedQuery.includes(stem);
      });

      for (const tok of meaningfulTokens) {
        const norm = normalizeAsciiLower(tok);
        const stem = norm.slice(0, 5);
        const isInnLike = INN_OR_COGNATE_SUFFIX_RE.test(norm);

        if (isInnLike && !normalizedQuery.includes(stem)) {
          if (!missing.some((m) => normalizeAsciiLower(m) === norm)) {
            missing.push(tok);
          }
        }
      }

      if (!clauseMatchedInQuery && resolvedDescriptorsCount < rawClauses.length) {
        const fallbackTok = meaningfulTokens.find((tok) => {
          const norm = normalizeAsciiLower(tok);
          return !normalizedQuery.includes(norm.slice(0, 5));
        });
        if (fallbackTok && !missing.some((m) => normalizeAsciiLower(m) === normalizeAsciiLower(fallbackTok))) {
          missing.push(fallbackTok);
        }
      }
    }
  }

  return missing;
}

/**
 * Calcule le statut PRESS officiel à 3 niveaux à partir du bilan technique déterministe
 * et des éventuelles alertes ⚠️ remontées par la revue qualitative IA.
 */
export function finalizePressStatus(
  pressReport: Pick<CritiqueReport, 'score' | 'pressBreakdown'>,
  qualitativeObservations: readonly AuditObservationEntry[],
  articleCount: number,
  hasActiveEmptyError = false
): { readonly pressStatus: PressStatusLevel; readonly pressAlertCount: number } {
  const breakdown = pressReport.pressBreakdown || [];
  const syntaxFailed = breakdown.some(
    (c) => c.id === 'syntax_integrity' && c.status === 'penalty'
  );
  const meshFailed = breakdown.some(
    (c) => c.id === 'mesh_coverage' && c.status === 'penalty'
  );
  const anyTechPenalty = breakdown.some((c) => c.status === 'penalty');

  if (articleCount === 0 || hasActiveEmptyError || syntaxFailed || meshFailed || anyTechPenalty) {
    return { pressStatus: 'revision_required', pressAlertCount: 1 };
  }

  const techWarnings = breakdown.filter((c) => c.status === 'warning').length;
  const aiWarnings = qualitativeObservations.filter(
    (obs) => normalizeAuditObservation(obs)?.severity === 'warning'
  ).length;
  const highVolumeAlert = articleCount > 2500 && !breakdown.some((c) => c.id === 'pubmed_volume' && c.status === 'warning') ? 1 : 0;

  const totalAlerts = techWarnings + aiWarnings + highVolumeAlert;
  if (totalAlerts > 0 || articleCount > 2500) {
    return {
      pressStatus: 'needs_refinement',
      pressAlertCount: Math.max(1, totalAlerts)
    };
  }

  return { pressStatus: 'compliant', pressAlertCount: 0 };
}

/**
 * Évalue la qualité PRESS de manière 100 % déterministe et explicable selon 5 contrôles objectifs :
 * 1. Couverture MeSH des axes cliniques actifs
 * 2. Couverture des termes saisis par l'utilisateur (molécules, sous-concepts)
 * 3. Intégrité syntaxique multi-bases PRISMA-S
 * 4. Volumétrie PubMed (alerte > 2 500 notices, erreur si 0)
 * 5. Conformité Cochrane sur C / NOT / filtres
 */
export function evaluatePressIndexDeterministic(input: PressAuditInput): CritiqueReport {
  const observations: AuditObservationItem[] = [];
  const recommendations: string[] = [];
  const breakdown: PressCriterionScore[] = [];

  // 1. Couverture MeSH officielle NLM sur les axes cliniques actifs (/25)
  const coreBlocks = input.blocks.filter((b) => b.picoType !== 'NOT');
  const axesWithOfficialMesh = coreBlocks.filter((b) =>
    b.descriptors.some((d) => Boolean(d.meshId) && !d.meshId.startsWith('Concept-') && d.meshId !== 'Custom')
  ).length;
  const expectedAxes = Math.max(1, input.activeCoreAxesCount, coreBlocks.length);

  let meshScore = 0;
  let meshStatus: PressCriterionScore['status'] = 'ok';
  let meshDetail = '';
  if (axesWithOfficialMesh === 0) {
    meshScore = 0;
    meshStatus = 'penalty';
    meshDetail = 'Aucun descripteur MeSH officiel NLM résolu sur les axes actifs.';
    observations.push({ severity: 'warning', text: meshDetail });
    recommendations.push('Précisez des termes cliniques reconnus pour activer les descripteurs MeSH officiels.');
  } else if (axesWithOfficialMesh < expectedAxes) {
    meshScore = Math.round((axesWithOfficialMesh / expectedAxes) * 25);
    meshStatus = 'warning';
    meshDetail = `${axesWithOfficialMesh} / ${expectedAxes} axe(s) actif(s) couverts par un descripteur MeSH NLM.`;
    observations.push({ severity: 'warning', text: meshDetail });
  } else {
    meshScore = 25;
    meshStatus = 'ok';
    meshDetail = `Tous les axes cliniques actifs (${axesWithOfficialMesh}) sont couverts par MeSH NLM.`;
    observations.push({ severity: 'ok', text: meshDetail });
  }
  breakdown.push({
    id: 'mesh_coverage',
    label: 'Couverture MeSH',
    score: meshScore,
    maxScore: 25,
    status: meshStatus,
    detail: meshDetail
  });

  // 2. Couverture des termes saisis par l'utilisateur + richesse lexicale [tiab]/[tw] (/20)
  const axesForCoverage =
    input.activeUserAxes ??
    input.blocks
      .filter((b) => Boolean(b.originalText?.trim()))
      .map((b) => ({ picoType: b.picoType, text: b.originalText || '' }));

  const missingUserTerms = findMissingUserTermsInQuery(
    axesForCoverage,
    input.blocks,
    input.pubmedQuery
  );
  const freeTagCount = (input.pubmedQuery.match(/\[(?:tiab|tw)\]/gi) || []).length;
  const lexicalCount = Math.max(input.totalSynonyms, freeTagCount);

  let termsScore = 20;
  let termsStatus: PressCriterionScore['status'] = 'ok';
  let termsDetail = '';
  if (missingUserTerms.length > 0) {
    termsScore = 10;
    termsStatus = 'warning';
    termsDetail = `Terme(s) saisi(s) absent(s) de l'équation finale : ${missingUserTerms.join(', ')}.`;
    observations.push({ severity: 'warning', text: termsDetail });
    recommendations.push(`Ajoutez en texte libre [tiab]/[tw] les termes manquants (${missingUserTerms.join(', ')}) ou séparez-les sur l'axe concerné.`);
  } else if (lexicalCount < 2) {
    termsScore = 14;
    termsStatus = 'warning';
    termsDetail = 'Couverture synonymique restreinte (< 2 variantes [tiab]/[tw]).';
    observations.push({ severity: 'warning', text: termsDetail });
    recommendations.push('Ajoutez des variantes [tiab] en colonne gauche pour limiter le silence documentaire.');
  } else {
    termsScore = 20;
    termsStatus = 'ok';
    termsDetail = `Termes saisis couverts et enrichis (${lexicalCount} variantes [tiab]/[tw]).`;
    observations.push({ severity: 'ok', text: termsDetail });
  }
  breakdown.push({
    id: 'input_terms_coverage',
    label: 'Couverture des termes saisis',
    score: termsScore,
    maxScore: 20,
    status: termsStatus,
    detail: termsDetail
  });

  // 3. Intégrité syntaxique multi-bases PRISMA-S (/20)
  const syntaxDefects = collectSyntaxDefectsForPress(
    input.pubmedQuery,
    input.embaseQuery,
    input.cochraneQuery
  );
  const syntaxScore = syntaxDefects.length === 0 ? 20 : Math.max(0, 20 - syntaxDefects.length * 10);
  const syntaxStatus: PressCriterionScore['status'] = syntaxDefects.length === 0 ? 'ok' : 'penalty';
  const syntaxDetail =
    syntaxDefects.length === 0
      ? 'Équilibre parenthèses/guillemets et syntaxe multi-bases conformes.'
      : syntaxDefects.join(' ; ');
  if (syntaxDefects.length > 0) {
    observations.push({ severity: 'warning', text: `Anomalie syntaxique : ${syntaxDetail}` });
    recommendations.push('Recalculez l\'équation depuis la colonne MeSH ou corrigez la syntaxe manuelle.');
  } else {
    observations.push({ severity: 'ok', text: syntaxDetail });
  }
  breakdown.push({
    id: 'syntax_integrity',
    label: 'Syntaxe PRISMA-S',
    score: syntaxScore,
    maxScore: 20,
    status: syntaxStatus,
    detail: syntaxDetail
  });

  // 4. Volumétrie PubMed (alerte ⚠️ > 2 500 notices, erreur ❌ si 0) (/20)
  let volScore = 20;
  let volStatus: PressCriterionScore['status'] = 'ok';
  let volDetail = '';
  if (input.articleCount === 0) {
    volScore = 0;
    volStatus = 'penalty';
    volDetail = 'Silence documentaire (0 notice PubMed identifiée).';
    observations.push({ severity: 'warning', text: volDetail });
    recommendations.push('Désactivez un axe restrictif (C ou NOT) ou passez en profil Haute sensibilité.');
  } else if (input.articleCount < 15) {
    volScore = 14;
    volStatus = 'warning';
    volDetail = `Volume très restreint (${input.articleCount} notice(s)) : risque de perte d'études éligibles.`;
    observations.push({ severity: 'warning', text: volDetail });
    recommendations.push('Vérifiez l\'absence de contrainte excessive (Comparateur C, Outcome O ou exclusion NOT).');
  } else if (input.articleCount > 2500) {
    volScore = input.articleCount > 20000 ? 10 : 20;
    volStatus = 'warning';
    volDetail = `Volume élevé (${input.articleCount.toLocaleString('fr-FR')} notices > 2 500) : envisagez un affinage pour le dépouillement.`;
    observations.push({ severity: 'warning', text: volDetail });
    recommendations.push('Précisez les critères ou activez un filtre méthodologique dans l\'affinage expert si le volume dépasse vos capacités de lecture.');
  } else {
    volScore = 20;
    volStatus = 'ok';
    volDetail = `Volume maîtrisé (${input.articleCount.toLocaleString('fr-FR')} notices ≤ 2 500).`;
    observations.push({ severity: 'ok', text: volDetail });
  }
  breakdown.push({
    id: 'pubmed_volume',
    label: 'Volume PubMed',
    score: volScore,
    maxScore: 20,
    status: volStatus,
    detail: volDetail
  });

  // 5. Conformité Cochrane sur C / NOT / filtres (/15)
  let cochranePenalty = 0;
  const cochraneNotes: string[] = [];
  const hasCompiledC = coreBlocks.some((b) => b.picoType === 'C');
  const hasStrictHumansInQuery =
    Boolean(input.hasStrictHumansFilter) ||
    /"Humans"\[(?:mh|Mesh)\]/i.test(input.pubmedQuery) &&
      !/NOT\s*\(\s*"Animals"\[Mesh\]\s+NOT\s+"Humans"\[Mesh\]\s*\)/i.test(input.pubmedQuery);

  if (input.hasActiveComparator && hasCompiledC && input.articleCount < 25) {
    cochranePenalty += 5;
    cochraneNotes.push('Comparateur C actif en AND avec volume < 25 (risque de silence Cochrane).');
  }
  if (input.hasActiveNot && input.articleCount < 50) {
    cochranePenalty += 5;
    cochraneNotes.push('Exclusion NOT active avec volume < 50 (risque d\'exclusion d\'études mixtes).');
  }
  if (hasStrictHumansInQuery) {
    cochranePenalty += 5;
    cochraneNotes.push('Filtre "Humans"[mh] strict : privilégier l\'exclusion animale non destructive Cochrane.');
  }

  const cochraneScore = Math.max(0, 15 - cochranePenalty);
  const cochraneStatus: PressCriterionScore['status'] =
    cochranePenalty >= 10 ? 'penalty' : cochranePenalty > 0 ? 'warning' : 'ok';
  const cochraneDetail =
    cochraneNotes.length > 0
      ? cochraneNotes.join(' ')
      : 'Gestion des axes C/NOT et des filtres conforme aux recommandations Cochrane.';
  if (cochranePenalty > 0) {
    recommendations.push(cochraneDetail);
  }
  breakdown.push({
    id: 'cochrane_c_not',
    label: 'Conformité Cochrane',
    score: cochraneScore,
    maxScore: 15,
    status: cochraneStatus,
    detail: cochraneDetail
  });

  const totalScore = Math.min(100, Math.max(0, meshScore + termsScore + syntaxScore + volScore + cochraneScore));
  const preliminaryReport = { score: totalScore, pressBreakdown: breakdown };
  const { pressStatus, pressAlertCount } = finalizePressStatus(
    preliminaryReport,
    observations,
    input.articleCount,
    false
  );

  return {
    score: totalScore,
    observations,
    recommendations,
    pressBreakdown: breakdown,
    pressStatus,
    pressAlertCount,
    source: 'rules',
    evaluatorModel: 'Contrôles PRESS (Déterministe)'
  };
}

/**
 * Détermine si le badge « Stratégie convergée » peut être affiché à l'Étape 2.
 * Interdit formellement l'état convergé en cas de `revision_required`, d'effectif nul (`hitCount <= 0`)
 * ou d'erreur d'interrogation PubMed (`pubmedError`).
 */
export function shouldDisplayStrategyConverged(params: {
  readonly pressStatus: PressStatusLevel;
  readonly refinementCount: number;
  readonly hitCount: number;
  readonly pubmedError?: string | null;
}): boolean {
  if (params.pubmedError && params.pubmedError.trim().length > 0) return false;
  if (params.hitCount <= 0) return false;
  if (params.pressStatus === 'revision_required') return false;
  return params.pressStatus === 'compliant' || params.refinementCount >= 2;
}

export type MultiBaseAuditTarget = 'embase' | 'cochrane';
export type MultiBaseCheckSeverity = 'ok' | 'info' | 'warning';
export type MultiBaseCheckCode =
  | 'embase_syntax_ok'
  | 'embase_syntax_unbalanced'
  | 'embase_pubmed_tag_leak'
  | 'embase_emtree_candidates_info'
  | 'embase_inverted_comma_warning'
  | 'embase_nonhuman_ok'
  | 'embase_nonhuman_missing_warning'
  | 'cochrane_syntax_ok'
  | 'cochrane_syntax_unbalanced'
  | 'cochrane_foreign_tag_leak'
  | 'cochrane_animal_filter_ok'
  | 'cochrane_animal_filter_missing_warning'
  | 'cochrane_date_range_info';

export interface MultiBaseTranslationCheck {
  readonly code: MultiBaseCheckCode;
  readonly severity: MultiBaseCheckSeverity;
  readonly examples?: readonly string[];
}

export interface MultiBaseTranslationAuditResult {
  readonly target: MultiBaseAuditTarget;
  readonly hasWarnings: boolean;
  readonly checks: readonly MultiBaseTranslationCheck[];
}

function areDelimitersBalanced(query: string, checkSingleQuotes: boolean): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let doubleQuotes = 0;
  let singleQuotes = 0;

  for (const ch of query) {
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth < 0) return false;
    } else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') {
      bracketDepth -= 1;
      if (bracketDepth < 0) return false;
    } else if (ch === '"') doubleQuotes += 1;
    else if (ch === "'") singleQuotes += 1;
  }

  if (parenDepth !== 0 || bracketDepth !== 0 || doubleQuotes % 2 !== 0) {
    return false;
  }
  if (checkSingleQuotes && singleQuotes % 2 !== 0) {
    return false;
  }
  return true;
}

/**
 * Contrôle déterministe 100 % hors-ligne (zéro appel LLM, zéro réseau) de la traduction
 * booléenne Embase.com ou Cochrane CENTRAL affichée à l'Étape 2.
 */
export function auditMultiBaseTranslationDeterministic(params: {
  readonly target: MultiBaseAuditTarget;
  readonly query: string;
  readonly hasHumansCochraneFilter?: boolean;
  readonly hasDateRange?: boolean;
}): MultiBaseTranslationAuditResult {
  const trimmed = (params.query || '').trim();
  const checks: MultiBaseTranslationCheck[] = [];

  if (params.target === 'embase') {
    const hasPubMedTagLeak = /\[(mesh|mh|majr|tiab|tw|pt|dp)\b/i.test(trimmed);
    const isBalanced = trimmed.length > 0 && areDelimitersBalanced(trimmed, true);

    if (hasPubMedTagLeak) {
      checks.push({ code: 'embase_pubmed_tag_leak', severity: 'warning' });
    }
    if (!isBalanced) {
      checks.push({ code: 'embase_syntax_unbalanced', severity: 'warning' });
    }
    if (!hasPubMedTagLeak && isBalanced) {
      checks.push({ code: 'embase_syntax_ok', severity: 'ok' });
    }

    const emtreeRegex = /'([^']+)'\/(?:exp|de)\b/gi;
    let emtreeCount = 0;
    const invertedExamples: string[] = [];
    const seenInverted = new Set<string>();
    let match = emtreeRegex.exec(trimmed);
    while (match !== null) {
      emtreeCount += 1;
      const fullTag = match[0];
      const termInside = match[1] ?? '';
      if (termInside.includes(',')) {
        const dedupKey = fullTag.toLowerCase();
        if (!seenInverted.has(dedupKey) && invertedExamples.length < 3) {
          seenInverted.add(dedupKey);
          invertedExamples.push(fullTag);
        }
      }
      match = emtreeRegex.exec(trimmed);
    }

    if (emtreeCount > 0) {
      checks.push({ code: 'embase_emtree_candidates_info', severity: 'info' });
    }
    if (invertedExamples.length > 0) {
      checks.push({
        code: 'embase_inverted_comma_warning',
        severity: 'warning',
        examples: invertedExamples
      });
    }

    const expectsAnimalExclusion =
      Boolean(params.hasHumansCochraneFilter) || /'animal'\/exp/i.test(trimmed);
    if (expectsAnimalExclusion) {
      if (/'nonhuman'\/exp/i.test(trimmed)) {
        checks.push({ code: 'embase_nonhuman_ok', severity: 'ok' });
      } else {
        checks.push({ code: 'embase_nonhuman_missing_warning', severity: 'warning' });
      }
    }
  } else {
    const hasForeignTagLeak =
      /\[(mesh|majr|tiab|tw|pt|dp)\b/i.test(trimmed) ||
      /'[^']+'\/(?:exp|de)\b/i.test(trimmed) ||
      /:ti,ab,kw,de\b/i.test(trimmed);
    const isBalanced = trimmed.length > 0 && areDelimitersBalanced(trimmed, false);

    if (hasForeignTagLeak) {
      checks.push({ code: 'cochrane_foreign_tag_leak', severity: 'warning' });
    }
    if (!isBalanced) {
      checks.push({ code: 'cochrane_syntax_unbalanced', severity: 'warning' });
    }
    if (!hasForeignTagLeak && isBalanced) {
      checks.push({ code: 'cochrane_syntax_ok', severity: 'ok' });
    }

    if (params.hasHumansCochraneFilter) {
      if (/NOT\s*\(\s*\[mh\s+"Animals"\]\s+NOT\s+\[mh\s+"Humans"\]\s*\)/i.test(trimmed)) {
        checks.push({ code: 'cochrane_animal_filter_ok', severity: 'ok' });
      } else {
        checks.push({ code: 'cochrane_animal_filter_missing_warning', severity: 'warning' });
      }
    }

    if (params.hasDateRange) {
      checks.push({ code: 'cochrane_date_range_info', severity: 'info' });
    }
  }

  return {
    target: params.target,
    hasWarnings: checks.some((c) => c.severity === 'warning'),
    checks
  };
}
