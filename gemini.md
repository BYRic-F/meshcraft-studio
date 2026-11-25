# 🏛️ CONSTITUTION DU PROJET — `gemini.md`
## MeSHcraft Studio · Plateforme d'Ingénierie Documentaire & de Revues Systématiques Médicales (PRISMA 2020 / Cochrane)

> **STATUT DU DOCUMENT :** Instructions Système Impératives (*System Prompt & Engineering Constitution*).  
> **PORTÉE :** Toute modification du code source (Rust/WASM, TypeScript, React, Services API, Tests) DOIT respecter intégralement et sans exception les règles définies dans ce document.

---

## 1. Rigueur Scientifique, Terminologique et Logique Booléenne *(Priorité Absolue)*

### 1.1. Règle « Zéro Hallucination MeSH » & « Zéro Dictionnaire en Dur »
1. **Séparation stricte Structuration Clinique $\neq$ Résolution Terminologique** :
   - Le LLM (Google Gemini ou modèle local) est utilisé pour l'**orchestration sémantique**, la **structuration PICO/PECO** (*Population, Intervention/Exposure, Comparator, Outcome, Exclusion*) et l'**assistance à l'évaluation critique**.
   - **Interdiction formelle au LLM d'inventer ou de traduire lui-même des descripteurs MeSH dans le PICO** : le PICO est extrait sous forme de concepts cliniques atomiques concis dans la langue d'origine.
   - **Validation Officielle Obligatoire** : Chaque concept médical DOIT être résolu et validé dynamiquement contre les référentiels officiels :
     1. **HeTOP / CISMeF (CHU de Rouen & Inserm)** pour la correspondance terminologique francophone $\rightarrow$ identifiant unique MeSH (`Dxxxxxx`).
     2. **NCBI Entrez E-Utilities (`db=mesh`)** pour la récupération du descripteur NLM anglais canonique, des *Entry Terms* officiels, des *Subheadings* autorisés et de la *Scope Note*.
   - **Zéro Dictionnaire en Dur (*No Hardcoded Dictionaries*)** : Il est strictement interdit d'encoder des listes de traductions médicales ou de descripteurs MeSH en dur dans le code pour faire passer un test ou un cas particulier. Tout doit reposer sur des règles grammaticales génériques et les API terminologiques officielles.
   - **Concepts non indexés** : Si un concept clinique (ex. molécule récente ou nom de dispositif) ne possède aucun identifiant `Dxxxxxx` validé par la NLM, il ne reçoit **jamais** la balise `[Mesh]` ; il est recherché exclusivement en texte libre (`[TiAb]` / `[tw]`).

### 1.2. Grammaire Mathématique des Équations Booléennes (PubMed, Embase.com, CENTRAL)
1. **Hiérarchie et Imbrication des Parenthèses** :
   - Au sein d'un même axe PICO/PECO, les descripteurs MeSH, synonymes (`[TiAb]` / `[tw]`) et troncatures (`*`) sont reliés exclusivement par l'opérateur disjonctif `OR` et encapsulés dans un bloc parenthésé unique : `(Terme_1 OR Terme_2 OR Terme_3)`.
   - Les axes positifs actifs (`P`, `I/E`, `C`, `O`) sont reliés entre eux par l'opérateur conjonctif `AND`.
   - L'axe d'exclusion (`NOT`) est assemblé en fin d'équation positive sous la forme `NOT (Exclusion_1 OR Exclusion_2)`, sans jamais supprimer accidentellement les articles comparatifs mixtes pertinents.
   - **Invariant syntaxique** : $\text{count}(\text{'('}) \equiv \text{count}(\text{')'})$ et $\text{count}(\text{'"'}) \equiv 0 \pmod 2$. Aucune balise doublée (`[TiAb][TiAb]`), aucun guillemet imbriqué (`""Terme""`), aucune forme inversée NLM avec virgule dans `[TiAb]` (ex. interdiction de `"fasting, intermittent"[TiAb]`).
2. **Règles de Troncature (`*`) — Normes BiUM / NLM** :
   - Racine lexicale minimale stricte de **$\ge 5$ caractères alphabétiques** (ex. `diabet*`, `parkinsonis*`). Les racines courtes génératrices de bruit documentaire (ex. `fast*`, `gene*`, `care*`) sont formellement interdites.
