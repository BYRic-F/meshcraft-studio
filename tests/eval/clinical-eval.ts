import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import {
  parseClinicalAbstractNLP,
  runMultiAgentPipeline,
  ClinicalPicoExtractionResult,
  MappedBlock,
  PipelineSettings
} from '../../src/services/multiAgentWorkflow';
import { saveAiConfig } from '../../src/services/localAiService';
import { isValidTreeNumberForAxis } from '../../src/services/meshDatabase';
import { setNcbiApiKey } from '../../src/services/pubmedApi';
import { setHetopCredentials } from '../../src/services/hetopService';

interface EnvSecrets {
  readonly geminiApiKey: string;
  readonly ncbiApiKey: string;
  readonly hetopUser: string;
  readonly hetopPass: string;
}

interface ScenarioTelemetry {
  llmCalls: number;
  promptTokens: number;
  candidateTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  modelsInvoked: string[];
}

interface ScenarioOutcomeExpectation {
  readonly id: string;
  readonly label: string;
  readonly clinicalProse: string;
  readonly pipelineOverrides?: Partial<PipelineSettings>;
  readonly expectedTargetCheck: (
    blocks: readonly MappedBlock[],
    pubmedQuery: string,
    extracted: ClinicalPicoExtractionResult
  ) => { readonly targetTreeOk: boolean; readonly domainSignalOk: boolean; readonly details: string };
}

interface ScenarioReportRow {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly score: number;
  readonly aiAuditScore: number | null;
  readonly pubmedCount: number;
  readonly latencyMs: number;
  readonly telemetry: ScenarioTelemetry;
  readonly estimatedCostEur: number;
  readonly failureReason?: string;
}

interface GeminiUsageMetadata {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly thoughtsTokenCount?: number;
  readonly totalTokenCount?: number;
}

interface GeminiApiResponseEnvelope {
  readonly usageMetadata?: GeminiUsageMetadata;
}

const GEMINI_FLASH_LITE_INPUT_USD_PER_1M = 0.10;
const GEMINI_FLASH_LITE_OUTPUT_USD_PER_1M = 0.40;
const USD_TO_EUR_RATE = 0.92;

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

function parseDotEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && val) {
      result[key] = val;
    }
  }
  return result;
}

function loadEnvSecrets(): EnvSecrets {
  const cwd = process.cwd();
  const dotEnvLocal = parseDotEnvFile(path.join(cwd, '.env.local'));
  const dotEnv = parseDotEnvFile(path.join(cwd, '.env'));

  const readVar = (name: string): string => {
    const direct = process.env[name];
    if (direct && direct.trim()) return direct.trim();
    if (dotEnvLocal[name]?.trim()) return dotEnvLocal[name].trim();
    if (dotEnv[name]?.trim()) return dotEnv[name].trim();
    return '';
  };

  return {
    geminiApiKey: readVar('GEMINI_API_KEY') || readVar('VITE_GEMINI_API_KEY'),
    ncbiApiKey: readVar('NCBI_API_KEY') || readVar('VITE_NCBI_API_KEY'),
    hetopUser: readVar('HETOP_USER') || readVar('VITE_HETOP_USER'),
    hetopPass: readVar('HETOP_PASS') || readVar('VITE_HETOP_PASS')
  };
}

function extractGeminiModelName(url: string): string {
  const match = url.match(/\/models\/([^:]+):generateContent/);
  return match ? match[1] : 'gemini-unknown';
}

function computeEstimatedCostEur(telemetry: ScenarioTelemetry): number {
  const outputAndThoughtTokens = telemetry.candidateTokens + telemetry.thoughtsTokens;
  const effectiveOutputTokens =
    outputAndThoughtTokens > 0
      ? outputAndThoughtTokens
      : Math.max(0, telemetry.totalTokens - telemetry.promptTokens);

  const usd =
    (telemetry.promptTokens / 1_000_000) * GEMINI_FLASH_LITE_INPUT_USD_PER_1M +
    (effectiveOutputTokens / 1_000_000) * GEMINI_FLASH_LITE_OUTPUT_USD_PER_1M;
  return usd * USD_TO_EUR_RATE;
}

