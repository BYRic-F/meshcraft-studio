import { describe, it, expect } from 'vitest';
import { runMultiAgentPipeline, PicoInputs } from '../../src/services/multiAgentWorkflow';

const CLINICAL_TEST_SCENARIOS: ReadonlyArray<{ readonly id: string; readonly pico: PicoInputs }> = [
  {
    id: 'these-lille-fasting',
    pico: {
      p: 'Adultes en excès pondéral ou obésité',
      i: 'Jeûne intermittent',
      c: 'Alimentation habituelle ou absence de restriction',
      o: 'Variation du poids corporel et IMC'
    }
  },
  {
    id: 't2dm-sglt2',
    pico: {
      p: 'Adultes atteints de diabète de type 2',
      i: 'Inhibiteurs de SGLT2',
      c: 'Placebo ou traitement standard',
      o: 'Hospitalisation pour insuffisance cardiaque'
    }
  },
  {
    id: 'stroke-thrombectomy',
    pico: {
      p: 'AVC ischémique aigu',
      i: 'Thrombectomie endovasculaire',
      c: 'Thrombolyse intraveineuse seule',
      o: 'Récupération fonctionnelle à 90 jours'
    }
  }
];

describe('3. Tests Fonctionnels ou Système (Functional & System Tests)', () => {
  describe('Scénario Clinique Majeur : Thèse de Médecine Lille 2026 (Dr Julie Zanier)', () => {
    it('doit générer une équation valide, trouver des articles réels et obtenir un score d\'audit >= 90', async () => {
      const thesisPreset = CLINICAL_TEST_SCENARIOS.find(p => p.id === 'these-lille-fasting');
      expect(thesisPreset).toBeDefined();

      const result = await runMultiAgentPipeline(
        thesisPreset!.pico,
        {
          strategy: 'balanced',
          activePico: { p: true, i: true, c: true, o: true },
          filters: ['humans']
        }
      );

      // Vérification syntaxe PubMed
      expect(result.pubmedQuery).toContain('"Overweight"[Mesh]');
      expect(result.pubmedQuery).toContain('"Intermittent Fasting"[Mesh]');
      expect(result.pubmedQuery).toContain('"Humans"[mh]');

      // Vérification syntaxe Embase & Cochrane
      expect(result.embaseQuery).toContain("'Overweight'/exp");
      expect(result.cochraneQuery).toContain('[mh "Overweight"]');

      // Vérification volume et score d'audit
      expect(result.liveResult.count).toBeGreaterThan(0);
      expect(result.critiqueReport.score).toBeGreaterThanOrEqual(90);
      expect(result.mappedBlocks.length).toBe(4);
    }, 60000);
  });

  describe('Scénario Diabétologie & Cardiologie : SGLT2 Inhibitors', () => {
    it('doit identifier Sodium-Glucose Transporter 2 Inhibitors et Heart Failure', async () => {
      const sglt2Preset = CLINICAL_TEST_SCENARIOS.find(p => p.id === 't2dm-sglt2');
      expect(sglt2Preset).toBeDefined();

      const result = await runMultiAgentPipeline(
        sglt2Preset!.pico,
        {
          strategy: 'balanced',
          activePico: { p: true, i: true, c: false, o: true },
          filters: ['humans']
        }
      );

      expect(result.pubmedQuery).toContain('Sodium-Glucose Transporter 2 Inhibitors');
      expect(result.pubmedQuery.includes('Heart Failure') || result.pubmedQuery.includes('Hospitalization')).toBe(true);
      expect(result.liveResult.count).toBeGreaterThan(0);
    }, 60000);
  });

  describe('Scénario AVC Ischémique Aigu : Thrombectomie Endovasculaire', () => {
    it('doit identifier Thrombectomy et Ischemic Stroke', async () => {
      const strokePreset = CLINICAL_TEST_SCENARIOS.find(p => p.id === 'stroke-thrombectomy');
      expect(strokePreset).toBeDefined();

      const result = await runMultiAgentPipeline(
        strokePreset!.pico,
        {
          strategy: 'balanced',
          activePico: { p: true, i: true, c: false, o: true },
          filters: ['humans']
        }
      );

      expect(result.pubmedQuery).toContain('Thrombectomy');
      expect(result.pubmedQuery).toContain('Stroke');
      expect(result.liveResult.count).toBeGreaterThan(0);
    }, 60000);
  });
});
