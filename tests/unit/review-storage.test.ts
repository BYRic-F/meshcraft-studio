import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACTIVE_DRAFT_ID,
  SavedReviewSnapshot,
  listReviews,
  saveReview,
  deleteReview,
  saveActiveDraft,
  loadActiveDraft,
  clearActiveDraft,
  serializeReviewToJson,
  parseAndValidateReviewJson,
  resetInMemoryReviewStoreForTests
} from '../../src/services/reviewStorageService';

function buildSampleSnapshot(id: string, title: string, updatedAt = Date.now()): SavedReviewSnapshot {
  return {
    schemaVersion: 1,
    id,
    title,
    createdAt: updatedAt - 1000,
    updatedAt,
    wizardStep: 3,
    summary: {
      pubmedHits: 750,
      loadedArticlesCount: 2,
      screenedCount: 2,
      includedCount: 1,
      robAssessedCount: 1
    },
    picoInputs: {
      p: 'Adultes avec insuffisance cardiaque chronique',
      i: 'Inhibiteurs de SGLT2',
      c: 'Placebo',
      o: 'Hospitalisation et mortalité cardiovasculaire',
      not: ''
    },
    searchSettings: {
      strategy: 'balanced',
      filters: ['humans_cochrane'],
      activePico: { p: true, i: true, c: false, o: true, not: false },
      useTruncation: true
    },
    resultData: {
      mappedBlocks: [
        {
          picoType: 'P',
          originalText: 'Insuffisance cardiaque chronique',
          descriptor: 'Heart Failure',
          meshId: 'D006333',
          entryTerms: ['heart failure', 'cardiac failure']
        }
      ],
      pubmedQuery: '("Heart Failure"[Mesh]) AND ("Sodium-Glucose Transporter 2 Inhibitors"[Mesh])',
      embaseQuery: "('heart failure'/exp) AND ('sodium glucose cotransporter 2 inhibitor'/exp)",
      cochraneQuery: '([mh "Heart Failure"]) AND ([mh "Sodium-Glucose Transporter 2 Inhibitors"])',
      liveResult: {
        count: 750,
        queryTranslation: '("Heart Failure"[Mesh])',
        articles: [],
        idList: ['40111222', '40111223'],
        error: null
      },
      critiqueReport: {
        score: 92,
        observations: [],
        recommendations: [],
        pressBreakdown: [],
        pressStatus: 'compliant',
        pressAlertCount: 0,
        source: 'rules'
      }
    },
    refinementCount: 1,
    screenedArticles: [
      {
        pmid: '40111222',
        doi: '10.1056/NEJMoa2107038',
        title: 'Empagliflozin in Heart Failure',
        authors: 'Anker SD',
        source: 'N Engl J Med',
        pubDate: '2024',
        abstract: 'Randomized controlled trial of empagliflozin.',
        meshHeadings: ['Heart Failure', 'Humans'],
        publicationTypes: ['Randomized Controlled Trial'],
        status: 'included',
        evidenceSnippet: 'Primary outcome reduced significantly.',
        url: 'https://pubmed.ncbi.nlm.nih.gov/40111222/',
        evaluatedBy: 'manual'
      },
      {
        pmid: '40111223',
        title: 'Animal rat model of cardiac hypertrophy',
        authors: 'Doe J',
        source: 'Cardiovasc Res',
        pubDate: '2023',
        abstract: 'Murine experiment.',
        meshHeadings: ['Animals'],
        publicationTypes: ['Journal Article'],
        status: 'excluded',
        exclusionReason: 'Modèle animal',
        url: 'https://pubmed.ncbi.nlm.nih.gov/40111223/',
        evaluatedBy: 'gemini'
      }
    ],
    robEvaluations: {
      '40111222': {
        pmid: '40111222',
        d1: 'low',
        d2: 'low',
        d3: 'low',
        d4: 'low',
        d5: 'low',
        overall: 'low',
        studyDesign: 'rct',
        justification: 'Double-blind RCT registered on ClinicalTrials.gov.',
        evaluatedBy: 'Manuel'
      }
    }
  };
}