function getBlockTreeNumbers(block: MappedBlock): string[] {
  const trees = new Set<string>();
  for (const d of block.descriptors || []) {
    for (const t of d.treeNumbers || []) {
      trees.add(t.trim().toUpperCase());
    }
  }
  return Array.from(trees);
}

function getBlockDescriptorTitles(block: MappedBlock): string[] {
  const titles = new Set<string>();
  if (block.descriptor) titles.add(block.descriptor.toLowerCase());
  for (const d of block.descriptors || []) {
    if (d.descriptor) titles.add(d.descriptor.toLowerCase());
  }
  return Array.from(titles);
}

function validatePrismaSSyntax(
  pubmedQuery: string,
  embaseQuery: string,
  cochraneQuery: string
): readonly string[] {
  const errors: string[] = [];

  const checkBalancedParens = (q: string, label: string) => {
    const open = (q.match(/\(/g) || []).length;
    const close = (q.match(/\)/g) || []).length;
    if (!q.trim()) {
      errors.push(`${label} vide`);
    } else if (open !== close) {
      errors.push(`${label} : parenthèses déséquilibrées (${open} ouvrantes vs ${close} fermantes)`);
    }
  };

  checkBalancedParens(pubmedQuery, 'PubMed');
  checkBalancedParens(embaseQuery, 'Embase');
  checkBalancedParens(cochraneQuery, 'Cochrane');

  const pubQuotes = (pubmedQuery.match(/"/g) || []).length;
  if (pubQuotes % 2 !== 0) {
    errors.push(`PubMed : nombre impair de guillemets (${pubQuotes})`);
  }

  const cochraneQuotes = (cochraneQuery.match(/"/g) || []).length;
  if (cochraneQuotes % 2 !== 0) {
    errors.push(`Cochrane : nombre impair de guillemets (${cochraneQuotes})`);
  }

  if (pubmedQuery.includes('""')) {
    errors.push('PubMed : présence de guillemets doubles imbriqués ""');
  }
  if (/\[[a-z]+\]\[[a-z]+\]/i.test(pubmedQuery)) {
    errors.push('PubMed : présence de balises doublées');
  }
  if (/(?:^|[\s(])[a-z]{1,4}\*/i.test(pubmedQuery)) {
    errors.push('PubMed : troncature trop courte (< 5 caractères)');
  }
  if (/"[^"]+,[^"]+"\[tiab\]/i.test(pubmedQuery)) {
    errors.push('PubMed : forme NLM inversée avec virgule interdite dans [tiab]');
  }

  return errors;
}

const CLINICAL_EVAL_SCENARIOS: readonly ScenarioOutcomeExpectation[] = [
  {
    id: 'S1',
    label: 'Parkinsonisme médicamenteux (Pharmacovigilance)',
    clinicalProse:
      "Protocole de revue systématique de pharmacovigilance sur 20 ans évaluant chez l'adulte en soins primaires le risque de syndrome parkinsonien secondaire induit chimiquement comme événement indésirable (EI) grave lié à l'exposition à l'halopéridol, la rispéridone ou le métoclopramide, comparativement à l'absence d'exposition ou prise en charge standard. Les patients pédiatriques (< 18 ans) sont exclus de l'analyse.",
    expectedTargetCheck: (blocks, pubmedQuery, extracted) => {
      const oBlocks = blocks.filter((b) => b.picoType === 'O');
      const iBlocks = blocks.filter((b) => b.picoType === 'I');
      const oTrees = oBlocks.flatMap(getBlockTreeNumbers);
      const targetTreeOk = oTrees.some((t) => t.startsWith('C') || t.startsWith('F03'));
      const hasParkinsonOutcome =
        oBlocks.some((b) => getBlockDescriptorTitles(b).some((t) => t.includes('parkinson'))) ||
        /parkinson/i.test(pubmedQuery);
      const hasDrugSignal =
        iBlocks.some((b) =>
          getBlockDescriptorTitles(b).some((t) =>
            /haloperidol|risperidone|metoclopramide/.test(t)
          )
        ) || /(?:haloperidol|risperidone|metoclopramide)/i.test(pubmedQuery);
      const hasExclusion = Boolean(extracted.not && extracted.not.trim().length > 0);
      return {
        targetTreeOk,
        domainSignalOk: hasParkinsonOutcome && hasDrugSignal && hasExclusion,
        details: `O-trees=[${oTrees.slice(0, 3).join(',')}], drugs=${hasDrugSignal}, not=${hasExclusion}`
      };
    }
  },
  {
    id: 'S2',
    label: 'Jeûne intermittent & Syndrome métabolique (G07)',
    clinicalProse:
      "Synthèse clinique des essais contrôlés randomisés menés chez des adultes atteints de syndrome métabolique ou de surpoids. Le protocole mesure l'impact du jeûne intermittent (alimentation en temps restreint, Time-Restricted Eating) par rapport à une alimentation habituelle sans restriction ni prise en charge standard sur l'évolution du poids corporel et de l'IMC à 24 semaines. Sont exclues les femmes enceintes et les populations pédiatriques.",
    expectedTargetCheck: (blocks, pubmedQuery) => {
      const iBlocks = blocks.filter((b) => b.picoType === 'I');
      const poBlocks = blocks.filter((b) => b.picoType === 'P' || b.picoType === 'O');
      const iTrees = iBlocks.flatMap(getBlockTreeNumbers);
      const poTrees = poBlocks.flatMap(getBlockTreeNumbers);
      const targetTreeOk = iTrees.some((t) => t.startsWith('G07'));
      const hasMetabolicOrObesity =
        poTrees.some((t) => t.startsWith('C') || t.startsWith('E01.370.600') || t.startsWith('G07.700')) ||
        /(?:Metabolic Syndrome|Obesity|Overweight|Body Weight|Body Mass Index)/i.test(pubmedQuery);
      const hasFastingSignal = /(?:Intermittent Fasting|Fasting)/i.test(pubmedQuery);
      return {
        targetTreeOk,
        domainSignalOk: hasFastingSignal && hasMetabolicOrObesity,
        details: `I-G07=${targetTreeOk}, metabolic/anthrop=${hasMetabolicOrObesity}`
      };
    }
  },
  {
    id: 'S3',
    label: 'Colchicine post-IDM & prévention secondaire',
    clinicalProse:
      "Méta-analyse d'essais randomisés incluant des patients coronariens stables après un IDM aigu récent (infarctus du myocarde). Cette étude compare l'administration quotidienne de colchicine à faible dose au placebo ou aux soins standards habituels afin de prévenir la récidive d'IDM et d'événements ischémiques cardiovasculaires. Les patients présentant une péricardite aiguë isolée sont exclus.",
    pipelineOverrides: {
      qualifiers: ['prevention & control']
    },
    expectedTargetCheck: (blocks, pubmedQuery) => {
      const iBlocks = blocks.filter((b) => b.picoType === 'I');
      const pAndOBlocks = blocks.filter((b) => b.picoType === 'P' || b.picoType === 'O');
      const iTrees = iBlocks.flatMap(getBlockTreeNumbers);
      const cTrees = pAndOBlocks.flatMap(getBlockTreeNumbers);
      const targetTreeOk = iTrees.some((t) => t.startsWith('D')) && cTrees.some((t) => t.startsWith('C14'));
      const hasColchicineMesh = /"Colchicine"\[Mesh\]/i.test(pubmedQuery);
      const hasPreventionSubheading = /\/prevention and control"\[Mesh\]/i.test(pubmedQuery);
      return {
        targetTreeOk,
        domainSignalOk: hasColchicineMesh && hasPreventionSubheading,
        details: `Colchicine[Mesh]=${hasColchicineMesh}, /prevention_and_control=${hasPreventionSubheading}`
      };
    }
  },
  {
    id: 'S4',
    label: 'Inhibiteurs SGLT2 (Empagliflozine, Dapagliflozine) & ICFEp',
    clinicalProse:
      "Revue systématique évaluant les patients adultes suivis pour une insuffisance cardiaque chronique à FEVG préservée (ICFEp). L'intervention étudiée repose sur l'initiation d'un inhibiteur SGLT2 (empagliflozine, dapagliflozine) comparée à une prise en charge standard ou placebo sur les hospitalisations pour insuffisance cardiaque et la mortalité cardiovasculaire. Les patients pédiatriques sont exclus.",
    expectedTargetCheck: (blocks, pubmedQuery) => {
      const iBlocks = blocks.filter((b) => b.picoType === 'I');
      const pBlocks = blocks.filter((b) => b.picoType === 'P');
      const iTrees = iBlocks.flatMap(getBlockTreeNumbers);
      const pTrees = pBlocks.flatMap(getBlockTreeNumbers);
      const targetTreeOk = iTrees.some((t) => t.startsWith('D')) && pTrees.some((t) => t.startsWith('C14'));
      const qLow = pubmedQuery.toLowerCase();
      const hasBothMolecules = qLow.includes('empagliflozin') && qLow.includes('dapagliflozin');
      const hasHeartFailure = /heart failure/i.test(pubmedQuery);
      return {
        targetTreeOk,
        domainSignalOk: hasBothMolecules && hasHeartFailure,
        details: `empagliflozin+dapagliflozin=${hasBothMolecules}, HF=${hasHeartFailure}`
      };
    }
  },
  {
    id: 'S5',
    label: 'Thrombectomie mécanique dans l’AVC ischémique aigu',
    clinicalProse:
      "Évaluation clinique de l'efficacité de la thrombectomie mécanique endovasculaire à la phase aiguë d'un AVC ischémique par occlusion d'un gros tronc cérébral chez l'adulte, comparativement à la thrombolyse intraveineuse seule ou à la prise en charge standard, sur la récupération fonctionnelle et la mortalité à 90 jours. Les patients victimes d'un AVC hémorragique primaire sont exclus.",
    expectedTargetCheck: (blocks, pubmedQuery) => {
      const iBlocks = blocks.filter((b) => b.picoType === 'I');
      const pBlocks = blocks.filter((b) => b.picoType === 'P');
      const iTrees = iBlocks.flatMap(getBlockTreeNumbers);
      const pTrees = pBlocks.flatMap(getBlockTreeNumbers);
      const targetTreeOk =
        iTrees.some((t) => t.startsWith('E04') || t.startsWith('E')) &&
        pTrees.some((t) => t.startsWith('C10') || t.startsWith('C14'));
      const hasProcedure = /(?:Thrombectomy|Endovascular)/i.test(pubmedQuery);
      const hasStroke = /(?:Stroke|Brain Ischemia|Cerebral Infarction)/i.test(pubmedQuery);
      return {
        targetTreeOk,
        domainSignalOk: hasProcedure && hasStroke,
        details: `I-E04=${targetTreeOk}, proc=${hasProcedure}, stroke=${hasStroke}`
      };
    }
  },
  {
    id: 'S6',
    label: 'Simulation haute-fidélité en pédagogie médicale (I02)',
    clinicalProse:
      "Revue de la littérature en pédagogie médicale chez les étudiants en médecine et internes de spécialité, analysant l'apport de l'apprentissage par simulation médicale haute-fidélité comparé à un enseignement magistral traditionnel ou une prise en charge pédagogique standard sur l'acquisition des compétences cliniques et la gestion des situations d'urgence.",
    expectedTargetCheck: (blocks, pubmedQuery) => {
      const allTrees = blocks.flatMap(getBlockTreeNumbers);
      const targetTreeOk = allTrees.some((t) => t.startsWith('I02'));
      const hasEducationTerm = /(?:Simulation Training|Education, Medical|Clinical Competence|simulation)/i.test(
        pubmedQuery
      );
      return {
        targetTreeOk,
        domainSignalOk: targetTreeOk && hasEducationTerm,
        details: `I02=${targetTreeOk}, eduSignal=${hasEducationTerm}`
      };
    }
  }
];

describe('Étage 3 — Banc d’Évaluation Clinique End-to-End (gemini-flash-lite-latest + Live NLM/PubMed)', () => {
  const secrets = loadEnvSecrets();
  const hasNcbiKey = Boolean(secrets.ncbiApiKey);
  const scenarioResults: ScenarioReportRow[] = [];

  let originalFetch: typeof globalThis.fetch | null = null;
  let originalStorage: Storage | undefined;
  let activeTelemetry: ScenarioTelemetry | null = null;

  beforeAll(() => {
    if (!secrets.geminiApiKey) {
      throw new Error(
        '[test:eval] GEMINI_API_KEY absente de l’environnement et de .env.local/.env. ' +
          'Lancez la campagne manuellement avec : $env:GEMINI_API_KEY="votre_cle"; npm.cmd run test:eval'
      );
    }

    originalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: createMemoryStorage()
    });

    saveAiConfig({
      provider: 'gemini',
      routingMode: 'economy',
      rateLimitMode: 'payg',
      geminiApiKey: secrets.geminiApiKey,
      geminiModel: 'gemini-flash-lite-latest',
      geminiBatchModel: 'gemini-flash-lite-latest'
    });

    if (secrets.ncbiApiKey) {
      setNcbiApiKey(secrets.ncbiApiKey);
    }
    if (secrets.hetopUser && secrets.hetopPass) {
      setHetopCredentials(secrets.hetopUser, secrets.hetopPass);
    }

    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!originalFetch) {
        throw new Error('originalFetch non initialisé');
      }

      const response = await originalFetch(input, init);

      // Proxy strictement non-intrusif : ne clone/parse QUE les réponses Gemini generateContent
      if (url.includes('generativelanguage.googleapis.com') && url.includes(':generateContent')) {
        const parsed = (await response
          .clone()
          .json()
          .catch(() => null)) as GeminiApiResponseEnvelope | null;

        if (activeTelemetry) {
          activeTelemetry.llmCalls += 1;
          const invokedModel = extractGeminiModelName(url);
          if (!activeTelemetry.modelsInvoked.includes(invokedModel)) {
            activeTelemetry.modelsInvoked.push(invokedModel);
          }
          const usage = parsed?.usageMetadata;
          if (usage) {
            activeTelemetry.promptTokens += usage.promptTokenCount ?? 0;
            activeTelemetry.candidateTokens += usage.candidatesTokenCount ?? 0;
            activeTelemetry.thoughtsTokens += usage.thoughtsTokenCount ?? 0;
            activeTelemetry.totalTokens += usage.totalTokenCount ?? 0;
          }
        }
      }

      return response;
    };
  });

  afterEach(async () => {
    activeTelemetry = null;
    if (!hasNcbiKey) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  });

  afterAll(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    if (originalStorage !== undefined) {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: originalStorage
      });
    }

    if (scenarioResults.length > 0) {
      const totalLatencyMs = scenarioResults.reduce((acc, r) => acc + r.latencyMs, 0);
      const totalPrompt = scenarioResults.reduce((acc, r) => acc + r.telemetry.promptTokens, 0);
      const totalOut = scenarioResults.reduce((acc, r) => acc + r.telemetry.candidateTokens, 0);
      const totalThink = scenarioResults.reduce((acc, r) => acc + r.telemetry.thoughtsTokens, 0);
      const totalCostEur = scenarioResults.reduce((acc, r) => acc + r.estimatedCostEur, 0);
      const avgScore =
        scenarioResults.reduce((acc, r) => acc + r.score, 0) / scenarioResults.length;

      const rowsForConsole = [
        ...scenarioResults.map((r) => ({
          ID: r.id,
          Scénario: r.label,
          Statut: r.passed ? 'PASS' : 'FAIL',
          'Score /100': r.score,
          'Audit IA': r.aiAuditScore !== null ? `${r.aiAuditScore}/100` : 'N/A',
          PubMed: r.pubmedCount,
          'Latence (s)': (r.latencyMs / 1000).toFixed(2),
          'Tokens (In/Out/Think)': `${r.telemetry.promptTokens} / ${r.telemetry.candidateTokens} / ${r.telemetry.thoughtsTokens}`,
          'Coût estimé (€)': r.estimatedCostEur.toFixed(6)
        })),
        {
          ID: 'TOTAL',
          Scénario: `Moyenne sur ${scenarioResults.length} scénarios`,
          Statut: avgScore >= 85 && scenarioResults.every((r) => r.passed) ? 'PASS' : 'FAIL',
          'Score /100': Number(avgScore.toFixed(1)),
          'Audit IA': '-',
          PubMed: scenarioResults.reduce((acc, r) => acc + r.pubmedCount, 0),
          'Latence (s)': (totalLatencyMs / 1000).toFixed(2),
          'Tokens (In/Out/Think)': `${totalPrompt} / ${totalOut} / ${totalThink}`,
          'Coût estimé (€)': totalCostEur.toFixed(6)
        }
      ];

      console.log('\n=== BILAN ÉTAGE 3 · BANC D’ÉVALUATION CLINIQUE (gemini-flash-lite-latest) ===');
      console.table(rowsForConsole);
    }
  });

  for (const scenario of CLINICAL_EVAL_SCENARIOS) {
    it(`[${scenario.id}] ${scenario.label}`, async () => {
      const telemetry: ScenarioTelemetry = {
        llmCalls: 0,
        promptTokens: 0,
        candidateTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 0,
        modelsInvoked: []
      };
      activeTelemetry = telemetry;

      const t0 = performance.now();
      let passed = false;
      let score = 0;
      let aiAuditScore: number | null = null;
      let pubmedCount = 0;
      let failureReason: string | undefined;
      let extractedForDebug: ClinicalPicoExtractionResult | null = null;
      let pipelineForDebug: Awaited<ReturnType<typeof runMultiAgentPipeline>> | null = null;

      try {
        const extracted = await parseClinicalAbstractNLP(scenario.clinicalProse);
        extractedForDebug = extracted;

        const recActive = extracted.qualifications?.recommendedActivePico;
        const settings: PipelineSettings = {
          strategy: 'balanced',
          filters: ['humans_cochrane'],
          qualifications: extracted.qualifications,
          activePico: recActive
            ? {
                p: recActive.p,
                i: recActive.i,
                c: recActive.c,
                o: recActive.o,
                not: recActive.not
              }
            : {
                p: Boolean(extracted.p),
                i: Boolean(extracted.i),
                c: Boolean(extracted.c),
                o: Boolean(extracted.o),
                not: Boolean(extracted.not)
              },
          ...(scenario.pipelineOverrides ?? {})
        };

        const pipelineResult = await runMultiAgentPipeline(
          {
            p: extracted.p,
            i: extracted.i,
            c: extracted.c,
            o: extracted.o,
            not: extracted.not
          },
          settings
        );
        pipelineForDebug = pipelineResult;

        pubmedCount = pipelineResult.liveResult.count;
        aiAuditScore = pipelineResult.critiqueReport?.score ?? null;

        // 1. Vérification stricte de tous les Tree Numbers résolus par axe
        const taxonomyViolations: string[] = [];
        const forbiddenOutcomeTerms: string[] = [];

        for (const block of pipelineResult.mappedBlocks) {
          for (const desc of block.descriptors || []) {
            if (desc.treeNumbers && desc.treeNumbers.length > 0) {
              if (!isValidTreeNumberForAxis(desc.treeNumbers, block.picoType)) {
                taxonomyViolations.push(
                  `${block.picoType}:${desc.descriptor}[${desc.treeNumbers.join(',')}]`
                );
              }
            }
            if (
              block.picoType === 'O' &&
              /^(?:exhibitions?|pharmacovigilance|pharmaceutical\s+preparations?|drug[\s-]related\s+side\s+effects)/i.test(
                desc.descriptor
              )
            ) {
              forbiddenOutcomeTerms.push(desc.descriptor);
            }
          }
        }

        const globalForbiddenInQuery =
          /"Exhibitions"\[Mesh\]/i.test(pipelineResult.pubmedQuery) ||
          /"Pharmaceutical Preparations"\[Mesh\]/i.test(pipelineResult.pubmedQuery);

        const syntaxErrors = validatePrismaSSyntax(
          pipelineResult.pubmedQuery,
          pipelineResult.embaseQuery,
          pipelineResult.cochraneQuery
        );

        const expectationCheck = scenario.expectedTargetCheck(
          pipelineResult.mappedBlocks,
          pipelineResult.pubmedQuery,
          extracted
        );

        // Calcul du score qualité /100
        let computedScore = 0;
        // 1) Extraction PICO IA (20 pts)
        if (extracted.source === 'gemini') computedScore += 10;
        if ((extracted.p || extracted.o) && extracted.i) computedScore += 10;

        // 2) Taxonomie Tree Numbers (25 pts)
        if (taxonomyViolations.length === 0) computedScore += 15;
        if (expectationCheck.targetTreeOk) computedScore += 10;

        // 3) Garde anti-faux-positifs & signal métier (20 pts)
        if (forbiddenOutcomeTerms.length === 0 && !globalForbiddenInQuery) computedScore += 10;
        if (expectationCheck.domainSignalOk) computedScore += 10;

        // 4) Intégrité syntaxique PRISMA-S (15 pts)
        if (syntaxErrors.length === 0) computedScore += 15;

        // 5) Pertinence PubMed Live (20 pts)
        if (pipelineResult.liveResult.error === null && pipelineResult.liveResult.count > 0) {
          computedScore += 10;
          if (pipelineResult.liveResult.count >= 5 && pipelineResult.liveResult.count < 500000) {
            computedScore += 10;
          }
        }

        score = computedScore;

        // Niveau 1 : Échec bloquant sur les invariants de sécurité & seuil >= 80
        expect(extracted.source).toBe('gemini');
        expect(taxonomyViolations).toEqual([]);
        expect(forbiddenOutcomeTerms).toEqual([]);
        expect(globalForbiddenInQuery).toBe(false);
        expect(syntaxErrors).toEqual([]);
        expect(pipelineResult.liveResult.error).toBeNull();
        expect(pipelineResult.liveResult.count).toBeGreaterThan(0);
        expect(
          score,
          `Score insuffisant (${score}/100) pour ${scenario.id} — Détails: ${expectationCheck.details}`
        ).toBeGreaterThanOrEqual(80);

        passed = true;
      } catch (err: unknown) {
        failureReason = err instanceof Error ? err.message : String(err);
        console.error(`\n[DIAGNOSTIC ÉCHEC ${scenario.id}] ${scenario.label}`);
        if (extractedForDebug) {
          console.error('PICO extrait :', {
            source: extractedForDebug.source,
            p: extractedForDebug.p,
            i: extractedForDebug.i,
            c: extractedForDebug.c,
            o: extractedForDebug.o,
            not: extractedForDebug.not,
            englishCoreTerms: {
              p: extractedForDebug.qualifications?.p?.englishCoreTerms ?? [],
              i: extractedForDebug.qualifications?.i?.englishCoreTerms ?? [],
              o: extractedForDebug.qualifications?.o?.englishCoreTerms ?? [],
              not: extractedForDebug.qualifications?.not?.englishCoreTerms ?? []
            }
          });
        }
        if (pipelineForDebug) {
          console.error(
            'Descripteurs MeSH :',
            pipelineForDebug.mappedBlocks.map(
              (b) => `${b.picoType}:${b.descriptor}(${b.meshId})`
            )
          );
          console.error('Équation PubMed :\n' + pipelineForDebug.pubmedQuery);
          console.error('PubMed liveResult :', {
            count: pipelineForDebug.liveResult.count,
            error: pipelineForDebug.liveResult.error
          });
        }
        throw err;
      } finally {
        const latencyMs = Math.round(performance.now() - t0);
        scenarioResults.push({
          id: scenario.id,
          label: scenario.label,
          passed,
          score,
          aiAuditScore,
          pubmedCount,
          latencyMs,
          telemetry,
          estimatedCostEur: computeEstimatedCostEur(telemetry),
          failureReason
        });
      }
    });
  }

  it('Invariant Niveau 2 : Score moyen global >= 85 / 100 sur les 6 scénarios', () => {
    expect(scenarioResults).toHaveLength(CLINICAL_EVAL_SCENARIOS.length);
    const meanScore =
      scenarioResults.reduce((acc, r) => acc + r.score, 0) / scenarioResults.length;
    expect(meanScore).toBeGreaterThanOrEqual(85);
  });
});

