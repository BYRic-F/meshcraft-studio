import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CanonicalStudyRecord,
  SourceImportBatch,
  normalizeTitleForDedup
} from '../../src/services/studyRecordTypes';
import { parseRisContent } from '../../src/services/risParserService';
import { deduplicateAndMergeCorpus } from '../../src/services/deduplicationService';
import { normalizePubMedToCanonical } from '../../src/services/agentScreener';

const FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'ris');

function makeRecord(overrides: Partial<CanonicalStudyRecord>): CanonicalStudyRecord {
  return {
    id: overrides.id ?? 'fp:default',
    pmid: overrides.pmid ?? '',
    doi: overrides.doi,
    identifiers: overrides.identifiers ?? {},
    sources: overrides.sources ?? ['pubmed'],
    recordKind: overrides.recordKind ?? 'article',
    title: overrides.title ?? 'Default Clinical Trial Title for Testing Purposes',
    authors: overrides.authors ?? 'Smith J, Doe A',
    source: overrides.source ?? 'Journal of Clinical Medicine',
    pubDate: overrides.pubDate ?? '2025',
    abstract: overrides.abstract ?? 'Detailed clinical abstract text.',
    meshHeadings: overrides.meshHeadings ?? [],
    publicationTypes: overrides.publicationTypes ?? ['Journal Article'],
    url: overrides.url ?? '',
    status: overrides.status ?? 'pending',
    exclusionReason: overrides.exclusionReason,
    evidenceSnippet: overrides.evidenceSnippet,
    evaluatedBy: overrides.evaluatedBy
  };
}