3. **Traduction Multi-Bases Fidèle (PRISMA-S)** :
   - **PubMed / MEDLINE** : `"Descriptor"[Mesh]`, `"Descriptor/subheading"[Mesh]`, `"term"[TiAb]`, `drug[tw]`, bornes temporelles `("YYYY/MM/DD"[dp] : "YYYY/MM/DD"[dp])`.
   - **Embase.com** : `'descriptor'/exp` (ou `/de`), `('term1' OR 'term2'):ti,ab,kw,de`, bornes temporelles `[DD-MM-YYYY to DD-MM-YYYY]/pd`.
   - **Cochrane CENTRAL** : `[mh "Descriptor"]` (ou `[mh ^"Descriptor"]`), `[mh "Descriptor"/CI]`, `("term1" OR "term2"):ti,ab,kw`.
   - **Filtre Humain non destructif** : Ne jamais imposer `AND "Humans"[mh]` par défaut sans avertissement, car cela exclut les articles récents *In-Process / Publisher* non encore indexés. Privilégier l'exclusion animale standard Cochrane : `NOT ("Animals"[Mesh] NOT "Humans"[Mesh])` ou le filtrage au dépouillement.

```
# Exemple de structure canonique PubMed validée
(
  ("Parkinson Disease, Secondary/chemically induced"[Mesh] OR "Parkinsonian Disorders/chemically induced"[Mesh] OR "secondary parkinsonism"[TiAb] OR parkinsonis*[TiAb])
  AND
  ("Antipsychotic Agents"[Mesh] OR "haloperidol"[tw] OR "risperidone"[tw])
)
AND ("2006/10/29"[dp] : "2026/10/28"[dp])
```

### 1.3. Conformité Méthodologique PRISMA 2020, PRISMA-S, PRESS & Cochrane Handbook
1. **Traçabilité Reproductible (PRISMA-S)** : Chaque exécution conserve l'équation exacte, la traduction interne PubMed (`queryTranslation`), la date/heure d'interrogation, les filtres actifs et les effectifs par base.
2. **Principe de Précaution au Dépouillement (Screening Titre/Résumé)** :
   - Conformément au *Cochrane Handbook*, l'absence de résumé ou une information insuffisante au stade titre/résumé ne vaut **jamais** exclusion clinique : l'article doit être classé en **`À vérifier sur texte intégral (Maybe / Incertain)`**.
   - L'IA agit comme **co-lecteur de priorisation et d'extraction préparatoire** ; elle trace son modèle exact (`evaluatedBy`) et son extrait de preuve (`evidenceSnippet`), mais ne remplace pas la décision humaine.
3. **Interopérabilité Rayyan (`rayyan.ai`) & Matrice de Lecture** :
   - Support natif de l'**Export vers Rayyan** (`.ris` / `.csv` avec pré-annotations IA optionnelles dans le champ `Notes`) pour la double lecture humaine en aveugle.
   - Support de l'**Import depuis Rayyan** (`RAYYAN-INCLUSION`, `RAYYAN-EXCLUSION-REASONS`) pour synchroniser le diagramme PRISMA 2020.
   - Génération d'une **Matrice de Lecture / Tableau de Synthèse des Études Incluses** (*Auteur, Année, Plan d'étude, Population/Exposition, Critère de jugement, Résultats clés, Risque de biais RoB 2 / ROBINS-I / JBI*).

---

## 2. Architecture Hybride (`Rust/WASM` $\leftrightarrow$ `React/TypeScript`)

### 2.1. Frontière d'Exécution Stricte
- **Moteur Algorithmique & Syntaxique (Couche Rust / Core Engine)** :
  - Le parsing booléen, la validation syntaxique des parenthèses/guillemets, la déduplication multi-bases (par `PMID`, `DOI`, puis titre normalisé), le calcul déterministe des scores PRISMA/Cochrane et le formatage des exports (`.ris`, `.csv`, `.nbib`) relèvent exclusivement de la couche moteur typée, pure et sans effet de bord UI.
- **Couche React / TypeScript** :
  - Strictement limitée à la **présentation déclarative**, à la **gestion d'état du workflow (Stepper)** et à l'**orchestration asynchrone** des appels réseau. Aucun composant `.tsx` ne doit contenir de regex de nettoyage booléen ou de logique métier de construction d'équation.

### 2.2. Sérialisation Optimisée (`Serde` / Pont WASM)
- Toutes les structures échangées entre Rust et TypeScript utilisent `#[derive(Serialize, Deserialize)]` avec `#[serde(rename_all = "camelCase")]`.
- **Interdiction des appels bavards (*No Chatty Calls*)** : Lors du traitement d'une cohorte de $N$ articles (dépouillement, dédoublonnage, calcul de métriques PRISMA), l'ensemble du lot est transmis en **un seul appel groupé (batch)** plutôt que via une boucle de $N$ appels unitaires traversant la frontière JS/WASM.

