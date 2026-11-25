import { MeshDetails, MeshDescriptorItem, isIupacOrLabCodeTerm } from './rustEngineService';
import { isHetopConfigured, searchHetopMesh } from './hetopService';
import { buildNcbiUrl, getNcbiApiKey } from './pubmedApi';
import {
  computeBackoffDelayMs,
  isPassiveComparatorConcept,
  isUnrestrictedDemographicConcept
} from './localAiService';

/**
 * Service de Vérification MeSH Médical — 100 % Officiel (HeTOP / CISMeF -> NCBI Entrez db=mesh)
 *
 * RÈGLE FONDAMENTALE (`GEMINI.md`) :
 * - Zéro dictionnaire en dur, zéro traduction automatique grand public (MyMemory/Wikidata), zéro fenêtrage heuristique.
 * - Chaque concept atomique normalisé par le LLM (`{ conceptFr, conceptEn, synonymsTiab }`) est vérifié
 *   d'abord sur HeTOP (correspondance officielle FR -> MeSH Dxxxxxx), puis validé/enrichi sur NCBI Entrez (`db=mesh`).
 * - Tout concept sans descripteur officiel `Dxxxxxx` validé bascule proprement en texte libre (`Concept-Libre` / `[TiAb]`).
 */

export interface AtomicConceptInput {
  readonly conceptFr?: string;
  readonly conceptEn: string;
  readonly broaderMeshRoot?: string;
  readonly synonymsTiab?: readonly string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let lastMeshNcbiCallTimestamp = 0;

/**
 * Appel HTTP résilient vers NCBI Entrez E-Utilities (`db=mesh`) avec cadencement NLM
 * et Exponential Backoff + Full Jitter sur HTTP 429, 500, 502, 503, 504 et TimeoutError.
 */
export async function fetchNcbiMeshWithBackoff(
  url: string,
  timeoutMs = 7500,
  maxRetries = 3
): Promise<Response> {
  const minIntervalMs = getNcbiApiKey() ? 110 : 340;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const now = Date.now();
    const elapsed = now - lastMeshNcbiCallTimestamp;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastMeshNcbiCallTimestamp = Date.now();

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      ) {
        if (attempt < maxRetries) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
          const waitMs = !Number.isNaN(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : computeBackoffDelayMs(attempt, 1200, 15000);
          await sleep(waitMs);
          continue;
        }
      }
      return response;
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(computeBackoffDelayMs(attempt, 1000, 10000));
        continue;
      }
      throw error;
    }
  }

  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

interface RawEntrezIdxLink {
  readonly parent?: string;
  readonly treenum?: string;
  readonly children?: readonly string[];
}

interface RawEntrezSummaryItem {
  readonly uid?: string;
  readonly ds_recordtype?: string;
  readonly ds_meshui?: string;
  readonly ds_meshterms?: readonly string[];
  readonly ds_subheading?: readonly string[];
  readonly ds_scopenote?: string;
  readonly ds_idxlinks?: readonly RawEntrezIdxLink[];
  readonly ds_treenum?: readonly string[];
  readonly treenumberlist?: readonly string[];
  readonly treeNumbers?: readonly string[];
}

/**
 * Extrait la liste officielle des Tree Numbers NLM (`TreeNumberList` / `ds_idxlinks[].treenum`)
 * depuis un enregistrement `esummary` (`db=mesh`).
 */
export function extractTreeNumbersFromEntrezItem(item: RawEntrezSummaryItem): string[] {
  const trees = new Set<string>();

  if (Array.isArray(item.ds_idxlinks)) {
    for (const link of item.ds_idxlinks) {
      if (link && typeof link.treenum === 'string' && link.treenum.trim()) {
        trees.add(link.treenum.trim().toUpperCase());
      }
    }
  }

  const directArrays = [item.ds_treenum, item.treenumberlist, item.treeNumbers];
  for (const arr of directArrays) {
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (typeof t === 'string' && t.trim()) {
          trees.add(t.trim().toUpperCase());
        }
      }
    }
  }

  return Array.from(trees);
}

const OUTCOME_ALLOWED_TREE_BRANCHES: readonly string[] = [
  'C',
  'F03',
  'G07.700',
  'E01.370.600',
  'N06.850.505.400',
  'I01.800'
];

