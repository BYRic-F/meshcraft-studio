import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  parseClinicalAbstractNLP,
  runMultiAgentPipeline,
  serializeAxisCompilationPayload,
  MappedBlock,
  PipelineSettings,
  PicoInputs,
  PressStatusLevel,
  normalizeAuditObservation,
  AuditObservationItem
} from '../../src/services/multiAgentWorkflow';
import {
  aiRefinePicoFromAudit,
  PicoSemanticQualifications,
  saveAiConfig
} from '../../src/services/localAiService';
import {
  AxisCompilationInputRust,
  CompiledAxisOutputRust,
  compileAxisBlockRust,
  extractInnLikeTokens
} from '../../src/services/rustEngineService';
import { setNcbiApiKey } from '../../src/services/pubmedApi';
import { setHetopCredentials } from '../../src/services/hetopService';

type BenchmarkCategory =
  | 'd27_plus_inn'
  | 'pure_inn_list'
  | 'non_drug_surgical'
  | 'peco_exposure'
  | 'rare_syndrome_complex'
  | 'composite_safety';

interface BenchmarkScenario {
  readonly id: string;
  readonly category: BenchmarkCategory;
  readonly label: string;
  readonly clinicalProse: string;
  readonly pipelineOverrides?: Partial<PipelineSettings>;
}

interface EnglishCoreTermsCoverage {
  readonly totalTerms: number;
  readonly matchedTerms: number;
  readonly coverageRate: number;
  readonly uncoveredTerms: readonly string[];
}

interface ParityResult {
  readonly parityOk: boolean;
  readonly blocksChecked: number;
  readonly mismatches: readonly string[];
}

interface MeshSnapshot {
  readonly descriptorsInBlocks: readonly string[];
  readonly coreDescriptorsInBlocks: readonly string[];
  readonly coreAxesWithEmittedMesh: readonly ('P' | 'I' | 'C' | 'O')[];
  readonly emittedMeshInQuery: readonly string[];
  readonly d27DescriptorsInBlocks: readonly string[];
  readonly d27EmittedInQuery: readonly string[];
}

interface StageSnapshot {
  readonly pico: PicoInputs;
  readonly activePico: Record<'p' | 'i' | 'c' | 'o' | 'not', boolean>;
  readonly pubmedQuery: string;
  readonly pubmedCount: number;
  readonly pressStatus: PressStatusLevel | 'unknown';
  readonly warningCount: number;
  readonly okCount: number;
  readonly warnings: readonly string[];
  readonly observations: readonly AuditObservationItem[];
  readonly recommendations: readonly string[];
  readonly mesh: MeshSnapshot;
  readonly englishCoreTerms: Record<string, readonly string[]>;
  readonly englishCoreTermsCoverage: EnglishCoreTermsCoverage;
  readonly parity: ParityResult;
}

interface BenchmarkCaseReport {
  readonly id: string;
  readonly category: BenchmarkCategory;
  readonly label: string;
  readonly executionError?: string;
  readonly latencyMs: number;
  readonly refinementApplied: boolean;
  readonly refinementExplanation?: string;
  readonly v1: StageSnapshot | null;
  readonly v2: StageSnapshot | null;
  readonly criticDriftWarnings: readonly string[];
  readonly regressionsInV2: readonly string[];
  readonly llmCalls: number;
  readonly totalTokens: number;
  readonly estimatedCostEur: number;
}

