import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  AxisCompilationInputRust,
  CompiledAxisOutputRust,
  compileAxisBlockRust
} from '../../src/services/rustEngineService';

const RUST_CLI_BIN = path.join(
  process.cwd(),
  'rust_engine',
  'target',
  'debug',
  process.platform === 'win32' ? 'compile_axis_cli.exe' : 'compile_axis_cli'
);

function invokeRustCliBatch(inputs: readonly AxisCompilationInputRust[]): CompiledAxisOutputRust[] {
  const stdout = execFileSync(RUST_CLI_BIN, [], {
    input: JSON.stringify(inputs),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  return JSON.parse(stdout) as CompiledAxisOutputRust[];
}

describe('Parité stricte TS (compileAxisBlockRust) <-> Rust (compile_axis_block_rust)', () => {
  beforeAll(() => {
    if (!fs.existsSync(RUST_CLI_BIN)) {
      execFileSync(
        'cargo',
        ['build', '--offline', '--manifest-path', 'rust_engine/Cargo.toml', '--bin', 'compile_axis_cli'],
        { stdio: 'inherit' }
      );
    }
  });

  it('doit produire des sorties strictement identiques champ par champ sur les cas critiques PICO/PECO', () => {
    const payloads: AxisCompilationInputRust[] = [
      // 1. Axe mixte classe pharmacologique D27 + molécules DCI
      {
        axisRole: 'drug_inn_list',
        impliedSubheadings: [],
        descriptors: [
          {
            descriptor: 'Sodium-Glucose Transporter 2 Inhibitors',
            meshId: 'D000077203',
            allowedSubheadings: ['pharmacology', 'therapeutic use'],
            selectedSubheadings: [],
            treeNumbers: ['D27.505.519.936'],
            isPharmacologicalSubstance: false,
            noExp: false,
            isMajor: false
          },
          {
            descriptor: 'Canagliflozin',
            meshId: 'D000068896',
            allowedSubheadings: ['pharmacology', 'adverse effects'],
            selectedSubheadings: [],
            treeNumbers: ['D02.078'],
            isPharmacologicalSubstance: true,
            noExp: false,
            isMajor: false
          }
        ],
        entryTerms: ['sodium-glucose transporter 2 inhibitors', 'empagliflozin', 'dapagliflozin'],
        rawClinicalTokens: ['inhibiteurs sglt2'],
        customTruncations: []
      },
      // 2. Liste de DCI pure sans classe thérapeutique
      {
        axisRole: 'drug_inn_list',
        impliedSubheadings: [],
        descriptors: [
          {
            descriptor: 'Haloperidol',
            meshId: 'D006220',
            allowedSubheadings: ['pharmacology', 'adverse effects'],
            selectedSubheadings: [],
            treeNumbers: ['D03.383.621'],
            isPharmacologicalSubstance: true,
            noExp: false,
            isMajor: false
          },
          {
            descriptor: 'Risperidone',
            meshId: 'D018967',
            allowedSubheadings: ['pharmacology', 'adverse effects'],
            selectedSubheadings: [],
            treeNumbers: ['D03.383.621'],
            isPharmacologicalSubstance: true,
            noExp: false,
            isMajor: false
          }
        ],
        entryTerms: ['Haloperidol Decanoate', 'Metoclopramide', '4-(4-chlorophenyl)-1-butanone'],
        rawClinicalTokens: ['halopéridol', 'rispéridone'],
        customTruncations: []
      },
      // 3. Cas limite : descripteur non-substance (isPharmacologicalSubstance: false) dans une liste de molécules
      {
        axisRole: 'drug_inn_list',
        impliedSubheadings: [],
        descriptors: [
          {
            descriptor: 'Chemotherapy, Adjuvant',
            meshId: 'D002624',
            allowedSubheadings: ['methods'],
            selectedSubheadings: [],
            treeNumbers: ['E02.319.162'],
            isPharmacologicalSubstance: false,
            noExp: false,
            isMajor: false
          },
          {
            descriptor: 'Cisplatin',
            meshId: 'D002945',
            allowedSubheadings: ['pharmacology'],
            selectedSubheadings: [],
            treeNumbers: ['D01.210.375'],
            isPharmacologicalSubstance: true,
            noExp: false,
            isMajor: false
          }
        ],
        entryTerms: ['adjuvant chemotherapy', 'cisplatin'],
        rawClinicalTokens: [],
        customTruncations: []
      },
      // 4. Syndrome secondaire induit chimiquement + dominance dérivationnelle + subsomption préfixielle
      {
        axisRole: 'pathology_outcome',
        impliedSubheadings: ['chemically induced'],
        descriptors: [
          {
            descriptor: 'Parkinson Disease, Secondary',
            meshId: 'D010302',
            allowedSubheadings: ['chemically induced', 'diagnosis', 'epidemiology'],
            selectedSubheadings: [],
            treeNumbers: ['C10.228.140.079.862.500'],
            isPharmacologicalSubstance: false,
            noExp: false,
            isMajor: false
          },
          {
            descriptor: 'Parkinsonian Disorders',
            meshId: 'D020734',
            allowedSubheadings: ['chemically induced', 'drug therapy'],
            selectedSubheadings: [],
            treeNumbers: ['C10.228.140.079.862'],
            isPharmacologicalSubstance: false,
            noExp: false,
            isMajor: false
          }
        ],
        entryTerms: [
          'Secondary Parkinsonism',
          'Parkinsonism, Secondary',
          'Drug-Induced Parkinsonism',
          'Parkinsonian Syndrome',
          'Parkinsonian Syndromes'
        ],
        rawClinicalTokens: ['parkinsonisme médicamenteux'],
        customTruncations: []
      },
      // 5. Sous-rubrique canonique NLM (prevention and control) vs CENTRAL (/PC)
      {
        axisRole: 'population',
        impliedSubheadings: [],
        descriptors: [
          {
            descriptor: 'Hypertension',
            meshId: 'D006973',
            allowedSubheadings: ['therapy', 'prevention and control'],
            selectedSubheadings: ['prevention & control'],
            treeNumbers: ['C14.907.489'],
            isPharmacologicalSubstance: false,
            noExp: false,
            isMajor: false
          }
        ],
        entryTerms: ['high blood pressure'],
        rawClinicalTokens: [],
        customTruncations: []
      },
      // 6. Déduplication par préfixe des troncatures
      {
        axisRole: 'pathology_outcome',
        impliedSubheadings: [],
        descriptors: [
          {
            descriptor: 'Mortality',
            meshId: 'D009026',
            allowedSubheadings: [],
            selectedSubheadings: [],
            treeNumbers: ['N06.850.505.400'],
            isPharmacologicalSubstance: false,
            noExp: false,
            isMajor: false
          }
        ],
        entryTerms: ['Mortality', 'Mortalities', 'mortality rate'],
        rawClinicalTokens: [],
        customTruncations: ['mortal*', 'mortality*', 'mortalities*']
      },
      // 7. Déduplication Embase 'descriptor'/exp lorsque plusieurs sous-descripteurs sont actifs
      {
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
      }
    ];

    const tsOutputs = payloads.map((p) => compileAxisBlockRust(p));
    const rustOutputs = invokeRustCliBatch(payloads);

    expect(rustOutputs).toHaveLength(tsOutputs.length);
    for (let i = 0; i < payloads.length; i += 1) {
      expect(tsOutputs[i]).toEqual(rustOutputs[i]);
    }
  });
});
