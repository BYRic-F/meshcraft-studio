/**
 * Service de déduplication multi-bases par fusion (Survivorship) et comptabilité PRISMA 2020.
 *
 * Cascade déterministe en 4 niveaux :
 * 1. DOI normalisé
 * 2. PMID numérique exact
 * 3. ID Embase / ID Cochrane / ID Registre (entre registres uniquement)
 * 4. Titre normalisé :
 *    - >= 25 caractères : année ±1 (tolérance Ahead of print) ou 1er auteur concordant si année absente
 *    - < 25 caractères  : titre normalisé + nom de famille du 1er auteur non vide + année exacte obligatoires
 *
 * Conforme à `GEMINI.md` : zéro `any`, logique 100 % pure et déterministe.
 */

import {
  BibliographicSource,
  CANONICAL_SOURCE_ORDER,
  CanonicalStudyRecord,
  CorpusDeduplicationStats,
  SourceImportBatch,
  StudyIdentifiers,
  StudyRecordKind,
  createEmptySourceCounts,
  extractFirstAuthorSurname,
  extractPubYear,
  normalizeDoi,
  normalizeEmbaseId,
  normalizePmid,
  normalizeTitleForDedup,
  resolvePreferredUrl
} from './studyRecordTypes';

export interface DeduplicationMergeResult {
  readonly records: CanonicalStudyRecord[];
  readonly stats: CorpusDeduplicationStats;
  readonly mergedDuplicatesCount: number;
  readonly addedRecordsCount: number;
}

const RECORD_KIND_PRIORITY: Readonly<Record<StudyRecordKind, number>> = {
  article: 4,
  review: 3,
  other: 2,
  trial_registry: 1
};

function mergeSourceLists(
  a: readonly BibliographicSource[],
  b: readonly BibliographicSource[]
): BibliographicSource[] {
  const combined = new Set<BibliographicSource>([...a, ...b]);
  return CANONICAL_SOURCE_ORDER.filter((src) => combined.has(src));
}

function mergeIdentifiers(a: StudyIdentifiers, b: StudyIdentifiers): StudyIdentifiers {
  const pmid = normalizePmid(a.pmid) ?? normalizePmid(b.pmid);
  const doi = normalizeDoi(a.doi) ?? normalizeDoi(b.doi);
  const embaseId = normalizeEmbaseId(a.embaseId) ?? normalizeEmbaseId(b.embaseId);
  const embasePui = a.embasePui || b.embasePui;
  const cochraneId = a.cochraneId || b.cochraneId;

  const regSet = new Set<string>();
  const registryIds: string[] = [];
  for (const reg of [...(a.registryIds ?? []), ...(b.registryIds ?? [])]) {
    const clean = reg.trim();
    if (clean && !regSet.has(clean.toUpperCase())) {
      regSet.add(clean.toUpperCase());
      registryIds.push(clean);
    }
  }

  return {
    ...(pmid ? { pmid } : {}),
    ...(doi ? { doi } : {}),
    ...(embaseId ? { embaseId } : {}),
    ...(embasePui ? { embasePui } : {}),
    ...(cochraneId ? { cochraneId } : {}),
    ...(registryIds.length > 0 ? { registryIds } : {})
  };
}

function mergeUniqueStringsCaseInsensitive(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...(first ?? []), ...(second ?? [])]) {
    const clean = item.trim();
    if (!clean) continue;
    const low = clean.toLowerCase();
    if (!seen.has(low)) {
      seen.add(low);
      out.push(clean);
    }
  }
  return out;
}

function pickBestAbstract(a: string, b: string): string {
  const cleanA = (a || '').trim();
  const cleanB = (b || '').trim();
  const isEmptyA = !cleanA || /aucun r[ée]sum[ée] disponible|no abstract available/i.test(cleanA);
  const isEmptyB = !cleanB || /aucun r[ée]sum[ée] disponible|no abstract available/i.test(cleanB);

  if (isEmptyA && !isEmptyB) return cleanB;
  if (!isEmptyA && isEmptyB) return cleanA;
  return cleanB.length > cleanA.length ? cleanB : cleanA;
}

function pickBestAuthors(a: string, b: string): string {
  const cleanA = (a || '').trim();
  const cleanB = (b || '').trim();
  if (!cleanA) return cleanB;
  if (!cleanB) return cleanA;
  return cleanB.length > cleanA.length ? cleanB : cleanA;
}

function pickBestJournalName(a: string, b: string): string {
  const cleanA = (a || '').trim();
  const cleanB = (b || '').trim();
  const aIsUrl = /^https?:\/\//i.test(cleanA);
  const bIsUrl = /^https?:\/\//i.test(cleanB);
  if (aIsUrl && !bIsUrl && cleanB) return cleanB;
  if (!aIsUrl && bIsUrl && cleanA) return cleanA;
  if (!cleanA) return cleanB;
  if (!cleanB) return cleanA;
  return cleanB.length > cleanA.length ? cleanB : cleanA;
}