interface EnvSecrets {
  readonly geminiApiKey: string;
  readonly ncbiApiKey: string;
  readonly hetopUser: string;
  readonly hetopPass: string;
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

interface ActiveTelemetry {
  llmCalls: number;
  promptTokens: number;
  candidateTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
}

const RUST_CLI_BIN = path.join(
  process.cwd(),
  'rust_engine',
  'target',
  'debug',
  process.platform === 'win32' ? 'compile_axis_cli.exe' : 'compile_axis_cli'
);

const STAGE_DELAY_MS = Number(process.env.BENCHMARK_STAGE_DELAY_MS || 1500);
const SCENARIO_DELAY_MS = Number(process.env.BENCHMARK_SCENARIO_DELAY_MS || 2200);

const GEMINI_FLASH_LITE_INPUT_USD_PER_1M = 0.1;
const GEMINI_FLASH_LITE_OUTPUT_USD_PER_1M = 0.4;
const USD_TO_EUR_RATE = 0.92;

const BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = [
  // 1. Classe pharmacologique D27 + DCI explicites (3 cas)
  {
    id: 'B01',
    category: 'd27_plus_inn',
    label: 'Diabète type 2 / MRC + Inhibiteurs SGLT2 (empagliflozine, dapagliflozine, canagliflozine)',
    clinicalProse:
      "Revue systématique évaluant chez les patients adultes atteints de diabète de type 2 et de maladie rénale chronique l'efficacité néphroprotectrice des inhibiteurs du cotransporteur sodium-glucose de type 2 (empagliflozine, dapagliflozine, canagliflozine) comparés au placebo ou à la prise en charge standard sur le déclin du débit de filtration glomérulaire et l'insuffisance rénale terminale."
  },
  {
    id: 'B02',
    category: 'd27_plus_inn',
    label: 'ICFEp + Inhibiteurs SGLT2 (empagliflozine, dapagliflozine)',
    clinicalProse:
      "Synthèse des essais contrôlés randomisés chez l'adulte présentant une insuffisance cardiaque à fraction d'éjection préservée évaluant les inhibiteurs du SGLT2 (empagliflozine, dapagliflozine) versus placebo sur les hospitalisations pour insuffisance cardiaque et la mortalité cardiovasculaire. Les populations pédiatriques sont exclues."
  },
  {
    id: 'B03',
    category: 'd27_plus_inn',
    label: 'Athérosclérose coronarienne + Statines (atorvastatine, rosuvastatine, simvastatine)',
    clinicalProse:
      "Méta-analyse chez des patients adultes présentant une maladie coronarienne stable comparant un traitement intensif par statines (atorvastatine, rosuvastatine, simvastatine) au placebo ou aux soins habituels sur la réduction des événements cardiovasculaires majeurs et la mortalité toutes causes."
  },

  // 2. Liste de DCI pure sans classe thérapeutique (2 cas)
  {
    id: 'B04',
    category: 'pure_inn_list',
    label: 'Douleur neuropathique diabétique + prégabaline, gabapentine, duloxétine',
    clinicalProse:
      "Revue systématique comparant l'efficacité antalgique de la prégabaline, de la gabapentine et de la duloxétine chez l'adulte souffrant de neuropathie diabétique douloureuse sur la réduction d'au moins 50 % de l'intensité douloureuse et la qualité de vie."
  },
  {
    id: 'B05',
    category: 'pure_inn_list',
    label: 'Psoriasis modéré à sévère + adalimumab, ustékinumab, sécukinumab',
    clinicalProse:
      "Évaluation comparative de l'efficacité et de la tolérance de l'adalimumab, de l'ustékinumab et du sécukinumab chez des patients adultes atteints de psoriasis en plaques modéré à sévère sur l'obtention d'une réponse PASI 90 à 16 semaines."
  },

  // 3. Intervention non médicamenteuse / chirurgicale (3 cas)
  {
    id: 'B06',
    category: 'non_drug_surgical',
    label: 'AVC ischémique aigu + thrombectomie mécanique vs thrombolyse IV',
    clinicalProse:
      "Revue systématique évaluant la thrombectomie mécanique endovasculaire à la phase aiguë d'un accident vasculaire cérébral ischémique par occlusion d'un gros tronc cérébral chez l'adulte, comparativement à la thrombolyse intraveineuse seule, sur l'autonomie fonctionnelle à 90 jours. Les hémorragies intracérébrales primaires sont exclues."
  },
  {
    id: 'B07',
    category: 'non_drug_surgical',
    label: 'Surpoids / obésité + jeûne intermittent (alimentation en temps restreint)',
    clinicalProse:
      "Synthèse des essais contrôlés randomisés chez l'adulte en surpoids ou obèse mesurant l'effet du jeûne intermittent (alimentation en temps restreint) par rapport à une alimentation habituelle sans restriction calorique sur la variation du poids corporel et de l'indice de masse corporelle à 24 semaines."
  },
  {
    id: 'B08',
    category: 'non_drug_surgical',
    label: 'Gonarthrose sévère + arthroplastie totale du genou vs rééducation',
    clinicalProse:
      "Étude de l'efficacité clinique de l'arthroplastie totale du genou comparée à la kinésithérapie structurée chez des adultes atteints d'arthrose fémoro-tibiale sévère sur la douleur articulaire et la capacité fonctionnelle à 12 mois."
  },

  // 4. Étude d'exposition PECO : facteur de risque / environnement / épidémiologie (2 cas)
  {
    id: 'B09',
    category: 'peco_exposure',
    label: 'PECO : Exposition professionnelle aux pesticides (glyphosate, organophosphorés) & Parkinson',
    clinicalProse:
      "Revue systématique épidémiologique de type PECO étudiant chez les travailleurs agricoles adultes l'exposition professionnelle aux pesticides (glyphosate, insecticides organophosphorés) par rapport à l'absence d'exposition sur l'incidence de la maladie de Parkinson."
  },
  {
    id: 'B10',
    category: 'peco_exposure',
    label: 'PECO : Pollution atmosphérique (particules fines PM2.5) & incidence de BPCO',
    clinicalProse:
      "Enquête étiologique PECO évaluant en population générale adulte l'exposition chronique à la pollution atmosphérique par particules fines (PM2.5) comparativement aux zones faiblement exposées sur le risque incident de bronchopneumopathie chronique obstructive."
  },

  // 5. Pathologie rare / syndrome avec synonymes complexes (2 cas)
  {
    id: 'B11',
    category: 'rare_syndrome_complex',
    label: 'Syndrome parkinsonien secondaire induit chimiquement (halopéridol, rispéridone, métoclopramide)',
    clinicalProse:
      "Revue systématique de pharmacovigilance sur 20 ans évaluant chez l'adulte en soins primaires le risque de syndrome parkinsonien secondaire induit chimiquement comme événement indésirable grave lié à l'halopéridol, la rispéridone ou le métoclopramide, comparé à l'absence d'exposition. Les patients pédiatriques sont exclus."
  },
  {
    id: 'B12',
    category: 'rare_syndrome_complex',
    label: 'Granulomatose avec polyangéite (maladie de Wegener) + rituximab vs cyclophosphamide',
    clinicalProse:
      "Revue systématique des essais cliniques chez les patients atteints de granulomatose avec polyangéite (maladie de Wegener) active comparant le rituximab au cyclophosphamide en traitement d'induction sur le taux de rémission complète à 6 mois et le taux de rechute."
  },

  // 6. Critère de jugement composite / sécurité médicamenteuse (2 cas)
  {
    id: 'B13',
    category: 'composite_safety',
    label: 'Colchicine post-IDM & prévention secondaire MACE',
    clinicalProse:
      "Méta-analyse d'essais randomisés incluant des coronariens stables après infarctus du myocarde aigu récent, comparant la colchicine à faible dose au placebo pour prévenir la récidive d'infarctus du myocarde, d'accident vasculaire cérébral et de mortalité cardiovasculaire. Les péricardites isolées sont exclues.",
    pipelineOverrides: {
      qualifiers: ['prevention & control']
    }
  },
  {
    id: 'B14',
    category: 'composite_safety',
    label: 'Anticoagulants oraux directs (apixaban, rivaroxaban) & hémorragie intracrânienne',
    clinicalProse:
      "Revue systématique de sécurité médicamenteuse chez des patients atteints de fibrillation atriale non valvulaire comparant les anticoagulants oraux directs (apixaban, rivaroxaban) aux antagonistes de la vitamine K (warfarine) sur la survenue d'hémorragies majeures et d'hémorragies intracrâniennes."
  }
];

const STOPWORDS_EN = new Set([
  'with', 'without', 'from', 'that', 'this', 'into', 'after', 'before', 'during',
  'type', 'acute', 'chronic', 'primary', 'secondary', 'disease', 'diseases',
  'disorder', 'disorders', 'syndrome', 'syndromes', 'adult', 'adults', 'patient',
  'patients', 'risk', 'rate', 'rates', 'outcome', 'outcomes', 'therapy', 'treatment'
]);

const STOPWORDS_FR_AUDIT = new Set([
  'avec', 'pour', 'dans', 'sans', 'cette', 'sont', 'etre', 'avoir', 'plus', 'moins',
  'afin', 'selon', 'entre', 'dont', 'tout', 'tous', 'toute', 'toutes', 'axes', 'axe',
  'terme', 'termes', 'requete', 'equation', 'mesh', 'pubmed', 'cochrane', 'press',
  'prisma', 'handbook', 'grille', 'strategie', 'recherche', 'bloc', 'blocs', 'clinique'
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function parseDotEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val) result[key] = val;
  }
  return result;
}

