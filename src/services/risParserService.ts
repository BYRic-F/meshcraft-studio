/**
 * Parseur RIS unifié multi-bases (Cochrane Reviews, Cochrane CENTRAL, Embase Elsevier, autres RIS)
 * vers le modèle canonique `CanonicalStudyRecord`.
 *
 * Conforme à `GEMINI.md` : TypeScript strict (zéro `any`), logique 100 % pure sans dépendance UI.
 */

import {
  BibliographicSource,
  CanonicalStudyRecord,
  StudyIdentifiers,
  StudyRecordKind,
  buildCanonicalRecordId,
  createEmptySourceCounts,
  extractFirstAuthorSurname,
  extractPubYear,
  normalizeDoi,
  normalizeEmbaseId,
  normalizePmid,
  normalizeTitleForDedup,
  resolvePreferredUrl
} from './studyRecordTypes';

export interface ParseRisOptions {
  readonly fileName?: string;
  readonly sourceOverride?: BibliographicSource;
}

export interface RisParseResult {
  readonly records: CanonicalStudyRecord[];
  readonly detectedSource: BibliographicSource;
  readonly rawRecordCount: number;
  readonly registryRecordCount: number;
  readonly warnings: readonly string[];
}

const REGISTRY_ID_PATTERN =
  /^(?:NCT\d{8}|ISRCTN\d{8}|ChiCTR\d{6,}|KCT\d{7,}|ACTRN\d{14}|DRKS\d{8}|EUCTR\d{4}-\d{6}-\d{2}|CTRI\/\d{4}\/\d+\/\d+|UMIN\d{9}|JPRN-[A-Za-z0-9]+|NL\d{4,}|NTR\d{4,}|PACTR\d{12,}|SLCTR\/\d{4}\/\d+|TCTR\d{11,}|IRCT\d+[A-Z0-9]*)$/i;

const REGISTRY_ID_GLOBAL_PATTERN =
  /\b(NCT\d{8}|ISRCTN\d{8}|ChiCTR\d{6,}|KCT\d{7,}|ACTRN\d{14}|DRKS\d{8}|EUCTR\d{4}-\d{6}-\d{2}|UMIN\d{9}|PROSPERO\s+(?:CRD)?\d{6,})\b/gi;

const HTML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

/**
 * Décode proprement les entités HTML (&amp;, &#39;, &#x2010;, etc.) et normalise les espaces/tirets Unicode parasites.
 */