/**
 * Fusionne deux notices reconnues comme doublons selon les règles de survivorship :
 * - conserve strictement `survivor.id` pour la stabilité des clés React / RoB 2
 * - unit `sources[]`, `identifiers`, `meshHeadings` et `publicationTypes`
 * - conserve toute décision humaine/Rayyan/IA déjà prise sur le survivant.
 */
export function mergeStudyRecords(
  survivor: CanonicalStudyRecord,
  incoming: CanonicalStudyRecord
): CanonicalStudyRecord {
  const mergedIdentifiers = mergeIdentifiers(survivor.identifiers, incoming.identifiers);
  const mergedSources = mergeSourceLists(survivor.sources, incoming.sources);
  const mergedKind: StudyRecordKind =
    RECORD_KIND_PRIORITY[incoming.recordKind] > RECORD_KIND_PRIORITY[survivor.recordKind]
      ? incoming.recordKind
      : survivor.recordKind;

  const pmid = mergedIdentifiers.pmid ?? normalizePmid(survivor.pmid) ?? normalizePmid(incoming.pmid) ?? '';
  const doi = mergedIdentifiers.doi ?? normalizeDoi(survivor.doi) ?? normalizeDoi(incoming.doi);
  const url = resolvePreferredUrl(mergedIdentifiers, survivor.url || incoming.url);

  const survivorHasDecision = survivor.status !== 'pending';
  const incomingHasDecision = incoming.status !== 'pending';
  const useIncomingDecision = !survivorHasDecision && incomingHasDecision;

  return {
    id: survivor.id,
    pmid,
    ...(doi ? { doi } : {}),
    identifiers: mergedIdentifiers,
    sources: mergedSources,
    recordKind: mergedKind,
    title: survivor.title.length >= incoming.title.length ? survivor.title : incoming.title,
    authors: pickBestAuthors(survivor.authors, incoming.authors),
    source: pickBestJournalName(survivor.source, incoming.source),
    pubDate: survivor.pubDate || incoming.pubDate,
    abstract: pickBestAbstract(survivor.abstract, incoming.abstract),
    meshHeadings: mergeUniqueStringsCaseInsensitive(survivor.meshHeadings, incoming.meshHeadings),
    publicationTypes: mergeUniqueStringsCaseInsensitive(
      survivor.publicationTypes,
      incoming.publicationTypes
    ),
    ...(survivor.language || incoming.language
      ? { language: survivor.language || incoming.language }
      : {}),
    url,
    status: useIncomingDecision ? incoming.status : survivor.status,
    ...(useIncomingDecision
      ? incoming.exclusionReason
        ? { exclusionReason: incoming.exclusionReason }
        : {}
      : survivor.exclusionReason
        ? { exclusionReason: survivor.exclusionReason }
        : {}),
    ...(useIncomingDecision
      ? incoming.evidenceSnippet
        ? { evidenceSnippet: incoming.evidenceSnippet }
        : {}
      : survivor.evidenceSnippet
        ? { evidenceSnippet: survivor.evidenceSnippet }
        : {}),
    ...(useIncomingDecision
      ? incoming.evaluatedBy
        ? { evaluatedBy: incoming.evaluatedBy }
        : {}
      : survivor.evaluatedBy
        ? { evaluatedBy: survivor.evaluatedBy }
        : {})
  };
}

function hasStrongIdentifierConflict(a: CanonicalStudyRecord, b: CanonicalStudyRecord): boolean {
  const doiA = normalizeDoi(a.identifiers.doi ?? a.doi);
  const doiB = normalizeDoi(b.identifiers.doi ?? b.doi);
  if (doiA && doiB && doiA !== doiB) return true;

  const pmidA = normalizePmid(a.identifiers.pmid ?? a.pmid);
  const pmidB = normalizePmid(b.identifiers.pmid ?? b.pmid);
  if (pmidA && pmidB && pmidA !== pmidB) return true;

  const embaseA = normalizeEmbaseId(a.identifiers.embaseId);
  const embaseB = normalizeEmbaseId(b.identifiers.embaseId);
  if (embaseA && embaseB && embaseA !== embaseB) return true;

  return false;
}