function loadEnvSecrets(): EnvSecrets {
  const cwd = process.cwd();
  const dotEnvLocal = parseDotEnvFile(path.join(cwd, '.env.local'));
  const dotEnv = parseDotEnvFile(path.join(cwd, '.env'));
  const readVar = (name: string): string =>
    (process.env[name] || dotEnvLocal[name] || dotEnv[name] || '').trim();

  return {
    geminiApiKey: readVar('GEMINI_API_KEY') || readVar('VITE_GEMINI_API_KEY'),
    ncbiApiKey: readVar('NCBI_API_KEY') || readVar('VITE_NCBI_API_KEY'),
    hetopUser: readVar('HETOP_USER') || readVar('VITE_HETOP_USER'),
    hetopPass: readVar('HETOP_PASS') || readVar('VITE_HETOP_PASS')
  };
}

function normalizeAsciiLower(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function invokeRustCliBatch(inputs: readonly AxisCompilationInputRust[]): CompiledAxisOutputRust[] {
  if (inputs.length === 0) return [];
  const stdout = execFileSync(RUST_CLI_BIN, [], {
    input: JSON.stringify(inputs),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  return JSON.parse(stdout) as CompiledAxisOutputRust[];
}

function checkTsRustParity(blocks: readonly MappedBlock[], settings: PipelineSettings): ParityResult {
  if (blocks.length === 0) {
    return { parityOk: true, blocksChecked: 0, mismatches: [] };
  }

  const payloads: AxisCompilationInputRust[] = blocks.map(
    (b) => JSON.parse(serializeAxisCompilationPayload(b, settings)) as AxisCompilationInputRust
  );
  const tsOutputs = payloads.map((p) => compileAxisBlockRust(p));
  const rustOutputs = invokeRustCliBatch(payloads);

  const mismatches: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const tsJson = JSON.stringify(tsOutputs[i]);
    const rustJson = JSON.stringify(rustOutputs[i]);
    if (tsJson !== rustJson) {
      mismatches.push(
        `Bloc ${blocks[i].picoType} (${blocks[i].descriptor}) : TS=${tsOutputs[i].pubmedClause} != Rust=${rustOutputs[i]?.pubmedClause ?? 'MISSING'}`
      );
    }
  }

  return {
    parityOk: mismatches.length === 0,
    blocksChecked: blocks.length,
    mismatches
  };
}

function extractMeshSnapshot(blocks: readonly MappedBlock[], pubmedQuery: string): MeshSnapshot {
  const descriptorsInBlocks = new Set<string>();
  const coreDescriptorsInBlocks = new Set<string>();
  const coreAxesWithEmittedMesh = new Set<'P' | 'I' | 'C' | 'O'>();
  const d27DescriptorsInBlocks = new Set<string>();
  const emittedMeshInQuery = new Set<string>();
  const d27EmittedInQuery = new Set<string>();

  const meshMatches = pubmedQuery.matchAll(/"([^"/]+)(?:\/[^"]+)?"\[(?:Mesh|Majr)[^\]]*\]/gi);
  for (const m of meshMatches) {
    if (m[1]) emittedMeshInQuery.add(m[1].trim());
  }
  const emittedLower = new Set(Array.from(emittedMeshInQuery).map((d) => d.toLowerCase()));

  for (const block of blocks) {
    const isCoreAxis = block.picoType !== 'NOT';
    for (const d of block.descriptors || []) {
      const name = (d.descriptor || '').trim();
      if (!name || !d.meshId || d.meshId.startsWith('Concept-') || d.meshId === 'Custom') continue;
      descriptorsInBlocks.add(name);
      if (isCoreAxis) {
        coreDescriptorsInBlocks.add(name);
        if (emittedLower.has(name.toLowerCase())) {
          coreAxesWithEmittedMesh.add(block.picoType);
        }
      }
      const hasD27 = (d.treeNumbers || []).some((tn) => tn.trim().toUpperCase().startsWith('D27'));
      if (hasD27) {
        d27DescriptorsInBlocks.add(name);
        if (emittedLower.has(name.toLowerCase())) {
          d27EmittedInQuery.add(name);
        }
      }
    }
  }

  return {
    descriptorsInBlocks: Array.from(descriptorsInBlocks),
    coreDescriptorsInBlocks: Array.from(coreDescriptorsInBlocks),
    coreAxesWithEmittedMesh: Array.from(coreAxesWithEmittedMesh),
    emittedMeshInQuery: Array.from(emittedMeshInQuery),
    d27DescriptorsInBlocks: Array.from(d27DescriptorsInBlocks),
    d27EmittedInQuery: Array.from(d27EmittedInQuery)
  };
}

function evaluateEnglishCoreTermsCoverage(
  qualifications: PicoSemanticQualifications | undefined,
  activePico: Record<'p' | 'i' | 'c' | 'o' | 'not', boolean>,
  blocks: readonly MappedBlock[],
  pubmedQuery: string
): EnglishCoreTermsCoverage {
  const normalizedQuery = normalizeAsciiLower(pubmedQuery);
  const blockTextPool = normalizeAsciiLower(
    blocks
      .flatMap((b) => [
        b.descriptor,
        ...(b.descriptors || []).map((d) => d.descriptor),
        ...(b.entryTerms || [])
      ])
      .join(' ')
  );
  const searchSpace = `${normalizedQuery} ${blockTextPool}`;

  const allTerms: string[] = [];
  for (const axis of ['p', 'i', 'c', 'o', 'not'] as const) {
    if (!activePico[axis]) continue;
    const axisQual = qualifications?.[axis];
    for (const term of axisQual?.englishCoreTerms || []) {
      const clean = term.trim();
      if (clean && !allTerms.some((t) => t.toLowerCase() === clean.toLowerCase())) {
        allTerms.push(clean);
      }
    }
  }

  if (allTerms.length === 0) {
    return { totalTerms: 0, matchedTerms: 0, coverageRate: 1, uncoveredTerms: [] };
  }

  let matchedTerms = 0;
  const uncoveredTerms: string[] = [];

  for (const term of allTerms) {
    const normTerm = normalizeAsciiLower(term).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normTerm) continue;

    if (searchSpace.includes(normTerm)) {
      matchedTerms += 1;
      continue;
    }

    const significantTokens = normTerm
      .split(' ')
      .filter((w) => w.length >= 4 && !STOPWORDS_EN.has(w));
    const tokensToCheck = significantTokens.length > 0 ? significantTokens : normTerm.split(' ').filter((w) => w.length >= 4);

    const isMatched =
      tokensToCheck.length > 0 &&
      tokensToCheck.every((tok) => searchSpace.includes(tok.slice(0, Math.min(5, tok.length))));

    if (isMatched) {
      matchedTerms += 1;
    } else {
      uncoveredTerms.push(term);
    }
  }

  return {
    totalTerms: allTerms.length,
    matchedTerms,
    coverageRate: Number((matchedTerms / allTerms.length).toFixed(2)),
    uncoveredTerms
  };
}

