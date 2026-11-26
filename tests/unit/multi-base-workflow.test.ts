import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseRisContent } from '../../src/services/risParserService';
import {
  deduplicateAndMergeCorpus,
  mergeImportBatchIdempotent
} from '../../src/services/deduplicationService';
import {
  CanonicalStudyRecord,
  SourceImportBatch,
  computeContentFingerprint,
  getArticleKey
} from '../../src/services/studyRecordTypes';
import {
  normalizePubMedToCanonical,
  runAgentScreeningDeep
} from '../../src/services/agentScreener';
import {
  aiEvaluateBatchRoB2,
  clearAiScreeningCache,
  saveAiConfig,
  selectUnassessedRobBatch
} from '../../src/services/localAiService';
import {
  applyRayyanDecisions,
  buildReadingMatrixRows,
  exportToRayyanCsv,
  exportToRayyanRis,
  parseRayyanImport
} from '../../src/services/rayyanAndMatrixService';
import {
  generatePrismaReportText,
  generatePrismaSummaryData
} from '../../src/services/prismaReport';

const FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'ris');

function readFixture(fileName: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, fileName), 'utf8');
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    }
  };
}

describe('Workflow multi-bases Lot 2 (hors-ligne : LLM index de lot, RoB N/A registres, idempotence, Rayyan, PRISMA)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    clearAiScreeningCache();
    saveAiConfig({
      provider: 'openai',
      routingMode: 'smart',
      rateLimitMode: 'payg',
      openaiApiKey: 'sk-test-lot2'
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAiScreeningCache();
  });

  it('Screening IA par index court de lot ("1".."N") sans casse sur IDs opaques (doi:/embase:/fp:/trial_registry)', async () => {
    const reviews = parseRisContent(readFixture('citation-export.ris'), {
      fileName: 'citation-export.ris'
    });
    const central = parseRisContent(readFixture('citation-export (1).ris'), {
      fileName: 'citation-export (1).ris'
    });

    const cd4057 = reviews.records[0]; // id = doi:10.1002/14651858.cd004057.pub3 (sans PMID)
    const cnRegistry = central.records.find((r) => r.recordKind === 'trial_registry')!; // CN-02583478
    const fpRecord: CanonicalStudyRecord = {
      id: 'fp:abc12345def67890',
      pmid: '',
      identifiers: {},
      sources: ['other_ris'],
      recordKind: 'article',
      title: 'Patient education trial without DOI or PMID',
      authors: 'Durand P',
      source: 'Clin Rehabil',
      pubDate: '2025',
      abstract: 'Randomized trial evaluating therapeutic patient education in chronic low back pain.',
      meshHeadings: [],
      publicationTypes: ['Journal Article'],
      url: '',
      status: 'pending'
    };
    const pubmedRecord = normalizePubMedToCanonical({
      pmid: '29773696',
      title: 'Electroacupuncture in chronic back pain',
      authors: 'Heo I',
      source: 'BMJ Open',
      pubDate: '2018',
      abstract: 'Pilot randomized controlled trial on non-acute low back pain.'
    });

    const corpus = [cd4057, cnRegistry, fpRecord, pubmedRecord];
    let capturedPrompt = '';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        capturedPrompt = body.messages?.map((m) => m.content || '').join('\n') || '';
        // Le LLM renvoie uniquement les index courts "1".."4" dans "pmid"
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      pmid: '1',
                      status: 'included',
                      evidenceSnippet: 'Revue Cochrane pertinente sur l’éducation thérapeutique.'
                    },
                    {
                      pmid: '2',
                      status: 'excluded',
                      exclusionCategory: 'study_design',
                      evidenceSnippet: 'Protocole de registre sans résultats publiés.'
                    },
                    {
                      pmid: '3',
                      status: 'maybe',
                      evidenceSnippet: 'Résultats partiels à vérifier sur texte intégral.'
                    },
                    {
                      pmid: '4',
                      status: 'included',
                      evidenceSnippet: 'Essai contrôlé randomisé éligible.'
                    }
                  ])
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );

    const report = await runAgentScreeningDeep(corpus, {
      p: 'Adultes avec lombalgie chronique',
      i: 'Éducation thérapeutique',
      c: '',
      o: 'Douleur et qualité de vie'
    });

    expect(capturedPrompt).toContain('ID_LOT: "1"');
    expect(capturedPrompt).toContain('ID_LOT: "4"');
    expect(report.totalScreened).toBe(4);
    expect(report.totalIncluded).toBe(2);
    expect(report.totalExcluded).toBe(1);
    expect(report.totalMaybe).toBe(1);

    expect(report.screenedArticles[0].id).toBe(cd4057.id);
    expect(report.screenedArticles[0].status).toBe('included');
    expect(report.screenedArticles[1].id).toBe(cnRegistry.id);
    expect(report.screenedArticles[1].status).toBe('excluded');
    expect(report.screenedArticles[2].id).toBe('fp:abc12345def67890');
    expect(report.screenedArticles[2].status).toBe('maybe');
    expect(report.screenedArticles[3].id).toBe('pmid:29773696');
    expect(report.screenedArticles[3].status).toBe('included');
  });

  it('RoB 2 : exclut automatiquement les trial_registry (N/A) et évalue les IDs opaques via index court "1".."N"', async () => {
    const reviews = parseRisContent(readFixture('citation-export.ris'), {
      fileName: 'citation-export.ris'
    });
    const central = parseRisContent(readFixture('citation-export (1).ris'), {
      fileName: 'citation-export (1).ris'
    });
    const embase = parseRisContent(readFixture('records.ris'), {
      fileName: 'records.ris'
    });

    // CN-01874495 est un Trial registry record dont le titre contient "Randomized Controlled Clinical Trial"
    const registryWithRctTitle = central.records.find(
      (r) => r.identifiers.cochraneId === 'CN-01874495'
    )!;
    const cochraneReview = reviews.records[0]; // id = doi:10.1002/14651858.cd004057.pub3
    const embaseStudy = embase.records[0];     // id = pmid:42966026

    const scoped = [
      { ...registryWithRctTitle, status: 'included' as const },
      { ...cochraneReview, status: 'included' as const },
      { ...embaseStudy, status: 'included' as const }
    ];

    const eligibleForRob = selectUnassessedRobBatch(scoped, {});
    expect(eligibleForRob).toHaveLength(2);
    expect(eligibleForRob.some((a) => a.id === registryWithRctTitle.id)).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      pmid: '1',
                      studyDesign: 'review',
                      d1: 'low',
                      d2: 'low',
                      d3: 'moderate',
                      d4: 'low',
                      d5: 'low',
                      justification: 'Revue systématique Cochrane avec méthode explicite.'
                    },
                    {
                      pmid: '2',
                      studyDesign: 'observational',
                      d1: 'moderate',
                      d2: 'moderate',
                      d3: 'low',
                      d4: 'low',
                      d5: 'moderate',
                      justification: 'Cohorte observationnelle prospective bien décrite.'
                    }
                  ])
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const robMap = await aiEvaluateBatchRoB2(eligibleForRob);
    expect(robMap.size).toBe(2);
    expect(robMap.get(cochraneReview.id)?.overall).toBe('moderate');
    expect(robMap.get(cochraneReview.id)?.recordId).toBe(cochraneReview.id);
    expect(robMap.get(embaseStudy.id)?.studyDesign).toBe('observational');

    // Vérifie la matrice de lecture : le trial_registry apparaît N/A sans jamais bloquer
    const robRecord: Record<string, (typeof robMap extends Map<string, infer V> ? V : never)> = {};
    for (const [k, v] of robMap.entries()) {
      robRecord[k] = v;
    }
    const matrix = buildReadingMatrixRows(scoped, robRecord);
    expect(matrix).toHaveLength(3);
    expect(matrix[0].riskOfBiasOverall).toBe('na');
    expect(matrix[0].identifierLabel).toBe('CENTRAL: CN-01874495');
    expect(matrix[1].riskOfBiasOverall).toBe('moderate');
    expect(matrix[1].sourcesLabel).toBe('Cochrane Reviews');
  });

  it('Idempotence & fusion non destructive : réimporter records.ris est idempotent et PubMed fusionne sans écraser les RIS', () => {
    const embaseText = readFixture('records.ris');
    const embaseParsed = parseRisContent(embaseText, { fileName: 'records.ris' });
    const embaseHash = computeContentFingerprint(embaseText);

    const embaseBatch: SourceImportBatch = {
      batchId: `ris:embase:${embaseHash}`,
      source: 'embase',
      fileName: 'records.ris',
      contentHash: embaseHash,
      importedAt: 1000,
      rawRecordCount: embaseParsed.rawRecordCount,
      registryRecordCount: embaseParsed.registryRecordCount
    };

    // 1er import
    const firstBatchMerge = mergeImportBatchIdempotent([], embaseBatch);
    expect(firstBatchMerge.wasDuplicateBatch).toBe(false);
    const afterFirstImport = deduplicateAndMergeCorpus([], embaseParsed.records, firstBatchMerge.batches);
    expect(afterFirstImport.records).toHaveLength(6);

    // 2e import du même fichier
    const secondBatchMerge = mergeImportBatchIdempotent(firstBatchMerge.batches, {
      ...embaseBatch,
      importedAt: 2000
    });
    expect(secondBatchMerge.wasDuplicateBatch).toBe(true);
    expect(secondBatchMerge.batches).toHaveLength(1);

    // Chargement PubMed ultérieur (contenant 1 doublon 42966026 + 1 notice PubMed inédite)
    const pubmedRecords = [
      normalizePubMedToCanonical({
        pmid: '42966026',
        doi: '10.1016/j.physio.2026.102370',
        title: embaseParsed.records[0].title,
        authors: 'Zhu Z',
        source: 'Physiotherapy',
        pubDate: '2026',
        abstract: ''
      }),
      normalizePubMedToCanonical({
        pmid: '99887766',
        title: 'Unique PubMed study on low back pain',
        authors: 'Martin L',
        source: 'Spine',
        pubDate: '2025',
        abstract: 'Randomized study.'
      })
    ];
    const pubmedBatch: SourceImportBatch = {
      batchId: 'pubmed:q1',
      source: 'pubmed',
      importedAt: 3000,
      rawRecordCount: pubmedRecords.length,
      registryRecordCount: 0
    };
    const batchesWithPubmed = mergeImportBatchIdempotent(secondBatchMerge.batches, pubmedBatch).batches;
    const afterPubmed = deduplicateAndMergeCorpus(
      afterFirstImport.records,
      pubmedRecords,
      batchesWithPubmed
    );

    expect(afterPubmed.records).toHaveLength(7); // 6 Embase + 1 PubMed unique
    expect(afterPubmed.stats.rawBySource.pubmed).toBe(2);
    expect(afterPubmed.stats.rawBySource.embase).toBe(6);
    expect(afterPubmed.stats.duplicatesRemoved).toBe(1);
    expect(afterPubmed.stats.uniqueCorpusCount).toBe(7);

    // PRISMA 2020 + texte Méthodes sans "(estimation)"
    const prismaSummary = generatePrismaSummaryData(
      { count: 2 },
      [{ picoType: 'P' }],
      undefined,
      afterPubmed.records,
      afterPubmed.stats
    );
    expect(prismaSummary.identification.embaseEstimatedHits).toBe(6);
    expect(prismaSummary.identification.duplicatesRemoved).toBe(1);

    const reportText = generatePrismaReportText(
      '("Low Back Pain"[Mesh])',
      {
        identifiedTotal: prismaSummary.identification.totalIdentified,
        pubmedCount: prismaSummary.identification.pubmedHits,
        embaseCount: prismaSummary.identification.embaseEstimatedHits,
        duplicatesRemoved: prismaSummary.identification.duplicatesRemoved,
        screened: 0,
        excludedScreening: 0,
        fullTextAssessed: 0,
        excludedFullText: 0,
        includedFinal: 0
      }
    );
    expect(reportText).not.toContain('(estimation)');
    expect(reportText).toContain('Embase (Elsevier) : 6');
  });

  it('Aller-retour Rayyan (.ris et .csv) sur notices multi-bases avec et sans PMID', () => {
    const reviews = parseRisContent(readFixture('citation-export.ris'), {
      fileName: 'citation-export.ris'
    });
    const embase = parseRisContent(readFixture('records.ris'), {
      fileName: 'records.ris'
    });

    const cochraneNoPmid = reviews.records[0]; // doi:10.1002/14651858.cd004057.pub3, pmid=''
    const embaseWithPmid = embase.records[0];  // pmid:42966026
    const cohort = [cochraneNoPmid, embaseWithPmid];

    const exportedRis = exportToRayyanRis(cohort, false);
    const exportedCsv = exportToRayyanCsv(cohort, false);

    // La colonne pmid du CSV reste vide pour Cochrane CD004057 (jamais de faux PMID)
    const csvLines = exportedCsv.split('\r\n');
    expect(csvLines[1]).toContain(`"${getArticleKey(cochraneNoPmid)}"`);
    expect(csvLines[1]).toContain(',"",');

    // Simule des décisions Rayyan ajoutées dans N1 (RIS) et dans la colonne notes (CSV)
    const rayyanRisWithVotes = exportedRis
      .replace(
        'ID  - doi:10.1002/14651858.cd004057.pub3\r\n',
        'ID  - doi:10.1002/14651858.cd004057.pub3\r\nN1  - RAYYAN-INCLUSION: {"A"=>"Included", "B"=>"Included"}\r\n'
      )
      .replace(
        'ID  - pmid:42966026\r\n',
        'ID  - pmid:42966026\r\nN1  - RAYYAN-INCLUSION: {"A"=>"Excluded", "B"=>"Excluded"} | RAYYAN-EXCLUSION-REASONS: Wrong intervention\r\n'
      );

    const parsedRisDecisions = parseRayyanImport(rayyanRisWithVotes);
    const appliedFromRis = applyRayyanDecisions(cohort, parsedRisDecisions);
    expect(appliedFromRis[0].status).toBe('included');
    expect(appliedFromRis[0].evaluatedBy).toBe('rayyan');
    expect(appliedFromRis[1].status).toBe('excluded');
    expect(appliedFromRis[1].exclusionReason).toBe('Wrong intervention');

    // Vérifie aussi le réimport CSV Rayyan sur une notice sans PMID
    const rayyanCsvWithVotes = [
      csvLines[0],
      csvLines[1].replace(/""$/, '"RAYYAN-INCLUSION: {""A""=>""Included""}"'),
      csvLines[2].replace(/""$/, '"RAYYAN-INCLUSION: {""A""=>""Maybe""}"')
    ].join('\r\n');

    const parsedCsvDecisions = parseRayyanImport(rayyanCsvWithVotes);
    const appliedFromCsv = applyRayyanDecisions(cohort, parsedCsvDecisions);
    expect(appliedFromCsv[0].status).toBe('included');
    expect(appliedFromCsv[1].status).toBe('maybe');
  });
});
