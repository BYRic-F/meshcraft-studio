import { MeshDetails, MeshDescriptorItem, isIupacOrLabCodeTerm } from './rustEngineService';
import { isHetopConfigured, searchHetopMesh } from './hetopService';
import { buildNcbiUrl, getNcbiApiKey } from './pubmedApi';
import {
  stripClinicalNarrativeFraming,
  computeBackoffDelayMs,
  isPassiveComparatorConcept,
  isUnrestrictedDemographicConcept
} from './localAiService';

/**
 * Service de Résolution MeSH Médical — 100% Dynamique & Officiel (NLM Entrez + HeTOP)
 *
 * RÈGLE FONDAMENTALE (`gemini.md`) : ZÉRO DICTIONNAIRE EN DUR.
 * 1. Résilience réseau : Exponential Backoff + Full Jitter sur `esearch.fcgi` / `esummary.fcgi`.
 * 2. Extraction NLM complète : `ds_meshterms`, `ds_meshui` (`Dxxxxxx`), `ds_subheading`, `ds_scopenote`.
 * 3. Qualification pharmacologique dynamique : détection native des DCI via `ds_subheading.includes('pharmacology')`.
 * 4. Co-descripteurs syndromiques NLM : rétention des descripteurs syndromiques frères issus d'`esummary`.
 */

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
 * - Axe O (`PathologyOutcome`) : N'accepte QUE les maladies (`C`), troubles mentaux (`F03`),
 *   mesures anthropométriques (`G07.700`), examen clinique/signes vitaux (`E01.370.600`),
 *   mortalité/morbidité (`N06.850.505.400`) et qualité de vie (`I01.800`).
 *   Rejette strictement l'imagerie diagnostique (`E01.370.350`), les régimes (`G07.203`),
 *   `Pharmacovigilance` (`E05`/`N04`), `D`, `L01` et `V01-V04` (`Exhibitions`).
 * - Axe I (`DrugInnList` / Intervention) & Axe C : N'accepte QUE les descripteurs commençant par
 *   `D` (Produits chimiques/Médicaments), `E` (Techniques), `N` (Soins de santé),
 *   `I02` (Enseignement médical) ou `G07` (Phénomènes physiologiques et nutritionnels).
 *   Rejette silencieusement toute dérive hors-sujet (ex: `Exhibitions` [L01]).
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
        t.startsWith('G07')
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
 * Extrait les termes anglophones ou alternatifs présents entre parenthèses.
 * Protège les descripteurs NLM inversés contenant une virgule (ex: `(Parkinson Disease, Secondary)`).
 */
export function extractParenthesizedTerms(text: string): string[] {
  const matches = text.match(/\(([^)]+)\)/g);
  if (!matches) return [];
  const terms: string[] = [];

  for (const m of matches) {
    const inner = m.replace(/[()]/g, '').trim();
    if (!inner) continue;
    if (/^(?:[<>≤≥=~+-]?\s*\d+|n\s*=\s*\d+)/i.test(inner)) continue;

    // Protéger les inversions taxonomiques NLM (ex: "Parkinson Disease, Secondary", "Diabetes Mellitus, Type 2")
    const parts = inner.split(
      /;\s*|,\s*(?!(?:Type\s+(?:\d+|[IVX]+)|Secondary|Primary|Acute|Chronic|Congenital|Idiopathic|Induced|Chemically\s+Induced|Drug-Induced|Familial|Experimental|Symptomatic|Nervous\s+System)\b)/i
    );
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 2 && !/^(?:[<>≤≥=~+-]?\s*\d+|n\s*=\s*\d+)/i.test(trimmed)) {
        terms.push(trimmed);
      }
    }
  }
  return terms;
}

export function isLikelyFrench(term: string): boolean {
  const clean = term.trim();
  if (!clean) return false;
  if (/[éèêëàâäôöùûüçîïœæ]/i.test(clean)) return true;
  if (/\b(?:[cdjlmnst]'|qu')[a-zàâäéèêëîïôöùûü]/i.test(clean)) return true;
  if (/\b(de|du|des|ou|et|le|la|les|un|une|sans|avec|chez|pour|dans|sur|par|aux|au|en|sous|vers|entre|contre|aucun|aucune|tous|toutes)\b/i.test(clean)) return true;
  if (/(?:ectomie|tomie|pathie|thérapie|therapie|logie|scopie|plastie|graphie|émie|emie|algie|isme|ique|iques|aire|aires|ement|ements|ateur|ateurs|atrice|atrices|iteur|iteurs|itrice|itrices|euse|euses|ien|ienne|iens|iennes|elle|elles|ive|ives|eux)\b/i.test(clean)) return true;
  return false;
}