function extractEnglishCoreTermsRecord(
  qualifications: PicoSemanticQualifications | undefined
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const axis of ['p', 'i', 'c', 'o', 'not'] as const) {
    out[axis] = qualifications?.[axis]?.englishCoreTerms ?? [];
  }
  return out;
}

function tokenizeForDrift(text: string): Set<string> {
  const normalized = normalizeAsciiLower(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS_FR_AUDIT.has(w));
  return new Set(normalized);
}

function detectCriticDrift(
  audit1Warnings: readonly string[],
  audit2Warnings: readonly string[]
): string[] {
  if (audit2Warnings.length === 0) return [];
  if (audit1Warnings.length === 0) return [...audit2Warnings];

  const a1TokenSets = audit1Warnings.map(tokenizeForDrift);
  const drift: string[] = [];

  for (const w2 of audit2Warnings) {
    const t2 = tokenizeForDrift(w2);
    if (t2.size === 0) continue;

    let maxOverlap = 0;
    for (const t1 of a1TokenSets) {
      if (t1.size === 0) continue;
      let shared = 0;
      for (const tok of t2) {
        if (t1.has(tok)) shared += 1;
      }
      const overlap = shared / Math.max(1, Math.min(t1.size, t2.size));
      if (overlap > maxOverlap) maxOverlap = overlap;
    }

    if (maxOverlap < 0.4) {
      drift.push(w2);
    }
  }

  return drift;
}

function pressStatusRank(status: PressStatusLevel | 'unknown'): number {
  switch (status) {
    case 'compliant':
      return 2;
    case 'needs_refinement':
      return 1;
    case 'revision_required':
      return 0;
    default:
      return -1;
  }
}

