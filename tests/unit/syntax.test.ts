import { describe, it, expect, vi } from 'vitest';
import { parseClinicalAbstractNLP, buildQuerySyntax, MappedBlock, serializeAxisCompilationPayload } from '../../src/services/multiAgentWorkflow';
import {
  evaluateCritiqueRust,
  evaluatePressIndexDeterministic,
  finalizePressStatus,
  findMissingUserTermsInQuery,
  normalizeAuditObservations,
  isIupacOrLabCodeTerm,
  computeDerivationalStemsRust,
  filterInnArityTwRust,
  compileAxisBlockRust,
  shouldDisplayStrategyConverged,
  auditMultiBaseTranslationDeterministic
} from '../../src/services/rustEngineService';
import { generatePrismaReportText, generatePrismaSummaryData } from '../../src/services/prismaReport';
import { parsePubMedEfetchXml, selectStratifiedPmids, queryPubMedLive } from '../../src/services/pubmedApi';
import {
  sanitizePicoConcept,
  aiNormalizePicoConcepts,
  inferStudyDesignFromText,
  computeCochraneOverallRating,
  computeBackoffDelayMs,
  mapErrorToUserMessage,
  selectUnassessedRobBatch,
  aiEvaluateBatchRoB2,
  stripIatrogenicTermsFromOutcome,
  isPassiveComparatorConcept,
  isUnrestrictedDemographicConcept,
  resolveActiveModelForTask,
  compressAbstractForLlm,
  computePicoFingerprint,
  getAiConfig,
  saveAiConfig,
  testAiConnectionLive,
  canUnlockPrerequisitesModal,
  resolvePrismaExclusionCategory,
  formatPrismaExclusionReason,
  PRISMA_EXCLUSION_LABELS_FR
} from '../../src/services/localAiService';
import {
  clearMeshResolutionCaches,
  isNlmPharmacologicalSubstance,
  searchNcbiMesh,
  extractTreeNumbersFromEntrezItem,
  isValidTreeNumberForAxis,
  pruneSubsumedAncestorDescriptors
} from '../../src/services/meshDatabase';
import {
  exportToRayyanRis,
  exportToRayyanCsv,
  parseRayyanImport,
  applyRayyanDecisions,
  parseBenchmarkPmids,
  evaluateBenchmarkCoverage,
  buildReadingMatrixRows,
  exportReadingMatrixCsv,
  exportReadingMatrixMarkdown
} from '../../src/services/rayyanAndMatrixService';
import {
  runAgentScreeningDeep,
  computeScreeningMetrics,
  ScreenedArticle,
  initializeUnscreenedArticles,
  selectPendingArticlesBatch,
  mergeScreenedArticleUpdate
} from '../../src/services/agentScreener';