function canMatchByTitleFallback(a: CanonicalStudyRecord, b: CanonicalStudyRecord): boolean {
  // Ne jamais fusionner un enregistrement de protocole de registre avec un article publié / revue
  if (
    (a.recordKind === 'trial_registry' && b.recordKind !== 'trial_registry') ||
    (b.recordKind === 'trial_registry' && a.recordKind !== 'trial_registry')
  ) {
    return false;
  }

  if (hasStrongIdentifierConflict(a, b)) {
    return false;
  }

  const normTitleA = normalizeTitleForDedup(a.title);
  const normTitleB = normalizeTitleForDedup(b.title);
  if (!normTitleA || normTitleA !== normTitleB) {
    return false;
  }

  const yearA = extractPubYear(a.pubDate);
  const yearB = extractPubYear(b.pubDate);
  const surnameA = extractFirstAuthorSurname(a.authors);
  const surnameB = extractFirstAuthorSurname(b.authors);

  // Règle stricte pour titres courts (< 25 caractères) : titre + nom du 1er auteur non vide + année exacte requis
  if (normTitleA.length < 25) {
    return (
      surnameA.length > 0 &&
      surnameB.length > 0 &&
      surnameA === surnameB &&
      yearA !== null &&
      yearB !== null &&
      yearA === yearB
    );
  }

  // Titre >= 25 caractères : année avec tolérance ±1 (Ahead of print)
  if (yearA !== null && yearB !== null) {
    return Math.abs(yearA - yearB) <= 1;
  }

  // Si au moins une année est absente : exiger la concordance du 1er auteur s'il est disponible des deux côtés
  if (surnameA && surnameB) {
    return surnameA === surnameB;
  }
  return true;
}

/**
 * Calcule les compteurs PRISMA 2020 exacts (brut par base, bases vs registres, doublons retirés, corpus unique).
 */
export function computeCorpusDeduplicationStats(
  uniqueRecords: readonly CanonicalStudyRecord[],
  importBatches?: readonly SourceImportBatch[]
): CorpusDeduplicationStats {
  const rawBySource = createEmptySourceCounts();
  let totalIdentifiedDatabases = 0;
  let totalIdentifiedRegisters = 0;

  if (importBatches && importBatches.length > 0) {
    for (const batch of importBatches) {
      rawBySource[batch.source] = (rawBySource[batch.source] ?? 0) + batch.rawRecordCount;
      const regs = Math.max(0, Math.min(batch.rawRecordCount, batch.registryRecordCount));
      totalIdentifiedRegisters += regs;
      totalIdentifiedDatabases += Math.max(0, batch.rawRecordCount - regs);
    }
  } else {
    for (const rec of uniqueRecords) {
      for (const src of rec.sources) {
        rawBySource[src] = (rawBySource[src] ?? 0) + 1;
      }
      if (rec.recordKind === 'trial_registry') {
        totalIdentifiedRegisters += rec.sources.length;
      } else {
        totalIdentifiedDatabases += rec.sources.length;
      }
    }
  }

  const totalIdentified = totalIdentifiedDatabases + totalIdentifiedRegisters;
  const uniqueCorpusCount = uniqueRecords.length;
  const duplicatesRemoved = Math.max(0, totalIdentified - uniqueCorpusCount);

  return {
    rawBySource,
    totalIdentifiedDatabases,
    totalIdentifiedRegisters,
    totalIdentified,
    duplicatesRemoved,
    uniqueCorpusCount
  };
}

/**
 * Déduplique et fusionne un lot entrant `incomingRecords` dans `existingRecords`
 * en appliquant la cascade DOI > PMID > Embase/Cochrane/Registre > Titre normalisé.
 */