function detectV2Regressions(v1: StageSnapshot, v2: StageSnapshot): string[] {
  const regressions: string[] = [];

  const lostD27 = v1.mesh.d27EmittedInQuery.filter(
    (d) => !v2.mesh.d27EmittedInQuery.some((d2) => d2.toLowerCase() === d.toLowerCase())
  );
  if (lostD27.length > 0) {
    regressions.push(`D27_MESH_DROPPED: ${lostD27.join(', ')}`);
  }

  if (v1.mesh.emittedMeshInQuery.length > 0 && v2.mesh.emittedMeshInQuery.length === 0) {
    regressions.push('MESH_COUNT_DROPPED_TO_ZERO');
  }

  if (v1.pubmedCount > 0 && v2.pubmedCount === 0) {
    regressions.push(`PUBMED_ZERO_RESULTS (V1=${v1.pubmedCount} -> V2=0)`);
  } else if (
    v1.pubmedCount > 50 &&
    (v2.pubmedCount < 10 || v2.pubmedCount < v1.pubmedCount * 0.1)
  ) {
    regressions.push(`PUBMED_COLLAPSE_GT_90PCT (V1=${v1.pubmedCount} -> V2=${v2.pubmedCount})`);
  }

  // Perte d'une DCI explicite de l'axe I présente en V1
  const v1Inns = extractInnLikeTokens(v1.pico.i || '');
  const q1Norm = normalizeAsciiLower(v1.pubmedQuery);
  const q2Norm = normalizeAsciiLower(v2.pubmedQuery);
  const lostInns = v1Inns.filter((inn) => {
    const stem = normalizeAsciiLower(inn).slice(0, Math.min(6, inn.length));
    return stem.length >= 5 && q1Norm.includes(stem) && !q2Norm.includes(stem);
  });
  if (lostInns.length > 0) {
    regressions.push(`EXPLICIT_INN_LOST: ${lostInns.join(', ')}`);
  }

  // Perte d'un axe MeSH principal (P, I, O) en excluant NOT (désactiver NOT en V2 est conforme Cochrane)
  const lostCoreMeshAxes = v1.mesh.coreAxesWithEmittedMesh.filter((axis) => {
    if (axis === 'C') return false;
    const axisKey = axis.toLowerCase() as 'p' | 'i' | 'o';
    return v2.activePico[axisKey] && !v2.mesh.coreAxesWithEmittedMesh.includes(axis);
  });
  if (lostCoreMeshAxes.length > 0) {
    regressions.push(`MESH_AXIS_LOST (${lostCoreMeshAxes.join(', ')})`);
  }

  if (
    v1.englishCoreTermsCoverage.totalTerms > 0 &&
    v2.englishCoreTermsCoverage.totalTerms > 0 &&
    v2.englishCoreTermsCoverage.coverageRate + 0.15 < v1.englishCoreTermsCoverage.coverageRate
  ) {
    regressions.push(
      `ENGLISH_CORE_TERMS_COVERAGE_DROP (${Math.round(v1.englishCoreTermsCoverage.coverageRate * 100)}% -> ${Math.round(v2.englishCoreTermsCoverage.coverageRate * 100)}%)`
    );
  }

  if (pressStatusRank(v2.pressStatus) < pressStatusRank(v1.pressStatus)) {
    regressions.push(`PRESS_STATUS_WORSENED (${v1.pressStatus} -> ${v2.pressStatus})`);
  }

  if (v2.warningCount > v1.warningCount) {
    regressions.push(`WARNING_COUNT_INCREASED (${v1.warningCount} -> ${v2.warningCount})`);
  }

  return regressions;
}

function buildStageSnapshot(
  pico: PicoInputs,
  activePico: Record<'p' | 'i' | 'c' | 'o' | 'not', boolean>,
  settings: PipelineSettings,
  pipelineResult: Awaited<ReturnType<typeof runMultiAgentPipeline>>
): StageSnapshot {
  const normalizedObs: AuditObservationItem[] = [];
  for (const raw of pipelineResult.critiqueReport?.observations || []) {
    const item = normalizeAuditObservation(raw);
    if (item) normalizedObs.push(item);
  }
  const warnings = normalizedObs.filter((o) => o.severity === 'warning').map((o) => o.text);
  const okCount = normalizedObs.filter((o) => o.severity === 'ok').length;
  const mesh = extractMeshSnapshot(pipelineResult.mappedBlocks, pipelineResult.pubmedQuery);
  const coverage = evaluateEnglishCoreTermsCoverage(
    settings.qualifications,
    activePico,
    pipelineResult.mappedBlocks,
    pipelineResult.pubmedQuery
  );
  const parity = checkTsRustParity(pipelineResult.mappedBlocks, settings);

  return {
    pico,
    activePico,
    pubmedQuery: pipelineResult.pubmedQuery,
    pubmedCount: pipelineResult.liveResult.count,
    pressStatus: pipelineResult.critiqueReport?.pressStatus ?? 'unknown',
    warningCount: warnings.length,
    okCount,
    warnings,
    observations: normalizedObs,
    recommendations: pipelineResult.critiqueReport?.recommendations || [],
    mesh,
    englishCoreTerms: extractEnglishCoreTermsRecord(settings.qualifications),
    englishCoreTermsCoverage: coverage,
    parity
  };
}

