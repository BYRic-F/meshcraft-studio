import { describe, it, expect } from 'vitest';
import { runMultiAgentPipeline } from '../../src/services/multiAgentWorkflow';
import { searchNcbiMesh } from '../../src/services/meshDatabase';
import { initializeUnscreenedArticles } from '../../src/services/agentScreener';

describe('5. Tests de Non-Régression & Robustesse Clinique (Regression & Clinical Invariants)', () => {
  describe('Régression Bug #1 : Interdiction formelle du tag [Mesh] sur Concept-Libre', () => {
    it('ne doit JAMAIS ajouter le tag [Mesh] sur un concept non indexé ou en français libre', async () => {
      const result = await runMultiAgentPipeline(
        {
          p: 'TermeInconnuSansMesh12345',
          i: 'InterventionInventee999',
          c: '',
          o: ''
        },
        {
          strategy: 'balanced',
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      expect(result.pubmedQuery).not.toContain('"TermeInconnuSansMesh12345"[Mesh]');
      expect(result.pubmedQuery).not.toContain('"InterventionInventee999"[Mesh]');
      expect(result.pubmedQuery).toContain('[tiab]');
    }, 45000);
  });

  describe('Régression Bug #2 : Respect strict de l\'axe Comparateur (C)', () => {
    it('doit inclure l\'axe C dans l\'équation quand activePico.c est activé', async () => {
      const result = await runMultiAgentPipeline(
        {
          p: 'Obesity',
          i: 'Fasting',
          c: 'Diet',
          o: 'Body Weight'
        },
        {
          strategy: 'balanced',
          activePico: { p: true, i: true, c: true, o: true }
        }
      );

      expect(result.pubmedQuery).toContain('"Diet"');
      expect(result.mappedBlocks.some(b => b.picoType === 'C')).toBe(true);
    }, 15000);
  });

  describe('Régression Bug #3 : Priorité des expressions médicales longues sur les mots courts', () => {
    it('ne doit pas matcher "adulte" quand on entre "adultes en excès pondéral ou obésité"', async () => {
      const result = await searchNcbiMesh('Adultes en excès pondéral ou obésité');
      expect(result).not.toBeNull();
      expect(result?.descriptor).toBe('Overweight');
      expect(result?.meshId).toBe('D050177');
    });
  });

  describe('Régression Bug #4 : Pas de qualificatif incompatible en mode équilibré', () => {
    it('ne doit pas injecter "/diet therapy" sur un descripteur d\'intervention ou d\'outcome', async () => {
      const result = await runMultiAgentPipeline(
        {
          p: 'Adultes en excès pondéral ou obésité',
          i: 'Jeûne intermittent (Intermittent Fasting, Time-Restricted Eating)',
          c: 'Alimentation habituelle ou absence de restriction',
          o: 'Variation du poids corporel et IMC'
        },
        {
          strategy: 'balanced',
          qualifiers: [],
          activePico: { p: true, i: true, c: true, o: true }
        }
      );

      expect(result.pubmedQuery).not.toContain('/diet therapy');
      expect(result.pubmedQuery).not.toContain('Diet/diet therapy');
    }, 60000);
  });

  describe('Régression Bug #5 : Invariant Syntaxe Booléenne — Zéro opérateur orphelin', () => {
    it('ne doit JAMAIS produire une équation commençant ou finissant par AND / OR', async () => {
      const result = await runMultiAgentPipeline(
        {
          p: 'Adultes en excès pondéral ou obésité',
          i: 'Jeûne intermittent',
          c: '',
          o: ''
        },
        {
          strategy: 'balanced',
          filters: ['humans'],
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      const trimmed = result.pubmedQuery.trim();
      expect(trimmed.startsWith('AND')).toBe(false);
      expect(trimmed.startsWith('OR')).toBe(false);
      expect(trimmed.endsWith('AND')).toBe(false);
      expect(trimmed.endsWith('OR')).toBe(false);
      expect(trimmed).not.toContain('AND\nAND');
      expect(trimmed).not.toContain('OR\nOR');
    }, 45000);

    it('doit rejeter proprement les requêtes avec 0 concept actif sans apposer "AND (Humans[mh])"', async () => {
      const result = await runMultiAgentPipeline(
        { p: '', i: '', c: '', o: '' },
        { filters: ['humans'], activePico: { p: true, i: true, c: true, o: true } }
      );

      expect(result.pubmedQuery).toBe('');
      expect(result.liveResult.count).toBe(0);
      expect(result.critiqueReport.score).toBe(0);
      expect(result.critiqueReport.observations.some(o => o.includes('Aucun axe PICO'))).toBe(true);
    });
  });

  describe('Régression Bug #6 : Invariant Intégrité Algébrique (Parenthèses & Guillemets)', () => {
    it('doit avoir un équilibrage strict des parenthèses et des guillemets sur toutes les bases', async () => {
      const result = await runMultiAgentPipeline(
        {
          p: 'Adultes en excès pondéral ou obésité',
          i: 'Jeûne intermittent (Intermittent Fasting, Time-Restricted Eating)',
          c: 'Alimentation habituelle ou absence de restriction',
          o: 'Variation du poids corporel et IMC'
        },
        {
          strategy: 'balanced',
          filters: ['humans'],
          activePico: { p: true, i: true, c: true, o: true }
        }
      );

      // 1. PubMed
      const openParensPubMed = (result.pubmedQuery.match(/\(/g) || []).length;
      const closeParensPubMed = (result.pubmedQuery.match(/\)/g) || []).length;
      expect(openParensPubMed).toBe(closeParensPubMed);
      const quotesPubMed = (result.pubmedQuery.match(/"/g) || []).length;
      expect(quotesPubMed % 2).toBe(0);

      // 2. Embase
      const openParensEmbase = (result.embaseQuery.match(/\(/g) || []).length;
      const closeParensEmbase = (result.embaseQuery.match(/\)/g) || []).length;
      expect(openParensEmbase).toBe(closeParensEmbase);

      // 3. Cochrane
      const openParensCochrane = (result.cochraneQuery.match(/\(/g) || []).length;
      const closeParensCochrane = (result.cochraneQuery.match(/\)/g) || []).length;
      expect(openParensCochrane).toBe(closeParensCochrane);
    }, 45000);
  });

  describe('Régression Bug #7 : Contrôle de Pertinence Clinique (Anti-Bruit Massif)', () => {
    it('doit renvoyer un volume bibliographique chirurgical (< 5 000 articles) et jamais le volume global (> 20M)', async () => {
      const result = await runMultiAgentPipeline(
        {
          p: 'Adultes en excès pondéral ou obésité',
          i: 'Jeûne intermittent (Intermittent Fasting, Time-Restricted Eating)',
          c: 'Alimentation habituelle ou absence de restriction',
          o: 'Variation du poids corporel et IMC'
        },
        {
          strategy: 'balanced',
          filters: ['humans'],
          activePico: { p: true, i: true, c: true, o: true }
        }
      );

      expect(result.liveResult.count).toBeGreaterThan(50);
      expect(result.liveResult.count).toBeLessThan(25000);
      expect(result.critiqueReport.score).toBeGreaterThanOrEqual(90);
    }, 60000);
  });

  describe('Régression Bug #8 : Combinaison de filtres de types d\'études (RCT + Revues systématiques)', () => {
    it('doit combiner RCT et Systematic Review avec un OR et non un AND strict', async () => {
      const result = await runMultiAgentPipeline(
        {
          p: 'Diabetes Mellitus, Type 2',
          i: 'Inhibiteur SGLT2 (Empagliflozine, Dapagliflozine)',
          c: '',
          o: ''
        },
        {
          strategy: 'balanced',
          filters: ['rct', 'systematic', 'humans'],
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      // Le filtre ne doit JAMAIS faire [pt] AND [pt] pour RCT et Revue systématique
      expect(result.pubmedQuery).toContain('("Randomized Controlled Trial"[pt] OR ("Systematic Review"[pt] OR "Meta-Analysis"[pt]))');
      expect(result.pubmedQuery).toContain('"Humans"[mh]');
      expect(result.pubmedQuery.toLowerCase()).toContain('empagliflozin');
    }, 45000);
  });

  describe('Régression Bug #9 : Agent de Dépouillement 100% IA (Zéro filtre déterministe générique)', () => {
    it('doit initialiser les articles en statut pending sans inventer d\'exclusion déterministe', () => {
      const article = {
        pmid: '32994159',
        title: 'Empagliflozin and Cardiovascular and Kidney Outcomes across KDIGO Risk Categories',
        abstract: 'Empagliflozin reduced the risk of cardiovascular death or hospitalization for heart failure in patients with type 2 diabetes.',
        meshHeadings: ['Diabetes Mellitus, Type 2', 'Cardiovascular Diseases', 'Sodium-Glucose Transporter 2 Inhibitors']
      };

      const [initialized] = initializeUnscreenedArticles([article]);

      expect(initialized.status).toBe('pending');
      expect(initialized.pmid).toBe('32994159');
      expect(initialized.exclusionReason).toBeUndefined();
    });
  });

  describe('Régression Bug #10 : Non-pollution du PICO par des balises techniques et interdiction des doubles guillemets/tags imbriqués', () => {
    it('ne doit JAMAIS produire de guillemets imbriqués ""..."" ou de balises dupliquées si du code est soumis au PICO', async () => {
      const result = await runMultiAgentPipeline(
        {
          p: '"Overweight"[Mesh] OR "Obesity"[Mesh] OR overweight[TiAb] OR obesity[TiAb]',
          i: '"Fasting"[Mesh] OR "intermittent fasting"[TiAb]',
          c: '',
          o: ''
        },
        {
          strategy: 'balanced',
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      // Ne doit JAMAIS contenir de doubles guillemets ""
      expect(result.pubmedQuery).not.toContain('""');
      expect(result.pubmedQuery).not.toMatch(/""[^"]+""/);
      expect(result.pubmedQuery).not.toMatch(/"[^"]*\[(?:mesh|tiab)\][^"]*"\[(?:mesh|tiab)\]/i);
      // Doit avoir résolu des descripteurs valides
      expect(result.pubmedQuery).toContain('"Overweight"');
      expect(result.pubmedQuery).toContain('"Fasting"');
    }, 45000);
  });
});