function matchesTreeBranch(treeNumber: string, branch: string): boolean {
  if (branch.length === 1) {
    return treeNumber.startsWith(branch);
  }
  return treeNumber === branch || treeNumber.startsWith(`${branch}.`);
}

/**
 * FILTRAGE ONTOLOGIQUE PAR TREE NUMBER (CATÉGORIE MeSH NLM) :
 * - Axe O (`PathologyOutcome`) : maladies (`C`), troubles mentaux (`F03`), mesures anthropométriques (`G07.700`),
 *   examen clinique/signes vitaux (`E01.370.600`), mortalité/morbidité (`N06.850.505.400`), qualité de vie (`I01.800`).
 * - Axes I & C (Intervention / Comparateur) : produits chimiques/médicaments (`D`), techniques/procédures (`E`),
 *   soins de santé (`N`), enseignement (`I02`), phénomènes physiologiques/nutritionnels (`G07`),
 *   ainsi que les produits biologiques/sanguins et cellulaires (`A15`, `A11`).
 * - Axe P (Population) : maladies (`C`), troubles mentaux (`F03`), groupes nommés (`M`), établissements (`N02`),
 *   disciplines (`H01`), phénomènes physiologiques (`G07`).
 */
export function isValidTreeNumberForAxis(
  treeNumbers: readonly string[],
  targetAxis?: 'P' | 'I' | 'C' | 'O' | 'NOT'
): boolean {
  if (!targetAxis || targetAxis === 'NOT') return true;
  if (!treeNumbers || treeNumbers.length === 0) return false;

  const normalized = treeNumbers.map((t) => t.trim().toUpperCase());

  if (targetAxis === 'O') {
    return normalized.some((tree) =>
      OUTCOME_ALLOWED_TREE_BRANCHES.some((branch) => matchesTreeBranch(tree, branch))
    );
  }

  if (targetAxis === 'I' || targetAxis === 'C') {
    return normalized.some(
      (t) =>
        t.startsWith('D') ||
        t.startsWith('E') ||
        t.startsWith('N') ||
        t.startsWith('I02') ||
        t.startsWith('G07') ||
        matchesTreeBranch(t, 'A15') ||
        matchesTreeBranch(t, 'A11')
    );
  }

  if (targetAxis === 'P') {
    return normalized.some(
      (t) =>
        t.startsWith('C') ||
        t.startsWith('F03') ||
        t.startsWith('M') ||
        t.startsWith('N02') ||
        t.startsWith('H01') ||
        t.startsWith('G07')
    );
  }

  return true;
}

/**
 * Élimine les descripteurs ancêtres redondants au sein d'un même concept clinique :
 * puisque `[Mesh]` inclut déjà les descendants par explosion hiérarchique NLM,
 * un descripteur B est supprimé si un descripteur distinct A possède au moins un Tree Number
 * descendant direct de B (`tA.startsWith(tB + '.')`) sans cycle inverse.
 */
export function pruneSubsumedAncestorDescriptors(
  descriptors: readonly MeshDescriptorItem[]
): MeshDescriptorItem[] {
  if (descriptors.length <= 1) {
    return [...descriptors];
  }

  const normalizedTreesByIdx = descriptors.map((item) =>
    (item.treeNumbers || [])
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
  );

  const isStrictDescendant = (childIdx: number, ancestorIdx: number): boolean => {
    const childTrees = normalizedTreesByIdx[childIdx];
    const ancestorTrees = normalizedTreesByIdx[ancestorIdx];
    if (childTrees.length === 0 || ancestorTrees.length === 0) return false;
    return ancestorTrees.some((tAnc) =>
      childTrees.some((tChild) => tChild.startsWith(`${tAnc}.`))
    );
  };

  return descriptors.filter((candidate, idxB) => {
    if (normalizedTreesByIdx[idxB].length === 0) return true;

    const hasMoreSpecificDescendant = descriptors.some((other, idxA) => {
      if (idxA === idxB) return false;
      const sameId =
        Boolean(other.meshId && candidate.meshId) &&
        other.meshId.toUpperCase() === candidate.meshId.toUpperCase();
      const sameTitle =
        other.descriptor.trim().toLowerCase() === candidate.descriptor.trim().toLowerCase();
      if (sameId || sameTitle) return false;

      return isStrictDescendant(idxA, idxB) && !isStrictDescendant(idxB, idxA);
    });

    return !hasMoreSpecificDescendant;
  });
}

