import {
  searchMeshRust as searchNcbiMesh,
  queryPubMedRust as queryPubMedLive,
  evaluatePressIndexDeterministic,
  finalizePressStatus,
  compileAxisBlockRust,
  CritiqueReport,
  AuditObservationEntry,
  AuditObservationItem,
  normalizeAuditObservation,
  PressCriterionScore,
  PressStatusLevel,
  MeshDescriptorItem,
  AxisCompilationInputRust,
  MeshDescriptorNodeRust,
  PicoAxisRoleRust
} from './rustEngineService';
import {
  aiExtractClinicalPico,
  aiAuditAndCritiqueQuery,
  PreviousAuditContext,
  ClinicalPicoExtractionResult,
  PicoSemanticQualifications,
  getAiConfig,
  getActiveProviderLabel,
  sanitizePicoConcept,
  inferDeterministicAxisQualification,
  stripIatrogenicTermsFromOutcome
} from './localAiService';

export type {
  ClinicalPicoExtractionResult,
  PicoSemanticQualifications,
  CritiqueReport,
  AuditObservationEntry,
  AuditObservationItem,
  PressCriterionScore,
  PressStatusLevel
};
export { normalizeAuditObservation };

export interface PicoInputs {
  p: string;
  i: string;
  c: string;
  o: string;
  not?: string;
}

export interface PipelineSettings {
  strategy?: 'sensitive' | 'balanced' | 'specific';
  useTruncation?: boolean;
  noExplode?: boolean;
  filters?: string[];
  qualifiers?: string[];
  screeningMode?: 'sample' | 'all';
  activePico?: {
    p: boolean;
    i: boolean;
    c: boolean;
    o: boolean;
    not: boolean;
  };
  qualifications?: PicoSemanticQualifications;
  previousAudit?: PreviousAuditContext;
  dateRange?: {
    enabled?: boolean;
    startYear?: number | string;
    endYear?: number | string;
    startDate?: string;
    endDate?: string;
  };
}

export interface MappedBlock {
  picoType: 'P' | 'I' | 'C' | 'O' | 'NOT';
  originalText: string;
  descriptor: string;
  meshId: string;
  descriptors: MeshDescriptorItem[];
  entryTerms: string[];
  truncationTerms?: string[];
  selectedQualifiers?: string[];
  allowedSubheadings?: string[];
  axisRole?: PicoAxisRoleRust;
  impliedSubheadings?: string[];
  isPharmacologicalSubstance?: boolean;
}

/**
 * Nettoie les syntagmes extraits en éliminant les scories verbales introductives
 * sans toucher aux entités biomédicales.
 */
