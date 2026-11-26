import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseRisContent } from '../../src/services/risParserService';
import { compressAbstractForLlm } from '../../src/services/localAiService';

const FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'ris');

function readFixture(fileName: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, fileName), 'utf8');
}

describe('Parseur RIS unifié multi-bases sur les 3 fixtures réelles', () => {
  it('Cochrane Reviews (citation-export.ris) : préambule hors-RIS, entités HTML, Unicode U+2028/U+2010 et Plain language summary', () => {
    const raw = readFixture('citation-export.ris');
    const parsed = parseRisContent(raw, { fileName: 'citation-export.ris' });

    expect(parsed.detectedSource).toBe('cochrane_reviews');
    expect(parsed.rawRecordCount).toBe(6);
    expect(parsed.registryRecordCount).toBe(0);
    expect(parsed.records).toHaveLength(6);

    const cochraneIds = parsed.records.map((r) => r.identifiers.cochraneId);
    expect(cochraneIds).toEqual([
      'CD004057',
      'CD005958',
      'CD005427',
      'CD001823',
      'CD006094',
      'CD007495'
    ]);

    for (const rec of parsed.records) {
      expect(rec.sources).toEqual(['cochrane_reviews']);
      expect(rec.recordKind).toBe('review');
      expect(rec.pmid).toBe('');
      expect(rec.id).toBe(`doi:${rec.identifiers.doi}`);
      expect(rec.source).toBe('Cochrane Database of Systematic Reviews');
      expect(rec.abstract).not.toMatch(/^Abstract\s*-/i);
      expect(rec.abstract).not.toContain('\u2028');
      expect(rec.abstract).not.toContain('\u2010');
      expect(rec.title).not.toContain('\u2010');
      expect(rec.abstract).not.toContain('&amp;');
      expect(rec.meshHeadings.every((kw) => !kw.includes('&amp;'))).toBe(true);
    }

    // Vérifie le décodage réel d'entités HTML sur KW de CD005958
    const cd5958 = parsed.records[1];
    expect(cd5958.meshHeadings.some((kw) => kw.includes('prevention & control'))).toBe(true);

    // Conserve le Plain language summary complet dans abstract pour l'UI,
    // mais tronque proprement avant "Plain language summary" dans compressAbstractForLlm
    const cd4057 = parsed.records[0];
    expect(cd4057.abstract).toContain('Plain language summary');
    expect(cd4057.abstract).toContain("Authors' conclusions");
    const llmPayload = compressAbstractForLlm(cd4057.abstract, 3000);
    expect(llmPayload).toContain("Authors' conclusions");
    expect(llmPayload).not.toContain('Plain language summary');
  });

  it('Cochrane CENTRAL (citation-export (1).ris) : extraction C3, distinction trial_registry via M3, JA URL et Unicode U+0131', () => {
    const raw = readFixture('citation-export (1).ris');
    const parsed = parseRisContent(raw, { fileName: 'citation-export (1).ris' });

    expect(parsed.detectedSource).toBe('cochrane_central');
    expect(parsed.rawRecordCount).toBe(7);
    expect(parsed.registryRecordCount).toBe(3);
    expect(parsed.records).toHaveLength(7);

    const registries = parsed.records.filter((r) => r.recordKind === 'trial_registry');
    const articles = parsed.records.filter((r) => r.recordKind === 'article');
    expect(registries).toHaveLength(3);
    expect(articles).toHaveLength(4);

    // Vérifie les 3 notices Trial registry record (AU ne pollue pas authors, JA URL basculée en url/nom lisible)
    expect(registries.map((r) => r.identifiers.cochraneId)).toEqual([
      'CN-02583478',
      'CN-02583275',
      'CN-01874495'
    ]);
    expect(registries[0].authors).toBe('');
    expect(registries[0].identifiers.registryIds).toContain('ChiCTR2300070317');
    expect(registries[0].source).toBe('WHO ICTRP');
    expect(registries[1].authors).toBe('');
    expect(registries[1].identifiers.registryIds).toContain('ChiCTR2300070183');
    expect(registries[2].authors).toBe('');
    expect(registries[2].identifiers.registryIds).toContain('KCT0001939');

    // Notice #3 CN-00896162 : PUBMED 21508915 sans DOI, titre avec 'ı' (U+0131) conservé lisible
    const cn896162 = parsed.records.find((r) => r.identifiers.cochraneId === 'CN-00896162');
    expect(cn896162).toBeDefined();
    expect(cn896162!.identifiers.pmid).toBe('21508915');
    expect(cn896162!.pmid).toBe('21508915');
    expect(cn896162!.id).toBe('pmid:21508915');
    expect(cn896162!.identifiers.doi).toBeUndefined();
    expect(cn896162!.meshHeadings.some((kw) => kw.includes('Quality of Life'))).toBe(true);

    // Notice #4 CN-01644482 : extraction PUBMED + EMBASE depuis C3 + NCT01966250 depuis AB
    // + déduplication insensible à la casse des KW ("Quality of Life" vs "Quality of life")
    const cn1644482 = parsed.records.find((r) => r.identifiers.cochraneId === 'CN-01644482');
    expect(cn1644482).toBeDefined();
    expect(cn1644482!.identifiers.pmid).toBe('29773696');
    expect(cn1644482!.identifiers.embaseId).toBe('623793174');
    expect(cn1644482!.identifiers.doi).toBe('10.1136/bmjopen-2017-018464');
    expect(cn1644482!.identifiers.registryIds).toContain('NCT01966250');
    const qolCount = cn1644482!.meshHeadings.filter(
      (kw) => kw.toLowerCase() === 'quality of life'
    ).length;
    expect(qolCount).toBe(1);
  });

  it('Embase Elsevier (records.ris) : mapping T1/N2/A1/Y1/C5/U2, attribution stricte embase malgré DB - Medline, exclusion M1/LK', () => {
    const raw = readFixture('records.ris');
    const parsed = parseRisContent(raw, { fileName: 'records.ris' });

    expect(parsed.detectedSource).toBe('embase');
    expect(parsed.rawRecordCount).toBe(6);
    expect(parsed.registryRecordCount).toBe(0);
    expect(parsed.records).toHaveLength(6);

    for (const rec of parsed.records) {
      // Malgré la présence de "DB - Medline", l'export vient d'Embase
      expect(rec.sources).toEqual(['embase']);
      expect(rec.identifiers.pmid).toMatch(/^\d{8}$/);
      expect(rec.pmid).toBe(rec.identifiers.pmid);
      expect(rec.identifiers.embasePui).toMatch(/^L\d+$/);
      expect(rec.identifiers.embaseId).toBe(rec.identifiers.embasePui!.slice(1));
      expect(rec.language).toBe('English');
      expect(rec.title.length).toBeGreaterThan(20);
      expect(rec.abstract.length).toBeGreaterThan(100);
      expect(rec.authors.length).toBeGreaterThan(5);

      // Aucune fuite des champs parasites M1 (affiliations/emails) ni LK (OpenURL lillocat)
      const serialized = JSON.stringify(rec);
      expect(serialized).not.toContain('lillocat.univ-lille.fr');
      expect(serialized).not.toContain('erasmsumc.nl');
      expect(serialized).not.toContain('Crobi151@jh.edu');
    }

    // Vérifie Y1=2027 préservé sur les 2 premières notices et M3 Review vs Article
    expect(parsed.records[0].pubDate).toBe('2027');
    expect(parsed.records[0].recordKind).toBe('article');
    expect(parsed.records[0].identifiers.pmid).toBe('42966026');
    expect(parsed.records[0].identifiers.embasePui).toBe('L2051170234');
    expect(parsed.records[0].identifiers.embaseId).toBe('2051170234');

    expect(parsed.records[2].recordKind).toBe('review');
    expect(parsed.records[3].recordKind).toBe('review');
    expect(parsed.records[4].identifiers.registryIds).toContain('NCT05234281');
  });
});