export function cleanRisTextValue(raw: string): string {
  if (!raw) return '';
  let decoded = raw.replace(/&([a-z]+|#\d+|#x[0-9a-f]+);/gi, (full, entity: string) => {
    const low = entity.toLowerCase();
    if (low in HTML_NAMED_ENTITIES) {
      return HTML_NAMED_ENTITIES[low];
    }
    if (low.startsWith('#x')) {
      const codePoint = Number.parseInt(low.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : full;
    }
    if (low.startsWith('#')) {
      const codePoint = Number.parseInt(low.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : full;
    }
    return full;
  });

  decoded = decoded
    .replace(/[\u2028\u2029]/g, ' ')
    .replace(/[\u2009\u00A0]/g, ' ')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  return decoded;
}

function preprocessRisRawContent(rawContent: string): string {
  return rawContent
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, ' ');
}

interface RawRisEntry {
  readonly fields: Map<string, string[]>;
}

function parseRawRisBlocks(rawContent: string): RawRisEntry[] {
  const normalized = preprocessRisRawContent(rawContent);
  const lines = normalized.split('\n');
  const entries: RawRisEntry[] = [];
  const tagLineRegex = /^([A-Z0-9]{2})\s{1,2}-\s*(.*)$/;

  let currentFields: Map<string, string[]> | null = null;
  let lastTag: string | null = null;

  const finalizeCurrent = () => {
    if (currentFields && currentFields.size > 0) {
      entries.push({ fields: currentFields });
    }
    currentFields = null;
    lastTag = null;
  };

  for (const line of lines) {
    const match = tagLineRegex.exec(line);
    if (match) {
      const tag = match[1].toUpperCase();
      const rawVal = match[2];

      if (tag === 'TY') {
        if (currentFields && currentFields.size > 0) {
          finalizeCurrent();
        }
        currentFields = new Map<string, string[]>();
        currentFields.set('TY', [cleanRisTextValue(rawVal)]);
        lastTag = 'TY';
        continue;
      }

      // Ignorer tout préambule hors-RIS avant le premier TY
      if (!currentFields) {
        continue;
      }

      if (tag === 'ER') {
        finalizeCurrent();
        continue;
      }

      const existing = currentFields.get(tag) ?? [];
      const cleanedVal = cleanRisTextValue(rawVal);
      if (cleanedVal.length > 0) {
        existing.push(cleanedVal);
        currentFields.set(tag, existing);
      }
      lastTag = tag;
      continue;
    }

    // Lignes de continuation à l'intérieur d'une notice ouverte
    if (currentFields && lastTag && lastTag !== 'TY') {
      const trimmedContinuation = cleanRisTextValue(line);
      if (trimmedContinuation.length > 0) {
        const list = currentFields.get(lastTag);
        if (list && list.length > 0) {
          list[list.length - 1] = `${list[list.length - 1]} ${trimmedContinuation}`.trim();
        }
      }
    }
  }

  if (currentFields && currentFields.size > 0) {
    finalizeCurrent();
  }

  return entries;
}

function getAll(fields: Map<string, string[]>, ...tags: string[]): string[] {
  const values: string[] = [];
  for (const tag of tags) {
    const list = fields.get(tag);
    if (list) {
      for (const item of list) {
        if (item.trim().length > 0) {
          values.push(item.trim());
        }
      }
    }
  }
  return values;
}

function getFirst(fields: Map<string, string[]>, ...tags: string[]): string {
  for (const tag of tags) {
    const list = fields.get(tag);
    if (list && list.length > 0 && list[0].trim().length > 0) {
      return list[0].trim();
    }
  }
  return '';
}

function detectRecordSource(
  fields: Map<string, string[]>,
  sourceOverride?: BibliographicSource
): BibliographicSource {
  if (sourceOverride) return sourceOverride;

  const an = getFirst(fields, 'AN');
  const jfJo = getAll(fields, 'JF', 'JO', 'JA', 'T2').join(' ').toLowerCase();
  const doi = getFirst(fields, 'DO').toLowerCase();
  const ur = getAll(fields, 'UR', 'L2').join(' ').toLowerCase();
  const u2 = getFirst(fields, 'U2');
  const dbList = getAll(fields, 'DB').map((d) => d.toLowerCase());

  if (
    /^CD\d+/i.test(an) ||
    jfJo.includes('cochrane database of systematic reviews') ||
    doi.includes('14651858.cd')
  ) {
    return 'cochrane_reviews';
  }

  if (/^CN-\d+/i.test(an) || ur.includes('cochranelibrary.com/central')) {
    return 'cochrane_central';
  }

  // IMPORTANT : un export Embase porte souvent deux lignes DB (Embase + Medline) — il reste strictement 'embase'
  if (
    u2.length > 0 ||
    ur.includes('embase.com') ||
    dbList.some((db) => db.includes('embase'))
  ) {
    return 'embase';
  }

  return 'other_ris';
}

function extractC3Identifiers(c3Values: readonly string[]): {
  pmid?: string;
  embaseId?: string;
  registryIds: string[];
} {
  let pmid: string | undefined;
  let embaseId: string | undefined;
  const registryIds: string[] = [];
  const seenReg = new Set<string>();

  const pushReg = (val: string) => {
    const clean = val.trim().replace(/[.,;]+$/, '');
    if (clean && !seenReg.has(clean.toUpperCase())) {
      seenReg.add(clean.toUpperCase());
      registryIds.push(clean);
    }
  };

  for (const raw of c3Values) {
    const tokens = raw.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
    for (const token of tokens) {
      const pubmedMatch = /^PUBMED\s+(\d{5,10})$/i.exec(token);
      if (pubmedMatch && !pmid) {
        pmid = normalizePmid(pubmedMatch[1]);
        continue;
      }

      const embaseMatch = /^EMBASE\s+([Ll]?\d{6,15})$/i.exec(token);
      if (embaseMatch && !embaseId) {
        embaseId = normalizeEmbaseId(embaseMatch[1]);
        continue;
      }

      const regMatch = /^(?:ICTRP|CT\.GOV|CLINICALTRIALS\.GOV|ISRCTN)\s+([A-Za-z0-9/-]+)$/i.exec(token);
      if (regMatch) {
        pushReg(regMatch[1]);
        continue;
      }

      if (REGISTRY_ID_PATTERN.test(token)) {
        pushReg(token);
      }
    }
  }

  return { pmid, embaseId, registryIds };
}

function extractRegistryIdsFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(REGISTRY_ID_GLOBAL_PATTERN) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const clean = m.replace(/\s+/g, ' ').trim();
    if (!seen.has(clean.toUpperCase())) {
      seen.add(clean.toUpperCase());
      unique.push(clean);
    }
  }
  return unique;
}