export function cleanClinicalClause(text: string): string {
  if (!text) return '';
  let s = text.trim();
  s = s.replace(/^[\s,;:\-–—.]+|[\s,;:\-–—.]+$/g, '');

  const noisePrefixes = [
    /^(?:nous avons (?:évalué|analysé|étudié|comparé|testé)|l'objectif (?:de cette étude|de ce travail|principal)? était (?:d'évaluer|de comparer|d'analyser|de déterminer)|cette étude (?:prospective|rétrospective|randomisée)? (?:évalue|analyse|compare)|il s'agit d'une? étude (?:prospective|rétrospective|randomisée)? (?:visant à|évaluant)|le but de cette étude était de)\s+/i,
    /^(?:we evaluated|the purpose of this study was to|this (?:randomized|prospective|retrospective)? study (?:aimed to|evaluated|investigated)|our objective was to)\s+/i,
    /^(?:évaluation de|évaluation d'|analyse de|analyse d'|étude de|étude d'|impact de|impact d'|effet de|effet d')\s+/i
  ];

  for (const pat of noisePrefixes) {
    s = s.replace(pat, '');
  }

  return s.trim();
}

export function parseExplicitStructuredSections(rawText: string): ClinicalPicoExtractionResult | null {
  if (!rawText || !rawText.trim()) return null;

  let p = '';
  let i = '';
  let c = '';
  let o = '';
  let not = '';
  let matchedCount = 0;

  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const pMatch = trimmed.match(/^(?:population|patients?(?:\s+et\s+m[ée]thodes)?|participants?|inclusion|cohorte|participants?\s+and\s+methods|subjects?)\s*[:\-–—]\s*(.+)$/i);
    if (pMatch && !p) {
      p = cleanClinicalClause(pMatch[1]);
      matchedCount++;
      continue;
    }

    const iMatch = trimmed.match(/^(?:intervention|traitement|treatment|exposure|proc[ée]dure|experimental\s+group|bras\s+actif)\s*[:\-–—]\s*(.+)$/i);
    if (iMatch && !i) {
      i = cleanClinicalClause(iMatch[1]);
      matchedCount++;
      continue;
    }

    const cMatch = trimmed.match(/^(?:comparat(?:eur|or)|contr[ôo]le|control(?:\s+group)?|placebo|r[ée]f[ée]rence|groupe\s+t[ée]moin|comparaison)\s*[:\-–—]\s*(.+)$/i);
    if (cMatch && !c) {
      c = cleanClinicalClause(cMatch[1]);
      matchedCount++;
      continue;
    }

    const oMatch = trimmed.match(/^(?:crit[èe]res?\s+(?:de\s+jugement|princip(?:al|aux))|outcomes?|endpoints?|r[ée]sultats?\s+mesur[ée]s?|mesures?|primary\s+endpoint)\s*[:\-–—]\s*(.+)$/i);
    if (oMatch && !o) {
      o = stripIatrogenicTermsFromOutcome(cleanClinicalClause(oMatch[1]));
      matchedCount++;
      continue;
    }

    const notMatch = trimmed.match(/^(?:crit[èe]res?\s+d['’]exclusion|exclusions?|non\s+inclus?|exclusion\s+criteria)\s*[:\-–—]\s*(.+)$/i);
    if (notMatch && !not) {
      not = cleanClinicalClause(notMatch[1]);
      matchedCount++;
      continue;
    }
  }

  if (matchedCount >= 2 && (p || i)) {
    const pQual = inferDeterministicAxisQualification('P', p);
    const iQual = inferDeterministicAxisQualification('I', i);
    const cQual = inferDeterministicAxisQualification('C', c);
    const oQual = inferDeterministicAxisQualification('O', o);
    const notQual = inferDeterministicAxisQualification('NOT', not);

    return {
      p,
      i,
      c,
      o,
      not,
      source: 'rules',
      confidence: 95,
      reasoning: 'Extraction structurée exacte basée sur les en-têtes explicites du texte.',
      qualifications: {
        p: pQual,
        i: iQual,
        c: cQual,
        o: oQual,
        not: notQual,
        recommendedActivePico: {
          p: pQual.axisRole !== 'demographic_unrestricted' && Boolean(p),
          i: Boolean(i),
          c: cQual.axisRole !== 'passive_comparator' && Boolean(c),
          o: Boolean(o),
          not: Boolean(not)
        }
      }
    };
  }

  return null;
}

function parseClinicalDiscourseFallback(rawText: string): ClinicalPicoExtractionResult | null {
  // 1. Détection grammaticale d'une question étiologique / pharmacovigilance interrogative
  // Ex: "Chez l’adulte, quels médicaments ... sont associés à la survenue d’un <phénotype>, avec quelle ampleur..."
  const etiologicQuestionMatch = rawText.match(
    /chez\s+(?:l['’]|les?\s+)([^,]+),\s*quels?\s+m[ée]dicaments?([^?]*?)\bsont\s+associ[ée]s?\s+[àa]\s+la\s+survenue\s+d['’](?:un[e]?\s+|des?\s+)?([^,?]+)/i
  );
  if (etiologicQuestionMatch) {
    const rawPop = etiologicQuestionMatch[1].trim();
    const rawContext = etiologicQuestionMatch[2].trim();
    const rawOutcome = stripIatrogenicTermsFromOutcome(etiologicQuestionMatch[3].trim());

    const p = /\bsoins?\s+primaires?\b/i.test(rawContext)
      ? 'Adultes en soins primaires'
      : cleanClinicalClause(rawPop);
    const i = 'Effets indésirables médicamenteux, Pharmacovigilance';
    const c = "Absence d'exposition";
    const o = /\binduit|\bm[ée]dicamenteux/i.test(rawOutcome)
      ? rawOutcome
      : `${rawOutcome} secondaire induit chimiquement`;

    const pQual = inferDeterministicAxisQualification('P', p);
    const iQual = inferDeterministicAxisQualification('I', i);
    const cQual = inferDeterministicAxisQualification('C', c);
    const oQual = inferDeterministicAxisQualification('O', o);
    const notQual = inferDeterministicAxisQualification('NOT', '');

    return {
      p,
      i,
      c,
      o,
      not: '',
      source: 'rules',
      confidence: 96,
      reasoning:
        "Question étiologique/pharmacovigilance ouverte (PECO Voie 2) : séparation stricte entre l'exposition médicamenteuse générique (I) et le phénotype induit chimiquement (O), avec désactivation documentaire de la démographie (P) et du comparateur passif (C).",
      qualifications: {
        p: pQual,
        i: iQual,
        c: cQual,
        o: oQual,
        not: notQual,
        recommendedActivePico: {
          p: pQual.axisRole !== 'demographic_unrestricted',
          i: true,
          c: cQual.axisRole !== 'passive_comparator',
          o: true,
          not: false
        }
      }
    };
  }

  const sentences = rawText
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  let p = '';
  let i = '';
  let c = '';
  let o = '';
  let not = '';

  for (const s of sentences) {
    if (!not && /\b(?:exclus(?:ion)?|non[\s-]inclus|contre[\s-]indiqu)\b/i.test(s)) {
      not = cleanClinicalClause(s);
      continue;
    }
    if (!o && /\b(?:crit[èe]res?\s+de\s+jugement|primary\s+endpoint|outcomes?|mortalit[ée]|survie|efficacité\s+sur)\b/i.test(s)) {
      o = stripIatrogenicTermsFromOutcome(cleanClinicalClause(s));
      continue;
    }
    if (!c && /\b(?:groupe\s+contr[ôo]le|placebo|comparateur|prise\s+en\s+charge\s+standard|soins?\s+usuels?|soins?\s+standards?)\b/i.test(s)) {
      c = cleanClinicalClause(s);
      continue;
    }
    if (!i && /\b(?:[ée]valu[ée]|traitement\s+par|intervention|administr[ée]|recevaient|th[ée]rapie\s+par)\b/i.test(s)) {
      i = cleanClinicalClause(s);
      continue;
    }
    if (!p && /\b(?:patients?|adultes?|sujets?|enfants?|population|atteints?\s+de|souffrant\s+de|ob[èe]ses?)\b/i.test(s)) {
      p = cleanClinicalClause(s);
      continue;
    }
  }

  if (p || i) {
    const pQual = inferDeterministicAxisQualification('P', p);
    const iQual = inferDeterministicAxisQualification('I', i);
    const cQual = inferDeterministicAxisQualification('C', c);
    const oQual = inferDeterministicAxisQualification('O', o);
    const notQual = inferDeterministicAxisQualification('NOT', not);

    return {
      p,
      i,
      c,
      o,
      not,
      source: 'rules',
      confidence: 80,
      reasoning: 'Extraction discursive par segmentation grammaticale des phrases cliniques.',
      qualifications: {
        p: pQual,
        i: iQual,
        c: cQual,
        o: oQual,
        not: notQual,
        recommendedActivePico: {
          p: pQual.axisRole !== 'demographic_unrestricted' && Boolean(p),
          i: Boolean(i),
          c: cQual.axisRole !== 'passive_comparator' && Boolean(c),
          o: Boolean(o),
          not: Boolean(not)
        }
      }
    };
  }
  return null;
}

export async function parseClinicalAbstractNLP(rawText: string): Promise<ClinicalPicoExtractionResult> {
  if (!rawText || rawText.trim() === '') {
    return { p: '', i: '', c: '', o: '', not: '', source: 'rules', confidence: 0, reasoning: 'Texte vide' };
  }

  const explicitResult = parseExplicitStructuredSections(rawText);
  if (explicitResult) {
    return explicitResult;
  }

  try {
    const aiExtracted = await aiExtractClinicalPico(rawText);
    if (aiExtracted && (aiExtracted.p || aiExtracted.i)) {
      return aiExtracted;
    }
  } catch {}

  const discourseFallback = parseClinicalDiscourseFallback(rawText);
  if (discourseFallback) {
    return discourseFallback;
  }

  throw new Error(
    "L'extraction par IA n'a pas pu identifier les axes PICO dans ce texte. Vérifiez votre clé API Cloud (Google Gemini, OpenAI ou Anthropic) dans les Paramètres."
  );
}

const VALID_RUST_AXIS_ROLES = new Set<PicoAxisRoleRust>([
  'pathology_outcome',
  'drug_inn_list',
  'therapeutic_class',
  'generic_intervention',
  'population',
  'comparator',
  'exclusion'
]);

function normalizeToRustAxisRole(
  picoType: 'P' | 'I' | 'C' | 'O' | 'NOT',
  rawRole?: string
): PicoAxisRoleRust {
  if (rawRole && VALID_RUST_AXIS_ROLES.has(rawRole as PicoAxisRoleRust)) {
    return rawRole as PicoAxisRoleRust;
  }
  switch (picoType) {
    case 'O':
      return 'pathology_outcome';
    case 'P':
      return 'population';
    case 'C':
      return 'comparator';
    case 'NOT':
      return 'exclusion';
    default:
      return 'generic_intervention';
  }
}

/**
 * Prépare et normalise le payload `AxisCompilationInputRust` destiné au moteur Rust/WASM (`compileAxisBlockWasm`).
 */
export function buildAxisCompilationPayload(
  block: MappedBlock,
  settings: PipelineSettings
): AxisCompilationInputRust {
  const inferred = inferDeterministicAxisQualification(block.picoType, block.originalText || block.descriptor);
  const isNotBlock = block.picoType === 'NOT';
  const isSpecific = settings.strategy === 'specific' && !isNotBlock;

  const isRealMesh = Boolean(
    block.meshId && !block.meshId.startsWith('Concept-') && block.meshId !== 'Custom'
  );

  const rawDescriptors: MeshDescriptorItem[] =
    block.descriptors && block.descriptors.length > 0
      ? block.descriptors.filter((d) =>
          Boolean(d.meshId && !d.meshId.startsWith('Concept-') && d.meshId !== 'Custom')
        )
      : isRealMesh
        ? [
            {
              descriptor: block.descriptor,
              meshId: block.meshId,
              noExp: false,
              isMajor: false,
              allowedSubheadings: block.allowedSubheadings,
              isPharmacologicalSubstance: block.isPharmacologicalSubstance
            }
          ]
        : [];

  const descriptorNodes: MeshDescriptorNodeRust[] = rawDescriptors.map((d) => ({
    descriptor: d.descriptor,
    meshId: d.meshId,
    allowedSubheadings: d.allowedSubheadings ?? block.allowedSubheadings ?? [],
    selectedSubheadings: isNotBlock
      ? []
      : [...(d.qualifiers ?? []), ...(block.selectedQualifiers ?? [])],
    treeNumbers: d.treeNumbers ?? [],
    isPharmacologicalSubstance: Boolean(d.isPharmacologicalSubstance ?? block.isPharmacologicalSubstance),
    noExp: Boolean(d.noExp || settings.noExplode),
    isMajor: Boolean(d.isMajor || isSpecific)
  }));

  const hasPharmaClass = descriptorNodes.some(
    (d) =>
      (d.treeNumbers ?? []).some((tn) => tn.trim().toUpperCase().startsWith('D27')) ||
      /\b(?:agents|drugs|inhibitors|antagonists|agonists|blockers|stimulants|depressants|therapeutics|preparations|compounds|derivatives|hormones|antibiotics|analgesics|anesthetics|vaccines|receptors|enzymes|analogues|analogs)\b/i.test(
        d.descriptor
      ) ||
      (!d.isPharmacologicalSubstance && descriptorNodes.some((other) => other.isPharmacologicalSubstance))
  );

  const allDescriptorsArePharma =
    !hasPharmaClass &&
    descriptorNodes.length > 1 &&
    descriptorNodes.every((d) => d.isPharmacologicalSubstance);

  const baseRole = normalizeToRustAxisRole(
    block.picoType,
    block.axisRole ?? (allDescriptorsArePharma ? 'drug_inn_list' : inferred.axisRole)
  );
  const resolvedAxisRole: PicoAxisRoleRust =
    hasPharmaClass && baseRole === 'drug_inn_list' ? 'therapeutic_class' : baseRole;

  const impliedSubheadings = isNotBlock
    ? []
    : Array.from(
        new Set([
          ...(block.impliedSubheadings ?? []),
          ...inferred.impliedSubheadings
        ])
      );

  const rawClinicalTokens = (block.originalText || '')
    .split(/[,;]|\s+(?:ou|or|et|and)\s+/i)
    .map((t) => t.replace(/[()]/g, '').trim())
    .filter((t) => t.length >= 4);

  return {
    axisRole: resolvedAxisRole,
    impliedSubheadings,
    descriptors: descriptorNodes,
    entryTerms: block.entryTerms || [],
    rawClinicalTokens,
    customTruncations: settings.useTruncation !== false ? (block.truncationTerms || []) : []
  };
}

/**
 * Sérialise en JSON strict (`camelCase`) le payload `AxisCompilationInput` pour `compileAxisBlockWasm`.
 */
export function serializeAxisCompilationPayload(
  block: MappedBlock,
  settings: PipelineSettings
): string {
  return JSON.stringify(buildAxisCompilationPayload(block, settings));
}

export async function runMultiAgentPipeline(
  picoInputs: PicoInputs,
  settings: PipelineSettings,
  onStepProgress?: (stepId: number, status: string, message: string) => void
) {
  onStepProgress?.(1, 'running', "Structuration des axes PICO & critères d'exclusion...");
  await new Promise((r) => setTimeout(r, 80));

  const activeBlocks = settings.activePico || { p: true, i: true, c: true, o: true, not: true };
  const activeConcepts: Array<{ type: 'P' | 'I' | 'C' | 'O' | 'NOT'; label: string; text: string }> = [];

  if (activeBlocks.p && picoInputs.p?.trim()) {
    activeConcepts.push({ type: 'P', label: 'Population', text: sanitizePicoConcept(picoInputs.p) });
  }
  if (activeBlocks.i && picoInputs.i?.trim()) {
    activeConcepts.push({ type: 'I', label: 'Intervention', text: sanitizePicoConcept(picoInputs.i) });
  }
  if (activeBlocks.c && picoInputs.c?.trim()) {
    activeConcepts.push({ type: 'C', label: 'Comparaison', text: sanitizePicoConcept(picoInputs.c) });
  }
  if (activeBlocks.o && picoInputs.o?.trim()) {
    const cleanOutcome = stripIatrogenicTermsFromOutcome(sanitizePicoConcept(picoInputs.o));
    if (cleanOutcome) {
      activeConcepts.push({ type: 'O', label: 'Outcome', text: cleanOutcome });
    }
  }
  if (activeBlocks.not && picoInputs.not?.trim()) {
    activeConcepts.push({ type: 'NOT', label: 'Exclusion', text: sanitizePicoConcept(picoInputs.not) });
  }

  // COURT-CIRCUIT STRICT (Hard Drop) :
  // 1. Tout axe qualifié en `passive_comparator` ("Absence d'exposition", "Placebo", "Soins courants") est éliminé avant tout appel NLM/HeTOP.
  // 2. Tout axe qualifié en `demographic_unrestricted` ("Adultes en soins primaires", "Population générale") est éliminé dès lors qu'au moins un axe clinique (I ou O) est présent.
  let droppedComparatorReason: 'passive_comparator' | 'unresolved_mesh' | undefined;
  const hasSpecificClinicalAxis = activeConcepts.some((c) => c.type === 'I' || c.type === 'O');
  const filteredConcepts = activeConcepts.filter((item) => {
    const qual = inferDeterministicAxisQualification(item.type, item.text);
    if (qual.axisRole === 'passive_comparator') {
      if (item.type === 'C') {
        droppedComparatorReason = 'passive_comparator';
      }
      return false;
    }
    if (qual.axisRole === 'demographic_unrestricted' && hasSpecificClinicalAxis) {
      return false;
    }
    return true;
  });

  const coreConcepts = filteredConcepts.filter((c) => c.type !== 'NOT');
  if (coreConcepts.length === 0) {
    onStepProgress?.(1, 'error', "0 axe PICO actif. Renseignez au moins la Population (P) ou l'Intervention (I).");
    return {
      pubmedQuery: '',
      embaseQuery: '',
      cochraneQuery: '',
      mappedBlocks: [],
      liveResult: { count: 0, queryTranslation: '', articles: [], error: 'Aucun concept clinique PICO actif sélectionné.' },
      usedFallback: false,
      critiqueReport: {
        score: 0,
        pressStatus: 'revision_required' as PressStatusLevel,
        pressAlertCount: 1,
        observations: ["🔴 Aucun axe PICO n'est actif. L'audit nécessite au moins un axe Population ou Intervention renseigné."],
        recommendations: ['Renseignez vos termes cliniques (Population ou Intervention) et vérifiez que leurs cases sont cochées.']
      }
    };
  }

  onStepProgress?.(
    1,
    'completed',
    `${filteredConcepts.length} axe(s) structuré(s) (dont ${filteredConcepts.filter((c) => c.type === 'NOT').length} exclusion).`
  );

  onStepProgress?.(2, 'running', 'Résolution dynamique MeSH officielle & qualification NLM (ds_subheading)...');

  const mappedBlocks: MappedBlock[] = [];
  for (const item of filteredConcepts) {
    const qualification = inferDeterministicAxisQualification(item.type, item.text);
    if (
      qualification.axisRole === 'passive_comparator' ||
      (qualification.axisRole === 'demographic_unrestricted' && hasSpecificClinicalAxis)
    ) {
      continue;
    }

    const queryTarget =
      item.type === 'O' && qualification.coreClinicalConcept
        ? qualification.coreClinicalConcept
        : item.text;

    const axisKey = item.type.toLowerCase() as 'p' | 'i' | 'c' | 'o' | 'not';
    const englishHints = settings.qualifications?.[axisKey]?.englishCoreTerms;

    const meshDetails = await searchNcbiMesh(queryTarget, item.type, englishHints);

    if (!meshDetails && item.type === 'C' && !droppedComparatorReason) {
      droppedComparatorReason = 'unresolved_mesh';
    }

    if (meshDetails) {
      const descriptorsList =
        meshDetails.descriptors && meshDetails.descriptors.length > 0
          ? meshDetails.descriptors
          : [
              {
                descriptor: meshDetails.descriptor,
                meshId: meshDetails.meshId,
                noExp: false,
                isMajor: false,
                allowedSubheadings: meshDetails.allowedSubheadings,
                treeNumbers: meshDetails.treeNumbers,
                isPharmacologicalSubstance: meshDetails.isPharmacologicalSubstance
              }
            ];

      const hasPharmaClassDescriptor = descriptorsList.some(
        (d) =>
          (d.treeNumbers ?? []).some((tn) => tn.trim().toUpperCase().startsWith('D27')) ||
          /\b(?:agents|drugs|inhibitors|antagonists|agonists|blockers|stimulants|depressants|therapeutics|preparations|compounds|derivatives|hormones|antibiotics|analgesics|anesthetics|vaccines|receptors|enzymes|analogues|analogs)\b/i.test(
            d.descriptor
          ) ||
          !d.isPharmacologicalSubstance
      );

      const isPharmaAxis =
        !hasPharmaClassDescriptor &&
        (qualification.axisRole === 'drug_inn_list' ||
          (descriptorsList.length > 1 && descriptorsList.every((d) => Boolean(d.isPharmacologicalSubstance))));

      const resolvedRole: PicoAxisRoleRust = isPharmaAxis
        ? 'drug_inn_list'
        : hasPharmaClassDescriptor && qualification.axisRole === 'drug_inn_list'
          ? 'therapeutic_class'
          : normalizeToRustAxisRole(item.type, qualification.axisRole);

      const explicitQualifiers =
        item.type !== 'NOT' && item.type !== 'C' ? [...(settings.qualifiers || [])] : [];
      const mergedQualifiers = Array.from(
        new Set([...explicitQualifiers, ...qualification.impliedSubheadings])
      );

      mappedBlocks.push({
        picoType: item.type,
        originalText: item.text,
        descriptor: meshDetails.descriptor,
        meshId: meshDetails.meshId || 'D-MeSH',
        descriptors: descriptorsList,
        entryTerms: meshDetails.entryTerms || [meshDetails.descriptor.toLowerCase()],
        truncationTerms: meshDetails.truncationTerms || [],
        selectedQualifiers: mergedQualifiers,
        allowedSubheadings: meshDetails.allowedSubheadings || [],
        axisRole: resolvedRole,
        impliedSubheadings: qualification.impliedSubheadings,
        isPharmacologicalSubstance: isPharmaAxis
      });
    }
  }

  const totalDescriptors = mappedBlocks.reduce((acc, b) => acc + b.descriptors.length, 0);
  const totalSynonyms = mappedBlocks.reduce((acc, b) => acc + b.entryTerms.length, 0);
  onStepProgress?.(
    2,
    'completed',
    `${totalDescriptors} descripteur(s) MeSH et ${totalSynonyms} termes d'entrée identifiés.`
  );

  onStepProgress?.(3, 'running', 'Compilation algébrique Rust/WASM (Filtre [tw], Dominance dérivationnelle, Subsomption)...');
  await new Promise((r) => setTimeout(r, 80));

  const { pubmedQuery, embaseQuery, cochraneQuery } = buildQuerySyntax(mappedBlocks, settings);

  onStepProgress?.(3, 'completed', 'Équations booléennes multi-bases construites.');

  onStepProgress?.(4, 'running', "Interrogation de l'API PubMed en direct (Best Match, échantillon stratifié)...");

  const liveResult = await queryPubMedLive(pubmedQuery, { maxResults: 2500, sort: 'relevance' });

  const sampleNote =
    liveResult.articles.length > 0
      ? ` (échantillon stratifié de ${liveResult.articles.length} titres prêt pour l'audit)`
      : '';
  onStepProgress?.(
    4,
    'completed',
    `${liveResult.count.toLocaleString('fr-FR')} article(s) trouvé(s) sur PubMed${sampleNote}.`
  );

  onStepProgress?.(5, 'running', 'Calcul de l\'indice PRESS déterministe & revue qualitative...');
  await new Promise((r) => setTimeout(r, 100));

  const sampleTitles = (liveResult.articles || []).map((a) => a.title).filter(Boolean);
  const descriptorNames = mappedBlocks.map((b) => b.descriptor);

  const effectiveAuditPico: PicoInputs = {
    p: activeBlocks.p ? picoInputs.p : '',
    i: activeBlocks.i ? picoInputs.i : '',
    c: activeBlocks.c ? picoInputs.c : '',
    o: activeBlocks.o ? picoInputs.o : '',
    not: activeBlocks.not ? (picoInputs.not || '') : ''
  };

  const pressReport = evaluatePressIndexDeterministic({
    pubmedQuery,
    embaseQuery,
    cochraneQuery,
    blocks: mappedBlocks,
    activeCoreAxesCount: coreConcepts.length,
    articleCount: liveResult.count,
    totalSynonyms,
    hasActiveComparator: Boolean(activeBlocks.c && picoInputs.c?.trim()),
    hasActiveNot: Boolean(activeBlocks.not && picoInputs.not?.trim()),
    hasStrictHumansFilter: Boolean(settings.filters?.includes('humans')),
    activeUserAxes: filteredConcepts.map((c) => ({ picoType: c.type, text: c.text }))
  });

  const aiConfig = getAiConfig();
  const isDeterministicProvider = aiConfig.provider === 'deterministic';
  const providerLabel = getActiveProviderLabel(aiConfig, 'reasoning');

  onStepProgress?.(
    5,
    'running',
    `Audit clinique & méthodologique (${isDeterministicProvider ? 'Contrôles PRESS' : providerLabel})...`
  );

  let critiqueReport: CritiqueReport = pressReport;

  if (!effectiveAuditPico.p && !effectiveAuditPico.i && !effectiveAuditPico.c && !effectiveAuditPico.o) {
    critiqueReport = {
      score: 0,
      pressStatus: 'revision_required',
      pressAlertCount: 1,
      observations: ["Aucun axe PICO n'a été renseigné pour cette recherche."],
      recommendations: ["Renseignez au minimum l'axe Population (P) et Intervention (I)."],
      pressBreakdown: pressReport.pressBreakdown
    };
  } else if (!isDeterministicProvider) {
    try {
      const aiCritique = await aiAuditAndCritiqueQuery(
        effectiveAuditPico,
        pubmedQuery,
        descriptorNames,
        liveResult.count,
        sampleTitles,
        settings.previousAudit,
        liveResult.stratifiedSample
      );
      if (aiCritique) {
        const finalized = finalizePressStatus(
          pressReport,
          aiCritique.observations,
          liveResult.count,
          false
        );
        critiqueReport = {
          score: pressReport.score,
          pressBreakdown: pressReport.pressBreakdown,
          pressStatus: finalized.pressStatus,
          pressAlertCount: finalized.pressAlertCount,
          observations: aiCritique.observations,
          recommendations: aiCritique.recommendations,
          source: aiCritique.source,
          evaluatorModel: aiCritique.evaluatorModel
        };
      }
    } catch {
      // Conservation du rapport déterministe PRESS en cas d'indisponibilité réseau/IA
      critiqueReport = pressReport;
    }
  }

  const sourceLabel =
    critiqueReport?.source === 'gemini'
      ? `Google Gemini (${critiqueReport.evaluatorModel || 'Pro'})`
      : critiqueReport?.source === 'openai'
        ? `OpenAI (${critiqueReport.evaluatorModel || 'gpt-4o'})`
        : critiqueReport?.source === 'anthropic'
          ? `Anthropic Claude (${critiqueReport.evaluatorModel || 'Sonnet'})`
          : 'Contrôles PRESS';

  const statusText =
    critiqueReport.pressStatus === 'revision_required'
      ? 'Révision requise'
      : critiqueReport.pressStatus === 'needs_refinement'
        ? `À affiner (${critiqueReport.pressAlertCount || 1})`
        : 'Stratégie conforme';

  onStepProgress?.(5, 'completed', `Analyse terminée (${sourceLabel}). Statut PRESS : ${statusText}.`);

  return {
    pubmedQuery,
    embaseQuery,
    cochraneQuery,
    mappedBlocks,
    droppedComparatorReason,
    liveResult,
    usedFallback: false,
    critiqueReport
  };
}

function toEmbaseDate(isoOrSlashDate: string): string {
  const parts = isoOrSlashDate.trim().split(/[/-]/);
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}-${parts[0]}`;
  }
  return isoOrSlashDate;
}

/**
 * GÉNÉRATEUR D'ÉQUATIONS BOOLÉENNES MÉDICALES DE HAUT NIVEAU (PRISMA-S / PRESS)
 * Délègue la compilation algébrique de chaque axe PICO au moteur pur `compileAxisBlockRust` :
 * - Filtre d'arité lexicale `[tw]` sur les listes de substances pharmacologiques (`drug_inn_list`)
 * - Loi d'absorption des sous-descripteurs (`"Descriptor/subheading"[Mesh]`)
 * - Dominance dérivationnelle des troncatures (`parkinsonis*`, `parkinsonian*` $\succ$ `parkinson*`)
 * - Subsomption préfixielle booléenne ($A \lor (A \land B) \equiv A$)
 */
export function buildQuerySyntax(mappedBlocks: MappedBlock[], settings: PipelineSettings) {
  const mode = settings.strategy || 'balanced';
  const useTrunc = settings.useTruncation !== false;

  const pubmedPositiveParts: string[] = [];
  const corePositiveParts: string[] = [];
  const pubmedNotParts: string[] = [];

  const embasePositiveParts: string[] = [];
  const embaseNotParts: string[] = [];

  const cochranePositiveParts: string[] = [];
  const cochraneNotParts: string[] = [];

  mappedBlocks.forEach((block) => {
    const inferred = inferDeterministicAxisQualification(
      block.picoType,
      block.originalText || block.descriptor
    );
    const effectiveRole = block.axisRole ?? (inferred.axisRole as PicoAxisRoleRust);
    if (
      effectiveRole === ('passive_comparator' as PicoAxisRoleRust) ||
      effectiveRole === ('demographic_unrestricted' as PicoAxisRoleRust)
    ) {
      return;
    }

    const isNotBlock = block.picoType === 'NOT';
    const payload = buildAxisCompilationPayload(block, settings);
    const compiled = compileAxisBlockRust(payload);

    let pubmedBlock = compiled.pubmedClause;
    let embaseBlock = compiled.embaseClause;
    let cochraneBlock = compiled.centralClause;

    // Fallback si Concept-Libre (aucun descripteur NLM Dxxxxxx valide et non-médicament)
    if (!pubmedBlock) {
      const textTag = mode === 'specific' && !isNotBlock ? '[Ti]' : '[TiAb]';
      const rawTerms = block.entryTerms && block.entryTerms.length > 0 ? block.entryTerms : [block.descriptor];
      const validTerms = Array.from(new Set([block.descriptor.toLowerCase(), ...rawTerms.map((t) => t.toLowerCase())]))
        .map((t) => t.replace(/["“”«»]/g, '').replace(/\[[^\]]+\]/g, '').trim())
        .filter((t) => Boolean(t) && !t.includes(','));
      const termStrings = validTerms.slice(0, 60).map((term) => `"${term}"${textTag}`);
      const cleanTruncs = useTrunc
        ? (block.truncationTerms || [])
            .slice(0, 4)
            .map((t) => t.replace(/["“”«»]/g, '').trim())
            .filter(Boolean)
        : [];
      const truncStrings = cleanTruncs.map((t) => (t.endsWith('*') ? `${t}${textTag}` : `${t}*${textTag}`));

      const combined = [...termStrings, ...truncStrings];
      pubmedBlock = combined.length > 1 ? `(${combined.join(' OR ')})` : combined[0] || `"${block.descriptor}"[TiAb]`;

      const embaseLex = [...validTerms.slice(0, 60).map((t) => `'${t}'`), ...cleanTruncs];
      embaseBlock =
        embaseLex.length > 1 ? `(${embaseLex.join(' OR ')}):ti,ab,kw,de` : `${embaseLex[0] || `'${block.descriptor.toLowerCase()}'`}:ti,ab,kw,de`;

      const cochraneLex = [...validTerms.slice(0, 60).map((t) => `"${t}"`), ...cleanTruncs];
      cochraneBlock =
        cochraneLex.length > 1 ? `(${cochraneLex.join(' OR ')}):ti,ab,kw` : `${cochraneLex[0] || `"${block.descriptor}"`}:ti,ab,kw`;
    }

    if (isNotBlock) {
      pubmedNotParts.push(pubmedBlock);
      embaseNotParts.push(embaseBlock);
      cochraneNotParts.push(cochraneBlock);
    } else {
      pubmedPositiveParts.push(pubmedBlock);
      if (block.picoType !== 'C') {
        corePositiveParts.push(pubmedBlock);
      }
      embasePositiveParts.push(embaseBlock);
      cochranePositiveParts.push(cochraneBlock);
    }
  });

  let fullPubMed = pubmedPositiveParts.join('\nAND\n');
  let corePubMed = corePositiveParts.length > 0 ? corePositiveParts.join('\nAND\n') : fullPubMed;
  let fullEmbase = embasePositiveParts.join('\nAND\n');
  let fullCochrane = cochranePositiveParts.join('\nAND\n');

  if (pubmedNotParts.length > 0) {
    const pubmedNotClause =
      pubmedNotParts.length > 1 ? `\nNOT\n(${pubmedNotParts.join(' OR ')})` : `\nNOT\n${pubmedNotParts[0]}`;
    fullPubMed += pubmedNotClause;
    corePubMed += pubmedNotClause;

    const embaseNotClause =
      embaseNotParts.length > 1 ? `\nNOT\n(${embaseNotParts.join(' OR ')})` : `\nNOT\n${embaseNotParts[0]}`;
    fullEmbase += embaseNotClause;

    const cochraneNotClause =
      cochraneNotParts.length > 1 ? `\nNOT\n(${cochraneNotParts.join(' OR ')})` : `\nNOT\n${cochraneNotParts[0]}`;
    fullCochrane += cochraneNotClause;
  }

  const pubmedFilterElements: string[] = [];
  const embaseFilterElements: string[] = [];
  let pubmedAnimalExclusion = '';
  let embaseAnimalExclusion = '';

  if (settings.filters && settings.filters.length > 0) {
    const pubmedStudyTypes: string[] = [];
    const embaseStudyTypes: string[] = [];

    settings.filters.forEach((f) => {
      if (f === 'rct') {
        pubmedStudyTypes.push(`"Randomized Controlled Trial"[pt]`);
        embaseStudyTypes.push(`'randomized controlled trial'/exp`);
      } else if (f === 'systematic') {
        pubmedStudyTypes.push(`("Systematic Review"[pt] OR "Meta-Analysis"[pt])`);
        embaseStudyTypes.push(`('systematic review'/exp OR 'meta analysis'/exp)`);
      } else if (f === 'humans') {
        pubmedFilterElements.push(`"Humans"[mh]`);
        embaseFilterElements.push(`'human'/exp`);
      } else if (f === 'humans_cochrane') {
        pubmedAnimalExclusion = `NOT ("Animals"[Mesh] NOT "Humans"[Mesh])`;
        embaseAnimalExclusion = `NOT ('animal'/exp NOT 'human'/exp)`;
      } else if (f === 'last5') {
        pubmedFilterElements.push(`"last 5 years"[dp]`);
      }
    });

    if (pubmedStudyTypes.length > 0) {
      pubmedFilterElements.push(
        pubmedStudyTypes.length > 1 ? `(${pubmedStudyTypes.join(' OR ')})` : pubmedStudyTypes[0]
      );
    }
    if (embaseStudyTypes.length > 0) {
      embaseFilterElements.push(
        embaseStudyTypes.length > 1 ? `(${embaseStudyTypes.join(' OR ')})` : embaseStudyTypes[0]
      );
    }
  }

  if (settings.dateRange?.enabled || (settings.dateRange?.startDate && settings.dateRange?.endDate)) {
    const start = (
      settings.dateRange.startDate ||
      (settings.dateRange.startYear ? `${settings.dateRange.startYear}/01/01` : '2006/10/29')
    ).replace(/-/g, '/');
    const end = (
      settings.dateRange.endDate ||
      (settings.dateRange.endYear ? `${settings.dateRange.endYear}/12/31` : '2026/10/28')
    ).replace(/-/g, '/');
    pubmedFilterElements.push(`("${start}"[dp] : "${end}"[dp])`);
    embaseFilterElements.push(`[${toEmbaseDate(start)} to ${toEmbaseDate(end)}]/pd`);
  }

  if (pubmedFilterElements.length > 0) {
    const filterBlock =
      pubmedFilterElements.length > 1 ? `(${pubmedFilterElements.join(' AND ')})` : pubmedFilterElements[0];
    if (fullPubMed.trim().length > 0) {
      fullPubMed += `\nAND\n${filterBlock}`;
      corePubMed += `\nAND\n${filterBlock}`;
    } else {
      fullPubMed = filterBlock;
      corePubMed = filterBlock;
    }
  }

  if (pubmedAnimalExclusion && fullPubMed.trim().length > 0) {
    fullPubMed += `\n${pubmedAnimalExclusion}`;
    corePubMed += `\n${pubmedAnimalExclusion}`;
  }

  if (embaseFilterElements.length > 0 && fullEmbase.trim().length > 0) {
    const embaseFilterBlock = embaseFilterElements.join(' AND ');
    fullEmbase += `\nAND\n${embaseFilterBlock}`;
  }

  if (embaseAnimalExclusion && fullEmbase.trim().length > 0) {
    fullEmbase += `\n${embaseAnimalExclusion}`;
  }

  return {
    pubmedQuery: fullPubMed,
    corePubMedQuery: corePubMed,
    embaseQuery: fullEmbase,
    cochraneQuery: fullCochrane
  };
}