/**
 * Dérive les troncatures conformes aux normes BiUM/NLM ($\ge 5$ caractères) en respectant
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
const translationCache = new Map<string, string>();
const meshResolutionCache = new Map<string, MeshDetails>();

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
      // Fusionner les Tree Numbers de tous les enregistrements partageant le même Dxxxxxx (ex: D27 + D02)
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

const translationCandidatesCache = new Map<string, string[]>();
const wikidataCache = new Map<string, string[]>();

async function fetchWikidataEnglishTerms(frenchText: string): Promise<string[]> {
  const clean = frenchText.trim();
  if (!clean) return [];
  const cacheKey = clean.toLowerCase();
  if (wikidataCache.has(cacheKey)) {
    return wikidataCache.get(cacheKey)!;
  }

  const terms: string[] = [];
  const addTerm = (val: string | undefined) => {
    if (!val) return;
    const sanitized = val.replace(/[‡†§¶*"'`]/g, '').replace(/\s+/g, ' ').trim();
    if (sanitized.length > 2 && !terms.some((t) => t.toLowerCase() === sanitized.toLowerCase())) {
      terms.push(sanitized);
    }
  };

  try {
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(clean)}&language=fr&format=json&origin=*`;
    const res = await fetch(searchUrl, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      const ids = (data?.search || [])
        .slice(0, 2)
        .map((item: { id?: string }) => item?.id)
        .filter((id: string | undefined): id is string => Boolean(id));
      if (ids.length > 0) {
        const detailsUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join('|')}&props=labels|aliases&languages=en&format=json&origin=*`;
        const detailsRes = await fetch(detailsUrl, { signal: AbortSignal.timeout(4000) });
        if (detailsRes.ok) {
          const detailsData = await detailsRes.json();
          for (const id of ids) {
            const entity = detailsData?.entities?.[id];
            addTerm(entity?.labels?.en?.value);
            const aliases = entity?.aliases?.en || [];
            for (const al of aliases) {
              addTerm(al?.value);
            }
          }
        }
      }
    }
  } catch {}

  wikidataCache.set(cacheKey, terms);
  return terms;
}

export async function translateFrenchToEnglishCandidates(frenchText: string): Promise<string[]> {
  const clean = frenchText.trim();
  if (!clean) return [];
  const cacheKey = clean.toLowerCase();
  if (translationCandidatesCache.has(cacheKey)) {
    return translationCandidatesCache.get(cacheKey)!;
  }

  const candidates: string[] = [];
  const addCandidate = (raw: string | undefined, subject?: string) => {
    if (!raw || raw.toUpperCase().includes('MYMEMORY WARNING')) return;
    if (subject && /engineering|manufacturing|electronics|computing|telecom|automotive|aviation/i.test(subject)) {
      return;
    }
    const sanitized = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/[‡†§¶*"'`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/power\s+suppl|electric\s+power|voltage|switchgear/i.test(sanitized)) {
      return;
    }
    if (sanitized.length > 1 && !candidates.some((c) => c.toLowerCase() === sanitized.toLowerCase())) {
      candidates.push(sanitized);
    }
  };

  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=fr|en&de=contact@meshcraft-studio.org`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      addCandidate(data?.responseData?.translatedText);
      if (Array.isArray(data?.matches)) {
        for (const m of data.matches) {
          if (typeof m?.match === 'number' && m.match < 0.85) continue;
          addCandidate(m?.translation, m?.subject);
        }
      }
    }
  } catch {}

  if (candidates.length > 0) {
    translationCandidatesCache.set(cacheKey, candidates);
    translationCache.set(cacheKey, candidates[0]);
  }
  return candidates;
}

export async function translateFrenchToEnglish(frenchText: string): Promise<string | null> {
  const clean = frenchText.trim();
  const cacheKey = clean.toLowerCase();
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey)!;
  }

  const candidates = await translateFrenchToEnglishCandidates(clean);
  return candidates[0] || null;
}

/**
 * Découpe une saisie clinique en clauses de premier niveau sans couper à l'intérieur des parenthèses
 * ni couper les descripteurs NLM inversés avec virgule (`Parkinson Disease, Secondary`, `Diabetes Mellitus, Type 2`).
 */