function statusShortLabel(status: PressStatusLevel | 'unknown'): string {
  switch (status) {
    case 'compliant':
      return 'Conforme';
    case 'needs_refinement':
      return 'A affiner';
    case 'revision_required':
      return 'Revision';
    default:
      return 'N/A';
  }
}

function buildMarkdownReport(reports: readonly BenchmarkCaseReport[], timestampIso: string): string {
  const totalCases = reports.length;
  const parityAllOk = reports.filter(
    (r) => Boolean(r.v1?.parity.parityOk) && (!r.v2 || r.v2.parity.parityOk)
  ).length;
  const d27Cases = reports.filter((r) => (r.v1?.mesh.d27DescriptorsInBlocks.length ?? 0) > 0);
  const d27PreservedAll = d27Cases.filter(
    (r) =>
      (r.v1?.mesh.d27EmittedInQuery.length ?? 0) >= (r.v1?.mesh.d27DescriptorsInBlocks.length ?? 0) &&
      (!r.v2 || (r.v2.mesh.d27EmittedInQuery.length ?? 0) >= (r.v1?.mesh.d27EmittedInQuery.length ?? 0))
  ).length;
  const driftCases = reports.filter((r) => r.criticDriftWarnings.length > 0);
  const regressionCases = reports.filter((r) => r.regressionsInV2.length > 0);
  const v1Compliant = reports.filter((r) => r.v1?.pressStatus === 'compliant').length;
  const v2Compliant = reports.filter((r) => r.v2?.pressStatus === 'compliant').length;
  const totalCost = reports.reduce((acc, r) => acc + r.estimatedCostEur, 0);

  const lines: string[] = [
    `# Benchmark Boucle d'Audit (V1 -> Audit 1 -> V2 -> Audit 2)`,
    ``,
    `- **Date** : ${timestampIso}`,
    `- **Cas évalués** : ${totalCases}`,
    `- **Parité exacte TS <-> Rust** : ${parityAllOk} / ${totalCases}`,
    `- **Préservation MeSH D27** : ${d27PreservedAll} / ${d27Cases.length} cas contenant D27`,
    `- **Convergence PRESS (\`compliant\`)** : V1 = ${v1Compliant}/${totalCases} -> V2 = ${v2Compliant}/${totalCases}`,
    `- **Cas avec Critic Drift (nouveau \`warning\` en Audit 2)** : ${driftCases.length} / ${totalCases}`,
    `- **Cas avec régression V2** : ${regressionCases.length} / ${totalCases}`,
    `- **Coût LLM estimé total** : ${totalCost.toFixed(5)} EUR`,
    ``,
    `## Synthèse par scénario`,
    ``,
    `| ID | Catégorie | Parité TS/Rust | D27 [Mesh] V1->V2 | CoreTerms V1->V2 | PubMed V1->V2 | Audit 1 (PRESS / warn) | Audit 2 (PRESS / warn) | Critic Drift | Régression V2 |`,
    `|---|---|---|---|---|---|---|---|---|---|`
  ];

  for (const r of reports) {
    const parityCell =
      r.executionError
        ? 'ERR'
        : r.v1?.parity.parityOk && (!r.v2 || r.v2.parity.parityOk)
          ? 'OK'
          : 'DIFF';
    const d27Cell = r.v1
      ? `${r.v1.mesh.d27EmittedInQuery.length}/${r.v1.mesh.d27DescriptorsInBlocks.length} -> ${r.v2 ? `${r.v2.mesh.d27EmittedInQuery.length}/${r.v2.mesh.d27DescriptorsInBlocks.length}` : '-'}`
      : '-';
    const coreCell = r.v1
      ? `${r.v1.englishCoreTermsCoverage.matchedTerms}/${r.v1.englishCoreTermsCoverage.totalTerms} -> ${r.v2 ? `${r.v2.englishCoreTermsCoverage.matchedTerms}/${r.v2.englishCoreTermsCoverage.totalTerms}` : '-'}`
      : '-';
    const pubmedCell = r.v1
      ? `${r.v1.pubmedCount} -> ${r.v2 ? r.v2.pubmedCount : '-'}`
      : '-';
    const a1Cell = r.v1
      ? `${statusShortLabel(r.v1.pressStatus)} (${r.v1.warningCount}w)`
      : 'ERR';
    const a2Cell = r.v2
      ? `${statusShortLabel(r.v2.pressStatus)} (${r.v2.warningCount}w)`
      : '-';
    const driftCell = r.criticDriftWarnings.length > 0 ? `${r.criticDriftWarnings.length} new` : '0';
    const regCell = r.regressionsInV2.length > 0 ? r.regressionsInV2.join('; ') : 'Aucune';

    lines.push(
      `| ${r.id} | ${r.category} | ${parityCell} | ${d27Cell} | ${coreCell} | ${pubmedCell} | ${a1Cell} | ${a2Cell} | ${driftCell} | ${regCell} |`
    );
  }

  lines.push('', '## Détails Critic Drift & Régressions V2', '');
  for (const r of reports) {
    if (r.criticDriftWarnings.length === 0 && r.regressionsInV2.length === 0 && !r.executionError) {
      continue;
    }
    lines.push(`### ${r.id} — ${r.label}`);
    if (r.executionError) lines.push(`- **Erreur d'exécution** : ${r.executionError}`);
    if (r.regressionsInV2.length > 0) {
      lines.push(`- **Régressions V2** : ${r.regressionsInV2.join(' | ')}`);
    }
    if (r.criticDriftWarnings.length > 0) {
      lines.push(`- **Critic Drift (nouveaux warnings Audit 2)** :`);
      for (const w of r.criticDriftWarnings) {
        lines.push(`  - ${w}`);
      }
    }
    if (r.v1 && r.v1.warnings.length > 0) {
      lines.push(`- **Warnings Audit 1** :`);
      for (const w of r.v1.warnings) {
        lines.push(`  - ${w}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

describe('Benchmark Diagnostic Boucle Audit (14 cas · V1 -> Audit 1 -> V2 -> Audit 2)', () => {
  const secrets = loadEnvSecrets();
  const reports: BenchmarkCaseReport[] = [];

  let originalFetch: typeof globalThis.fetch | null = null;
  let originalStorage: Storage | undefined;
  let currentTelemetry: ActiveTelemetry | null = null;

  beforeAll(() => {
    if (!secrets.geminiApiKey) {
      throw new Error(
        '[test:benchmark] GEMINI_API_KEY absente de l’environnement et de .env.local/.env. ' +
          'Exécutez : $env:GEMINI_API_KEY="votre_cle"; npm.cmd run test:benchmark'
      );
    }

    if (!fs.existsSync(RUST_CLI_BIN)) {
      execFileSync(
        'cargo',
        ['build', '--offline', '--manifest-path', 'rust_engine/Cargo.toml', '--bin', 'compile_axis_cli'],
        { stdio: 'inherit' }
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

    if (secrets.ncbiApiKey) setNcbiApiKey(secrets.ncbiApiKey);
    if (secrets.hetopUser && secrets.hetopPass) {
      setHetopCredentials(secrets.hetopUser, secrets.hetopPass);
    }

    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!originalFetch) throw new Error('originalFetch non initialisé');
      const response = await originalFetch(input, init);

      if (url.includes('generativelanguage.googleapis.com') && url.includes(':generateContent')) {
        const parsed = (await response
          .clone()
          .json()
          .catch(() => null)) as GeminiApiResponseEnvelope | null;
        if (currentTelemetry) {
          currentTelemetry.llmCalls += 1;
          const usage = parsed?.usageMetadata;
          if (usage) {
            currentTelemetry.promptTokens += usage.promptTokenCount ?? 0;
            currentTelemetry.candidateTokens += usage.candidatesTokenCount ?? 0;
            currentTelemetry.thoughtsTokens += usage.thoughtsTokenCount ?? 0;
            currentTelemetry.totalTokens += usage.totalTokenCount ?? 0;
          }
        }
      }

      return response;
    };
  });

  afterAll(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    if (originalStorage !== undefined) {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: originalStorage
      });
    }

    if (reports.length > 0) {
      const reportsDir = path.join(process.cwd(), 'reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      const tsSlug = new Date().toISOString().replace(/[:.]/g, '-');
      const timestampIso = new Date().toISOString();

      const jsonPayload = {
        generatedAt: timestampIso,
        totalCases: reports.length,
        summary: {
          tsRustParityOkCount: reports.filter(
            (r) => Boolean(r.v1?.parity.parityOk) && (!r.v2 || r.v2.parity.parityOk)
          ).length,
          criticDriftCaseCount: reports.filter((r) => r.criticDriftWarnings.length > 0).length,
          regressionCaseCount: reports.filter((r) => r.regressionsInV2.length > 0).length,
          v1CompliantCount: reports.filter((r) => r.v1?.pressStatus === 'compliant').length,
          v2CompliantCount: reports.filter((r) => r.v2?.pressStatus === 'compliant').length
        },
        cases: reports
      };

      const mdReport = buildMarkdownReport(reports, timestampIso);
      const latestJsonPath = path.join(reportsDir, 'audit-loop-benchmark-latest.json');
      const latestMdPath = path.join(reportsDir, 'audit-loop-benchmark-latest.md');
      const stampedJsonPath = path.join(reportsDir, `audit-loop-benchmark-${tsSlug}.json`);
      const stampedMdPath = path.join(reportsDir, `audit-loop-benchmark-${tsSlug}.md`);

      fs.writeFileSync(latestJsonPath, JSON.stringify(jsonPayload, null, 2), 'utf8');
      fs.writeFileSync(latestMdPath, mdReport, 'utf8');
      fs.writeFileSync(stampedJsonPath, JSON.stringify(jsonPayload, null, 2), 'utf8');
      fs.writeFileSync(stampedMdPath, mdReport, 'utf8');

      console.log('\n' + mdReport);
      console.log(`\nRapports exportés :\n- ${latestMdPath}\n- ${latestJsonPath}`);
    }
  });

  const subsetFilter = (process.env.BENCHMARK_SUBSET || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const scenariosToRun =
    subsetFilter.length > 0
      ? BENCHMARK_SCENARIOS.filter((s) => subsetFilter.includes(s.id.toUpperCase()))
      : BENCHMARK_SCENARIOS;

  for (let idx = 0; idx < scenariosToRun.length; idx += 1) {
    const scenario = scenariosToRun[idx];

    it(`[${scenario.id}] ${scenario.label}`, async () => {
      const telemetry: ActiveTelemetry = {
        llmCalls: 0,
        promptTokens: 0,
        candidateTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 0
      };
      currentTelemetry = telemetry;
      const t0 = performance.now();

      let v1Snapshot: StageSnapshot | null = null;
      let v2Snapshot: StageSnapshot | null = null;
      let refinementApplied = false;
      let refinementExplanation: string | undefined;
      let executionError: string | undefined;
      let criticDriftWarnings: string[] = [];
      let regressionsInV2: string[] = [];

      try {
        // 1. Extraction PICO initiale (Agent 1)
        const extracted = await parseClinicalAbstractNLP(scenario.clinicalProse);
        await sleep(STAGE_DELAY_MS);

        const recActive = extracted.qualifications?.recommendedActivePico;
        const v1ActivePico: Record<'p' | 'i' | 'c' | 'o' | 'not', boolean> = recActive
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
            };

        const v1Pico: PicoInputs = {
          p: extracted.p,
          i: extracted.i,
          c: extracted.c,
          o: extracted.o,
          not: extracted.not
        };
        const v1Settings: PipelineSettings = {
          strategy: 'balanced',
          filters: ['humans_cochrane'],
          qualifications: extracted.qualifications,
          activePico: v1ActivePico,
          ...(scenario.pipelineOverrides ?? {})
        };

        // 2. Exécution V1 + Audit 1
        const v1Result = await runMultiAgentPipeline(v1Pico, v1Settings);
        v1Snapshot = buildStageSnapshot(v1Pico, v1ActivePico, v1Settings, v1Result);
        await sleep(STAGE_DELAY_MS);

        // 3. Raffinement V2 selon Audit 1
        const refined = await aiRefinePicoFromAudit(
          v1Pico,
          v1ActivePico,
          v1Result.critiqueReport,
          v1Settings.qualifications
        );
        await sleep(STAGE_DELAY_MS);

        if (refined) {
          refinementApplied = true;
          refinementExplanation = refined.explanation;
          const v2ActivePico: Record<'p' | 'i' | 'c' | 'o' | 'not', boolean> = {
            p: refined.activePico?.p ?? v1ActivePico.p,
            i: refined.activePico?.i ?? v1ActivePico.i,
            c: refined.activePico?.c ?? v1ActivePico.c,
            o: refined.activePico?.o ?? v1ActivePico.o,
            not: refined.activePico?.not ?? v1ActivePico.not
          };
          const mergedQualifications: PicoSemanticQualifications = {
            ...(v1Settings.qualifications || {}),
            ...(refined.qualifications || {})
          };
          const v2Settings: PipelineSettings = {
            ...v1Settings,
            qualifications:
              Object.keys(mergedQualifications).length > 0 ? mergedQualifications : v1Settings.qualifications,
            activePico: v2ActivePico,
            strategy: refined.strategy || v1Settings.strategy,
            previousAudit: {
              iteration: 2,
              previousWarnings: v1Snapshot.warnings,
              changesSummary: (['p', 'i', 'c', 'o', 'not'] as const)
                .filter((k) => (v1Pico[k] || '').trim() !== (refined.refinedPico[k] || '').trim())
                .map((k) => `${k.toUpperCase()}: "${v1Pico[k] || ''}" -> "${refined.refinedPico[k] || ''}"`)
                .join(' ; ')
            }
          };
          const v2Pico: PicoInputs = {
            p: refined.refinedPico.p,
            i: refined.refinedPico.i,
            c: refined.refinedPico.c,
            o: refined.refinedPico.o,
            not: refined.refinedPico.not
          };

          // 4. Exécution V2 + Audit 2
          const v2Result = await runMultiAgentPipeline(v2Pico, v2Settings);
          v2Snapshot = buildStageSnapshot(v2Pico, v2ActivePico, v2Settings, v2Result);

          criticDriftWarnings = detectCriticDrift(v1Snapshot.warnings, v2Snapshot.warnings);
          regressionsInV2 = detectV2Regressions(v1Snapshot, v2Snapshot);
        }
      } catch (err: unknown) {
        executionError = err instanceof Error ? err.message : String(err);
      } finally {
        const latencyMs = Math.round(performance.now() - t0);
        const outputTokens = telemetry.candidateTokens + telemetry.thoughtsTokens;
        const effectiveOut = outputTokens > 0 ? outputTokens : Math.max(0, telemetry.totalTokens - telemetry.promptTokens);
        const estimatedCostEur =
          ((telemetry.promptTokens / 1_000_000) * GEMINI_FLASH_LITE_INPUT_USD_PER_1M +
            (effectiveOut / 1_000_000) * GEMINI_FLASH_LITE_OUTPUT_USD_PER_1M) *
          USD_TO_EUR_RATE;

        reports.push({
          id: scenario.id,
          category: scenario.category,
          label: scenario.label,
          executionError,
          latencyMs,
          refinementApplied,
          refinementExplanation,
          v1: v1Snapshot,
          v2: v2Snapshot,
          criticDriftWarnings,
          regressionsInV2,
          llmCalls: telemetry.llmCalls,
          totalTokens: telemetry.totalTokens,
          estimatedCostEur
        });

        currentTelemetry = null;
        if (idx < scenariosToRun.length - 1) {
          await sleep(SCENARIO_DELAY_MS);
        }
      }

      // Seule assertion bloquante du benchmark diagnostique : exécution complète + parité stricte TS <-> Rust
      expect(executionError).toBeUndefined();
      expect(v1Snapshot?.parity.parityOk, v1Snapshot?.parity.mismatches.join(' | ')).toBe(true);
      if (v2Snapshot) {
        expect(v2Snapshot.parity.parityOk, v2Snapshot.parity.mismatches.join(' | ')).toBe(true);
      }
    });
  }
});