function deriveRegistryDisplayName(url: string): string {
  const low = url.toLowerCase();
  if (low.includes('trialsearch.who.int')) return 'WHO ICTRP';
  if (low.includes('clinicaltrials.gov')) return 'ClinicalTrials.gov';
  if (low.includes('isrctn.com')) return 'ISRCTN';
  if (low.includes('chictr.org')) return 'ChiCTR';
  if (low.includes('euclinicaltrials.eu') || low.includes('clinicaltrialsregister.eu')) {
    return 'EU Clinical Trials Register';
  }
  return 'Trial Registry';
}

function resolveRecordKindAndPubTypes(
  m3Values: readonly string[],
  source: BibliographicSource,
  ty: string
): { readonly recordKind: StudyRecordKind; readonly publicationTypes: string[] } {
  const m3Joined = m3Values.join(' ').trim();
  const m3Lower = m3Joined.toLowerCase();

  if (m3Lower.includes('trial registry record')) {
    return {
      recordKind: 'trial_registry',
      publicationTypes: ['Trial Registry Record']
    };
  }

  if (source === 'cochrane_reviews') {
    return {
      recordKind: 'review',
      publicationTypes: ['Systematic Review']
    };
  }

  if (/\breview\b/.test(m3Lower)) {
    return {
      recordKind: 'review',
      publicationTypes: [m3Joined || 'Review']
    };
  }

  if (
    m3Lower.includes('editorial') ||
    m3Lower.includes('letter') ||
    m3Lower.includes('comment') ||
    m3Lower.includes('conference abstract') ||
    m3Lower.includes('note') ||
    m3Lower.includes('erratum')
  ) {
    return {
      recordKind: 'other',
      publicationTypes: [m3Joined]
    };
  }

  if (m3Lower.includes('article') || ty.toUpperCase() === 'JOUR') {
    return {
      recordKind: 'article',
      publicationTypes: m3Joined ? [m3Joined] : ['Journal Article']
    };
  }

  return {
    recordKind: 'other',
    publicationTypes: m3Joined ? [m3Joined] : []
  };
}

/**
 * Parse le contenu texte d'un export `.ris` (Cochrane Reviews, Cochrane CENTRAL, Embase ou RIS générique)
 * et retourne des notices unifiées `CanonicalStudyRecord[]`.
 */