/**
 * Détermine dynamiquement si un descripteur NLM est une substance pharmacologique individuelle (DCI/INN)
 * par inspection de ses `ds_subheading` officiels (`pharmacology` / `pharmacokinetics`)
 * et absence de marqueur morphologique de classe plurielle (`Agents`, `Inhibitors`, `Antagonists`, etc.).
 */
export function isNlmPharmacologicalSubstance(
  descriptorTitle: string,
  allowedSubheadings: readonly string[]
): boolean {
  const hasPharmacology = allowedSubheadings.some((sh) => {
    const low = sh.trim().toLowerCase();
    return low === 'pharmacology' || low === 'pharmacokinetics' || low === 'agonists' || low === 'antagonists & inhibitors';
  });
  if (!hasPharmacology) return false;

  const isPluralClassHeading = /\b(?:agents|drugs|inhibitors|antagonists|agonists|blockers|stimulants|depressants|therapeutics|preparations|compounds|derivatives|hormones|antibiotics|analgesics|anesthetics|vaccines|proteins|receptors|enzymes)\b/i.test(
    descriptorTitle
  );
  return !isPluralClassHeading;
}

function normalizeText(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatTitleCase(str: string): string {
  if (!str) return '';
  return str
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\b(And|Or|For|With|Of|In|At|By|To|The)\b/g, (match) => match.toLowerCase());
}

/**
 * Dérive les troncatures conformes aux normes BiUM/NLM (>= 5 caractères) en respectant
 * les suffixes dérivationnels (`-ism` -> `...is*`, `-ian` -> `...ian*`).
 */
export function deriveTruncationTerms(terms: string[]): string[] {
  const result = new Set<string>();

  const addStem = (stem: string) => {
    if (stem.length >= 5) {
      result.add(`${stem}*`);
    }
  };

  for (const raw of terms) {
    const clean = raw.trim().toLowerCase();
    if (!/^[a-z]{5,25}$/.test(clean)) continue;

    if (clean.length >= 8 && (clean.endsWith('ism') || clean.endsWith('isms'))) {
      addStem(clean.endsWith('isms') ? clean.slice(0, -2) : clean.slice(0, -1));
    } else if (clean.length >= 8 && (clean.endsWith('ian') || clean.endsWith('ians'))) {
      addStem(clean.endsWith('ians') ? clean.slice(0, -1) : clean);
    } else if (clean.endsWith('ing')) {
      addStem(clean);
      if (clean.length >= 9) addStem(clean.slice(0, -3));
    } else if (clean.endsWith('ity')) {
      addStem(clean.slice(0, -3));
    } else if (clean.endsWith('tion')) {
      addStem(clean.slice(0, -4));
    } else if (clean.endsWith('ectomy')) {
      addStem(clean.slice(0, -6));
    } else if (clean.endsWith('ic') || clean.endsWith('al')) {
      addStem(clean.slice(0, -2));
    } else {
      addStem(clean);
    }
  }

  return Array.from(result);
}

const nlmLookupCache = new Map<string, MeshDetails | null>();
const meshResolutionCache = new Map<string, MeshDetails>();

/**
 * Réinitialise les caches locaux de résolution MeSH (utile pour les tests unitaires).
 */
export function clearMeshResolutionCaches(): void {
  nlmLookupCache.clear();
  meshResolutionCache.clear();
}

/**
 * Interroge en direct l'API officielle NCBI Entrez E-Utilities (`db=mesh`) avec Exponential Backoff.
 * Extrait :
 * - `descriptor` + `meshId` (`Dxxxxxx`)
 * - `entryTerms` (`ds_meshterms`)
 * - `allowedSubheadings` (`ds_subheading`)
 * - `isPharmacologicalSubstance` (`ds_subheading.includes('pharmacology')`)
 * - Co-descripteurs syndromiques NLM lorsque la requête cible une entité nosologique dérivée (`-ism`/`-ian`).
 */