function splitClausesRespectingParens(text: string): string[] {
  const step1: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (depth === 0 && (ch === ';' || ch === '&' || ch === '/' || ch === ',')) {
      const rest = text.slice(i + 1);
      if (
        ch === ',' &&
        /^\s*(?:Type\s+(?:\d+|[IVX]+)|Secondary|Primary|Acute|Chronic|Congenital|Idiopathic|Induced|Chemically\s+Induced|Drug-Induced|Familial|Experimental|Symptomatic|Nervous\s+System)\b/i.test(
          rest
        )
      ) {
        current += ch;
        continue;
      }
      if (current.trim()) step1.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) step1.push(current.trim());

  const clauses: string[] = [];
  for (const chunk of step1) {
    const parts = chunk.split(/\s+(?:ou|or|et|and|pour|for)\s+(?![^(]*\))/i);
    for (const p of parts) {
      if (p.trim()) clauses.push(p.trim());
    }
  }
  return clauses;
}

const PHARMACOLOGICAL_CLASS_PATTERN = /\b(?:inhibiteurs?|agonistes?|antagonistes?|bloquants?|statines?|anticoagulants?|antiagr[ée]gants?|immunosuppresseurs?|antibiotiques?|cortico[ïi]des?|neuroleptiques?|antipsychotiques?|anti[ée]pileptiques?|antid[ée]presseurs?)\b/i;

export function extractSubConcepts(text: string): string[] {
  const result: string[] = [];
  const addUnique = (val: string) => {
    const trimmed = val.trim();
    if (trimmed.length > 2 && !result.some((r) => r.toLowerCase() === trimmed.toLowerCase())) {
      result.push(trimmed);
    }
  };

  const allParens = extractParenthesizedTerms(text);
  const clauses = splitClausesRespectingParens(text);

  const cleanedOuterClauses = clauses
    .map((c) => stripClinicalNarrativeFraming(c.replace(/\([^)]*\)/g, ' ')))
    .filter((c) => c.length > 2);

  if (
    allParens.length >= 2 &&
    allParens.every((p) => !isLikelyFrench(p)) &&
    cleanedOuterClauses.length === allParens.length &&
    cleanedOuterClauses.every((c) => isLikelyFrench(c) && !PHARMACOLOGICAL_CLASS_PATTERN.test(c))
  ) {
    allParens.forEach(addUnique);
    return result;
  }

  for (const clause of clauses) {
    const clauseParens = extractParenthesizedTerms(clause);
    const outerRaw = clause.replace(/\([^)]*\)/g, ' ').trim();
    const outerClean = stripClinicalNarrativeFraming(outerRaw);

    clauseParens.forEach(addUnique);

    if (outerClean.length > 2) {
      const hasExplicitEnglishTranslation =
        clauseParens.length > 0 &&
        clauseParens.every((p) => !isLikelyFrench(p)) &&
        isLikelyFrench(outerClean) &&
        !PHARMACOLOGICAL_CLASS_PATTERN.test(outerClean);

      if (!hasExplicitEnglishTranslation) {
        addUnique(outerClean);
      }
    }
  }

  if (result.length === 0 && text.trim().length > 2) {
    addUnique(stripClinicalNarrativeFraming(text.trim()) || text.trim());
  }

  return result;
}

const NON_CONCEPT_SINGLE_WORDS = /^(and|the|for|with|without|from|into|than|that|this|which|whom|whose|adult|adults|patient|patients|subject|subjects|group|groups|study|studies|versus|vs|trial|trials|in|on|at|by|of|or|to|as|is|are|was|were|feeding|change|changes|variation|variations|loss|free|absence|lack|usual|standard|habitual|routine|normal|ordinary|type|model|restriction|restrictions|intake|intakes|power|supply|supplies|electric|electrical|level|levels|rate|rates|value|values|effect|effects|impact|outcome|outcomes|accident|accidents|acute|chronic|severe|mild|moderate|score|index|total|global|overall|syndrome|syndromes|disease|diseases|disorder|disorders|infarction|infarctions|recurrence|relapse)$/i;