describe('Service de persistance complète des revues (reviewStorageService)', () => {
  beforeEach(() => {
    resetInMemoryReviewStoreForTests();
  });

  it('doit sauvegarder, lister, mettre à jour et supprimer des revues nommées', async () => {
    const rev1 = buildSampleSnapshot('rev-1', 'Revue SGLT2i', 1000);
    const rev2 = buildSampleSnapshot('rev-2', 'Revue Jeûne intermittent', 2000);

    await saveReview(rev1);
    await saveReview(rev2);

    const listed = await listReviews();
    expect(listed).toHaveLength(2);
    expect(listed.map(r => r.id)).toContain('rev-1');
    expect(listed.map(r => r.id)).toContain('rev-2');

    // Mise à jour de rev-1
    await saveReview({ ...rev1, title: 'Revue SGLT2i — v2', wizardStep: 4 });
    const afterUpdate = await listReviews();
    const updatedRev1 = afterUpdate.find(r => r.id === 'rev-1');
    expect(updatedRev1?.title).toBe('Revue SGLT2i — v2');
    expect(updatedRev1?.wizardStep).toBe(4);
    expect(updatedRev1?.summary.includedCount).toBe(1);
    expect(updatedRev1?.summary.screenedCount).toBe(2);
    expect(updatedRev1?.summary.robAssessedCount).toBe(1);

    // Suppression de rev-2
    await deleteReview('rev-2');
    const afterDelete = await listReviews();
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].id).toBe('rev-1');
  });

  it('doit gérer le brouillon actif anti-F5 et exclure strictement __active_draft__ de listReviews()', async () => {
    const rev = buildSampleSnapshot('rev-named', 'Revue nommée');
    await saveReview(rev);

    const { id: _ignored, ...draftData } = buildSampleSnapshot('tmp', 'Brouillon en cours');
    void _ignored;
    await saveActiveDraft(draftData);

    const loadedDraft = await loadActiveDraft();
    expect(loadedDraft).not.toBeNull();
    expect(loadedDraft?.id).toBe(ACTIVE_DRAFT_ID);
    expect(loadedDraft?.title).toBe('Brouillon en cours');
    expect(loadedDraft?.screenedArticles).toHaveLength(2);

    // listReviews() ne doit jamais exposer __active_draft__
    const namedReviews = await listReviews();
    expect(namedReviews).toHaveLength(1);
    expect(namedReviews.some(r => r.id === ACTIVE_DRAFT_ID)).toBe(false);

    await clearActiveDraft();
    expect(await loadActiveDraft()).toBeNull();
  });

  it('doit assurer un aller-retour serializeReviewToJson / parseAndValidateReviewJson fidèle sans aucune clé API', () => {
    const base = buildSampleSnapshot('rev-export', 'Revue complète exportable');
    // Injection simulée de champs sensibles qui doivent être éliminés à la sérialisation
    const polluted = {
      ...base,
      searchSettings: {
        ...base.searchSettings,
        geminiApiKey: 'AIzaSySECRET_SHOULD_NEVER_EXPORT',
        ncbiApiKey: 'NCBI_SECRET_KEY',
        hetopPassword: 'SUPER_SECRET_PASSWORD'
      }
    } as unknown as SavedReviewSnapshot;

    const json = serializeReviewToJson(polluted);
    expect(json).not.toContain('AIzaSySECRET_SHOULD_NEVER_EXPORT');
    expect(json).not.toContain('NCBI_SECRET_KEY');
    expect(json).not.toContain('SUPER_SECRET_PASSWORD');
    expect(json).not.toContain('geminiApiKey');

    const parsed = parseAndValidateReviewJson(json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot.picoInputs.p).toBe('Adultes avec insuffisance cardiaque chronique');
      expect(parsed.snapshot.resultData?.pubmedQuery).toContain('"Heart Failure"[Mesh]');
      expect(parsed.snapshot.screenedArticles).toHaveLength(2);
      expect(parsed.snapshot.screenedArticles[0].status).toBe('included');
      expect(parsed.snapshot.robEvaluations['40111222']?.overall).toBe('low');
    }
  });

  it('doit rejeter proprement un JSON mal formé ou un schéma non pris en charge', () => {
    const emptyRes = parseAndValidateReviewJson('');
    expect(emptyRes.ok).toBe(false);

    const malformedRes = parseAndValidateReviewJson('{ invalid json');
    expect(malformedRes.ok).toBe(false);

    const badVersionRes = parseAndValidateReviewJson(
      JSON.stringify({ schemaVersion: 99, picoInputs: { p: '', i: '', c: '', o: '' }, screenedArticles: [], robEvaluations: {} })
    );
    expect(badVersionRes.ok).toBe(false);
    if (!badVersionRes.ok) {
      expect(badVersionRes.error).toContain('schéma');
    }

    const missingPicoRes = parseAndValidateReviewJson(
      JSON.stringify({ schemaVersion: 1, screenedArticles: [], robEvaluations: {} })
    );
    expect(missingPicoRes.ok).toBe(false);
  });
});