export function parseRisContent(
  rawContent: string,
  options: ParseRisOptions = {}
): RisParseResult {
  const warnings: string[] = [];
  if (!rawContent || !rawContent.trim()) {
    return {
      records: [],
      detectedSource: options.sourceOverride ?? 'other_ris',
      rawRecordCount: 0,
      registryRecordCount: 0,
      warnings: ['Le fichier RIS est vide.']
    };
  }

  const rawEntries = parseRawRisBlocks(rawContent);
  if (rawEntries.length === 0) {
    return {
      records: [],
      detectedSource: options.sourceOverride ?? 'other_ris',
      rawRecordCount: 0,
      registryRecordCount: 0,
      warnings: ['Aucune notice RIS valide (TY  - ... ER  -) détectée.']
    };
  }

  const records: CanonicalStudyRecord[] = [];
  const sourceVotes = createEmptySourceCounts();
  let registryRecordCount = 0;

  for (const entry of rawEntries) {
    const { fields } = entry;
    const ty = getFirst(fields, 'TY') || 'JOUR';
    const detectedRecordSource = detectRecordSource(fields, options.sourceOverride);
    sourceVotes[detectedRecordSource] += 1;

    const m3Values = getAll(fields, 'M3');
    const { recordKind, publicationTypes } = resolveRecordKindAndPubTypes(
      m3Values,
      detectedRecordSource,
      ty
    );
    if (recordKind === 'trial_registry') {
      registryRecordCount += 1;
    }

    const title = getFirst(fields, 'TI', 'T1', 'CT', 'BT');
    if (!title) {
      warnings.push('Une notice RIS sans titre a été ignorée.');
      continue;
    }

    // Résumé : nettoyer "Abstract - " en tête (Cochrane Reviews) tout en conservant l'intégralité pour l'UI
    const rawAbstract = getAll(fields, 'AB', 'N2').join('\n\n').trim();
    const abstract = rawAbstract.replace(/^Abstract\s*-\s*/i, '').trim();

    // Identifiants croisés
    const doi =
      normalizeDoi(getFirst(fields, 'DO')) ??
      normalizeDoi(getFirst(fields, 'L2'));
    const c5Pmid = normalizePmid(getFirst(fields, 'C5'));
    const u2Raw = getFirst(fields, 'U2');
    const u2EmbaseId = normalizeEmbaseId(u2Raw);
    const an = getFirst(fields, 'AN');
    const cochraneId = /^(?:CD\d+|CN-\d+)$/i.test(an) ? an.toUpperCase() : undefined;
    const c3Parsed = extractC3Identifiers(getAll(fields, 'C3'));

    const pmid = c5Pmid ?? c3Parsed.pmid;
    const embaseId = u2EmbaseId ?? c3Parsed.embaseId;
    const embasePui = u2Raw ? u2Raw.trim() : undefined;

    // Auteurs (sur trial_registry CENTRAL, AU contient souvent un identifiant de registre suivi d'une virgule)
    const rawAuthors = getAll(fields, 'AU', 'A1');
    const cleanAuthors: string[] = [];
    const registryIdsSet = new Set<string>(c3Parsed.registryIds);

    for (const au of rawAuthors) {
      const stripped = au.replace(/,+\s*$/, '').trim();
      if (!stripped) continue;
      if (recordKind === 'trial_registry' && REGISTRY_ID_PATTERN.test(stripped)) {
        registryIdsSet.add(stripped);
        continue;
      }
      cleanAuthors.push(stripped);
    }

    for (const regFromText of extractRegistryIdsFromText(abstract)) {
      registryIdsSet.add(regFromText);
    }

    const registryIds = Array.from(registryIdsSet);
    const authors = cleanAuthors.join(', ');

    // Revue / Source publiante (JF > JO > T2 > JA ; si URL dans JA sur CENTRAL trial_registry, la basculer dans fallbackUrl)
    const rawJournalCandidates = getAll(fields, 'JF', 'JO', 'T2', 'JA');
    let journalName = '';
    let journalUrlFromJa = '';
    for (const cand of rawJournalCandidates) {
      if (/^https?:\/\//i.test(cand)) {
        if (!journalUrlFromJa) journalUrlFromJa = cand;
      } else if (!journalName) {
        journalName = cand;
      }
    }
    if (!journalName && journalUrlFromJa) {
      journalName = deriveRegistryDisplayName(journalUrlFromJa);
    }
    if (!journalName && recordKind === 'trial_registry') {
      journalName = 'Trial Registry';
    }

    // Année de publication
    const rawYearInput = getFirst(fields, 'PY', 'Y1', 'DA');
    const parsedYear = extractPubYear(rawYearInput);
    const pubDate = parsedYear !== null ? String(parsedYear) : rawYearInput;

    // Langue & mots-clés dédupliqués (M1 et LK sont volontairement ignorés)
    const language = getFirst(fields, 'LA') || undefined;
    const rawKeywords = getAll(fields, 'KW');
    const meshHeadings: string[] = [];
    const seenKw = new Set<string>();
    for (const kw of rawKeywords) {
      const low = kw.toLowerCase();
      if (!seenKw.has(low)) {
        seenKw.add(low);
        meshHeadings.push(kw);
      }
    }

    const identifiers: StudyIdentifiers = {
      ...(pmid ? { pmid } : {}),
      ...(doi ? { doi } : {}),
      ...(embaseId ? { embaseId } : {}),
      ...(embasePui ? { embasePui } : {}),
      ...(cochraneId ? { cochraneId } : {}),
      ...(registryIds.length > 0 ? { registryIds } : {})
    };

    const rawUrl = getFirst(fields, 'UR') || journalUrlFromJa || getFirst(fields, 'L2');
    const url = resolvePreferredUrl(identifiers, rawUrl);

    const normTitle = normalizeTitleForDedup(title);
    const firstSurname = extractFirstAuthorSurname(authors);
    const id = buildCanonicalRecordId(identifiers, normTitle, firstSurname, parsedYear);

    records.push({
      id,
      pmid: pmid ?? '',
      ...(doi ? { doi } : {}),
      identifiers,
      sources: [detectedRecordSource],
      recordKind,
      title,
      authors,
      source: journalName,
      pubDate,
      abstract,
      meshHeadings,
      publicationTypes,
      ...(language ? { language } : {}),
      url,
      status: 'pending'
    });
  }

  let detectedSource: BibliographicSource = options.sourceOverride ?? 'other_ris';
  if (!options.sourceOverride) {
    let bestCount = -1;
    (Object.entries(sourceVotes) as Array<[BibliographicSource, number]>).forEach(([src, count]) => {
      if (count > bestCount && count > 0) {
        bestCount = count;
        detectedSource = src;
      }
    });
  }

  return {
    records,
    detectedSource,
    rawRecordCount: records.length,
    registryRecordCount,
    warnings
  };
}