### 2.3. Typage Impitoyable (`strict: true`, Zéro `any`)
- Le compilateur TypeScript doit fonctionner en mode `strict: true`.
- **Le mot-clé `any` est formellement proscrit** dans tout nouveau code ou fichier modifié. Utiliser `unknown` avec des *type guards* explicites ou des schémas de validation typés.
- Chaque interface TypeScript doit être le miroir exact de la structure métier :

```typescript
// Miroir exact entre les types TypeScript et les structs Rust (Serde camelCase)
export type PicoAxisType = 'P' | 'I' | 'C' | 'O' | 'NOT';
export type ScreeningDecision = 'included' | 'maybe' | 'excluded' | 'pending';
export type RiskOfBiasLevel = 'low' | 'moderate' | 'high' | 'unassessed';
export type StudyDesignType = 'rct' | 'observational' | 'review' | 'pharmacovigilance' | 'case_series';

export interface MeshDescriptorItem {
  readonly descriptor: string;
  readonly meshId: string;
  readonly noExp: boolean;
  readonly isMajor: boolean;
  readonly qualifiers?: readonly string[];
}

export interface ScreenedArticleRecord {
  readonly pmid: string;
  readonly doi?: string;
  readonly title: string;
  readonly authors: string;
  readonly journal: string;
  readonly pubdate: string;
  readonly abstractText: string;
  readonly status: ScreeningDecision;
  readonly exclusionReason?: string;
  readonly evidenceSnippet?: string;
  readonly evaluatedBy?: string;
  readonly studyDesign?: StudyDesignType;
}
```

---

## 3. Interactions LLM (API Gemini / IA Locale) et Résilience Réseau

