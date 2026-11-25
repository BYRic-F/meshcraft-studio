# MeSHcraft Studio

Application web d'aide à la conception d'équations booléennes biomédicales et à la conduite d'une revue systématique de la littérature selon les recommandations **PRISMA 2020**, **PRISMA-S**, **PRESS** et le **Cochrane Handbook**.

---

## Parcours en 4 étapes

1. **Question clinique et cadrage (PICO / PECO)**
   - Saisie guidée par axe (**P**opulation, **I**ntervention / **E**xposition, **C**omparateur, **O**utcome, critère d'exclusion **NOT**) ou structuration assistée par IA à partir d'une question rédigée en langage naturel (français ou anglais).
   - Paramètres de recherche : stratégie de sensibilité, bornes de dates, exclusion animale Cochrane non destructive (`NOT ("Animals"[Mesh] NOT "Humans"[Mesh])`), sous-rubriques MeSH et troncatures contrôlées (≥ 5 caractères).

2. **Validation terminologique MeSH, équations multi-bases et audit**
   - Résolution dynamique des descripteurs MeSH officiels via **HeTOP / CISMeF** (CHU de Rouen) et **NCBI Entrez E-Utilities (`db=mesh`)** : aucun dictionnaire médical codé en dur.
   - Génération simultanée d'équations équilibrées pour **PubMed / MEDLINE**, **Embase.com** et **Cochrane CENTRAL**.
   - Interrogation en direct de PubMed (`esearch.fcgi` en `POST` sans limite de longueur d'URL), échantillonnage stratifié (Tête / Milieu / Queue) pour l'audit qualitatif, contrôle des PMIDs repères (*gold standard*) et statut de conformité PRESS (`Conforme`, `À affiner`, `Révision requise`).

3. **Sélection des études (titre/résumé) et interopérabilité Rayyan / Zotero**
   - Chargement à la demande du corpus complet via `efetch` XML (exhaustif jusqu'à 2 500 notices ; aperçu plafonné à 1 000 au-delà avec lien direct PubMed), incluant les articles classiques et les chapitres NCBI Bookshelf (`<PubmedBookArticle>`), les DOI et les `<PublicationType>` officiels NLM.
   - Tri manuel (`Inclure`, `À vérifier`, `Exclure`) ou pré-dépouillement IA par lots maîtrisés (50 notices en attente par défaut, interruption via `AbortController`, respect du principe de précaution Cochrane en l'absence de résumé).
   - Export et ré-import bidirectionnels **Rayyan / Zotero** (`.ris` et `.csv`, lecture des balises `RAYYAN-INCLUSION` et `RAYYAN-EXCLUSION-REASONS`).

4. **Diagramme PRISMA 2020, risque de biais, matrice de synthèse et chapitre Méthodes**
   - Diagramme de flux PRISMA 2020 alimenté par les effectifs réels et les motifs d'exclusion triés par fréquence.
   - Pré-repérage indicatif du risque de biais par lots bornés (20 études, `AbortController`, classification du plan d'étude priorisant les `<PublicationType>` NLM, exclusion des revues narratives et recommandations hors grille ECR).
   - Matrice de synthèse par étude exportable en **CSV (Excel UTF-8)** et **Markdown**, et génération du chapitre **Matériel & Méthodes** prêt à être copié ou téléchargé (`.md`).

---

## Architecture et confidentialité (local-first)

- **Exécution 100 % côté navigateur** : l'interface et la logique d'orchestration s'exécutent localement dans le navigateur de l'utilisateur, sans base de données distante ni compte applicatif.
- **Persistance locale (`IndexedDB`) et portabilité (`.json`)** :
  - Auto-sauvegarde automatique de la session active dans `IndexedDB` (reprise transparente après actualisation de la page).
  - Tiroir **« Mes revues »** permettant de sauvegarder, reprendre sans ré-interroger les API, exporter et ré-importer une revue complète au format `.json` (PICO, paramètres de recherche, équations, décisions de tri et pré-évaluations de biais).
- **Isolation des clés API** :
  - Les clés API (**Google Gemini**, **OpenAI**, **Anthropic**, **NCBI PubMed**) et identifiants **HeTOP** sont saisis dans la modale *Paramètres & API* et conservés uniquement dans le `localStorage` du navigateur.
  - Les exports `.json` de revue filtrent et excluent systématiquement toute clé API ou mot de passe.
- **Relais léger HeTOP** :
  - En développement local, Vite relaie `/api/hetop/*` vers `https://www.hetop.eu/CISMeFhetopservice/REST/*`.
  - En production sur Cloudflare Pages, la Pages Function [`functions/api/hetop/[[path]].ts`](./functions/api/hetop/%5B%5Bpath%5D%5D.ts) assure uniquement ce relais HTTPS/CORS en transmettant l'en-tête `Authorization` fourni par l'utilisateur.
  - Les appels PubMed (`eutils.ncbi.nlm.nih.gov`), Gemini, OpenAI et Anthropic partent directement en HTTPS depuis le navigateur en production.

---

## Stack technique

- **Interface** : React 19, TypeScript (`strict`), Tailwind CSS v4, Lucide Icons, Vite 8
- **Moteur booléen et validation syntaxique** : compilateur Rust (`rust_engine/`) et miroir TypeScript (`src/services/rustEngineService.ts`) vérifiés par tests de parité champ par champ
- **Persistance** : API native `IndexedDB` (sans dépendance externe)
- **Qualité et tests** : Vitest (tests unitaires, résilience réseau et parité Rust/TS) et oxlint

---

## Installation et commandes locales

### Prérequis

- **Node.js** ≥ 20 et `npm`
- Une clé API IA au choix (Google Gemini, OpenAI ou Anthropic) ; clé **NCBI PubMed** et compte **HeTOP** optionnels, configurables directement depuis *Paramètres & API* dans l'interface.

### Commandes

```bash
# Installer les dépendances
npm install

# Lancer le serveur de développement local (Vite)
npm run dev

# Compiler le bundle de production (dist/)
npm run build

# Exécuter les tests unitaires
npx vitest run

# Exécuter le linter
npx oxlint src tests
```

*(Sous Windows PowerShell, utiliser `npm.cmd` et `npx.cmd` si nécessaire.)*

---

## Déploiement statique (Cloudflare Pages)

Le projet ne nécessite ni serveur Node.js en production ni compilation Rust côté hébergeur :

- **Build command** : `npm run build`
- **Build output directory** : `dist`
- **Functions directory** : `functions` (détecté automatiquement par Cloudflare Pages pour activer le relais `/api/hetop/*`)
- **Variables d'environnement côté build** : aucune variable `VITE_*` requise.

---

## Limites méthodologiques

- Les modèles de langage assistent la structuration PICO/PECO, l'audit des équations, le pré-tri titre/résumé et le pré-repérage des biais.
- **La décision finale d'inclusion/exclusion** (idéalement en double lecture humaine en aveugle via Rayyan) et **l'évaluation définitive du risque de biais** (RoB 2, ROBINS-I, AMSTAR 2) requièrent impérativement la lecture humaine des textes intégraux.
- Les résultats PubMed reflètent l'état de la base MEDLINE/PubMed à la date d'interrogation ; une revue systématique conforme aux recommandations PRISMA 2020 implique d'exécuter également les équations générées sur **Embase** et **Cochrane CENTRAL**.

Pour le détail des options de recherche et de leurs justifications méthodologiques, voir [`docs/guide-methodologie.md`](./docs/guide-methodologie.md).