export async function fetchEntrezMeshDescriptor(
  term: string,
  targetAxis?: 'P' | 'I' | 'C' | 'O' | 'NOT'
): Promise<MeshDetails | null> {
  if (!term || term.trim().length < 2) return null;
  const clean = term.trim();
  const cacheKey = `${clean.toLowerCase()}__${targetAxis || 'ANY'}`;

  if (nlmLookupCache.has(cacheKey)) {
    return nlmLookupCache.get(cacheKey)!;
  }

  try {
    const isMeshUiCode = /^D\d{6,9}$/i.test(clean);
    let idlist: string[] = [];

    // 1. Recherche directe par identifiant MeSH Unique ID (Dxxxxxx) ou par [MeSH Terms]
    const firstQueryTerm = isMeshUiCode ? `"${clean}"[All Fields]` : `"${clean}"[MeSH Terms]`;
    const exactSearchUrl = buildNcbiUrl('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
      db: 'mesh',
      term: firstQueryTerm
    });

    let res = await fetchNcbiMeshWithBackoff(exactSearchUrl);
    let data = res.ok ? await res.json() : null;
    idlist = data?.esearchresult?.idlist || [];

    // 2. Recherche d'expression exacte dans tous les champs MeSH ([All Fields])
    if (idlist.length === 0 && !isMeshUiCode) {
      const phraseSearchUrl = buildNcbiUrl('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
        db: 'mesh',
        term: `"${clean}"[All Fields]`
      });
      res = await fetchNcbiMeshWithBackoff(phraseSearchUrl);
      data = res.ok ? await res.json() : null;
      idlist = data?.esearchresult?.idlist || [];
    }

    // 3. Recherche large par terme médical
    if (idlist.length === 0) {
      const broadSearchUrl = buildNcbiUrl('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
        db: 'mesh',
        term: clean
      });
      res = await fetchNcbiMeshWithBackoff(broadSearchUrl);
      data = res.ok ? await res.json() : null;
      idlist = data?.esearchresult?.idlist || [];
    }

    if (idlist.length === 0) {
      nlmLookupCache.set(cacheKey, null);
      return null;
    }

    // 4. Récupération groupée des résumés NLM (`esummary.fcgi`)
    const summaryIds = idlist.slice(0, 8).join(',');
    const summaryUrl = buildNcbiUrl('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi', {
      db: 'mesh',
      id: summaryIds
    });

    const sumRes = await fetchNcbiMeshWithBackoff(summaryUrl);
    if (!sumRes.ok) return null;

    const sumData = await sumRes.json();
    const resultObj: Record<string, RawEntrezSummaryItem> = sumData?.result || {};

    let bestItem: RawEntrezSummaryItem | null = null;
    const lowClean = clean.toLowerCase();

    const validDescriptorItems: RawEntrezSummaryItem[] = [];
    for (const uid of idlist.slice(0, 8)) {
      const item = resultObj[uid];
      if (!item) continue;
      const isDescriptor = item.ds_recordtype === 'descriptor' || Boolean(item.ds_meshui?.startsWith('D'));
      if (!isDescriptor) continue;

      // FILTRAGE ONTOLOGIQUE PAR TREE NUMBER (Catégorie MeSH officielle)
      const treeNumbers = extractTreeNumbersFromEntrezItem(item);
      if (targetAxis && !isValidTreeNumberForAxis(treeNumbers, targetAxis)) {
        continue;
      }

      validDescriptorItems.push(item);
    }

    const normalizeMatchKey = (value: string): string =>
      value.toLowerCase().replace(/[-\s]+/g, ' ').trim();
    const cleanMatchKey = normalizeMatchKey(clean);

    // 4a. Match exact sur Dxxxxxx ou sur l'intitulé principal ds_meshterms[0]
    for (const item of validDescriptorItems) {
      const terms = (item.ds_meshterms || []).map(normalizeMatchKey);
      if (item.ds_meshui?.toLowerCase() === lowClean || (terms.length > 0 && terms[0] === cleanMatchKey)) {
        bestItem = item;
        break;
      }
    }

    // 4b. Match exact dans les Entry Terms (ds_meshterms)
    if (!bestItem) {
      for (const item of validDescriptorItems) {
        const terms = (item.ds_meshterms || []).map(normalizeMatchKey);
        if (terms.includes(cleanMatchKey)) {
          bestItem = item;
          break;
        }
      }
    }

    if (!bestItem) {
      nlmLookupCache.set(cacheKey, null);
      return null;
    }

    const buildDescriptorItem = (item: RawEntrezSummaryItem): MeshDescriptorItem => {
      const rawDesc = item.ds_meshterms?.[0] || clean;
      const descTitle =
        rawDesc.length > 2 && rawDesc === rawDesc.toUpperCase()
          ? formatTitleCase(rawDesc)
          : rawDesc;
      const meshId = item.ds_meshui || `D${item.uid || ''}`;
      const allowedSubheadings = [...(item.ds_subheading || [])];
      const mergedTrees = new Set<string>(extractTreeNumbersFromEntrezItem(item));
      for (const sibling of validDescriptorItems) {
        if (sibling.ds_meshui && item.ds_meshui && sibling.ds_meshui === item.ds_meshui) {
          for (const tn of extractTreeNumbersFromEntrezItem(sibling)) {
            mergedTrees.add(tn);
          }
        }
      }
      const treeNumbers = Array.from(mergedTrees);
      const isPharma = isNlmPharmacologicalSubstance(descTitle, allowedSubheadings);

      return {
        descriptor: descTitle,
        meshId,
        noExp: false,
        isMajor: false,
        allowedSubheadings,
        treeNumbers,
        isPharmacologicalSubstance: isPharma
      };
    };

    const primaryNode = buildDescriptorItem(bestItem);
    const descriptorNodes: MeshDescriptorItem[] = [primaryNode];
    const combinedRawTerms: string[] = [...(bestItem.ds_meshterms || [])];

    // 4c. Co-descripteur syndromique NLM
    if (!primaryNode.isPharmacologicalSubstance) {
      const derivMatch = lowClean.match(/\b([a-z]{5,}(?:ism|ian))\b/);
      const isSecondaryHeading = primaryNode.descriptor.toLowerCase().includes(', secondary');
      if (derivMatch || isSecondaryHeading) {
        const baseRoot = derivMatch
          ? derivMatch[1].replace(/(?:ism|ian)$/, '')
          : primaryNode.descriptor.split(/[,\s]+/)[0].toLowerCase();

        if (baseRoot.length >= 5) {
          for (const candidateItem of validDescriptorItems) {
            if (candidateItem === bestItem) continue;
            const candNode = buildDescriptorItem(candidateItem);
            const candLow = candNode.descriptor.toLowerCase();
            const isSyndromicSibling =
              candLow.startsWith(baseRoot) &&
              (candLow.includes('disorders') || candLow.includes(', secondary') || candLow.includes('syndrome'));
            if (
              isSyndromicSibling &&
              !descriptorNodes.some((d) => d.meshId === candNode.meshId)
            ) {
              descriptorNodes.push(candNode);
              combinedRawTerms.push(...(candidateItem.ds_meshterms || []));
            }
          }
        }
      }
    }

    const entryTerms = primaryNode.isPharmacologicalSubstance
      ? Array.from(
          new Set([
            primaryNode.descriptor.toLowerCase(),
            ...combinedRawTerms
              .map((t) => t.toLowerCase().trim())
              .filter((t) => t.length > 0 && !isIupacOrLabCodeTerm(t))
          ])
        )
      : Array.from(
          new Set([
            primaryNode.descriptor.toLowerCase(),
            ...combinedRawTerms
              .map((t) => t.toLowerCase().trim())
              .filter((t) => !t.includes(',') && !isIupacOrLabCodeTerm(t))
          ])
        ).slice(0, 14);

    const truncationTerms = primaryNode.isPharmacologicalSubstance
      ? []
      : deriveTruncationTerms(entryTerms);

    const result: MeshDetails = {
      descriptor: primaryNode.descriptor,
      meshId: primaryNode.meshId,
      entryTerms,
      descriptors: descriptorNodes,
      truncationTerms,
      scopeNote: bestItem.ds_scopenote || '',
      allowedSubheadings: primaryNode.allowedSubheadings ? [...primaryNode.allowedSubheadings] : [],
      treeNumbers: primaryNode.treeNumbers ? [...primaryNode.treeNumbers] : [],
      isPharmacologicalSubstance: primaryNode.isPharmacologicalSubstance
    };

    nlmLookupCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Vérifie un concept atomique unique contre les deux référentiels officiels :
 * 1. HeTOP / CISMeF prioritaire sur `conceptFr` (si HeTOP est configuré), puis enrichissement/validation NLM.
 * 2. NCBI Entrez `db=mesh` sur `conceptEn` si HeTOP n'est pas configuré ou ne renvoie rien.
 */
