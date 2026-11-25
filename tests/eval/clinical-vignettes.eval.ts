import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  parseClinicalAbstractNLP,
  runMultiAgentPipeline
} from '../../src/services/multiAgentWorkflow';
import {
  saveAiConfig,
  aiScreenBatchArticles,
  clearAiScreeningCache
} from '../../src/services/localAiService';
import { fetchArticlesDetailsForIds, setNcbiApiKey } from '../../src/services/pubmedApi';
import { clearMeshResolutionCaches } from '../../src/services/meshDatabase';

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim();
const NCBI_API_KEY = (process.env.NCBI_API_KEY || process.env.VITE_NCBI_API_KEY || '').trim();
const HAS_GEMINI_KEY = GEMINI_API_KEY.length > 0;

if (!HAS_GEMINI_KEY) {
  console.warn(
    '[test:eval] Variable GEMINI_API_KEY absente — suite live clinical-vignettes.eval.ts ignorée.'
  );
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

interface EsearchAuditResult {
  readonly count: number;
  readonly idList: readonly string[];
  readonly hasErrorList: boolean;
  readonly errorDetail?: string;
}

async function verifyPubMedEsearchLive(query: string): Promise<EsearchAuditResult> {
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmode: 'json',
    retmax: '20',
    sort: 'relevance',
    tool: 'MeshCraftStudioEval',
    email: 'contact@meshcraft-studio.org'
  });
  if (NCBI_API_KEY) {
    params.set('api_key', NCBI_API_KEY);
  }

  const res = await fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: params.toString(),
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) {
    return {
      count: 0,
      idList: [],
      hasErrorList: true,
      errorDetail: `HTTP ${res.status}`
    };
  }

  const data = (await res.json()) as {
    esearchresult?: {
      count?: string;
      idlist?: string[];
      ERROR?: string;
      errorlist?: {
        phrasesnotfound?: string[];
        fieldsnotfound?: string[];
      };
    };
  };

  const result = data.esearchresult;
  const fieldsNotFound = result?.errorlist?.fieldsnotfound ?? [];
  const hasApiError = Boolean(result?.ERROR) || fieldsNotFound.length > 0;
  const count = Number.parseInt(result?.count || '0', 10);

  return {
    count: Number.isFinite(count) ? count : 0,
    idList: result?.idlist ?? [],
    hasErrorList: hasApiError,
    errorDetail: result?.ERROR || (fieldsNotFound.length > 0 ? `fieldsnotfound: ${fieldsNotFound.join(', ')}` : undefined)
  };
}