describe('Déduplication multi-bases par fusion (Survivorship) & normalisation', () => {
  it('normalizeTitleForDedup retire les crochets [...] PubMed et translittère ı, ø, æ et U+2010', () => {
    expect(normalizeTitleForDedup('[Non-specific chronic low back pain in adults].')).toBe(
      'non specific chronic low back pain in adults'
    );
    expect(
      normalizeTitleForDedup(
        'Quality of life in patıents with chronıc non‐specific low back pain (Børsheim)'
      )
    ).toBe('quality of life in patients with chronic non specific low back pain borsheim');
  });

  it('fusionne PubMed + Embase via C5 (PMID) et DOI en conservant survivor.id et les décisions existantes', () => {
    const embaseRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'records.ris'), 'utf8');
    const embaseParsed = parseRisContent(embaseRaw, { fileName: 'records.ris' });
    const embaseRec0 = embaseParsed.records[0]; // PMID 42966026, DOI 10.1016/j.physio.2026.102370

    const pubmedExisting = normalizePubMedToCanonical({
      pmid: '42966026',
      doi: '10.1016/j.physio.2026.102370',
      title: embaseRec0.title,
      authors: 'Zhu Z, Chiarotto A',
      source: 'Physiotherapy',
      pubDate: '2026',
      abstract: '' // PubMed sans résumé -> le résumé Embase doit survivre
    });
    const decidedExisting: CanonicalStudyRecord = {
      ...pubmedExisting,
      status: 'included',
      evidenceSnippet: 'Validé manuellement',
      evaluatedBy: 'manual'
    };

    const batches: SourceImportBatch[] = [
      {
        batchId: 'b-pubmed',
        source: 'pubmed',
        importedAt: 1000,
        rawRecordCount: 1,
        registryRecordCount: 0
      },
      {
        batchId: 'b-embase',
        source: 'embase',
        fileName: 'records.ris',
        importedAt: 2000,
        rawRecordCount: embaseParsed.rawRecordCount,
        registryRecordCount: 0
      }
    ];

    const res = deduplicateAndMergeCorpus([decidedExisting], embaseParsed.records, batches);

    expect(res.mergedDuplicatesCount).toBe(1);
    expect(res.addedRecordsCount).toBe(5);
    expect(res.records).toHaveLength(6);

    const merged0 = res.records[0];
    expect(merged0.id).toBe('pmid:42966026');
    expect(merged0.sources).toEqual(['pubmed', 'embase']);
    expect(merged0.identifiers.pmid).toBe('42966026');
    expect(merged0.identifiers.embaseId).toBe('2051170234');
    expect(merged0.identifiers.embasePui).toBe('L2051170234');
    expect(merged0.abstract).toContain('GLA:D');
    expect(merged0.status).toBe('included');
    expect(merged0.evaluatedBy).toBe('manual');

    expect(res.stats.totalIdentifiedDatabases).toBe(7);
    expect(res.stats.totalIdentifiedRegisters).toBe(0);
    expect(res.stats.duplicatesRemoved).toBe(1);
    expect(res.stats.uniqueCorpusCount).toBe(6);
  });

  it('fusionne PubMed + CENTRAL via C3 (PUBMED 21508915 sans DOI) et via embaseId normalisé', () => {
    const centralRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'citation-export (1).ris'), 'utf8');
    const centralParsed = parseRisContent(centralRaw, { fileName: 'citation-export (1).ris' });

    const pubmed21508915 = normalizePubMedToCanonical({
      pmid: '21508915',
      title: 'Quality of life improved by multidisciplinary back school program',
      authors: 'Morone G, Paolucci T',
      source: 'Eur J Phys Rehabil Med',
      pubDate: '2011',
      abstract: 'Original PubMed abstract'
    });

    const embaseNoPmid = makeRecord({
      id: 'embase:623793174',
      identifiers: { embaseId: '623793174', embasePui: 'L623793174' },
      sources: ['embase'],
      title: 'Electroacupuncture as a complement to usual care (alias sans DOI)',
      authors: 'Heo I',
      pubDate: '2018'
    });

    const res = deduplicateAndMergeCorpus([pubmed21508915, embaseNoPmid], centralParsed.records);

    // 2 doublons : 21508915 (via C3 PUBMED) et 623793174 (via C3 EMBASE)
    expect(res.mergedDuplicatesCount).toBe(2);
    expect(res.records).toHaveLength(7);

    const moroneMerged = res.records.find((r) => r.identifiers.pmid === '21508915');
    expect(moroneMerged?.sources).toEqual(['pubmed', 'cochrane_central']);
    expect(moroneMerged?.identifiers.cochraneId).toBe('CN-00896162');

    const heoMerged = res.records.find((r) => r.identifiers.embaseId === '623793174');
    expect(heoMerged?.id).toBe('embase:623793174');
    expect(heoMerged?.sources).toEqual(['embase', 'cochrane_central']);
    expect(heoMerged?.identifiers.pmid).toBe('29773696');
  });

  it('fusionne par titre normalisé sans ID (U+0131 + crochets PubMed + tolérance année ±1 Ahead of print)', () => {
    const pubmedBracketed = makeRecord({
      id: 'fp:pubmed1',
      identifiers: {},
      sources: ['pubmed'],
      title: '[Quality of life improved by multidisciplinary back school program in patients with chronic non-specific low back pain].',
      authors: 'Morone G',
      pubDate: '2026',
      abstract: ''
    });

    const risVariant = makeRecord({
      id: 'fp:ris1',
      identifiers: {},
      sources: ['embase'],
      title: 'Quality of life improved by multidisciplinary back school program in patıents with chronıc non‐specific low back pain',
      authors: 'Morone, G.',
      pubDate: '2027',
      abstract: 'Full structured abstract from Embase Ahead of print.'
    });

    const res = deduplicateAndMergeCorpus([pubmedBracketed], [risVariant]);
    expect(res.mergedDuplicatesCount).toBe(1);
    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('fp:pubmed1');
    expect(res.records[0].sources).toEqual(['pubmed', 'embase']);
    expect(res.records[0].abstract).toContain('Full structured abstract');
  });

  it('titre court (< 25 car.) : fusionne UNIQUEMENT si titre + nom de famille du 1er auteur + année exacte concordent', () => {
    const baseShort = makeRecord({
      id: 'fp:short1',
      identifiers: {},
      sources: ['pubmed'],
      title: 'Back pain trial',
      authors: 'Dupont J',
      pubDate: '2024'
    });

    const sameAllThree = makeRecord({
      id: 'fp:short2',
      identifiers: {},
      sources: ['embase'],
      title: 'Back pain trial',
      authors: 'Dupont, Jean',
      pubDate: '2024'
    });

    const diffAuthor = makeRecord({
      id: 'fp:short3',
      identifiers: {},
      sources: ['embase'],
      title: 'Back pain trial',
      authors: 'Martin P',
      pubDate: '2024'
    });

    const diffYear = makeRecord({
      id: 'fp:short4',
      identifiers: {},
      sources: ['cochrane_central'],
      title: 'Back pain trial',
      authors: 'Dupont J',
      pubDate: '2025'
    });

    const res = deduplicateAndMergeCorpus([baseShort], [sameAllThree, diffAuthor, diffYear]);
    expect(res.mergedDuplicatesCount).toBe(1);
    expect(res.addedRecordsCount).toBe(2);
    expect(res.records).toHaveLength(3);
    expect(res.records[0].sources).toEqual(['pubmed', 'embase']);
  });

  it('ne fusionne JAMAIS un trial_registry avec un article publié ni ne fusionne deux DOIs distincts', () => {
    const centralRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'citation-export (1).ris'), 'utf8');
    const centralParsed = parseRisContent(centralRaw, { fileName: 'citation-export (1).ris' });
    // CN-01644482 (Journal article, mentions NCT01966250) et CN-01874495 (Trial registry record)
    const cn1644482 = centralParsed.records.find((r) => r.identifiers.cochraneId === 'CN-01644482')!;
    const cn1874495 = centralParsed.records.find((r) => r.identifiers.cochraneId === 'CN-01874495')!;

    // Même si un essai publié a le même titre qu'un registre, ils doivent rester séparés
    const fakeArticleSameTitle = makeRecord({
      id: 'pmid:99999999',
      pmid: '99999999',
      identifiers: { pmid: '99999999', registryIds: ['KCT0001939'] },
      sources: ['pubmed'],
      recordKind: 'article',
      title: cn1874495.title,
      authors: 'Kim H',
      pubDate: '2016'
    });

    const res = deduplicateAndMergeCorpus([cn1644482, fakeArticleSameTitle], [cn1874495]);
    expect(res.mergedDuplicatesCount).toBe(0);
    expect(res.records).toHaveLength(3);

    // Conflit de DOI explicite même avec titre identique : pas de fusion
    const doiA = makeRecord({
      id: 'doi:10.1000/aaa',
      doi: '10.1000/aaa',
      identifiers: { doi: '10.1000/aaa' },
      title: 'Multicenter randomized trial of physical therapy for chronic pain',
      pubDate: '2025'
    });
    const doiB = makeRecord({
      id: 'doi:10.1000/bbb',
      doi: '10.1000/bbb',
      identifiers: { doi: '10.1000/bbb' },
      title: 'Multicenter randomized trial of physical therapy for chronic pain',
      pubDate: '2025'
    });
    const resConflict = deduplicateAndMergeCorpus([doiA], [doiB]);
    expect(resConflict.mergedDuplicatesCount).toBe(0);
    expect(resConflict.records).toHaveLength(2);
  });

  it('calcule exactement la ventilation PRISMA 2020 Bases vs Registres sur la combinaison des 3 fixtures', () => {
    const reviews = parseRisContent(readFixtureText('citation-export.ris'), {
      fileName: 'citation-export.ris'
    });
    const central = parseRisContent(readFixtureText('citation-export (1).ris'), {
      fileName: 'citation-export (1).ris'
    });
    const embase = parseRisContent(readFixtureText('records.ris'), {
      fileName: 'records.ris'
    });

    const batches: SourceImportBatch[] = [
      {
        batchId: 'b-rev',
        source: reviews.detectedSource,
        fileName: 'citation-export.ris',
        importedAt: 1,
        rawRecordCount: reviews.rawRecordCount,
        registryRecordCount: reviews.registryRecordCount
      },
      {
        batchId: 'b-cen',
        source: central.detectedSource,
        fileName: 'citation-export (1).ris',
        importedAt: 2,
        rawRecordCount: central.rawRecordCount,
        registryRecordCount: central.registryRecordCount
      },
      {
        batchId: 'b-emb',
        source: embase.detectedSource,
        fileName: 'records.ris',
        importedAt: 3,
        rawRecordCount: embase.rawRecordCount,
        registryRecordCount: embase.registryRecordCount
      }
    ];

    const res = deduplicateAndMergeCorpus(
      [],
      [...reviews.records, ...central.records, ...embase.records],
      batches
    );

    expect(res.stats.rawBySource.cochrane_reviews).toBe(6);
    expect(res.stats.rawBySource.cochrane_central).toBe(7);
    expect(res.stats.rawBySource.embase).toBe(6);
    expect(res.stats.rawBySource.pubmed).toBe(0);
    expect(res.stats.totalIdentifiedDatabases).toBe(16); // 6 reviews + 4 central articles + 6 embase
    expect(res.stats.totalIdentifiedRegisters).toBe(3);  // 3 central trial_registry
    expect(res.stats.totalIdentified).toBe(19);
    expect(res.stats.uniqueCorpusCount).toBe(19);
    expect(res.stats.duplicatesRemoved).toBe(0);
  });
});

function readFixtureText(fileName: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, fileName), 'utf8');
}