async function resolveAtomicConceptOfficial(
  concept: AtomicConceptInput,
  targetAxis?: 'P' | 'I' | 'C' | 'O' | 'NOT'
): Promise<MeshDetails | null> {
  const conceptFr = (concept.conceptFr || '').trim();
  const conceptEn = (concept.conceptEn || '').trim();

  // 1. Interrogation HeTOP prioritaire (correspondance officielle FR -> MeSH Dxxxxxx)
  if (isHetopConfigured() && conceptFr.length >= 2) {
    try {
      const hetopRes = await searchHetopMesh(conceptFr);
      if (hetopRes) {
        if (hetopRes.meshId && /^D\d+$/i.test(hetopRes.meshId)) {
          const nlmByCode = await fetchEntrezMeshDescriptor(hetopRes.meshId, targetAxis);
          if (nlmByCode) return nlmByCode;
        }
        if (hetopRes.descriptor && hetopRes.descriptor.trim().length >= 2) {
          const nlmByLabel = await fetchEntrezMeshDescriptor(hetopRes.descriptor.trim(), targetAxis);
          if (nlmByLabel) return nlmByLabel;
        }
      }
    } catch {
      // Poursuit sur NCBI Entrez avec conceptEn
    }
  }

  // 2. Interrogation directe NCBI Entrez db=mesh sur le concept anglais
  if (conceptEn.length >= 2) {
    const nlmDirect = await fetchEntrezMeshDescriptor(conceptEn, targetAxis);
    if (nlmDirect) return nlmDirect;
  }

  return null;
}