### 3.1. Déterminisme Médical
- Toutes les requêtes vers l'API Google Gemini (`generateContent`) ou Ollama/LM Studio doivent imposer une température quasi-déterministe :
  - `temperature: 0.1` (ou `0.0` pour l'extraction JSON et la classification binaire/ternaire).
  - `responseMimeType: "application/json"` systématiquement activé sur Gemini.

### 3.2. Sorties Structurées (*Structured Outputs*) & Parsing Défensif
- Chaque prompt LLM doit spécifier un contrat JSON strict et passer par le parseur défensif unique `extractJsonFromLlmResponse<T>(rawText: string): T | null`.
- Toute réponse JSON est validée champ par champ avant d'être injectée dans l'état de l'application. Une réponse tronquée ou malformée ne provoque jamais d'`Uncaught SyntaxError`.

### 3.3. Blindage Réseau : *Exponential Backoff with Full Jitter* & *Model Cascade*
Toutes les requêtes vers **Google Gemini**, **NCBI Entrez E-Utilities** et **HeTOP** doivent appliquer la politique de résilience suivante :

```typescript
/**
 * Calcul du délai de réessai avec Exponential Backoff + Full Jitter
 * Gère les erreurs HTTP 429 (Quota/Rate Limit), 500, 502, 503 (High Demand / Overloaded), 504 et TimeoutError.
 */
export function computeBackoffDelayMs(attempt: number, baseDelayMs = 1500, maxDelayMs = 30000): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * 1000);
  return exponential + jitter;
}
```

1. **Gestion de l'erreur `503 Service Unavailable` (*Model High Demand / Overloaded*)** :
   - Ne **jamais** faire planter l'application sur un `503`.
   - Appliquer 2 réessais rapides avec *Exponential Backoff + Jitter* (`~1,8 s`, puis `~3,5 s`).
   - **Cascade automatique de modèle (*Model Cascade*)** : Si le modèle principal (ex. `gemini-2.5-flash` ou `gemini-3.8-flash`) reste en `503` ou `429`, basculer automatiquement et de façon transparente la requête sur le modèle de secours (`gemini-3.5-flash-lite` ou `gemini-2.0-flash`).
2. **Gestion de l'erreur `429 Too Many Requests` (*Rate Limit*)** :
   - Lire le délai officiel `retry in Xs` de Google s'il est présent, sinon appliquer `computeBackoffDelayMs`, puis basculer sur le modèle suivant de la cascade.
3. **Isolation des Lots (*Batch Fault Isolation*)** :
   - Le dépouillement et l'évaluation du risque de biais (RoB 2) s'exécutent par lots isolés (`try / catch` par lot). Si un lot échoue après épuisement de la cascade, les lots précédents sont intégralement préservés, un repli déterministe (ou statut `À vérifier`) est appliqué au lot en échec, et un indicateur visuel non bloquant informe l'utilisateur.
4. **Cadencement NCBI Entrez (`pacedNcbiFetch`)** :
   - File d'attente séquentielle respectant la limite stricte NLM ($3\text{ req/s}$ sans clé API, $10\text{ req/s}$ avec clé API) avec retry automatique sur `429` et `5xx`.

---

## 4. Standards UI/UX (Architecture Épurée & Charge Cognitive Minimale)

### 4.1. Flux Progressif par Étapes (*Wizard / Stepper*) — Fin du Fouillis Visuel
- **Principe de Révélation Progressive (*Progressive Disclosure*)** : Un médecin, interne ou thésard ne doit voir à l'écran **que les informations et actions nécessaires à l'étape en cours**.
- Remplacement de la page unique surchargée (multi-onglets simultanés, pavés de texte redondants, badges multicolores concurrents) par un **Parcours Guidé en 4 Étapes Claires** :
  1. **Étape 1 · Question Clinique & Cadrage PICO/PECO** *(Saisie assistée ou structurée, choix PICO/PECO, bornes temporelles)*.
  2. **Étape 2 · Validation Terminologique MeSH & Équations Multi-Bases** *(Descripteurs validés NLM/HeTOP, équations PubMed / Embase / CENTRAL prêtes à l'emploi, audit de pertinence et contrôle des PMID repères)*.
  3. **Étape 3 · Sélection des Études (Screening Assisté & Pont Rayyan)** *(Tri Titre/Résumé en Inclus / À vérifier / Exclus, filtres rapides, Export/Import Rayyan `.ris`/`.csv`)*.
  4. **Étape 4 · Analyse Critique (RoB 2), Matrice de Lecture & Rapport PRISMA 2020** *(Diagramme de flux officiel, grille de biais, tableau de synthèse des études incluses et export Thèse Word/Markdown)*.

### 4.2. Sobriété Graphique Médicale (*Clinical Grade Design*)
- **Palette chromatique restreinte et sémantique** :
  - Fond neutre reposant (`slate-50` / `white`), typographie haute lisibilité (`Inter` pour l'UI, `JetBrains Mono` uniquement pour les équations booléennes et identifiants `PMID`/`Dxxxxxx`).
  - **Une seule couleur d'action primaire** (`indigo-600` / `blue-600`).
  - **Trois couleurs sémantiques réservées aux statuts cliniques** :
    - 🟢 Vert (`emerald`) : *Inclus / Faible risque de biais / Validé NLM*
    - 🟡 Ambre (`amber`) : *À vérifier (Maybe) / Préoccupations modérées / Attente quota API*
    - 🔴 Rouge (`rose`) : *Exclu / Haut risque de biais / Erreur critique*
- **Zéro paragraphe décoratif** : Remplacer les longs textes explicatifs statiques par des infobulles contextuelles (`?`) ou des tiroirs repliables à la demande.

### 4.3. Internationalisation par Design (`i18n`)
- **Aucune chaîne de caractères d'interface en dur dans les composants `.tsx`** : tous les libellés, titres d'étapes, boutons, messages d'erreur et infobulles méthodologiques doivent provenir d'un dictionnaire centralisé typé (`src/i18n/fr.ts` / `src/i18n/en.ts` via un hook `useTranslation()`).

### 4.4. Gestion Élégante des Erreurs Asynchrones
- **Zéro Stacktrace Brute** : Aucune erreur technique (`TypeError: Failed to fetch`, `AbortError: signal timed out`, `HTTP 503`, `SyntaxError: Unexpected token`) ne doit jamais s'afficher telle quelle à l'écran.
- Toute erreur est interceptée et traduite par un mappeur dédié (`mapErrorToUserMessage`) en un message clinique clair accompagné d'une action corrective immédiate (ex. *« Le serveur Google Gemini est momentanément très sollicité. Bascule automatique sur le modèle léger en cours (tentative 2/3)… »*).

---

## 5. Checklist de Validation Avant Tout Commit / Livraison

Avant de considérer une tâche comme terminée, l'agent DOIT vérifier :
- [ ] `npm.cmd run build` compile avec **0 erreur TypeScript/Vite**.
- [ ] `npx.cmd vitest run` passe **100 % des tests unitaires et d'intégration**.
- [ ] Aucun dictionnaire médical en dur n'a été introduit dans `src/`.
- [ ] Aucun type `any` ni chaîne UI en dur n'a été ajouté dans les composants refondus.
- [ ] Les équations générées respectent l'équilibre strict des parenthèses et guillemets sur PubMed, Embase.com et CENTRAL.