describe.skipIf(!HAS_GEMINI_KEY)(
  'Évaluation Live Opt-In · 4 Vignettes Cliniques + Mini-Dépouillement (Gemini + PubMed)',
  () => {
    let vignette3Pmids: readonly string[] = [];

    beforeAll(() => {
      vi.stubGlobal('localStorage', createMemoryStorage());
      clearAiScreeningCache();
      clearMeshResolutionCaches();
      if (NCBI_API_KEY) {
        setNcbiApiKey(NCBI_API_KEY);
      }
      saveAiConfig({
        provider: 'gemini',
        routingMode: 'smart',
        rateLimitMode: 'payg',
        geminiApiKey: GEMINI_API_KEY
      });
    });

    afterAll(() => {
      vi.unstubAllGlobals();
    });

    it('Vignette 1 — PICO médicamenteux avec comparateur (statines vs placebo en prévention cardiovasculaire)', async () => {
      const pipeline = await runMultiAgentPipeline(
        {
          p: 'Patients en prévention cardiovasculaire primaire ou secondaire',
          i: 'Statines',
          c: 'Placebo',
          o: 'Événements cardiovasculaires majeurs et mortalité'
        },
        {
          strategy: 'balanced',
          useTruncation: true,
          filters: ['humans_cochrane'],
          activePico: { p: true, i: true, c: false, o: true, not: false }
        }
      );

      expect(pipeline.pubmedQuery.trim().length).toBeGreaterThan(10);
      const check = await verifyPubMedEsearchLive(pipeline.pubmedQuery);
      expect(check.hasErrorList, check.errorDetail).toBe(false);
      expect(check.count).toBeGreaterThan(10);
    }, 60000);

    it('Vignette 2 — PECO observationnel (IPP vs anti-H2 et insuffisance rénale chronique)', async () => {
      const question =
        "Chez les adultes traités par inhibiteurs de la pompe à protons comparés aux antihistaminiques H2, quel est le risque de survenue d'une insuffisance rénale chronique ?";
      const extracted = await parseClinicalAbstractNLP(question);
      expect(extracted.approach).toBe('peco');

      const pipeline = await runMultiAgentPipeline(
        {
          p: extracted.p,
          i: extracted.i,
          c: extracted.c,
          o: extracted.o,
          not: extracted.not
        },
        {
          strategy: 'balanced',
          useTruncation: true,
          filters: ['humans_cochrane'],
          qualifications: extracted.qualifications,
          activePico: { p: Boolean(extracted.p), i: true, c: Boolean(extracted.c), o: true, not: false }
        }
      );

      expect(pipeline.pubmedQuery.trim().length).toBeGreaterThan(10);
      const check = await verifyPubMedEsearchLive(pipeline.pubmedQuery);
      expect(check.hasErrorList, check.errorDetail).toBe(false);
      expect(check.count).toBeGreaterThan(5);
    }, 60000);

    it('Vignette 3 — PICO non médicamenteux sans comparateur (C vide) avec « chez l’adulte » (lombalgie chronique)', async () => {
      const question =
        "Chez les adultes atteints de lombalgie chronique non spécifique, quel est l'impact de l'éducation thérapeutique du patient sur la douleur et la qualité de vie ?";
      const extracted = await parseClinicalAbstractNLP(question);

      const pipeline = await runMultiAgentPipeline(
        {
          p: extracted.p || 'Adultes atteints de lombalgie chronique non spécifique',
          i: extracted.i || 'Éducation thérapeutique du patient',
          c: '',
          o: extracted.o || 'Douleur et qualité de vie',
          not: ''
        },
        {
          strategy: 'balanced',
          useTruncation: true,
          filters: ['humans_cochrane'],
          activePico: { p: true, i: true, c: false, o: true, not: false }
        }
      );

      const queryWithoutCochraneFilter = pipeline.pubmedQuery.replace(
        /NOT\s*\("Animals"\[Mesh\]\s+NOT\s+"Humans"\[Mesh\]\)/gi,
        ''
      );
      expect(queryWithoutCochraneFilter).not.toMatch(/"Adult"\[Mesh\]/i);
      expect(queryWithoutCochraneFilter).not.toMatch(/"Humans"\[Mesh\]/i);
      expect(queryWithoutCochraneFilter).not.toMatch(/"Middle Aged"\[Mesh\]/i);

      const check = await verifyPubMedEsearchLive(pipeline.pubmedQuery);
      expect(check.hasErrorList, check.errorDetail).toBe(false);
      expect(check.count).toBeGreaterThan(5);
      expect(check.count).toBeLessThan(3500);

      vignette3Pmids = check.idList.slice(0, 12);
    }, 60000);

    it('Vignette 4 — PICO avec sous-population spécifique (enfant asthmatique + corticoïdes inhalés)', async () => {
      const question =
        "Chez l'enfant asthmatique, efficacité des corticoïdes inhalés sur les exacerbations";
      const extracted = await parseClinicalAbstractNLP(question);

      const pipeline = await runMultiAgentPipeline(
        {
          p: extracted.p || 'Enfant asthmatique',
          i: extracted.i || 'Corticoïdes inhalés',
          c: '',
          o: extracted.o || 'Exacerbations',
          not: ''
        },
        {
          strategy: 'balanced',
          useTruncation: true,
          filters: ['humans_cochrane'],
          activePico: { p: true, i: true, c: false, o: true, not: false }
        }
      );

      // Aucune fusion en OR direct entre un descripteur d'âge pédiatrique et "Asthma"[Mesh] dans un même bloc
      const blocks = pipeline.pubmedQuery.split(/\nAND\n/i);
      const asthmaBlock = blocks.find((b) => /"Asthma"\[Mesh\]/i.test(b)) || '';
      expect(asthmaBlock).not.toMatch(/"(?:Child|Child, Preschool|Infant|Adolescent|Pediatrics)"\[Mesh\]/i);

      const check = await verifyPubMedEsearchLive(pipeline.pubmedQuery);
      expect(check.hasErrorList, check.errorDetail).toBe(false);
      expect(check.count).toBeGreaterThan(10);
    }, 60000);

    it('Vignette 5 — Mini-dépouillement réel sur 12 notices de la vignette 3 via aiScreenBatchArticles', async () => {
      expect(vignette3Pmids.length).toBeGreaterThan(0);
      const targetPmids = vignette3Pmids.slice(0, 12);
      const fetched = await fetchArticlesDetailsForIds(targetPmids, { chunkSize: 12 });
      const withAbstract = fetched.filter((a) => a.abstract && a.abstract.trim().length >= 25);
      expect(withAbstract.length).toBeGreaterThan(0);

      const expectedSet = new Set(withAbstract.map((a) => String(a.pmid).trim()));
      const decisions = await aiScreenBatchArticles(
        withAbstract.map((a) => ({
          pmid: a.pmid,
          title: a.title,
          abstract: a.abstract,
          meshHeadings: a.meshHeadings
        })),
        {
          p: 'Adultes atteints de lombalgie chronique non spécifique',
          i: 'Éducation thérapeutique du patient',
          c: '',
          o: 'Douleur et qualité de vie'
        }
      );

      expect(decisions.length).toBeGreaterThan(0);
      for (const d of decisions) {
        expect(expectedSet.has(d.pmid)).toBe(true);
        expect(['included', 'maybe', 'excluded']).toContain(d.status);
      }
    }, 60000);
  }
);