/**
 * MOTEUR DE VÉRIFICATION MeSH OFFICIEL (HeTOP -> NCBI Entrez + Validation Ontologique TreeNumberList)
 *
 * Parcourt l'intégralité des concepts atomiques normalisés par le LLM (sans jamais s'arrêter au premier match) :
 * - Chaque concept confirmé par HeTOP / NCBI Entrez apporte ses descripteurs `[Mesh]` officiels (`Dxxxxxx`) et Entry Terms.
 * - Tout concept non indexé dans MeSH bascule proprement en texte libre (`[TiAb]`) avec ses `synonymsTiab`.
 */
export async function searchNcbiMesh(
  term: string,
  targetAxis?: 'P' | 'I' | 'C' | 'O' | 'NOT',
  englishHints?: readonly string[],
  atomicConcepts?: readonly AtomicConceptInput[]
): Promise<MeshDetails | null> {
  if (!term || term.trim() === '') return null;
  const rawClean = term.trim();

  if (isPassiveComparatorConcept(rawClean) || isUnrestrictedDemographicConcept(rawClean)) {
    return null;
  }

  const conceptsToResolve: AtomicConceptInput[] = [];
  if (atomicConcepts && atomicConcepts.length > 0) {
    for (const c of atomicConcepts) {
      const cleanEn = (c.conceptEn || '').replace(/[()[\]"]/g, '').trim();
      const cleanFr = (c.conceptFr || '').replace(/[()[\]"]/g, '').trim();
      const cleanBroader = (c.broaderMeshRoot || '').replace(/[()[\]"]/g, '').trim();
      if (cleanEn.length >= 2) {
        conceptsToResolve.push({
          conceptFr: cleanFr || undefined,
          conceptEn: cleanEn,
          ...(cleanBroader.length >= 2 && cleanBroader.toLowerCase() !== cleanEn.toLowerCase()
            ? { broaderMeshRoot: cleanBroader }
            : {}),
          synonymsTiab: c.synonymsTiab
        });
      }
    }
  } else if (englishHints && englishHints.length > 0) {
    for (const h of englishHints) {
      const cleanHint = h.replace(/[()[\]"]/g, '').trim();
      if (cleanHint.length >= 2 && !cleanHint.includes('*') && !cleanHint.includes('_')) {
        conceptsToResolve.push({ conceptEn: cleanHint });
      }
    }
  }

  if (conceptsToResolve.length === 0) {
    conceptsToResolve.push({ conceptFr: rawClean, conceptEn: rawClean });
  }

  const cacheSignature = conceptsToResolve
    .map(
      (c) =>
        `${normalizeText(c.conceptFr || '')}:${normalizeText(c.conceptEn)}:${normalizeText(c.broaderMeshRoot || '')}`
    )
    .join('|');
  const cacheKey = `${normalizeText(rawClean)}__${targetAxis || 'ANY'}__${cacheSignature}`;

  if (meshResolutionCache.has(cacheKey)) {
    return meshResolutionCache.get(cacheKey)!;
  }

  interface ResolvedConceptEntry {
    readonly details: MeshDetails;
    readonly items: MeshDescriptorItem[];
  }

  const resolvedEntries: ResolvedConceptEntry[] = [];
  const existingIds = new Set<string>();
  const extraTiabTerms = new Set<string>();
  const unresolvedFreeTerms: string[] = [];
  const unresolvedMeshAttempts = new Set<string>();

  for (const concept of conceptsToResolve) {
    for (const syn of concept.synonymsTiab || []) {
      const cleanSyn = syn.replace(/["“”«»[\]*]/g, '').trim().toLowerCase();
      if (cleanSyn.length >= 2 && !cleanSyn.includes(',') && !isIupacOrLabCodeTerm(cleanSyn)) {
        extraTiabTerms.add(cleanSyn);
      }
    }

    // 1. Résolution officielle exacte d'abord (préserve tout descripteur pré-coordonné ex. "Renal Insufficiency, Chronic")
    let details = await resolveAtomicConceptOfficial(concept, targetAxis);

    // 2. Repli contrôlé sur `broaderMeshRoot` UNIQUEMENT si la résolution exacte renvoie 0 descripteur MeSH
    if (!details) {
      unresolvedMeshAttempts.add(concept.conceptEn);
      const exactFreeEn = concept.conceptEn.replace(/["“”«»[\]*]/g, '').trim().toLowerCase();
      if (exactFreeEn.length >= 2 && !exactFreeEn.includes(',') && !isIupacOrLabCodeTerm(exactFreeEn)) {
        extraTiabTerms.add(exactFreeEn);
      }

      const broaderRoot = (concept.broaderMeshRoot || '').trim();
      if (broaderRoot.length >= 2 && broaderRoot.toLowerCase() !== concept.conceptEn.toLowerCase()) {
        details = await resolveAtomicConceptOfficial(
          { conceptFr: broaderRoot, conceptEn: broaderRoot },
          targetAxis
        );
        if (!details) {
          unresolvedMeshAttempts.add(broaderRoot);
        }
      }
    }

    if (details) {
      const rawItems =
        details.descriptors && details.descriptors.length > 0
          ? details.descriptors
          : [
              {
                descriptor: details.descriptor,
                meshId: details.meshId,
                noExp: false,
                isMajor: false,
                allowedSubheadings: details.allowedSubheadings,
                treeNumbers: details.treeNumbers,
                isPharmacologicalSubstance: details.isPharmacologicalSubstance
              }
            ];

      const freshItems = rawItems.filter((item) => {
        const key = item.meshId ? item.meshId.toUpperCase() : item.descriptor.toLowerCase();
        if (existingIds.has(key)) return false;
        existingIds.add(key);
        return true;
      });

      if (freshItems.length > 0) {
        resolvedEntries.push({ details, items: freshItems });
      }
    } else {
      const freeEn = concept.conceptEn.replace(/["“”«»[\]*]/g, '').trim().toLowerCase();
      if (freeEn.length >= 2 && !freeEn.includes(',')) {
        unresolvedFreeTerms.push(freeEn);
      }
      for (const syn of concept.synonymsTiab || []) {
        const cleanSyn = syn.replace(/["“”«»[\]*]/g, '').trim().toLowerCase();
        if (cleanSyn.length >= 2 && !cleanSyn.includes(',')) {
          unresolvedFreeTerms.push(cleanSyn);
        }
      }
    }
  }

  // Subsomption hiérarchique MeSH uniquement lorsqu'un concept unique a remonté plusieurs descripteurs redondants
  let retainedEntries: ResolvedConceptEntry[] = resolvedEntries;
  if (conceptsToResolve.length === 1 && resolvedEntries.length > 1) {
    const allItems = resolvedEntries.flatMap((entry) => entry.items);
    const survivingItems = pruneSubsumedAncestorDescriptors(allItems);
    const descriptorKey = (item: MeshDescriptorItem): string =>
      item.meshId ? item.meshId.toUpperCase() : item.descriptor.trim().toLowerCase();
    const survivingKeys = new Set(survivingItems.map(descriptorKey));

    const prunedEntries = resolvedEntries
      .map((entry) => ({
        details: entry.details,
        items: entry.items.filter((item) => survivingKeys.has(descriptorKey(item)))
      }))
      .filter((entry) => entry.items.length > 0);

    if (prunedEntries.length > 0) {
      retainedEntries = prunedEntries;
    }
  }

  const primaryDetails = retainedEntries[0]?.details ?? null;
  const foundDescriptors: MeshDescriptorItem[] = [];
  const mergedEntryTerms = new Set<string>();
  const mergedTruncations = new Set<string>();
  const mergedAllowedSubheadings = new Set<string>();
  const mergedTreeNumbers = new Set<string>();

  for (const entry of retainedEntries) {
    for (const item of entry.items) {
      if (!foundDescriptors.some((d) => d.descriptor.toLowerCase() === item.descriptor.toLowerCase())) {
        foundDescriptors.push(item);
      }
      for (const sh of item.allowedSubheadings || []) {
        mergedAllowedSubheadings.add(sh);
      }
      for (const tn of item.treeNumbers || []) {
        mergedTreeNumbers.add(tn);
      }
    }
    for (const sh of entry.details.allowedSubheadings || []) {
      mergedAllowedSubheadings.add(sh);
    }
    for (const tn of entry.details.treeNumbers || []) {
      mergedTreeNumbers.add(tn);
    }
    for (const t of entry.details.entryTerms || []) {
      mergedEntryTerms.add(t);
    }
    for (const t of entry.details.truncationTerms || []) {
      mergedTruncations.add(t);
    }
  }

  for (const extraTerm of extraTiabTerms) {
    mergedEntryTerms.add(extraTerm);
  }
  for (const freeTerm of unresolvedFreeTerms) {
    mergedEntryTerms.add(freeTerm);
    deriveTruncationTerms([freeTerm]).forEach((t) => mergedTruncations.add(t));
  }

  const unresolvedMeshTerms = Array.from(unresolvedMeshAttempts);

  if (primaryDetails && foundDescriptors.length > 0) {
    const allEntryTerms = Array.from(mergedEntryTerms);
    const allPharmacological =
      foundDescriptors.length > 0 && foundDescriptors.every((d) => Boolean(d.isPharmacologicalSubstance));
    const result: MeshDetails = {
      descriptor: primaryDetails.descriptor,
      meshId: primaryDetails.meshId,
      entryTerms: allEntryTerms.length > 0 ? allEntryTerms : primaryDetails.entryTerms,
      descriptors: foundDescriptors,
      truncationTerms: allPharmacological ? [] : Array.from(mergedTruncations),
      scopeNote: primaryDetails.scopeNote,
      allowedSubheadings: Array.from(mergedAllowedSubheadings),
      treeNumbers: Array.from(mergedTreeNumbers),
      isPharmacologicalSubstance: allPharmacological,
      ...(unresolvedMeshTerms.length > 0 ? { unresolvedMeshTerms } : {})
    };
    meshResolutionCache.set(cacheKey, result);
    return result;
  }

  // Concept Libre (aucun descripteur MeSH Dxxxxxx officiel trouvé) : strictement en texte libre [TiAb]
  const primaryLabel = conceptsToResolve[0]?.conceptEn || rawClean;
  const titleCase = formatTitleCase(primaryLabel);
  const freeTermsSet = new Set<string>([
    primaryLabel.toLowerCase(),
    ...unresolvedFreeTerms,
    ...extraTiabTerms
  ]);
  const freeEntryTerms = Array.from(freeTermsSet).filter((t) => t.length >= 2 && !t.includes(','));
  const freeTruncs = deriveTruncationTerms(freeEntryTerms);

  const freeResult: MeshDetails = {
    descriptor: titleCase,
    meshId: 'Concept-Libre',
    entryTerms: freeEntryTerms.length > 0 ? freeEntryTerms : [primaryLabel.toLowerCase()],
    descriptors: [
      {
        descriptor: titleCase,
        meshId: 'Concept-Libre',
        noExp: false,
        isMajor: false
      }
    ],
    truncationTerms: freeTruncs,
    ...(unresolvedMeshTerms.length > 0 ? { unresolvedMeshTerms } : {})
  };
  meshResolutionCache.set(cacheKey, freeResult);
  return freeResult;
}