async function resolveSingleConcept(
  concept: string,
  targetAxis?: 'P' | 'I' | 'C' | 'O' | 'NOT'
): Promise<MeshDetails | null> {
  const clean = stripClinicalNarrativeFraming(concept.trim()) || concept.trim();
  if (clean.length < 2) return null;

  const frenchDetected = isLikelyFrench(clean);

  // 1. Interrogation HeTOP officielle prioritaire
  if (isHetopConfigured()) {
    try {
      const hetopRes = await searchHetopMesh(clean);
      if (hetopRes) {
        if (hetopRes.meshId && /^D\d+$/.test(hetopRes.meshId)) {
          const nlmByCode = await fetchEntrezMeshDescriptor(hetopRes.meshId, targetAxis);
          if (nlmByCode) return nlmByCode;
          if (targetAxis) return null; // Rejeté par la validation ontologique Tree Number
        }
        return hetopRes;
      }
    } catch {}
  }

  // 2. Construction des candidats anglophones
  const englishCandidates: string[] = [];

  if (frenchDetected) {
    const transCandidates = await translateFrenchToEnglishCandidates(clean);
    for (const tc of transCandidates) {
      if (!englishCandidates.includes(tc)) englishCandidates.push(tc);
    }
  } else {
    englishCandidates.push(clean);
  }

  const tryMatchCandidates = async (candidates: string[]): Promise<MeshDetails | null> => {
    for (const eng of candidates) {
      const directNlm = await fetchEntrezMeshDescriptor(eng, targetAxis);
      if (directNlm) return directNlm;

      const words = eng.replace(/[,;()&/]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
      const meaningful = words.filter((w) => !NON_CONCEPT_SINGLE_WORDS.test(w.toLowerCase()));

      if (meaningful.length > 0) {
        const candidateSubPhrases: string[] = [];
        if (meaningful.length >= 3) {
          candidateSubPhrases.push(meaningful.slice(-3).join(' '));
        }
        if (meaningful.length >= 2) {
          candidateSubPhrases.push(meaningful.slice(-2).join(' '));
          candidateSubPhrases.push(meaningful.slice(0, 2).join(' '));
        }
        if (words.length >= 2 && /^accidents?$/i.test(words[words.length - 1])) {
          candidateSubPhrases.unshift(words.slice(-2).join(' '));
        }
        candidateSubPhrases.push(meaningful[meaningful.length - 1]);
        for (let i = meaningful.length - 2; i >= 0; i--) {
          if (!candidateSubPhrases.includes(meaningful[i])) {
            candidateSubPhrases.push(meaningful[i]);
          }
        }

        for (const phrase of candidateSubPhrases) {
          if (phrase.split(/\s+/).length === 1 && NON_CONCEPT_SINGLE_WORDS.test(phrase)) {
            continue;
          }
          const match = await fetchEntrezMeshDescriptor(phrase, targetAxis);
          if (match) return match;
        }
      }
    }
    return null;
  };

  const firstPass = await tryMatchCandidates(englishCandidates);
  if (firstPass) return firstPass;

  const routineModFilter = /^(?:adultes?|patients?|sujets?|groupes?|hommes?|femmes?|en|de|des|du|le|la|les|un|une|par|pour|sur|avec|sans|chez|ou|et|dans|habituel(?:le)?s?|usuel(?:le)?s?|courant(?:e)?s?|normal(?:e)?s?|ordinaire|standard|absence|aucun(?:e)?|restriction|restrictions)$/i;
  const deElided = clean.replace(/\b(?:[cdjlmnst]|qu)['’]/gi, ' ');
  const coreWords = deElided
    .split(/\s+/)
    .filter((w) => w.length > 2 && !routineModFilter.test(w.toLowerCase()) && !NON_CONCEPT_SINGLE_WORDS.test(w.toLowerCase()));

  if (coreWords.length === 0) {
    return null;
  }

  if (!frenchDetected) {
    const fallbackCandidates = await translateFrenchToEnglishCandidates(clean);
    const secondPass = await tryMatchCandidates(fallbackCandidates);
    if (secondPass) return secondPass;
  } else {
    const fallbackPool: string[] = [];
    const coreStr = coreWords.join(' ');
    if (coreStr.toLowerCase() !== clean.toLowerCase()) {
      const coreTrans = await translateFrenchToEnglishCandidates(coreStr);
      fallbackPool.push(...coreTrans);
    }
    const wikiTerms = await fetchWikidataEnglishTerms(coreStr || clean);
    fallbackPool.push(...wikiTerms);

    const secondPass = await tryMatchCandidates(fallbackPool);
    if (secondPass) return secondPass;
  }

  return null;
}

/**
 * MOTEUR PRINCIPAL DE RÉSOLUTION MeSH (NLM Entrez + HeTOP + Validation Ontologique TreeNumberList)
 */
export async function searchNcbiMesh(
  term: string,
  targetAxis?: 'P' | 'I' | 'C' | 'O' | 'NOT',
  englishHints?: readonly string[]
): Promise<MeshDetails | null> {
  if (!term || term.trim() === '') return null;
  const rawClean = term.trim();

  if (isPassiveComparatorConcept(rawClean) || isUnrestrictedDemographicConcept(rawClean)) {
    return null;
  }

  const cleanHints = (englishHints || [])
    .map((h) => h.replace(/[()[\]"]/g, '').trim())
    .filter((h) => h.length > 2 && !h.includes('*') && !h.includes('_') && !isLikelyFrench(h))
    .slice(0, 6);

  const hintsKey = cleanHints.map((h) => h.toLowerCase()).sort().join('|');
  const normalized = hintsKey
    ? `${normalizeText(rawClean)}__${targetAxis || 'ANY'}__${hintsKey}`
    : `${normalizeText(rawClean)}__${targetAxis || 'ANY'}`;

  if (meshResolutionCache.has(normalized)) {
    return meshResolutionCache.get(normalized)!;
  }

  // 1. Si la saisie est un descripteur NLM unique
  const commaCount = (rawClean.match(/,/g) || []).length;
  const isSingleInvertedNlm =
    commaCount === 1 &&
    /,\s*(?:Type\s+(?:\d+|[IVX]+)|Secondary|Primary|Acute|Chronic|Congenital|Idiopathic|Induced|Chemically\s+Induced)\b/i.test(
      rawClean
    );
  if (!rawClean.includes('(') && !/\b(?:ou|or|et|and)\b/i.test(rawClean) && (commaCount === 0 || isSingleInvertedNlm)) {
    const exactFull = await fetchEntrezMeshDescriptor(rawClean, targetAxis);
    if (exactFull) {
      meshResolutionCache.set(normalized, exactFull);
      return exactFull;
    }
  }

  interface ResolvedSubConceptEntry {
    readonly details: MeshDetails;
    readonly items: MeshDescriptorItem[];
  }

  // 2. Découpage en sous-concepts médicaux distincts
  const subConcepts = extractSubConcepts(rawClean);
  const parenthesizedTermsSet = new Set(extractParenthesizedTerms(rawClean).map((p) => p.toLowerCase()));
  const resolvedEntries: ResolvedSubConceptEntry[] = [];
  const unresolvedFreeTerms: string[] = [];

  for (const sub of subConcepts) {
    const details = await resolveSingleConcept(sub, targetAxis);
    if (details) {
      const itemsToAdd =
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
      resolvedEntries.push({ details, items: itemsToAdd });
    } else if (
      (!targetAxis ||
        (targetAxis === 'I' && (parenthesizedTermsSet.has(sub.toLowerCase()) || subConcepts.length > 1))) &&
      sub.trim().length > 2
    ) {
      // Conserver les termes libres hors axe strict, ainsi que les molécules/termes séparés par des virgules ou parenthèses sur l'Axe I
      let engSub = (await translateFrenchToEnglish(sub)) || '';
      if (!engSub || engSub.toLowerCase() === sub.toLowerCase()) {
        const wikiCandidates = await fetchWikidataEnglishTerms(sub);
        if (wikiCandidates.length > 0) {
          engSub = wikiCandidates[0];
        }
      }
      const cleanSub = (engSub || sub).replace(/[()]/g, '').trim().toLowerCase();
      if (cleanSub.length > 2 && !isLikelyFrench(cleanSub) && !NON_CONCEPT_SINGLE_WORDS.test(cleanSub)) {
        unresolvedFreeTerms.push(cleanSub);
      }
    }
  }

  // 3. Fallback sur la phrase entière si aucun sous-concept n'a matché
  if (resolvedEntries.length === 0) {
    const fullDetails = await resolveSingleConcept(rawClean, targetAxis);
    if (fullDetails) {
      const itemsToAdd =
        fullDetails.descriptors && fullDetails.descriptors.length > 0
          ? fullDetails.descriptors
          : [
              {
                descriptor: fullDetails.descriptor,
                meshId: fullDetails.meshId,
                noExp: false,
                isMajor: false,
                allowedSubheadings: fullDetails.allowedSubheadings,
                treeNumbers: fullDetails.treeNumbers,
                isPharmacologicalSubstance: fullDetails.isPharmacologicalSubstance
              }
            ];
      resolvedEntries.push({ details: fullDetails, items: itemsToAdd });
    }
  }

  // 3a. Passerelle secondaire par candidats anglophones d'Agent 1 (englishHints)
  // Déclenchée uniquement si la résolution directe est absente ou partielle par rapport au nombre de clauses.
  // Zéro hallucination MeSH : chaque candidat DOIT être validé en direct par Entrez Dxxxxxx + Tree Number.
  const clauseCount = Math.max(1, splitClausesRespectingParens(rawClean).length);
  if (cleanHints.length > 0 && (resolvedEntries.length === 0 || resolvedEntries.length < clauseCount)) {
    const existingIds = new Set<string>(
      resolvedEntries.flatMap((entry) => entry.items.map((item) => item.meshId.toUpperCase()))
    );

    for (const hint of cleanHints) {
      const hintDetails = await fetchEntrezMeshDescriptor(hint, targetAxis);
      if (!hintDetails || !/^D\d+$/i.test(hintDetails.meshId)) {
        continue;
      }

      const rawItems =
        hintDetails.descriptors && hintDetails.descriptors.length > 0
          ? hintDetails.descriptors
          : [
              {
                descriptor: hintDetails.descriptor,
                meshId: hintDetails.meshId,
                noExp: false,
                isMajor: false,
                allowedSubheadings: hintDetails.allowedSubheadings,
                treeNumbers: hintDetails.treeNumbers,
                isPharmacologicalSubstance: hintDetails.isPharmacologicalSubstance
              }
            ];

      const validItems = rawItems.filter((item) => {
        if (!/^D\d+$/i.test(item.meshId)) return false;
        if (existingIds.has(item.meshId.toUpperCase())) return false;
        const itemTrees = item.treeNumbers ?? hintDetails.treeNumbers ?? [];
        return !targetAxis || isValidTreeNumberForAxis(itemTrees, targetAxis);
      });

      if (validItems.length > 0) {
        validItems.forEach((item) => existingIds.add(item.meshId.toUpperCase()));
        resolvedEntries.push({ details: hintDetails, items: validItems });
      }
    }
  }

  // 3b. Subsumption hiérarchique MeSH au sein d'un même concept clinique unifié
  // (élimine un ancêtre trop large B si un descendant direct A a été résolu pour ce même concept)
  const isSingleUnifiedConcept =
    splitClausesRespectingParens(rawClean).length === 1 && !PHARMACOLOGICAL_CLASS_PATTERN.test(rawClean);

  let retainedEntries: ResolvedSubConceptEntry[] = resolvedEntries;
  if (isSingleUnifiedConcept && resolvedEntries.length > 1) {
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

  // 4. Agrégation finale à partir des seules entrées retenues post-subsumption
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

  for (const freeTerm of unresolvedFreeTerms) {
    mergedEntryTerms.add(freeTerm);
    deriveTruncationTerms([freeTerm]).forEach((t) => mergedTruncations.add(t));
  }

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
      isPharmacologicalSubstance: allPharmacological
    };
    meshResolutionCache.set(normalized, result);
    return result;
  }

  // Si un axe strict (O, I, C) est spécifié et qu'aucun descripteur NLM n'a passé le filtre Tree Number,
  // rejeter silencieusement le concept pour empêcher toute pollution hors-taxonomie.
  if (targetAxis === 'O' || targetAxis === 'C') {
    return null;
  }

  // 5. Concept Libre (Non indexé au MeSH NLM) : strictement en texte libre [TiAb]
  const englishConcept = (await translateFrenchToEnglish(rawClean)) || rawClean;
  const cleanEnglish = englishConcept.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const titleCase = formatTitleCase(cleanEnglish);

  const fallbackTerms = [cleanEnglish.toLowerCase()];
  const fallbackTruncs = deriveTruncationTerms(fallbackTerms);

  return {
    descriptor: titleCase,
    meshId: 'Concept-Libre',
    entryTerms: fallbackTerms,
    descriptors: [
      {
        descriptor: titleCase,
        meshId: 'Concept-Libre',
        noExp: false,
        isMajor: false
      }
    ],
    truncationTerms: fallbackTruncs
  };
}