describe('1. Tests Unitaires & Conformité Constitutionnelle (gemini.md)', () => {
  describe('Sanitisation du PICO en langage naturel (sanitizePicoConcept)', () => {
    it('doit éliminer les balises MeSH et TiAb ainsi que les opérateurs booléens complexes', () => {
      const dirty = '"Overweight"[Mesh] OR "Obesity"[Mesh] OR overweight[TiAb] OR obesity[TiAb]';
      const clean = sanitizePicoConcept(dirty);
      expect(clean).not.toContain('[Mesh]');
      expect(clean).not.toContain('[TiAb]');
      expect(clean).not.toContain('OR');
      expect(clean).not.toContain('"');
      expect(clean.toLowerCase()).toContain('overweight');
      expect(clean.toLowerCase()).toContain('obesity');
    });

    it('doit dédoublonner les termes identiques', () => {
      const repeated = 'Fasting, fasting, "Fasting"[Mesh], fast*[TiAb]';
      const clean = sanitizePicoConcept(repeated);
      expect(clean).toBe('Fasting, fast*');
    });

    it('doit préserver le langage médical naturel propre', () => {
      const natural = 'Adultes en surpoids ou avec obésité';
      const clean = sanitizePicoConcept(natural);
      expect(clean).toBe('Adultes en surpoids ou avec obésité');
    });

    it('doit préserver les parenthèses MeSH équilibrées et nettoyer les périphrases de prévention secondaire', () => {
      const hybrid = 'Patients en prévention secondaire après un infarctus du myocarde (Myocardial Infarction) ou un syndrome coronarien aigu (Acute Coronary Syndrome)';
      const clean = sanitizePicoConcept(hybrid);
      expect(clean).toContain('(Myocardial Infarction)');
      expect(clean).toContain('(Acute Coronary Syndrome)');
      expect(clean.toLowerCase()).not.toContain('prévention secondaire');
    });

    it('doit autoriser les branches NLM biologiques/cellulaires (A15, A11) sur les axes I et C sans ouvrir aux branches hors-sujet', () => {
      expect(isValidTreeNumberForAxis(['A15.145.693'], 'I')).toBe(true);
      expect(isValidTreeNumberForAxis(['A11.872'], 'C')).toBe(true);
      expect(isValidTreeNumberForAxis(['L01.462'], 'I')).toBe(false);
    });

    it('doit normaliser les axes via aiNormalizePicoConcepts en concepts atomiques { conceptFr, conceptEn, synonymsTiab }', async () => {
      const store = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        get length() { return store.size; },
        clear() { store.clear(); },
        getItem(k: string) { return store.get(k) ?? null; },
        key(i: number) { return Array.from(store.keys())[i] ?? null; },
        removeItem(k: string) { store.delete(k); },
        setItem(k: string, v: string) { store.set(k, v); }
      });

      saveAiConfig({ provider: 'openai', routingMode: 'smart', openaiApiKey: 'sk-test-norm-key' });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      i: [
                        {
                          conceptFr: 'plasma riche en plaquettes',
                          conceptEn: 'Platelet-Rich Plasma',
                          synonymsTiab: ['platelet-rich plasma', 'PRP']
                        }
                      ],
                      o: [
                        { conceptFr: 'douleur', conceptEn: 'Pain', synonymsTiab: ['pain', 'VAS'] },
                        { conceptFr: 'fonction articulaire', conceptEn: 'Joint Function', synonymsTiab: ['WOMAC', 'joint function'] }
                      ]
                    })
                  }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      );

      try {
        const normalized = await aiNormalizePicoConcepts([
          { key: 'i', text: 'Injections intra-articulaires de plasma riche en plaquettes' },
          { key: 'o', text: 'Douleur et fonction articulaire' }
        ]);
        expect(normalized.i).toHaveLength(1);
        expect(normalized.i?.[0].conceptFr).toBe('plasma riche en plaquettes');
        expect(normalized.i?.[0].conceptEn).toBe('Platelet-Rich Plasma');
        expect(normalized.i?.[0].synonymsTiab).toContain('PRP');
        expect(normalized.o).toHaveLength(2);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('doit résoudre chaque concept atomique via HeTOP puis NCBI Entrez sans arrêt prématuré et basculer en Concept-Libre si non indexé', async () => {
      clearMeshResolutionCaches();
      const store = new Map<string, string>();
      store.set('meshcraft_hetop_creds', JSON.stringify({ username: 'doc', password: 'secret' }));
      vi.stubGlobal('localStorage', {
        get length() { return store.size; },
        clear() { store.clear(); },
        getItem(k: string) { return store.get(k) ?? null; },
        key(i: number) { return Array.from(store.keys())[i] ?? null; },
        removeItem(k: string) { store.delete(k); },
        setItem(k: string, v: string) { store.set(k, v); }
      });

      const calledUrls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          calledUrls.push(url);
          if (url.includes('/api/hetop/searchConcepts/')) {
            if (url.includes('plasma')) {
              return new Response(
                JSON.stringify({
                  concepts: [{ terminology: 'MeSH', code: 'D053657', preferredLabelEn: 'Platelet-Rich Plasma' }]
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              );
            }
            return new Response(JSON.stringify({ concepts: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          if (url.includes('esearch.fcgi')) {
            if (url.includes('D053657')) {
              return new Response(JSON.stringify({ esearchresult: { idlist: ['53657'] } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              });
            }
            return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          if (url.includes('esummary.fcgi')) {
            return new Response(
              JSON.stringify({
                result: {
                  '53657': {
                    uid: '53657',
                    ds_recordtype: 'descriptor',
                    ds_meshui: 'D053657',
                    ds_meshterms: ['Platelet-Rich Plasma', 'Plasma, Platelet-Rich'],
                    ds_subheading: ['therapeutic use'],
                    ds_treenum: ['A15.145.693']
                  }
                }
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response('{}', { status: 404 });
        })
      );

      try {
        // 1. HeTOP prioritaire (D053657) -> enrichissement NCBI (A15.145.693 accepté sur I)
        const prpMesh = await searchNcbiMesh('Injections intra-articulaires de plasma riche en plaquettes', 'I', undefined, [
          {
            conceptFr: 'plasma riche en plaquettes',
            conceptEn: 'Platelet-Rich Plasma',
            synonymsTiab: ['platelet-rich plasma', 'PRP']
          }
        ]);
        expect(prpMesh).not.toBeNull();
        expect(prpMesh?.meshId).toBe('D053657');
        expect(prpMesh?.descriptor).toBe('Platelet-Rich Plasma');
        expect(prpMesh?.entryTerms).toContain('prp');
        expect(calledUrls.some((u) => u.includes('/api/hetop/searchConcepts/'))).toBe(true);

        // 2. Concept non indexé sur axe O -> jamais null, bascule proprement en Concept-Libre [TiAb]
        const freeOutcome = await searchNcbiMesh('Score fonctionnel WOMAC', 'O', undefined, [
          {
            conceptFr: 'score WOMAC',
            conceptEn: 'WOMAC functional score',
            synonymsTiab: ['WOMAC', 'joint function']
          }
        ]);
        expect(freeOutcome).not.toBeNull();
        expect(freeOutcome?.meshId).toBe('Concept-Libre');
        expect(freeOutcome?.entryTerms).toContain('womac');
      } finally {
        clearMeshResolutionCaches();
        vi.unstubAllGlobals();
      }
    });
  });

  describe('Extraction NLP du Résumé Clinique (parseClinicalAbstractNLP)', () => {
    const createMemoryStorage = (): Storage => {
      const store = new Map<string, string>();
      return {
        get length() { return store.size; },
        clear() { store.clear(); },
        getItem(key: string) { return store.has(key) ? (store.get(key) ?? null) : null; },
        key(index: number) { return Array.from(store.keys())[index] ?? null; },
        removeItem(key: string) { store.delete(key); },
        setItem(key: string, value: string) { store.set(key, String(value)); }
      };
    };

    const sleepApneaQuestion =
      "Chez les adultes atteints d'apnée obstructive du sommeil, quel est l'effet des orthèses d'avancée mandibulaire comparées à la pression positive continue (PPC) sur la pression artérielle et l'indice d'apnées-hypopnées ?";

    it('doit lever une erreur explicite si le texte est vide ou si aucune clé API IA n\'est configurée', async () => {
      vi.stubGlobal('localStorage', createMemoryStorage());
      try {
        await expect(parseClinicalAbstractNLP('')).rejects.toThrow(/saisir une question clinique/i);

        saveAiConfig({ provider: 'openai', geminiApiKey: '', openaiApiKey: '', anthropicApiKey: '' });
        await expect(parseClinicalAbstractNLP(sleepApneaQuestion)).rejects.toThrow(/clé API IA/i);

        saveAiConfig({ provider: 'gemini', geminiApiKey: '', openaiApiKey: '', anthropicApiKey: '' });
        await expect(parseClinicalAbstractNLP(sleepApneaQuestion)).rejects.toThrow(/clé API IA/i);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('doit extraire une structure JSON PICO complète via le modèle rapide sur une question clinique libre', async () => {
      vi.stubGlobal('localStorage', createMemoryStorage());
      saveAiConfig({
        provider: 'gemini',
        routingMode: 'smart',
        geminiApiKey: 'AIzaSyTestKey1234567890'
      });

      const calledUrls: string[] = [];
      const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calledUrls.push(url);
        if (url.includes('/v1beta/models?')) {
          return new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        approach: 'pico',
                        p: "Adultes atteints d'apnée obstructive du sommeil",
                        i: "Orthèses d'avancée mandibulaire",
                        c: 'Pression positive continue',
                        o: "Pression artérielle, Indice d'apnées-hypopnées",
                        not: '',
                        qualifications: {
                          p: {
                            axisRole: 'clinical_condition',
                            impliedSubheadings: [],
                            coreClinicalConcept: 'Apnée obstructive du sommeil',
                            englishCoreTerms: ['Sleep Apnea, Obstructive']
                          },
                          i: {
                            axisRole: 'clinical_condition',
                            impliedSubheadings: [],
                            coreClinicalConcept: "Orthèse d'avancée mandibulaire",
                            englishCoreTerms: ['Mandibular Advancement', 'Orthotic Devices']
                          },
                          c: {
                            axisRole: 'clinical_condition',
                            impliedSubheadings: [],
                            coreClinicalConcept: 'Pression positive continue',
                            englishCoreTerms: ['Continuous Positive Airway Pressure']
                          },
                          o: {
                            axisRole: 'clinical_condition',
                            impliedSubheadings: [],
                            coreClinicalConcept: 'Pression artérielle',
                            englishCoreTerms: ['Blood Pressure', 'Apnea-Hypopnea Index']
                          },
                          not: {
                            axisRole: 'clinical_condition',
                            impliedSubheadings: [],
                            coreClinicalConcept: '',
                            englishCoreTerms: []
                          },
                          recommendedActivePico: { p: true, i: true, c: true, o: true, not: false }
                        },
                        confidence: 96,
                        reasoning: 'Question interventionnelle comparant deux thérapeutiques actives (PICO).'
                      })
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
      vi.stubGlobal('fetch', mockFetch);

      try {
        const extracted = await parseClinicalAbstractNLP(sleepApneaQuestion);
        expect(extracted.approach).toBe('pico');
        expect(extracted.source).toBe('gemini');
        expect(extracted.modelUsed).toBe('gemini-flash-latest');
        expect(extracted.p.toLowerCase()).toContain('apnée obstructive du sommeil');
        expect(extracted.i.toLowerCase()).toContain('orthèses');
        expect(extracted.c.toLowerCase()).toContain('pression positive continue');
        expect(extracted.o.toLowerCase()).toContain('pression artérielle');
        expect(extracted.qualifications?.recommendedActivePico?.c).toBe(true);
        expect(calledUrls.some((u) => u.includes('gemini-flash-latest:generateContent'))).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('doit propager explicitement une erreur API (HTTP 401 ou 503) sans jamais basculer sur un repli par règles', async () => {
      vi.stubGlobal('localStorage', createMemoryStorage());
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-invalid-key-1234567890',
        geminiApiKey: '',
        anthropicApiKey: ''
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        })
      );

      try {
        await expect(parseClinicalAbstractNLP(sleepApneaQuestion)).rejects.toThrow(/Clé API Cloud manquante ou invalide/i);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('doit envoyer response_format json_object sur OpenAI et rejeter un JSON invalide sans repli silencieux', async () => {
      vi.stubGlobal('localStorage', createMemoryStorage());
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-valid-key-1234567890',
        geminiApiKey: '',
        anthropicApiKey: ''
      });

      let capturedBody = '';
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
          capturedBody = typeof init?.body === 'string' ? init.body : '';
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Texte libre non structuré sans accolades' } }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        })
      );

      try {
        await expect(parseClinicalAbstractNLP(sleepApneaQuestion)).rejects.toThrow(/JSON PICO\/PECO valide/i);
        const payload = JSON.parse(capturedBody) as { model?: string; response_format?: { type?: string } };
        expect(payload.model).toBe('gpt-4o-mini');
        expect(payload.response_format?.type).toBe('json_object');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('Évaluation de la Qualité Méthodologique (evaluateCritiqueRust)', () => {
    it('doit pénaliser une requête qui renvoie 0 article', () => {
      const report = evaluateCritiqueRust(0, 5);
      expect(report.score).toBeLessThanOrEqual(60);
      expect(report.observations.some(o => o.includes('Aucun article'))).toBe(true);
      expect(report.recommendations.length).toBeGreaterThan(0);
    });

    it('doit attribuer un score optimal pour un volume équilibré', () => {
      const report = evaluateCritiqueRust(450, 12);
      expect(report.score).toBeGreaterThanOrEqual(90);
      expect(report.observations.some(o => o.includes('optimal'))).toBe(true);
    });

    it('doit avertir en cas de volume massif (> 20 000 articles)', () => {
      const report = evaluateCritiqueRust(35000, 8);
      expect(report.score).toBeLessThan(90);
      expect(report.observations.some(o => o.includes('très élevé'))).toBe(true);
    });
  });

  describe('Indice PRESS 100 % déterministe et explicable (evaluatePressIndexDeterministic)', () => {
    it('doit attribuer 100/100 avec 5 critères au vert pour une stratégie optimale', () => {
      const report = evaluatePressIndexDeterministic({
        pubmedQuery: '("Overweight"[Mesh] OR overweight[tiab]) AND ("Intermittent Fasting"[Mesh] OR fasting[tiab]) AND ("Body Weight"[Mesh] OR weight[tiab]) NOT ("Animals"[Mesh] NOT "Humans"[Mesh])',
        embaseQuery: "('overweight'/exp) AND ('intermittent fasting'/exp) AND ('body weight'/exp)",
        cochraneQuery: '([mh "Overweight"]) AND ([mh "Intermittent Fasting"]) AND ([mh "Body Weight"])',
        blocks: [
          { picoType: 'P', descriptors: [{ meshId: 'D050177' }] },
          { picoType: 'I', descriptors: [{ meshId: 'D000093763' }] },
          { picoType: 'O', descriptors: [{ meshId: 'D001835' }] }
        ],
        activeCoreAxesCount: 3,
        articleCount: 420,
        totalSynonyms: 12,
        hasActiveComparator: false,
        hasActiveNot: false,
        hasStrictHumansFilter: false
      });

      expect(report.score).toBe(100);
      expect(report.pressStatus).toBe('compliant');
      expect(report.pressAlertCount).toBe(0);
      expect(report.pressBreakdown).toHaveLength(5);
      expect(report.pressBreakdown?.every((c) => c.status === 'ok')).toBe(true);
    });

    it('doit exposer les pénalités exactes en cas de silence (0 notice), Concept-Libre seul et filtre Humans strict', () => {
      const report = evaluatePressIndexDeterministic({
        pubmedQuery: '("free term"[tiab]) AND "Humans"[mh]',
        embaseQuery: "('free term':ti,ab,kw,de) AND 'human'/exp",
        cochraneQuery: '("free term":ti,ab,kw)',
        blocks: [
          { picoType: 'P', descriptors: [{ meshId: 'Concept-Libre' }] }
        ],
        activeCoreAxesCount: 2,
        articleCount: 0,
        totalSynonyms: 1,
        hasActiveComparator: false,
        hasActiveNot: true,
        hasStrictHumansFilter: true
      });

      expect(report.score).toBe(39); // 0 (MeSH) + 14 (syn/terms) + 20 (syntax) + 0 (vol) + 5 (Cochrane: -5 NOT<50, -5 Humans)
      expect(report.pressStatus).toBe('revision_required');
      const meshCrit = report.pressBreakdown?.find((c) => c.id === 'mesh_coverage');
      const volCrit = report.pressBreakdown?.find((c) => c.id === 'pubmed_volume');
      const cochraneCrit = report.pressBreakdown?.find((c) => c.id === 'cochrane_c_not');
      expect(meshCrit?.status).toBe('penalty');
      expect(volCrit?.score).toBe(0);
      expect(cochraneCrit?.score).toBe(5);
    });

    it('doit passer au statut À affiner (needs_refinement) si un terme saisi (DCI) manque, si volume > 2 500 ou si une observation ⚠️ IA existe', () => {
      const missingDrugs = findMissingUserTermsInQuery(
        [
          {
            picoType: 'I',
            text: 'Inhibiteurs du SGLT2 (empagliflozine, dapagliflozine)'
          }
        ],
        [
          {
            picoType: 'I',
            descriptors: [{ meshId: 'D000077202' }]
          }
        ],
        '("Sodium-Glucose Transporter 2 Inhibitors"[Mesh] OR sglt2*[tiab])'
      );
      expect(missingDrugs).toEqual(['empagliflozine', 'dapagliflozine']);

      const missingReport = evaluatePressIndexDeterministic({
        pubmedQuery: '("Diabetes Mellitus, Type 2"[Mesh] OR diabetes[tiab]) AND ("Sodium-Glucose Transporter 2 Inhibitors"[Mesh] OR sglt2*[tiab])',
        embaseQuery: "('diabetes'/exp) AND ('sglt2'/exp)",
        cochraneQuery: '([mh "Diabetes Mellitus, Type 2"]) AND ([mh "Sodium-Glucose Transporter 2 Inhibitors"])',
        blocks: [
          { picoType: 'P', descriptors: [{ meshId: 'D003924' }] },
          { picoType: 'I', descriptors: [{ meshId: 'D000077202' }] }
        ],
        activeCoreAxesCount: 2,
        activeUserAxes: [
          { picoType: 'P', text: 'Diabète de type 2' },
          { picoType: 'I', text: 'Inhibiteurs du SGLT2, empagliflozine, dapagliflozine' }
        ],
        articleCount: 680,
        totalSynonyms: 6,
        hasActiveComparator: false,
        hasActiveNot: false,
        hasStrictHumansFilter: false
      });
      expect(missingReport.pressStatus).toBe('needs_refinement');
      expect(missingReport.pressBreakdown?.find((c) => c.id === 'input_terms_coverage')?.status).toBe('warning');

      const highVolReport = evaluatePressIndexDeterministic({
        pubmedQuery: '("Diabetes Mellitus, Type 2"[Mesh] OR diabetes[tiab]) AND ("Kidney Failure, Chronic"[Mesh] OR renal[tiab])',
        embaseQuery: "('diabetes'/exp) AND ('renal'/exp)",
        cochraneQuery: '([mh "Diabetes Mellitus, Type 2"]) AND ([mh "Kidney Failure, Chronic"])',
        blocks: [
          { picoType: 'P', descriptors: [{ meshId: 'D003924' }] },
          { picoType: 'O', descriptors: [{ meshId: 'D007676' }] }
        ],
        activeCoreAxesCount: 2,
        articleCount: 4120,
        totalSynonyms: 8,
        hasActiveComparator: false,
        hasActiveNot: false,
        hasStrictHumansFilter: false
      });
      expect(highVolReport.score).toBe(100); // score interne préservé pour rétrocompatibilité <= 20 000
      expect(highVolReport.pressStatus).toBe('needs_refinement');
      expect(highVolReport.pressBreakdown?.find((c) => c.id === 'pubmed_volume')?.status).toBe('warning');

      const compliantReport = evaluatePressIndexDeterministic({
        pubmedQuery: '("Overweight"[Mesh] OR overweight[tiab]) AND ("Intermittent Fasting"[Mesh] OR fasting[tiab])',
        embaseQuery: "('overweight'/exp) AND ('intermittent fasting'/exp)",
        cochraneQuery: '([mh "Overweight"]) AND ([mh "Intermittent Fasting"])',
        blocks: [
          { picoType: 'P', descriptors: [{ meshId: 'D050177' }] },
          { picoType: 'I', descriptors: [{ meshId: 'D000093763' }] }
        ],
        activeCoreAxesCount: 2,
        articleCount: 380,
        totalSynonyms: 6,
        hasActiveComparator: false,
        hasActiveNot: false,
        hasStrictHumansFilter: false
      });
      expect(compliantReport.pressStatus).toBe('compliant');

      const withStructuredAiWarning = finalizePressStatus(
        compliantReport,
        [
          { severity: 'ok', text: 'Structure PICO conforme aux standards PRESS 2015.' },
          { severity: 'warning', text: 'Terme empagliflozine absent du bloc I malgré sa saisie.' }
        ],
        380,
        false
      );
      expect(withStructuredAiWarning.pressStatus).toBe('needs_refinement');
      expect(withStructuredAiWarning.pressAlertCount).toBe(1);

      // Vérifie qu'une observation avec severity: 'ok' ne déclenche pas d'alerte même si elle évoque un concept clinique
      const withOkOnly = finalizePressStatus(
        compliantReport,
        [{ severity: 'ok', text: 'Aucune exclusion excessive détectée.' }],
        380,
        false
      );
      expect(withOkOnly.pressStatus).toBe('compliant');
      expect(withOkOnly.pressAlertCount).toBe(0);

      const normalizedMixed = normalizeAuditObservations([
        { severity: 'ok', text: '✅ Structure conforme' },
        { severity: 'info', text: '💡 Vigilance au dépouillement sur les revues narratives.' },
        { severity: 'warning', text: '⚠️ Absence de canagliflozine' },
        '⚠️ Chaîne brute héritée'
      ]);
      expect(normalizedMixed).toEqual([
        { severity: 'ok', text: 'Structure conforme' },
        { severity: 'info', text: 'Vigilance au dépouillement sur les revues narratives.' },
        { severity: 'warning', text: 'Absence de canagliflozine' },
        { severity: 'warning', text: 'Chaîne brute héritée' }
      ]);

      // Les observations 'info' ne doivent jamais bloquer le statut 'compliant'
      const withInfoOnly = finalizePressStatus(
        compliantReport,
        [
          { severity: 'ok', text: 'Descripteurs MeSH conformes.' },
          { severity: 'info', text: 'Hétérogénéité normale d’une stratégie sensible à vérifier au dépouillement.' }
        ],
        380,
        false
      );
      expect(withInfoOnly.pressStatus).toBe('compliant');
      expect(withInfoOnly.pressAlertCount).toBe(0);

      // Filtrage IUPAC / codes labo vs termes cliniques valides
      expect(isIupacOrLabCodeTerm('1-(glucopyranosyl)-4-methyl-3-(5-(4-fluorophenyl)-2-thienylmethyl)benzene - t777973')).toBe(true);
      expect(isIupacOrLabCodeTerm('3-oxazolidin-5-yl)methyl)thiophene-2-carboxamide 5-chloro-n-(((5s)-2-oxo-3-(4-(3-oxomorpholin-4-yl)phenyl)-1')).toBe(true);
      expect(isIupacOrLabCodeTerm('bay 59-7939')).toBe(true);
      expect(isIupacOrLabCodeTerm('interleukin-17')).toBe(false);
      expect(isIupacOrLabCodeTerm('type 2 diabetes mellitus')).toBe(false);

      // findMissingUserTermsInQuery ne doit pas lever de faux positif sur les adjectifs de gravité généraux ("Severity")
      const missingSeverityOnly = findMissingUserTermsInQuery(
        [{ picoType: 'P', text: 'Psoriasis modéré à sévère (Moderate to Severity)' }],
        [{ picoType: 'P', descriptors: [{ meshId: 'D011565' }] }],
        '("Psoriasis"[Mesh] OR psoriasis*[tiab])'
      );
      expect(missingSeverityOnly).toEqual([]);
    });

    it('doit conserver le descripteur [Mesh] de classe pharmacologique (D27) lorsque des molécules DCI (Canagliflozin, empagliflozin) sont présentes dans le même axe I', () => {
      const compiledMixed = compileAxisBlockRust({
        axisRole: 'drug_inn_list',
        descriptors: [
          {
            descriptor: 'Sodium-Glucose Transporter 2 Inhibitors',
            meshId: 'D000077203',
            allowedSubheadings: ['pharmacology', 'therapeutic use'],
            treeNumbers: ['D27.505.519.936'],
            isPharmacologicalSubstance: false,
            noExp: false,
            isMajor: false
          },
          {
            descriptor: 'Canagliflozin',
            meshId: 'D000068896',
            allowedSubheadings: ['pharmacology', 'adverse effects'],
            treeNumbers: ['D02.078'],
            isPharmacologicalSubstance: true,
            noExp: false,
            isMajor: false
          }
        ],
        entryTerms: [
          'sodium-glucose transporter 2 inhibitors',
          'empagliflozin',
          'dapagliflozin'
        ],
        rawClinicalTokens: ['inhibiteurs sglt2', 'empagliflozine', 'dapagliflozine', 'canagliflozine']
      });

      expect(compiledMixed.meshTermsEmitted).toContain('"Sodium-Glucose Transporter 2 Inhibitors"[Mesh]');
      expect(compiledMixed.pubmedClause).toContain('"Sodium-Glucose Transporter 2 Inhibitors"[Mesh]');
      expect(compiledMixed.pubmedClause).toMatch(/empagliflozin\*?"?\[tiab\]/i);
      expect(compiledMixed.pubmedClause).toMatch(/dapagliflozin\*?"?\[tiab\]/i);
      expect(compiledMixed.pubmedClause).toMatch(/canagliflozin\*?"?\[tiab\]/i);
    });
  });

  describe('Déduplication par préfixe des troncatures (computeDerivationalStemsRust & compileAxisBlockRust)', () => {
    it('doit éliminer les troncatures redondantes déjà subsumées par un préfixe plus court dans le même axe', () => {
      const stems = computeDerivationalStemsRust(
        [{ descriptor: 'Mortality', meshId: 'D009026' }],
        ['Mortality', 'Mortalities', 'mortality rate', 'Case Fatality Rate'],
        ['mortal*', 'mortality*', 'mortalities*']
      );
      expect(stems).toContain('mortal');
      expect(stems).not.toContain('mortality');
      expect(stems).not.toContain('mortalities');

      const compiled = compileAxisBlockRust({
        axisType: 'O',
        descriptors: [{ descriptor: 'Mortality', meshId: 'D009026', isMajor: false, noExp: false }],
        entryTerms: ['Mortality', 'Mortalities', 'mortality rate'],
        customTruncations: ['mortal*', 'mortality*', 'mortalities*'],
        impliedSubheadings: [],
        yearMin: 2015,
        yearMax: 2025
      });
      expect(compiled.truncationsEmitted).toContain('mortal*[tiab]');
      expect(compiled.truncationsEmitted).not.toContain('mortality*[tiab]');
      expect(compiled.truncationsEmitted).not.toContain('mortalities*[tiab]');
    });

    it('doit conserver deux troncatures qui ne sont pas préfixe l’une de l’autre (parkinsonis* vs parkinsonian*)', () => {
      const stems = computeDerivationalStemsRust(
        [{ descriptor: 'Parkinson Disease, Secondary', meshId: 'D020734' }],
        ['Parkinsonism', 'Parkinsonian Disorders'],
        []
      );
      expect(stems).toContain('parkinsonis');
      expect(stems).toContain('parkinsonian');
    });
  });

  describe('Générateur de Rapport PRISMA 2020 (generatePrismaReportText)', () => {
    it('doit compiler un chapitre méthodologique complet avec équation et statistiques', () => {
      const report = generatePrismaReportText(
        '("Overweight"[Mesh]) AND ("Fasting"[Mesh])',
        {
          identifiedTotal: 823,
          pubmedCount: 245,
          embaseCount: 578,
          duplicatesRemoved: 85,
          screened: 738,
          excludedScreening: 694,
          fullTextAssessed: 44,
          excludedFullText: 35,
          includedFinal: 9
        }
      );

      expect(report).toContain('RAPPORT MÉTHODOLOGIQUE PRISMA 2020');
      expect(report).toContain('ÉQUATION DE RECHERCHE PRINCIPALE (PUBMED)');
      expect(report).toContain('823');
      expect(report).toContain('9');
      expect(report).toContain('FLUX DE SÉLECTION DÉTAILLÉ');
      expect(report).toContain('PubMed / MEDLINE (National Library of Medicine) et Embase (Elsevier) ont été interrogées');
    });

    it('ne doit mentionner que PubMed / MEDLINE comme base interrogée lorsque Embase et Cochrane sont à 0', () => {
      const report = generatePrismaReportText(
        '("Osteoarthritis, Knee"[Mesh]) AND ("Platelet-Rich Plasma"[Mesh])',
        {
          identifiedTotal: 180,
          pubmedCount: 180,
          embaseCount: 0,
          duplicatesRemoved: 0,
          screened: 180,
          excludedScreening: 120,
          fullTextAssessed: 60,
          excludedFullText: 0,
          includedFinal: 40
        }
      );

      expect(report).toContain('La base de données PubMed / MEDLINE (National Library of Medicine) a été interrogée.');
      expect(report).toContain('Les équations traduites pour Embase (Elsevier) et Cochrane CENTRAL sont fournies ci-dessous');
      expect(report).not.toContain('Embase (Elsevier) et la Cochrane Library ont été interrogées');
    });

    it('doit normaliser et agréger proprement les motifs d\'exclusion PRISMA dans les 7 catégories standardisées', () => {
      expect(resolvePrismaExclusionCategory('study_design')).toBe('study_design');
      expect(resolvePrismaExclusionCategory('preclinical')).toBe('preclinical');
      expect(resolvePrismaExclusionCategory(undefined, 'Modèle animal murin')).toBe('preclinical');
      expect(formatPrismaExclusionReason('comparator')).toBe(PRISMA_EXCLUSION_LABELS_FR.comparator);
      expect(formatPrismaExclusionReason('outcome')).toBe(PRISMA_EXCLUSION_LABELS_FR.outcome);
    });
  });

  describe('Grille Cochrane RoB 2 / ROBINS-I (computeCochraneOverallRating & inferStudyDesignFromText)', () => {
    it('doit calculer le score global RoB 2 selon la règle stricte Cochrane', () => {
      expect(computeCochraneOverallRating('low', 'low', 'low', 'low', 'low')).toBe('low');
      expect(computeCochraneOverallRating('low', 'moderate', 'low', 'low', 'low')).toBe('moderate');
      expect(computeCochraneOverallRating('low', 'moderate', 'high', 'low', 'low')).toBe('high');
    });

    it('doit détecter le schéma d\'étude (ECR, Observationnel, Revue systématique)', () => {
      expect(inferStudyDesignFromText('Time-restricted eating in obesity: a randomized controlled trial')).toBe('rct');
      expect(inferStudyDesignFromText('Retrospective cohort study of SGLT2 inhibitors in real-world practice')).toBe('observational');
      expect(inferStudyDesignFromText('Intermittent fasting and weight loss: a systematic review and meta-analysis')).toBe('review');
    });

    it('doit évaluer les 5 domaines RoB 2 via le LLM et propager une erreur explicite si le lot est incomplet ou échoue', async () => {
      const store = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        get length() { return store.size; },
        clear() { store.clear(); },
        getItem(k: string) { return store.get(k) ?? null; },
        key(i: number) { return Array.from(store.keys())[i] ?? null; },
        removeItem(k: string) { store.delete(k); },
        setItem(k: string, v: string) { store.set(k, v); }
      });

      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-rob2-key'
      });

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
                        pmid: '42413768',
                        studyDesign: 'rct',
                        d1: 'moderate',
                        d2: 'low',
                        d3: 'low',
                        d4: 'low',
                        d5: 'low',
                        justification: 'Essai en double insu avec analyse ITT et enregistrement NCT.'
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

      try {
        const res = await aiEvaluateBatchRoB2([
          {
            pmid: '42413768',
            title: 'Time-restricted eating in adults: A randomized controlled trial.',
            abstract: 'Double-blind randomized trial registered at NCT04567890 with intention-to-treat analysis.'
          }
        ]);
        const rob = res.get('42413768');
        expect(rob).toBeDefined();
        expect(rob?.studyDesign).toBe('rct');
        expect(rob?.overall).toBe('moderate');

        // Réponse incomplète (2 études envoyées, 1 seule retournée) -> doit lever une erreur explicite (zéro repli heuristique)
        await expect(
          aiEvaluateBatchRoB2([
            { pmid: '42413768', title: 'Study 1', abstract: 'Abstract 1' },
            { pmid: '42413769', title: 'Study 2', abstract: 'Abstract 2' }
          ])
        ).rejects.toThrow(/incomplète/i);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('Grammaire Mathématique Multi-Bases (PubMed, Embase.com, CENTRAL) — Protocole Bayen 2026', () => {
    it('doit générer des équations équilibrées avec qualificatifs /CI, dates exactes et filtre Cochrane non destructif', () => {
      const blocks: MappedBlock[] = [
        {
          picoType: 'P',
          originalText: 'Parkinsonisme secondaire induit chimiquement',
          descriptor: 'Parkinson Disease, Secondary',
          meshId: 'D010302',
          descriptors: [
            { descriptor: 'Parkinson Disease, Secondary', meshId: 'D010302', noExp: false, isMajor: false },
            { descriptor: 'Parkinsonian Disorders', meshId: 'D020734', noExp: false, isMajor: false }
          ],
          entryTerms: ['secondary parkinsonism', 'drug-induced parkinsonism'],
          truncationTerms: ['parkinsonis*'],
          selectedQualifiers: ['chemically induced']
        },
        {
          picoType: 'I',
          originalText: 'Antipsychotiques, halopéridol, rispéridone, métoclopramide',
          descriptor: 'Antipsychotic Agents',
          meshId: 'D014150',
          descriptors: [
            { descriptor: 'Antipsychotic Agents', meshId: 'D014150', noExp: false, isMajor: false }
          ],
          entryTerms: ['haloperidol', 'risperidone', 'metoclopramide'],
          truncationTerms: ['antipsychotic*'],
          selectedQualifiers: []
        }
      ];

      const { pubmedQuery, embaseQuery, cochraneQuery } = buildQuerySyntax(blocks, {
        strategy: 'balanced',
        useTruncation: true,
        filters: ['humans_cochrane'],
        dateRange: {
          enabled: true,
          startDate: '2006/10/29',
          endDate: '2026/10/28'
        }
      });

      // 1. Invariant d'équilibre des parenthèses et guillemets sur les 3 bases
      for (const q of [pubmedQuery, embaseQuery, cochraneQuery]) {
        const openParens = (q.match(/\(/g) || []).length;
        const closeParens = (q.match(/\)/g) || []).length;
        const quotes = (q.match(/"/g) || []).length;
        expect(openParens).toBe(closeParens);
        expect(quotes % 2).toBe(0);
      }

      // 2. PubMed : qualificatif /chemically induced, bornes [dp] et filtre Cochrane non destructif
      expect(pubmedQuery).toContain('"Parkinson Disease, Secondary/chemically induced"[Mesh]');
      expect(pubmedQuery).toContain('("2006/10/29"[dp] : "2026/10/28"[dp])');
      expect(pubmedQuery).toContain('NOT ("Animals"[Mesh] NOT "Humans"[Mesh])');

      // 3. Embase.com : syntaxe factorisée :ti,ab,kw,de et bornes [DD-MM-YYYY to DD-MM-YYYY]/pd
      expect(embaseQuery).toContain("'parkinson disease, secondary'/exp");
      expect(embaseQuery).toContain(':ti,ab,kw,de');
      expect(embaseQuery).toContain('[29-10-2006 to 28-10-2026]/pd');

      // 4. Cochrane CENTRAL : code qualificatif officiel /CI
      expect(cochraneQuery).toContain('[mh "Parkinson Disease, Secondary"/CI]');
      expect(cochraneQuery).toContain(':ti,ab,kw');
    });

    it('ne doit générer aucun AND () orphelin lorsque le comparateur C est vide', () => {
      const blocks: MappedBlock[] = [
        {
          picoType: 'P',
          originalText: 'Lombalgie chronique',
          descriptor: 'Low Back Pain',
          meshId: 'D017116',
          descriptors: [{ descriptor: 'Low Back Pain', meshId: 'D017116', noExp: false, isMajor: false }],
          entryTerms: ['low back pain', 'chronic low back pain'],
          truncationTerms: []
        },
        {
          picoType: 'I',
          originalText: 'Éducation thérapeutique du patient',
          descriptor: 'Patient Education as Topic',
          meshId: 'D010353',
          descriptors: [{ descriptor: 'Patient Education as Topic', meshId: 'D010353', noExp: false, isMajor: false }],
          entryTerms: ['patient education'],
          truncationTerms: []
        },
        {
          picoType: 'C',
          originalText: '',
          descriptor: '',
          meshId: '',
          descriptors: [],
          entryTerms: [],
          truncationTerms: []
        }
      ];

      const { pubmedQuery, embaseQuery, cochraneQuery } = buildQuerySyntax(blocks, {
        strategy: 'balanced',
        useTruncation: true,
        filters: ['humans_cochrane']
      });

      for (const q of [pubmedQuery, embaseQuery, cochraneQuery]) {
        expect(q).not.toMatch(/\bAND\s*\(\s*\)/i);
        expect(q).not.toMatch(/\(\s*\)\s*AND\b/i);
        expect(q).not.toMatch(/^\s*(?:AND|OR)\b|\b(?:AND|OR)\s*$/i);
        expect((q.match(/\(/g) || []).length).toBe((q.match(/\)/g) || []).length);
        expect((q.match(/"/g) || []).length % 2).toBe(0);
      }
    });

    it('doit assembler un bloc NOT utilisateur avec le filtre Cochrane NOT ("Animals"[Mesh] NOT "Humans"[Mesh]) en gardant des parenthèses équilibrées', () => {
      const blocks: MappedBlock[] = [
        {
          picoType: 'P',
          originalText: 'Asthme',
          descriptor: 'Asthma',
          meshId: 'D001249',
          descriptors: [{ descriptor: 'Asthma', meshId: 'D001249', noExp: false, isMajor: false }],
          entryTerms: ['asthma'],
          truncationTerms: []
        },
        {
          picoType: 'I',
          originalText: 'Corticoïdes inhalés',
          descriptor: 'Budesonide',
          meshId: 'D019819',
          descriptors: [{ descriptor: 'Budesonide', meshId: 'D019819', noExp: false, isMajor: false }],
          entryTerms: ['budesonide', 'inhaled corticosteroids'],
          truncationTerms: []
        },
        {
          picoType: 'NOT',
          originalText: 'Bronchopneumopathie chronique obstructive',
          descriptor: 'Pulmonary Disease, Chronic Obstructive',
          meshId: 'D029424',
          descriptors: [
            { descriptor: 'Pulmonary Disease, Chronic Obstructive', meshId: 'D029424', noExp: false, isMajor: false }
          ],
          entryTerms: ['copd'],
          truncationTerms: []
        }
      ];

      const { pubmedQuery, embaseQuery, cochraneQuery } = buildQuerySyntax(blocks, {
        strategy: 'balanced',
        useTruncation: true,
        filters: ['humans_cochrane']
      });

      expect(pubmedQuery).toContain('NOT\n(');
      expect(pubmedQuery).toContain('"Pulmonary Disease, Chronic Obstructive"[Mesh]');
      expect(pubmedQuery).toContain('NOT ("Animals"[Mesh] NOT "Humans"[Mesh])');

      for (const q of [pubmedQuery, embaseQuery, cochraneQuery]) {
        expect((q.match(/\(/g) || []).length).toBe((q.match(/\)/g) || []).length);
        expect((q.match(/"/g) || []).length % 2).toBe(0);
        expect(q).not.toMatch(/\[[^\]]+\]\[[^\]]+\]/);
        expect(q).not.toContain('""');
      }
    });

    it('doit émettre la forme canonique NLM (prevention and control) pour PubMed tout en conservant /PC sur CENTRAL', () => {
      const compiled = compileAxisBlockRust({
        axisRole: 'population',
        descriptors: [
          {
            descriptor: 'Hypertension',
            meshId: 'D006973',
            allowedSubheadings: ['therapy', 'prevention and control'],
            selectedSubheadings: ['prevention & control'],
            noExp: false,
            isMajor: false
          }
        ],
        entryTerms: ['high blood pressure']
      });

      expect(compiled.pubmedClause).toContain('"Hypertension/prevention and control"[Mesh]');
      expect(compiled.pubmedClause).not.toContain('prevention & control');
      expect(compiled.centralClause).toContain('[mh "Hypertension"/PC]');
    });

    it('doit reproduire à 100% la structure algébrique Gold Standard (Filtre [tw], Dominance dérivationnelle, Subsomption préfixielle, Absorption /chemically induced)', () => {
      // 1. Qualification NLM dynamique par ds_subheading
      expect(isNlmPharmacologicalSubstance('Haloperidol', ['administration & dosage', 'adverse effects', 'pharmacology'])).toBe(true);
      expect(isNlmPharmacologicalSubstance('Antipsychotic Agents', ['adverse effects', 'pharmacology', 'therapeutic use'])).toBe(false);
      expect(isNlmPharmacologicalSubstance('Parkinson Disease, Secondary', ['chemically induced', 'diagnosis', 'epidemiology'])).toBe(false);

      // 2. Filtre d'arité lexicale [tw] sur les Entry Terms NLM bruts (sels et codes IUPAC rejetés)
      const arity = filterInnArityTwRust([
        'Haloperidol',
        'Haloperidol Decanoate',
        '4-(4-(4-chlorophenyl)-4-hydroxy-1-piperidinyl)-1-(4-fluorophenyl)-1-butanone',
        'Chlorpromazine',
        'Chlorpromazine Hydrochloride',
        'Methotrimeprazine',
        'Levomepromazine',
        'Valproic Acid',
        'Valproate Sodium',
        '2-Propylpentanoic Acid'
      ]);
      expect(arity.acceptedTwClauses).toEqual([
        'haloperidol[tw]',
        'chlorpromazine[tw]',
        'methotrimeprazine[tw]',
        'levomepromazine[tw]',
        '"valproic acid"[tw]'
      ]);

      // 3. Compilation algébrique complète du bloc Parkinsonisme médicamenteux
      const parkinsonBlock: MappedBlock = {
        picoType: 'O',
        originalText: 'Parkinsonisme induit par les médicaments',
        descriptor: 'Parkinson Disease, Secondary',
        meshId: 'D010302',
        axisRole: 'pathology_outcome',
        impliedSubheadings: ['chemically induced'],
        descriptors: [
          {
            descriptor: 'Parkinson Disease, Secondary',
            meshId: 'D010302',
            allowedSubheadings: ['chemically induced', 'diagnosis', 'epidemiology']
          },
          {
            descriptor: 'Parkinsonian Disorders',
            meshId: 'D020734',
            allowedSubheadings: ['chemically induced', 'drug therapy']
          }
        ],
        entryTerms: [
          'Secondary Parkinsonism',
          'Parkinsonism, Secondary',
          'Drug-Induced Parkinsonism',
          'Parkinsonian Syndrome',
          'Parkinsonian Syndromes'
        ]
      };

      const serializedPayload = serializeAxisCompilationPayload(parkinsonBlock, { strategy: 'balanced', useTruncation: true });
      const compiledOutcome = compileAxisBlockRust(JSON.parse(serializedPayload));

      expect(compiledOutcome.pubmedClause).toBe(
        '("Parkinson Disease, Secondary/chemically induced"[Mesh] OR "Parkinsonian Disorders/chemically induced"[Mesh] OR parkinsonis*[tiab] OR parkinsonian*[tiab])'
      );
      expect(compiledOutcome.pubmedClause).not.toContain('parkinson*[tiab]');
      expect(compiledOutcome.pubmedClause).not.toContain('"Parkinson Disease, Secondary"[Mesh]');
    });

    it('doit bloquer les troncatures sur les mots génériques (NON_CLINICAL_STEMS) et préserver les syntagmes composés (Cas N°1 PMC11479423 & Cas N°2 PROSPERO)', () => {
      // Cas N°1 : Problem-Based Learning + Problem Solving
      const pblCompiled = compileAxisBlockRust({
        axisRole: 'generic_intervention',
        impliedSubheadings: [],
        descriptors: [
          { descriptor: 'Problem-Based Learning', meshId: 'D018794' },
          { descriptor: 'Problem Solving', meshId: 'D011340' }
        ],
        entryTerms: [
          'Problem-Based Learning',
          'Problem Solving',
          'Problem-Based Curriculum',
          'Problem-Based Curricula'
        ]
      });

      expect(pblCompiled.truncationsEmitted).toEqual([]);
      expect(pblCompiled.pubmedClause).toBe(
        '("Problem-Based Learning"[Mesh] OR "Problem Solving"[Mesh] OR "problem-based learning"[tiab] OR "problem solving"[tiab] OR "problem-based curriculum"[tiab] OR "problem-based curricula"[tiab])'
      );

      // Cas N°2 : Hospitals + Inpatients (PROSPERO)
      const hospitalCompiled = compileAxisBlockRust({
        axisRole: 'population',
        impliedSubheadings: [],
        descriptors: [
          { descriptor: 'Hospitals', meshId: 'D006761' },
          { descriptor: 'Inpatients', meshId: 'D007297' }
        ],
        entryTerms: ['Hospitals', 'Inpatients', 'Hospital', 'Inpatient']
      });

      expect(hospitalCompiled.pubmedClause).toBe(
        '("Hospitals"[Mesh] OR "Inpatients"[Mesh] OR hospital*[tiab] OR inpatient*[tiab])'
      );
    });

    it('doit court-circuiter (Hard Drop) "Absence d\'exposition" / "Adultes en soins primaires" et purger "Pharmacovigilance" de l\'Axe O', async () => {
      expect(isPassiveComparatorConcept("Absence d'exposition")).toBe(true);
      expect(isPassiveComparatorConcept('Placebo ou soins courants')).toBe(true);
      expect(isUnrestrictedDemographicConcept('Adultes en soins primaires')).toBe(true);

      // Court-circuit strict avant tout appel réseau NLM/HeTOP (empêche l'hallucination "Exhibition"[Mesh])
      expect(await searchNcbiMesh("Absence d'exposition")).toBeNull();
      expect(await searchNcbiMesh('Adultes en soins primaires')).toBeNull();

      // Purge stricte de Pharmacovigilance / Iatrogénie égarés dans l'Axe O
      expect(stripIatrogenicTermsFromOutcome('Syndrome parkinsonien, Pharmacovigilance')).toBe('Syndrome parkinsonien');
      expect(stripIatrogenicTermsFromOutcome('Syndrome parkinsonien secondaire, Iatrogénie, Effets indésirables')).toBe(
        'Syndrome parkinsonien secondaire'
      );

      // Filtrage ontologique par Tree Number (Catégorie MeSH NLM) :
      // 1. Axe O (PathologyOutcome) : C, F03 + sous-branches cliniques/anthropométriques chirurgicales
      expect(isValidTreeNumberForAxis(['C10.228.140.079.862.800'], 'O')).toBe(true); // Parkinson Disease, Secondary
      expect(isValidTreeNumberForAxis(['F03.615.250'], 'O')).toBe(true); // Delirium
      expect(isValidTreeNumberForAxis(['G07.700.125'], 'O')).toBe(true); // Body Weights and Measures
      expect(isValidTreeNumberForAxis(['E01.370.600.115.100.125'], 'O')).toBe(true); // Body Mass Index (Physical Examination)
      expect(isValidTreeNumberForAxis(['N06.850.505.400.975.550'], 'O')).toBe(true); // Mortality
      expect(isValidTreeNumberForAxis(['I01.800'], 'O')).toBe(true); // Quality of Life
      expect(isValidTreeNumberForAxis(['E01.370.350.700'], 'O')).toBe(false); // Diagnostic Imaging rejeté sur O
      expect(isValidTreeNumberForAxis(['G07.203.650.240.587'], 'O')).toBe(false); // Fasting / Diet rejeté sur O
      expect(isValidTreeNumberForAxis(['E05.318.308.940', 'N04.452.718.500'], 'O')).toBe(false); // Pharmacovigilance rejeté sur O
      expect(isValidTreeNumberForAxis(['L01.462.500.590.400'], 'O')).toBe(false); // Exhibitions L01 rejeté sur O
      expect(isValidTreeNumberForAxis(['V01.175'], 'O')).toBe(false); // V01-V04 rejeté sur O
      expect(isValidTreeNumberForAxis(['D02.522.352.500'], 'O')).toBe(false); // D rejeté sur O

      // 1b. Subsumption hiérarchique MeSH générique (élimine l'ancêtre trop large B si descendant A présent)
      const prunedHierarchy = pruneSubsumedAncestorDescriptors([
        {
          descriptor: 'Fasting',
          meshId: 'D005215',
          treeNumbers: ['F01.145.407.400', 'G07.203.650.240.587']
        },
        {
          descriptor: 'Intermittent Fasting',
          meshId: 'D000093763',
          treeNumbers: ['F01.145.407.400.500', 'G07.203.650.240.587.500']
        }
      ]);
      expect(prunedHierarchy.map((d) => d.descriptor)).toEqual(['Intermittent Fasting']);

      const preservedSiblings = pruneSubsumedAncestorDescriptors([
        {
          descriptor: 'Empagliflozin',
          meshId: 'D000077202',
          treeNumbers: ['D02.033.100.500']
        },
        {
          descriptor: 'Dapagliflozin',
          meshId: 'D000077203',
          treeNumbers: ['D02.033.100.600']
        }
      ]);
      expect(preservedSiblings.map((d) => d.descriptor)).toEqual(['Empagliflozin', 'Dapagliflozin']);

      // 2. Axe I (Intervention / DrugInnList) : n'accepte QUE D, E, N (et I02)
      expect(isValidTreeNumberForAxis(['D02.522.352.500', 'D03.383.621.318'], 'I')).toBe(true); // Haloperidol
      expect(isValidTreeNumberForAxis(['E05.318.308.940', 'N04.452.718.500'], 'I')).toBe(true); // Pharmacovigilance accepté sur I
      expect(isValidTreeNumberForAxis(['L01.462.500.590.400'], 'I')).toBe(false); // Exhibitions rejeté sur I
      expect(isValidTreeNumberForAxis(['L01.462.500.590.400'], 'C')).toBe(false); // Exhibitions rejeté sur C

      // 3. Extraction depuis ds_idxlinks NLM esummary
      const extractedTrees = extractTreeNumbersFromEntrezItem({
        ds_meshui: 'D010302',
        ds_idxlinks: [{ treenum: 'C10.228.140.079.862.800' }]
      });
      expect(extractedTrees).toEqual(['C10.228.140.079.862.800']);
    });
  });

  describe('Résilience Réseau API (Exponential Backoff with Jitter & Friendly Error Mapping)', () => {
    it('doit calculer un délai exponentiel borné avec Jitter', () => {
      const d0 = computeBackoffDelayMs(0, 1500, 30000);
      const d1 = computeBackoffDelayMs(1, 1500, 30000);
      const d10 = computeBackoffDelayMs(10, 1500, 30000);
      expect(d0).toBeGreaterThanOrEqual(1500);
      expect(d0).toBeLessThan(2600);
      expect(d1).toBeGreaterThanOrEqual(3000);
      expect(d10).toBeLessThanOrEqual(31000);
    });

    it('doit traduire les erreurs HTTP 503 / 429 / Timeout en messages cliniques sans stacktrace brute', () => {
      const msg503 = mapErrorToUserMessage(new Error('HTTP 503 Service Unavailable - Model is overloaded / high demand'));
      expect(msg503).toContain('sollicité');
      expect(msg503).not.toContain('Stack');

      const msg429 = mapErrorToUserMessage(new Error('429 Too Many Requests: Resource has been exhausted'));
      expect(msg429).toContain('Limite de requêtes');

      const msgTimeout = mapErrorToUserMessage(new Error('TimeoutError: signal timed out'));
      expect(msgTimeout).toContain('délai');
    });
  });

  describe('Interopérabilité Rayyan (.ris / .csv), PMIDs Repères PRESS & Matrice de Lecture', () => {
    const sampleArticles: ScreenedArticle[] = [
      {
        pmid: '34567890',
        title: 'Drug-induced parkinsonism with haloperidol and risperidone: a cohort study',
        authors: 'Bayen S, Dupont M',
        source: 'Mov Disord',
        pubDate: '2024',
        abstract: 'Background: We evaluated drug-induced parkinsonism in 450 patients exposed to haloperidol or risperidone.',
        url: 'https://pubmed.ncbi.nlm.nih.gov/34567890/',
        doi: '10.1002/mds.12345',
        status: 'included',
        exclusionReason: 'Pertinent : Étude de cohorte sur le parkinsonisme induit par les antipsychotiques',
        evidenceSnippet: 'evaluated drug-induced parkinsonism in 450 patients',
        evaluatedBy: 'gemini'
      },
      {
        pmid: '34567891',
        title: 'Notice without abstract on movement disorders',
        authors: 'Martin L',
        source: 'Rev Neurol',
        pubDate: '2023',
        abstract: '',
        url: 'https://pubmed.ncbi.nlm.nih.gov/34567891/',
        status: 'maybe',
        exclusionReason: 'À vérifier sur texte intégral (Résumé absent sur PubMed — Principe de précaution Cochrane)',
        evaluatedBy: 'gemini'
      },
      {
        pmid: '34567892',
        title: 'Animal rat model of striatal dopamine depletion',
        authors: 'Smith J',
        source: 'Brain Res',
        pubDate: '2022',
        abstract: 'In vivo rat model of dopamine depletion.',
        url: 'https://pubmed.ncbi.nlm.nih.gov/34567892/',
        status: 'excluded',
        exclusionReason: 'Exclu : Étude pré-clinique / modèle animal',
        evaluatedBy: 'gemini'
      }
    ];

    it('doit comptabiliser séparément les articles Inclus, À vérifier (Maybe) et Exclus', () => {
      const metrics = computeScreeningMetrics(sampleArticles);
      expect(metrics.totalIncluded).toBe(1);
      expect(metrics.totalMaybe).toBe(1);
      expect(metrics.totalExcluded).toBe(1);
      expect(metrics.totalScreened).toBe(3);
    });

    it('doit exporter au format RIS standard Rayyan et ré-importer les décisions RAYYAN-INCLUSION', () => {
      const ris = exportToRayyanRis(sampleArticles, true);
      expect(ris).toContain('TY  - JOUR');
      expect(ris).toContain('AN  - 34567890');
      expect(ris).toContain('AI-PreScreen: INCLUDE');
      expect(ris).toContain('AI-PreScreen: MAYBE (Full-text check)');

      const csv = exportToRayyanCsv(sampleArticles);
      expect(csv).toContain('34567890');

      // Simulation d'un retour Rayyan où le relecteur humain exclut 34567891 et inclut 34567890
      const rayyanReturnRis = [
        'TY  - JOUR',
        'AN  - 34567890',
        'N1  - RAYYAN-INCLUSION: {"Dr_Bayen"=>"Included"}',
        'ER  - ',
        'TY  - JOUR',
        'AN  - 34567891',
        'N1  - RAYYAN-INCLUSION: {"Dr_Bayen"=>"Excluded"} | RAYYAN-EXCLUSION-REASONS: Éditorial sans données originales',
        'ER  - '
      ].join('\n');

      const parsed = parseRayyanImport(rayyanReturnRis);
      expect(parsed.size).toBe(2);
      const updated = applyRayyanDecisions(sampleArticles, parsed);
      expect(updated.find(a => a.pmid === '34567890')?.status).toBe('included');
      expect(updated.find(a => a.pmid === '34567891')?.status).toBe('excluded');
      expect(updated.find(a => a.pmid === '34567891')?.exclusionReason).toContain('Éditorial');
    });

    it('doit évaluer le taux de couverture des PMIDs repères (Validation PRESS / PRISMA-S)', () => {
      const benchmarks = parseBenchmarkPmids('34567890, 34567891, 99999999');
      expect(benchmarks).toEqual(['34567890', '34567891', '99999999']);

      const report = evaluateBenchmarkCoverage(benchmarks, sampleArticles.map(a => a.pmid));
      expect(report.foundPmids).toEqual(['34567890', '34567891']);
      expect(report.missingPmids).toEqual(['99999999']);
      expect(report.coveragePercent).toBe(67);
    });

    it('doit générer la Matrice de Synthèse (incluses par défaut, option includeMaybe) sans PICO statique ni émojis bruts', () => {
      // Par défaut : études incluses uniquement
      const rowsIncludedOnly = buildReadingMatrixRows(sampleArticles, {});
      expect(rowsIncludedOnly).toHaveLength(1);
      expect(rowsIncludedOnly[0].pmid).toBe('34567890');
      expect(rowsIncludedOnly[0].firstAuthorYear).toContain('Bayen S (2024)');
      expect(rowsIncludedOnly[0].screeningStatus).toBe('included');

      // Option activée : incluses + à vérifier
      const rowsWithMaybe = buildReadingMatrixRows(sampleArticles, {}, { includeMaybe: true });
      expect(rowsWithMaybe).toHaveLength(2);
      expect(rowsWithMaybe[1].screeningStatus).toBe('maybe');

      const csv = exportReadingMatrixCsv(rowsWithMaybe);
      expect(csv).toContain('34567890');
      expect(csv).toContain('Mov Disord');
      expect(csv).toContain('Synthèse titre/résumé');
      expect(csv).not.toContain('Population & Exposition');

      const md = exportReadingMatrixMarkdown(rowsWithMaybe);
      expect(md).toContain('| Référence | Auteur (Année) | Plan d\'étude & Statut | Synthèse titre/résumé | Risque de biais |');
      expect(md).toContain('34567890');
      expect(md).not.toContain('Population & Exposition');
      expect(md).not.toMatch(/[🟢🟡🔴⚪]/u);
    });
  });

  describe('12. Architecture Cloud Multi-Fournisseurs (Gemini, OpenAI, Anthropic) & Optimisations FinOps', () => {
    it('doit router automatiquement les tâches entre le modèle Pro (reasoning) et le modèle Flash/Mini/Haiku (batch) en mode Smart', () => {
      const baseConf = getAiConfig();

      // 1. Google Gemini Smart Routing (alias -latest pérennes & FinOps minimal-thinking sur batch)
      const geminiConf = { ...baseConf, provider: 'gemini' as const, routingMode: 'smart' as const };
      expect(resolveActiveModelForTask(geminiConf, 'reasoning')).toBe('gemini-pro-latest');
      expect(resolveActiveModelForTask(geminiConf, 'fast')).toBe('gemini-flash-latest');
      expect(resolveActiveModelForTask(geminiConf, 'batch')).toBe('gemini-flash-lite-latest');

      // 2. OpenAI Smart Routing (GPT-4o + GPT-4o-mini)
      const openaiConf = { ...baseConf, provider: 'openai' as const, routingMode: 'smart' as const };
      expect(resolveActiveModelForTask(openaiConf, 'reasoning')).toBe('gpt-4o');
      expect(resolveActiveModelForTask(openaiConf, 'batch')).toBe('gpt-4o-mini');

      // 3. Anthropic Claude Smart Routing (Sonnet + Haiku)
      const claudeConf = { ...baseConf, provider: 'anthropic' as const, routingMode: 'smart' as const };
      expect(resolveActiveModelForTask(claudeConf, 'reasoning')).toBe('claude-3-5-sonnet-latest');
      expect(resolveActiveModelForTask(claudeConf, 'batch')).toBe('claude-3-5-haiku-latest');

      // 4. Modes forcés : pro_only et economy
      expect(resolveActiveModelForTask({ ...openaiConf, routingMode: 'pro_only' }, 'batch')).toBe('gpt-4o');
      expect(resolveActiveModelForTask({ ...claudeConf, routingMode: 'economy' }, 'reasoning')).toBe('claude-3-5-haiku-latest');
    });

    it('doit migrer automatiquement toute ancienne configuration locale (ollama / lmstudio) vers le Cloud Gemini', () => {
      const migrated = saveAiConfig({ provider: 'ollama' as unknown as 'gemini' });
      expect(migrated.provider).toBe('gemini');
    });

    it('doit compresser les résumés PubMed en supprimant les déclarations de conflits d\'intérêts et droits d\'auteur (FinOps)', () => {
      const rawAbstract =
        'Double-blind randomized controlled trial (NCT04589123) evaluating haloperidol vs risperidone in 320 patients. Conflict of interest: The authors declare no competing financial interests. Funding statement: Supported by grant #1234. © 2025 Elsevier Ltd. All rights reserved.';
      const compressed = compressAbstractForLlm(rawAbstract, 500);

      expect(compressed).toContain('NCT04589123');
      expect(compressed).toContain('haloperidol vs risperidone');
      expect(compressed).not.toContain('Conflict of interest:');
      expect(compressed).not.toContain('Funding statement:');
      expect(compressed).not.toContain('Elsevier');
    });

    it('doit générer une empreinte PICO déterministe pour le cache d\'idempotence du screening', () => {
      const fp1 = computePicoFingerprint({
        p: ' Adultes ',
        i: 'Halopéridol',
        c: 'Placebo',
        o: 'Syndrome parkinsonien'
      });
      const fp2 = computePicoFingerprint({
        p: 'adultes',
        i: 'halopéridol',
        c: 'placebo',
        o: 'syndrome parkinsonien'
      });
      expect(fp1).toBe(fp2);
    });

    it('doit propager une erreur explicite dans runAgentScreeningDeep sans boucle infinie ni faux positif si le LLM renvoie une réponse vide', async () => {
      const store = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        get length() { return store.size; },
        clear() { store.clear(); },
        getItem(k: string) { return store.get(k) ?? null; },
        key(i: number) { return Array.from(store.keys())[i] ?? null; },
        removeItem(k: string) { store.delete(k); },
        setItem(k: string, v: string) { store.set(k, v); }
      });

      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-empty-screening'
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      );

      try {
        await expect(
          runAgentScreeningDeep(
            [
              {
                pmid: '99001122',
                title: 'Sample clinical trial',
                authors: 'Doe J',
                source: 'Lancet',
                pubDate: '2025',
                abstract: 'A randomized trial with sufficient abstract length for batch screening evaluation.',
                meshHeadings: ['Humans']
              }
            ],
            { p: 'Adultes', i: 'Halopéridol', c: '', o: 'Syndrome parkinsonien' }
          )
        ).rejects.toThrow(/réponse vide/i);
      } finally {
        vi.unstubAllGlobals();
      }
    }, 15000);
  });

  describe('13. Étape 3 — Parsing XML efetch-only, Échantillonnage Stratifié, PRISMA & Lots de Pré-Dépouillement', () => {
    it('doit parser directement un XML efetch PubMed (résumé structuré \\n\\n sans HTML, DOI, CollectiveName, MedlineDate)', () => {
      const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation Status="MEDLINE">
      <PMID Version="1">40123456</PMID>
      <Article PubModel="Print">
        <Journal>
          <JournalIssue>
            <PubDate>
              <MedlineDate>2024 Nov-Dec</MedlineDate>
            </PubDate>
          </JournalIssue>
          <ISOAbbreviation>N Engl J Med</ISOAbbreviation>
        </Journal>
        <ArticleTitle>Effect of <i>empagliflozin</i> on heart failure<sup>2</sup> &amp; renal outcomes.</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND">Patients with <b>heart failure</b> face high mortality.</AbstractText>
          <AbstractText Label="METHODS">Double-blind randomized trial.<br/>Primary outcome was hospitalization.</AbstractText>
          <AbstractText Label="RESULTS">Hazard ratio was 0.75 (95% CI, 0.65-0.86).</AbstractText>
        </Abstract>
        <AuthorList>
          <Author><LastName>Dupont</LastName><Initials>M</Initials></Author>
          <Author><CollectiveName>EMPEROR-Preserved Study Group</CollectiveName></Author>
        </AuthorList>
      </Article>
      <MeshHeadingList>
        <MeshHeading><DescriptorName>Heart Failure</DescriptorName></MeshHeading>
        <MeshHeading><DescriptorName>Humans</DescriptorName></MeshHeading>
      </MeshHeadingList>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="pubmed">40123456</ArticleId>
        <ArticleId IdType="doi">10.1056/NEJMoa2107038</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>`;

      const parsed = parsePubMedEfetchXml(sampleXml);
      expect(parsed).toHaveLength(1);
      const art = parsed[0];
      expect(art.pmid).toBe('40123456');
      expect(art.doi).toBe('10.1056/NEJMoa2107038');
      expect(art.pubDate).toBe('2024 Nov-Dec');
      expect(art.source).toBe('N Engl J Med');
      expect(art.authors).toContain('Dupont M');
      expect(art.authors).toContain('EMPEROR-Preserved Study Group');
      expect(art.title).toBe('Effect of empagliflozin on heart failure2 & renal outcomes.');
      expect(art.title).not.toMatch(/<\/?(?:i|b|sup|br)\b/i);
      expect(art.abstract).toContain('BACKGROUND: Patients with heart failure face high mortality.');
      expect(art.abstract).toContain('\n\nMETHODS: Double-blind randomized trial.Primary outcome was hospitalization.');
      expect(art.abstract).toContain('\n\nRESULTS: Hazard ratio was 0.75 (95% CI, 0.65-0.86).');
      expect(art.abstract).not.toMatch(/<\/?(?:i|b|sup|br)\b/i);
      expect(art.meshHeadings).toEqual(['Heart Failure', 'Humans']);
    });

    it('doit prélever 30 PMIDs en 3 strates (10 Tête / 10 Milieu / 10 Queue) sur un grand corpus et la totalité si ≤ 30', () => {
      const largeIds = Array.from({ length: 250 }, (_, idx) => String(100000 + idx));
      const stratified = selectStratifiedPmids(largeIds, 10);
      expect(stratified.topIds).toHaveLength(10);
      expect(stratified.middleIds).toHaveLength(10);
      expect(stratified.tailIds).toHaveLength(10);
      expect(stratified.selectedIds).toHaveLength(30);
      expect(stratified.topIds[0]).toBe('100000');
      expect(stratified.tailIds[9]).toBe('100249');
      // Zéro doublon entre les 3 strates
      expect(new Set(stratified.selectedIds).size).toBe(30);

      const smallIds = Array.from({ length: 18 }, (_, idx) => String(200000 + idx));
      const smallStratified = selectStratifiedPmids(smallIds, 10);
      expect(smallStratified.selectedIds).toEqual(smallIds);
      expect(smallStratified.topIds).toHaveLength(10);
      expect(smallStratified.middleIds).toHaveLength(8);
      expect(smallStratified.tailIds).toHaveLength(0);
    });

    it('doit préserver le champ doi dans initializeUnscreenedArticles', () => {
      const initialized = initializeUnscreenedArticles([
        {
          pmid: '40999888',
          doi: '10.1001/jama.2025.1234',
          title: 'Clinical Trial Title',
          authors: 'Martin A',
          source: 'JAMA',
          pubDate: '2025',
          abstract: 'Clean structured abstract text.',
          meshHeadings: ['Humans']
        }
      ]);
      expect(initialized).toHaveLength(1);
      expect(initialized[0].doi).toBe('10.1001/jama.2025.1234');
      expect(initialized[0].status).toBe('pending');
      expect(initialized[0].url).toBe('https://pubmed.ncbi.nlm.nih.gov/40999888/');
    });

    it('doit calculer sans erreur generatePrismaSummaryData avec customScreenedArticles et préserver le total PubMed réel', () => {
      const customScreened: ScreenedArticle[] = [
        {
          pmid: '1',
          title: 'Included Study',
          authors: 'A',
          source: 'BMJ',
          pubDate: '2024',
          abstract: 'Included abstract text.',
          meshHeadings: [],
          status: 'included',
          url: 'https://pubmed.ncbi.nlm.nih.gov/1/',
          evaluatedBy: 'manual'
        },
        {
          pmid: '2',
          title: 'Maybe Study',
          authors: 'B',
          source: 'BMJ',
          pubDate: '2024',
          abstract: '',
          meshHeadings: [],
          status: 'maybe',
          url: 'https://pubmed.ncbi.nlm.nih.gov/2/',
          evaluatedBy: 'gemini'
        },
        {
          pmid: '3',
          title: 'Excluded Study',
          authors: 'C',
          source: 'BMJ',
          pubDate: '2024',
          abstract: 'Excluded abstract text.',
          meshHeadings: [],
          status: 'excluded',
          exclusionReason: 'Hors population',
          url: 'https://pubmed.ncbi.nlm.nih.gov/3/',
          evaluatedBy: 'gemini'
        }
      ];

      const summary = generatePrismaSummaryData(
        { count: 1636 },
        [{ descriptor: 'Heart Failure' }, { descriptor: 'Sodium-Glucose Transporter 2 Inhibitors' }],
        undefined,
        customScreened
      );

      expect(summary.identification.pubmedHits).toBe(1636);
      expect(summary.identification.totalIdentified).toBe(1636);
      expect(summary.screening.recordsScreened).toBe(3);
      expect(summary.screening.recordsExcluded).toBe(1);
      expect(summary.eligibility.fullTextAssessed).toBe(2); // included + maybe
      expect(summary.included.studiesIncluded).toBe(1);
      expect(summary.included.meshDescriptorsUsed).toBe(2);
    });

    it('doit sélectionner uniquement 50 notices pending et préserver les décisions manuelles ou Rayyan lors de la fusion', () => {
      const manualArt: ScreenedArticle = {
        pmid: 'manual-1',
        title: 'Manual Included',
        authors: 'A',
        source: 'Lancet',
        pubDate: '2025',
        abstract: 'Abstract',
        meshHeadings: [],
        status: 'included',
        exclusionReason: 'Inclus manuellement',
        url: 'https://pubmed.ncbi.nlm.nih.gov/manual-1/',
        evaluatedBy: 'manual'
      };
      const rayyanArt: ScreenedArticle = {
        pmid: 'rayyan-1',
        title: 'Rayyan Excluded',
        authors: 'B',
        source: 'Lancet',
        pubDate: '2025',
        abstract: 'Abstract',
        meshHeadings: [],
        status: 'excluded',
        exclusionReason: 'Rayyan: hors sujet',
        url: 'https://pubmed.ncbi.nlm.nih.gov/rayyan-1/',
        evaluatedBy: 'rayyan'
      };
      const pendingArts: ScreenedArticle[] = Array.from({ length: 65 }, (_, i) => ({
        pmid: `pending-${i + 1}`,
        title: `Pending ${i + 1}`,
        authors: 'C',
        source: 'BMJ',
        pubDate: '2025',
        abstract: 'Abstract text',
        meshHeadings: [],
        status: 'pending',
        url: `https://pubmed.ncbi.nlm.nih.gov/pending-${i + 1}/`
      }));

      const cohort = [manualArt, rayyanArt, ...pendingArts];
      const batch = selectPendingArticlesBatch(cohort, 50);
      expect(batch).toHaveLength(50);
      expect(batch.every(a => a.status === 'pending')).toBe(true);
      expect(batch.some(a => a.pmid === 'manual-1' || a.pmid === 'rayyan-1')).toBe(false);

      // Fusion d'une mise à jour IA sur un pending -> appliquée
      const afterPendingUpdate = mergeScreenedArticleUpdate(cohort, {
        ...pendingArts[0],
        status: 'included',
        evaluatedBy: 'gemini'
      });
      expect(afterPendingUpdate.find(a => a.pmid === 'pending-1')?.status).toBe('included');

      // Tentative d'écrasement IA sur une décision manuelle ou Rayyan -> ignorée (préservée)
      const afterProtectedAttempt1 = mergeScreenedArticleUpdate(afterPendingUpdate, {
        ...manualArt,
        status: 'excluded',
        evaluatedBy: 'gemini'
      });
      const afterProtectedAttempt2 = mergeScreenedArticleUpdate(afterProtectedAttempt1, {
        ...rayyanArt,
        status: 'included',
        evaluatedBy: 'gemini'
      });
      expect(afterProtectedAttempt2.find(a => a.pmid === 'manual-1')?.status).toBe('included');
      expect(afterProtectedAttempt2.find(a => a.pmid === 'manual-1')?.evaluatedBy).toBe('manual');
      expect(afterProtectedAttempt2.find(a => a.pmid === 'rayyan-1')?.status).toBe('excluded');
      expect(afterProtectedAttempt2.find(a => a.pmid === 'rayyan-1')?.evaluatedBy).toBe('rayyan');
    });
  });

  describe('14. Étape 4 (Passe A) — PubmedBookArticle, PublicationType NLM, Plan d\'étude & Cohérence PRISMA', () => {
    it('doit parser un <PubmedBookArticle> (NCBI Bookshelf) et extraire <PublicationTypeList><PublicationType>', () => {
      const mixedXml = `<?xml version="1.0" encoding="UTF-8"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation Status="MEDLINE">
      <PMID Version="1">40222333</PMID>
      <Article>
        <Journal>
          <JournalIssue><PubDate><Year>2025</Year><Month>Mar</Month></PubDate></JournalIssue>
          <ISOAbbreviation>Eur Heart J</ISOAbbreviation>
        </Journal>
        <ArticleTitle>2025 ESC Guidelines on heart failure management.</ArticleTitle>
        <Abstract><AbstractText>Updated clinical practice recommendations.</AbstractText></Abstract>
        <AuthorList><Author><CollectiveName>ESC Task Force</CollectiveName></Author></AuthorList>
        <PublicationTypeList>
          <PublicationType UI="D016428">Journal Article</PublicationType>
          <PublicationType UI="D017065">Practice Guideline</PublicationType>
        </PublicationTypeList>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
  <PubmedBookArticle>
    <BookDocument>
      <PMID Version="1">32491500</PMID>
      <ArticleIdList>
        <ArticleId IdType="pubmed">32491500</ArticleId>
        <ArticleId IdType="bookaccession">NBK557568</ArticleId>
      </ArticleIdList>
      <Book>
        <Publisher><PublisherName>StatPearls Publishing</PublisherName></Publisher>
        <BookTitle book="statpearls">StatPearls</BookTitle>
        <PubDate><Year>2024</Year><Month>Jan</Month></PubDate>
      </Book>
      <ArticleTitle>Drug-Induced Parkinsonism</ArticleTitle>
      <AuthorList Type="authors">
        <Author><LastName>Ward</LastName><Initials>KM</Initials></Author>
        <Author><LastName>Citrome</LastName><Initials>L</Initials></Author>
      </AuthorList>
      <PublicationType UI="D016454">Review</PublicationType>
      <Abstract>
        <AbstractText>Drug-induced parkinsonism is the second most common cause of parkinsonism.</AbstractText>
      </Abstract>
    </BookDocument>
  </PubmedBookArticle>
</PubmedArticleSet>`;

      const parsed = parsePubMedEfetchXml(mixedXml);
      expect(parsed).toHaveLength(2);

      const guideline = parsed[0];
      expect(guideline.pmid).toBe('40222333');
      expect(guideline.publicationTypes).toEqual(['Journal Article', 'Practice Guideline']);

      const book = parsed[1];
      expect(book.pmid).toBe('32491500');
      expect(book.title).toBe('Drug-Induced Parkinsonism');
      expect(book.source).toBe('StatPearls');
      expect(book.pubDate).toBe('2024 Jan');
      expect(book.authors).toBe('Ward KM, Citrome L');
      expect(book.publicationTypes).toEqual(['Review']);
      expect(book.abstract).toContain('second most common cause of parkinsonism');

      const initialized = initializeUnscreenedArticles(parsed);
      expect(initialized[0].publicationTypes).toEqual(['Journal Article', 'Practice Guideline']);
      expect(initialized[1].publicationTypes).toEqual(['Review']);
    });

    it('doit classer prioritairement via publicationTypes NLM et replier par défaut vers other (jamais rct)', () => {
      // Priorité aux types officiels NLM
      expect(
        inferStudyDesignFromText('Ambiguous title', 'Short text', ['Journal Article', 'Systematic Review', 'Review'])
      ).toBe('review');
      expect(
        inferStudyDesignFromText('Ambiguous title', 'Short text', ['Journal Article', 'Multicenter Study', 'Randomized Controlled Trial'])
      ).toBe('rct');
      expect(
        inferStudyDesignFromText('Ambiguous title', 'Short text', ['Journal Article', 'Observational Study'])
      ).toBe('observational');
      expect(
        inferStudyDesignFromText('Review of heart failure therapeutics', 'Narrative overview.', ['Journal Article', 'Review'])
      ).toBe('other');
      expect(
        inferStudyDesignFromText('2025 Clinical Guidelines', 'Expert consensus.', ['Practice Guideline'])
      ).toBe('other');
      expect(
        inferStudyDesignFromText('Unusual adverse event', 'A 65-year-old patient presented...', ['Case Reports'])
      ).toBe('other');

      // Sans publicationTypes concluant : un texte narratif / guideline / non classifiable doit tomber en 'other'
      expect(inferStudyDesignFromText('State of the art overview of gliflozins', 'We discuss mechanisms of action.')).toBe('other');
      expect(inferStudyDesignFromText('2025 ESC/EASD Guideline update', 'Consensus recommendations.', ['Journal Article'])).toBe('other');
    });

    it('doit normaliser (trim) et trier exclusionBreakdown par effectif décroissant dans computeScreeningMetrics', () => {
      const makeExcl = (pmid: string, reason: string): ScreenedArticle => ({
        pmid,
        title: `Study ${pmid}`,
        authors: 'A',
        source: 'BMJ',
        pubDate: '2025',
        abstract: 'Abstract',
        meshHeadings: [],
        status: 'excluded',
        exclusionReason: reason,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      });

      const metrics = computeScreeningMetrics([
        makeExcl('1', 'Modèle animal'),
        makeExcl('2', ' Population hors périmètre '),
        makeExcl('3', 'Population hors périmètre'),
        makeExcl('4', 'Population hors périmètre'),
        makeExcl('5', 'Revue narrative'),
        makeExcl('6', 'Revue narrative')
      ]);

      expect(metrics.exclusionBreakdown.map(b => [b.reason, b.count])).toEqual([
        ['Population hors périmètre', 3],
        ['Revue narrative', 2],
        ['Modèle animal', 1]
      ]);
    });

    it('doit injecter le vrai PICO, Embase, les motifs réels et séparer pendingFullText de excludedFullText dans generatePrismaReportText', () => {
      const report = generatePrismaReportText(
        '("Heart Failure"[Mesh]) AND ("Empagliflozin"[tw])',
        {
          identifiedTotal: 750,
          pubmedCount: 750,
          embaseCount: 0,
          duplicatesRemoved: 0,
          screened: 750,
          excludedScreening: 282,
          fullTextAssessed: 468,
          pendingFullText: 45,
          excludedFullText: 0,
          includedFinal: 423,
          exclusionBreakdown: [
            { reason: 'Population hors périmètre', count: 150 },
            { reason: 'Modèle animal ou in vitro', count: 80 }
          ]
        },
        {
          pico: {
            p: 'Adultes avec insuffisance cardiaque chronique',
            i: 'Inhibiteurs de SGLT2 (empagliflozine, dapagliflozine)',
            c: 'Placebo ou traitement standard',
            o: 'Hospitalisation pour insuffisance cardiaque et mortalité cardiovasculaire'
          },
          embaseQuery: "('heart failure'/exp) AND ('sodium glucose cotransporter 2 inhibitor'/exp)",
          cochraneQuery: '([mh "Heart Failure"]) AND ([mh "Sodium-Glucose Transporter 2 Inhibitors"])'
        }
      );

      expect(report).toContain('Adultes avec insuffisance cardiaque chronique');
      expect(report).toContain('Inhibiteurs de SGLT2 (empagliflozine, dapagliflozine)');
      expect(report).toContain("('heart failure'/exp) AND ('sodium glucose cotransporter 2 inhibitor'/exp)");
      expect(report).toContain('([mh "Heart Failure"]) AND ([mh "Sodium-Glucose Transporter 2 Inhibitors"])');
      expect(report).not.toContain('Population (P)                  : Non spécifiée');
      expect(report).not.toContain('[la pathologie]');
      expect(report).toContain('En attente de vérification sur texte intégral (À vérifier) : 45');
      expect(report).toContain('6. Textes intégraux exclus : 0');
      expect(report).toContain('Population hors périmètre (n = 150)');
      expect(report).not.toContain('Titre/résumé non pertinent');
    });
  });

  describe('15. Étape 4 (Passe B) — Lots de pré-repérage des biais, AbortSignal & Matrice de synthèse', () => {
    it('doit exclure les formats other et préserver les études déjà évaluées dans selectUnassessedRobBatch', () => {
      const rctEvaluatedManual = {
        pmid: '1001',
        title: 'Randomized controlled trial of drug A',
        abstract: 'Double-blind RCT.',
        publicationTypes: ['Randomized Controlled Trial']
      };
      const guidelineOther = {
        pmid: '1002',
        title: '2025 Clinical practice guideline on heart failure',
        abstract: 'Consensus expert statement.',
        publicationTypes: ['Practice Guideline']
      };
      const narrativeOther = {
        pmid: '1003',
        title: 'Narrative overview of drug mechanisms',
        abstract: 'General discussion.',
        publicationTypes: ['Review']
      };
      const eligiblePending = Array.from({ length: 25 }, (_, i) => ({
        pmid: `200${i}`,
        title: `Retrospective cohort study #${i + 1}`,
        abstract: 'Observational cohort study.',
        publicationTypes: ['Observational Study']
      }));

      const existing = {
        '1001': {
          pmid: '1001',
          d1: 'low' as const,
          d2: 'low' as const,
          d3: 'low' as const,
          d4: 'low' as const,
          d5: 'low' as const,
          overall: 'low' as const,
          studyDesign: 'rct' as const,
          evaluatedBy: 'Manuel'
        }
      };

      const batch20 = selectUnassessedRobBatch(
        [rctEvaluatedManual, guidelineOther, narrativeOther, ...eligiblePending],
        existing,
        20
      );

      expect(batch20).toHaveLength(20);
      expect(batch20.some(a => a.pmid === '1001')).toBe(false);
      expect(batch20.some(a => a.pmid === '1002' || a.pmid === '1003')).toBe(false);
      expect(batch20[0].pmid).toBe('2000');

      const allEligible = selectUnassessedRobBatch(
        [rctEvaluatedManual, guidelineOther, narrativeOther, ...eligiblePending],
        existing
      );
      expect(allEligible).toHaveLength(25);
    });

    it('doit interrompre immédiatement aiEvaluateBatchRoB2 avec AbortError lorsque AbortSignal est déclenché', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        aiEvaluateBatchRoB2(
          [
            {
              pmid: '40555666',
              title: 'Randomized trial of SGLT2 inhibitors',
              abstract: 'Double-blind randomized controlled trial.',
              publicationTypes: ['Randomized Controlled Trial']
            }
          ],
          controller.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('doit classer Hors grille (N/A) les formats other dans buildReadingMatrixRows et les exports CSV/Markdown', () => {
      const articlesWithOther: ScreenedArticle[] = [
        {
          pmid: '50001',
          title: '2025 ESC Guidelines on chronic heart failure',
          authors: 'Task Force ESC',
          source: 'Eur Heart J',
          pubDate: '2025',
          abstract: 'Consensus guideline recommendations for clinical practice.',
          meshHeadings: [],
          publicationTypes: ['Practice Guideline'],
          status: 'included',
          url: 'https://pubmed.ncbi.nlm.nih.gov/50001/',
          evaluatedBy: 'manual'
        },
        {
          pmid: '50002',
          title: 'Empagliflozin in heart failure: a randomized controlled trial',
          authors: 'Anker SD',
          source: 'N Engl J Med',
          pubDate: '2024',
          abstract: 'Double-blind trial in 5988 patients.',
          meshHeadings: [],
          publicationTypes: ['Randomized Controlled Trial'],
          status: 'maybe',
          url: 'https://pubmed.ncbi.nlm.nih.gov/50002/',
          evaluatedBy: 'gemini'
        }
      ];

      const includedOnly = buildReadingMatrixRows(articlesWithOther, {});
      expect(includedOnly).toHaveLength(1);
      expect(includedOnly[0].riskOfBiasOverall).toBe('na');
      expect(includedOnly[0].studyDesign).toBe('other');

      const withMaybe = buildReadingMatrixRows(articlesWithOther, {}, { includeMaybe: true });
      expect(withMaybe).toHaveLength(2);
      expect(withMaybe[1].riskOfBiasOverall).toBe('unassessed');

      const csv = exportReadingMatrixCsv(withMaybe);
      expect(csv).toContain('Hors grille (N/A)');
      expect(csv).toContain('Non évalué');
      expect(csv).not.toContain('Population & Exposition');

      const md = exportReadingMatrixMarkdown(withMaybe);
      expect(md).toContain('Hors grille (N/A)');
      expect(md).toContain('À vérifier');
      expect(md).not.toMatch(/[🟢🟡🔴⚪]/u);
    });
  });

  describe('16. Étape 2 — PubMed esearch POST (> 4 000 car.), erreurs HTTP explicites & non-convergence UI', () => {
    it('doit envoyer esearch.fcgi en POST (x-www-form-urlencoded) même sur une équation > 4 000 caractères', async () => {
      const longSynonyms = Array.from({ length: 120 }, (_, i) => `"clinical synonym term number ${i + 1}"[tiab]`).join(' OR ');
      const longQuery = `("Diabetes Mellitus, Type 2"[Mesh] OR ${longSynonyms}) AND ("Sodium-Glucose Transporter 2 Inhibitors"[Mesh])`;
      expect(longQuery.length).toBeGreaterThan(4000);

      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('esearch.fcgi')) {
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '412',
                querytranslation: longQuery,
                idlist: ['40111222']
              }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            result: {
              '40111222': {
                title: 'SGLT2 inhibitors in type 2 diabetes and chronic kidney disease',
                authors: [{ name: 'Perkovic V' }],
                source: 'N Engl J Med',
                pubdate: '2024'
              }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;
      try {
        const res = await queryPubMedLive(longQuery);
        expect(res.error).toBeNull();
        expect(res.count).toBe(412);
        expect(res.idList).toEqual(['40111222']);

        const esearchCall = fetchMock.mock.calls.find(([u]) => String(u).includes('esearch.fcgi'));
        expect(esearchCall).toBeDefined();
        const [calledUrl, calledInit] = esearchCall!;
        expect(String(calledUrl)).not.toContain('term=');
        expect(calledInit?.method).toBe('POST');
        const headers = calledInit?.headers as Record<string, string>;
        expect(headers['Content-Type']).toContain('application/x-www-form-urlencoded');
        const bodyParams = new URLSearchParams(String(calledInit?.body || ''));
        expect(bodyParams.get('db')).toBe('pubmed');
        expect(bodyParams.get('term')).toBe(longQuery);
        expect(bodyParams.get('retmode')).toBe('json');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('doit remonter une erreur explicite (et jamais 0 notice silencieux) en cas d\'échec HTTP sur esearch', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('URI Too Long', { status: 414 })
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;
      try {
        const res = await queryPubMedLive('("Heart Failure"[Mesh])');
        expect(res.error).toBeTruthy();
        expect(res.error).toContain('HTTP 414');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('ne doit jamais afficher Stratégie convergée si revision_required, 0 notice ou erreur PubMed même après >= 2 affinages', () => {
      expect(
        shouldDisplayStrategyConverged({
          pressStatus: 'revision_required',
          refinementCount: 2,
          hitCount: 0,
          pubmedError: null
        })
      ).toBe(false);

      expect(
        shouldDisplayStrategyConverged({
          pressStatus: 'revision_required',
          refinementCount: 3,
          hitCount: 150,
          pubmedError: null
        })
      ).toBe(false);

      expect(
        shouldDisplayStrategyConverged({
          pressStatus: 'compliant',
          refinementCount: 2,
          hitCount: 0,
          pubmedError: null
        })
      ).toBe(false);

      expect(
        shouldDisplayStrategyConverged({
          pressStatus: 'compliant',
          refinementCount: 1,
          hitCount: 320,
          pubmedError: 'Erreur lors de l\'interrogation PubMed (HTTP 503).'
        })
      ).toBe(false);

      // Cas légitimement convergés
      expect(
        shouldDisplayStrategyConverged({
          pressStatus: 'compliant',
          refinementCount: 1,
          hitCount: 320,
          pubmedError: null
        })
      ).toBe(true);

      expect(
        shouldDisplayStrategyConverged({
          pressStatus: 'needs_refinement',
          refinementCount: 2,
          hitCount: 320,
          pubmedError: null
        })
      ).toBe(true);
    });
  });

  describe('17. Paramètres & API — Test de connexion IA réel (testAiConnectionLive)', () => {
    it('doit retourner online: true avec le modèle et la latence en cas de succès HTTP 200', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ name: 'models/gemini-pro-latest' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;
      try {
        const res = await testAiConnectionLive({
          provider: 'gemini',
          geminiApiKey: 'AIzaSyTestKey1234567890',
          geminiModel: 'gemini-pro-latest',
          routingMode: 'smart'
        });
        expect(res.online).toBe(true);
        expect(res.httpStatus).toBe(200);
        expect(typeof res.latencyMs).toBe('number');
        expect(res.message).toContain('gemini-pro-latest');
        expect(res.message).toContain('ms');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('doit retourner online: false avec erreur explicite en cas de HTTP 401/403 ou clé absente', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'API key not valid.' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;
      try {
        const res403 = await testAiConnectionLive({
          provider: 'gemini',
          geminiApiKey: 'AIzaSyInvalidKey1234567',
          geminiModel: 'gemini-pro-latest',
          routingMode: 'smart'
        });
        expect(res403.online).toBe(false);
        expect(res403.httpStatus).toBe(403);
        expect(res403.message).toContain('403');

        const resOpenai401 = await testAiConnectionLive({
          provider: 'openai',
          openaiApiKey: 'sk-proj-invalid123456',
          openaiModel: 'gpt-4o',
          routingMode: 'smart'
        });
        expect(resOpenai401.online).toBe(false);

        const resMissing = await testAiConnectionLive({
          provider: 'anthropic',
          anthropicApiKey: '',
          anthropicModel: 'claude-3-5-sonnet-latest',
          routingMode: 'smart'
        });
        expect(resMissing.online).toBe(false);
        expect(resMissing.message).toContain('manquante');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('doit débloquer la configuration initiale dès qu\'une clé IA valide est fournie sans exiger NCBI ni HeTOP', () => {
      expect(canUnlockPrerequisitesModal({ activeKey: '', testedStatus: null })).toBe(false);
      expect(canUnlockPrerequisitesModal({ activeKey: 'short', testedStatus: null })).toBe(false);
      expect(canUnlockPrerequisitesModal({ activeKey: 'AIzaSyValidKey123456', testedStatus: null })).toBe(true);
      expect(
        canUnlockPrerequisitesModal({
          activeKey: 'AIzaSyInvalidKey123456',
          testedStatus: {
            online: false,
            provider: 'Google Gemini',
            models: [],
            activeModel: 'gemini-pro-latest',
            routingMode: 'smart',
            httpStatus: 403,
            message: 'Clé API Google Gemini invalide (HTTP 403).'
          }
        })
      ).toBe(false);
      expect(
        canUnlockPrerequisitesModal({
          activeKey: 'AIzaSyValidKey123456',
          testedStatus: {
            online: true,
            provider: 'Google Gemini',
            models: [],
            activeModel: 'gemini-pro-latest',
            routingMode: 'smart',
            httpStatus: 200,
            latencyMs: 120,
            message: 'Connecté · gemini-pro-latest (120 ms)'
          }
        })
      ).toBe(true);
    });
  });

  describe('Lot 3 · Traduction Multi-Bases Embase / CENTRAL & Contrôleur Déterministe', () => {
    const sampleBlocks: MappedBlock[] = [
      {
        picoType: 'P',
        originalText: 'Parkinsonisme secondaire induit chimiquement',
        descriptor: 'Parkinson Disease, Secondary',
        meshId: 'D010302',
        descriptors: [
          { descriptor: 'Parkinson Disease, Secondary', meshId: 'D010302', noExp: false, isMajor: false }
        ],
        entryTerms: ['secondary parkinsonism'],
        truncationTerms: [],
        selectedQualifiers: ['chemically induced', 'drug therapy']
      }
    ];

    it('applique NOT ((\'animal\'/exp OR \'nonhuman\'/exp) NOT \'human\'/exp) sur Embase et NOT ([mh "Animals"] NOT [mh "Humans"]) sur CENTRAL uniquement quand humans_cochrane est actif', () => {
      const withCochraneFilter = buildQuerySyntax(sampleBlocks, {
        strategy: 'balanced',
        useTruncation: false,
        filters: ['humans_cochrane']
      });
      expect(withCochraneFilter.embaseQuery).toContain(
        "NOT (('animal'/exp OR 'nonhuman'/exp) NOT 'human'/exp)"
      );
      expect(withCochraneFilter.cochraneQuery).toContain(
        'NOT ([mh "Animals"] NOT [mh "Humans"])'
      );

      const withoutCochraneFilter = buildQuerySyntax(sampleBlocks, {
        strategy: 'balanced',
        useTruncation: false,
        filters: ['rct']
      });
      expect(withoutCochraneFilter.embaseQuery).not.toContain("'nonhuman'/exp");
      expect(withoutCochraneFilter.cochraneQuery).not.toContain('[mh "Animals"]');
      expect(withoutCochraneFilter.cochraneQuery).not.toContain('[mh "Humans"]');

      const emptyFilters = buildQuerySyntax(sampleBlocks, {
        strategy: 'balanced',
        useTruncation: false,
        filters: []
      });
      expect(emptyFilters.cochraneQuery).not.toContain('Animals');
    });

    it('déduplique \'descriptor\'/exp sur Embase lorsqu\'un descripteur possède plusieurs sous-descripteurs actifs', () => {
      const compiled = compileAxisBlockRust({
        axisRole: 'pathology_outcome',
        impliedSubheadings: [],
        descriptors: [
          {
            descriptor: 'Parkinson Disease, Secondary',
            meshId: 'D010302',
            allowedSubheadings: ['chemically induced', 'drug therapy'],
            selectedSubheadings: ['chemically induced', 'drug therapy'],
            treeNumbers: ['C10.228.140.079.862.500'],
            isPharmacologicalSubstance: false,
            noExp: false,
            isMajor: false
          }
        ],
        entryTerms: ['secondary parkinsonism'],
        rawClinicalTokens: [],
        customTruncations: []
      });

      const matches = compiled.embaseClause.match(/'parkinson disease, secondary'\/exp/g) || [];
      expect(matches).toHaveLength(1);
    });

    it('contrôle déterministement Embase.com et Cochrane CENTRAL sans aucun appel LLM', () => {
      const embaseClean = auditMultiBaseTranslationDeterministic({
        target: 'embase',
        query: "('low back pain'/exp OR 'low back pain':ti,ab,kw,de)\nNOT (('animal'/exp OR 'nonhuman'/exp) NOT 'human'/exp)",
        hasHumansCochraneFilter: true
      });
      expect(embaseClean.hasWarnings).toBe(false);
      expect(embaseClean.checks.map((c) => c.code)).toEqual([
        'embase_syntax_ok',
        'embase_emtree_candidates_info',
        'embase_nonhuman_ok'
      ]);

      const embaseInverted = auditMultiBaseTranslationDeterministic({
        target: 'embase',
        query: "('parkinson disease, secondary'/exp OR 'secondary parkinsonism':ti,ab,kw,de)\nNOT ('animal'/exp NOT 'human'/exp)",
        hasHumansCochraneFilter: true
      });
      expect(embaseInverted.hasWarnings).toBe(true);
      const invertedCheck = embaseInverted.checks.find(
        (c) => c.code === 'embase_inverted_comma_warning'
      );
      expect(invertedCheck?.examples).toContain("'parkinson disease, secondary'/exp");
      expect(embaseInverted.checks.some((c) => c.code === 'embase_nonhuman_missing_warning')).toBe(
        true
      );

      const embaseDefective = auditMultiBaseTranslationDeterministic({
        target: 'embase',
        query: '("Diabetes Mellitus"[Mesh] OR \'unclosed:ti,ab,kw,de)'
      });
      expect(embaseDefective.hasWarnings).toBe(true);
      expect(embaseDefective.checks.some((c) => c.code === 'embase_pubmed_tag_leak')).toBe(true);
      expect(embaseDefective.checks.some((c) => c.code === 'embase_syntax_unbalanced')).toBe(true);

      const cochraneClean = auditMultiBaseTranslationDeterministic({
        target: 'cochrane',
        query: '([mh "Low Back Pain"] OR "low back pain":ti,ab,kw)\nNOT ([mh "Animals"] NOT [mh "Humans"])',
        hasHumansCochraneFilter: true,
        hasDateRange: true
      });
      expect(cochraneClean.hasWarnings).toBe(false);
      expect(cochraneClean.checks.map((c) => c.code)).toEqual([
        'cochrane_syntax_ok',
        'cochrane_animal_filter_ok',
        'cochrane_date_range_info'
      ]);

      const cochraneDefective = auditMultiBaseTranslationDeterministic({
        target: 'cochrane',
        query: "('low back pain'/exp OR [mh \"Low Back Pain\")",
        hasHumansCochraneFilter: true
      });
      expect(cochraneDefective.hasWarnings).toBe(true);
      expect(cochraneDefective.checks.some((c) => c.code === 'cochrane_foreign_tag_leak')).toBe(
        true
      );
      expect(cochraneDefective.checks.some((c) => c.code === 'cochrane_syntax_unbalanced')).toBe(
        true
      );
      expect(
        cochraneDefective.checks.some((c) => c.code === 'cochrane_animal_filter_missing_warning')
      ).toBe(true);
    });
  });
});