export function deduplicateAndMergeCorpus(
  existingRecords: readonly CanonicalStudyRecord[],
  incomingRecords: readonly CanonicalStudyRecord[],
  importBatches?: readonly SourceImportBatch[]
): DeduplicationMergeResult {
  const mergedList: CanonicalStudyRecord[] = [];

  const doiIndex = new Map<string, number>();
  const pmidIndex = new Map<string, number>();
  const embaseIndex = new Map<string, number>();
  const cochraneIndex = new Map<string, number>();
  const registryIndex = new Map<string, number>();
  const titleIndex = new Map<string, number[]>();

  const registerIndices = (rec: CanonicalStudyRecord, idx: number) => {
    const doi = normalizeDoi(rec.identifiers.doi ?? rec.doi);
    if (doi && !doiIndex.has(doi)) doiIndex.set(doi, idx);

    const pmid = normalizePmid(rec.identifiers.pmid ?? rec.pmid);
    if (pmid && !pmidIndex.has(pmid)) pmidIndex.set(pmid, idx);

    const embaseId = normalizeEmbaseId(rec.identifiers.embaseId);
    if (embaseId && !embaseIndex.has(embaseId)) embaseIndex.set(embaseId, idx);

    const cochraneId = rec.identifiers.cochraneId?.trim().toUpperCase();
    if (cochraneId && !cochraneIndex.has(cochraneId)) cochraneIndex.set(cochraneId, idx);

    if (rec.recordKind === 'trial_registry') {
      for (const reg of rec.identifiers.registryIds ?? []) {
        const key = reg.trim().toUpperCase();
        if (key && !registryIndex.has(key)) {
          registryIndex.set(key, idx);
        }
      }
    }

    const normTitle = normalizeTitleForDedup(rec.title);
    if (normTitle) {
      const bucket = titleIndex.get(normTitle) ?? [];
      if (!bucket.includes(idx)) {
        bucket.push(idx);
        titleIndex.set(normTitle, bucket);
      }
    }
  };

  const findMatchingIndex = (candidate: CanonicalStudyRecord): number => {
    // 1. DOI normalisé
    const doi = normalizeDoi(candidate.identifiers.doi ?? candidate.doi);
    if (doi && doiIndex.has(doi)) {
      return doiIndex.get(doi)!;
    }

    // 2. PMID numérique exact
    const pmid = normalizePmid(candidate.identifiers.pmid ?? candidate.pmid);
    if (pmid && pmidIndex.has(pmid)) {
      return pmidIndex.get(pmid)!;
    }

    // 3. ID Embase / ID Cochrane / ID Registre (entre trial_registry uniquement)
    const embaseId = normalizeEmbaseId(candidate.identifiers.embaseId);
    if (embaseId && embaseIndex.has(embaseId)) {
      return embaseIndex.get(embaseId)!;
    }

    const cochraneId = candidate.identifiers.cochraneId?.trim().toUpperCase();
    if (cochraneId && cochraneIndex.has(cochraneId)) {
      return cochraneIndex.get(cochraneId)!;
    }

    if (candidate.recordKind === 'trial_registry') {
      for (const reg of candidate.identifiers.registryIds ?? []) {
        const key = reg.trim().toUpperCase();
        if (key && registryIndex.has(key)) {
          const matchedIdx = registryIndex.get(key)!;
          if (mergedList[matchedIdx]?.recordKind === 'trial_registry') {
            return matchedIdx;
          }
        }
      }
    }

    // 4. Repli titre normalisé (+ année ±1 si >= 25 car. ; + auteur + année exacte si < 25 car.)
    const normTitle = normalizeTitleForDedup(candidate.title);
    if (normTitle) {
      const candidates = titleIndex.get(normTitle) ?? [];
      for (const idx of candidates) {
        if (canMatchByTitleFallback(mergedList[idx], candidate)) {
          return idx;
        }
      }
    }

    return -1;
  };

  let mergedDuplicatesCount = 0;
  let addedRecordsCount = 0;

  const insertOrMerge = (record: CanonicalStudyRecord, countStats: boolean) => {
    const matchIdx = findMatchingIndex(record);
    if (matchIdx >= 0) {
      const updated = mergeStudyRecords(mergedList[matchIdx], record);
      mergedList[matchIdx] = updated;
      registerIndices(updated, matchIdx);
      if (countStats) mergedDuplicatesCount += 1;
    } else {
      const nextIdx = mergedList.length;
      mergedList.push(record);
      registerIndices(record, nextIdx);
      if (countStats) addedRecordsCount += 1;
    }
  };

  for (const existing of existingRecords) {
    insertOrMerge(existing, false);
  }
  for (const incoming of incomingRecords) {
    insertOrMerge(incoming, true);
  }

  const stats = computeCorpusDeduplicationStats(mergedList, importBatches);

  return {
    records: mergedList,
    stats,
    mergedDuplicatesCount,
    addedRecordsCount
  };
}

/**
 * Met à jour la liste des lots importés de manière idempotente :
 * - un rechargement PubMed remplace le lot PubMed précédent sans jamais le doubler ;
 * - un fichier RIS déjà importé (même `contentHash` non vide ou même `batchId`) est ignoré côté compteurs.
 */
export function mergeImportBatchIdempotent(
  existingBatches: readonly SourceImportBatch[],
  incomingBatch: SourceImportBatch
): { readonly batches: SourceImportBatch[]; readonly wasDuplicateBatch: boolean } {
  if (incomingBatch.source === 'pubmed') {
    const withoutPrevPubmed = existingBatches.filter((b) => b.source !== 'pubmed');
    return {
      batches: [incomingBatch, ...withoutPrevPubmed],
      wasDuplicateBatch: false
    };
  }

  const alreadyImported = existingBatches.some(
    (b) =>
      b.batchId === incomingBatch.batchId ||
      (Boolean(incomingBatch.contentHash) && b.contentHash === incomingBatch.contentHash)
  );
  if (alreadyImported) {
    return {
      batches: [...existingBatches],
      wasDuplicateBatch: true
    };
  }

  return {
    batches: [...existingBatches, incomingBatch],
    wasDuplicateBatch: false
  };
}
