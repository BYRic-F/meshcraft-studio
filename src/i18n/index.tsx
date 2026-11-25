import React, { createContext, useContext, useState } from 'react';

export type LocaleCode = 'fr' | 'en';

export interface TranslationDictionary {
  readonly appTitle: string;
  readonly appSubtitle: string;
  readonly header: {
    readonly historyBtn: string;
    readonly settingsBtn: string;
    readonly step1Short: string;
    readonly step2Short: string;
    readonly step3Short: string;
    readonly step4Short: string;
  };
  readonly step1: {
    readonly badge: string;
    readonly title: string;
    readonly subtitle: string;
    readonly modeStructured: string;
    readonly modeFreeText: string;
    readonly frameworkApproachLabel: string;
    readonly frameworkPico: string;
    readonly frameworkPeco: string;
    readonly pLabel: string;
    readonly pPlaceholder: string;
    readonly iLabelPico: string;
    readonly iLabelPeco: string;
    readonly iPlaceholderPico: string;
    readonly iPlaceholderPeco: string;
    readonly cLabel: string;
    readonly cTooltip: string;
    readonly cPlaceholder: string;
    readonly oLabel: string;
    readonly oPlaceholder: string;
    readonly notLabel: string;
    readonly notTooltip: string;
    readonly notPlaceholder: string;
    readonly freeTextLabel: string;
    readonly freeTextPlaceholder: string;
    readonly extractBtn: string;
    readonly extractingBtn: string;
    readonly applyExtractionBtn: string;
    readonly sampleFasting: string;
    readonly sampleSglt2: string;
    readonly sampleParkinson: string;
    readonly expertRefinementTitle: string;
    readonly expertActiveSingle: string;
    readonly expertActivePlural: string;
    readonly sensitivityLabel: string;
    readonly sensBroad: string;
    readonly sensBalanced: string;
    readonly sensSpecific: string;
    readonly dateRangeLabel: string;
    readonly dateFrom: string;
    readonly dateTo: string;
    readonly dateEnable: string;
    readonly dateEnabled: string;
    readonly filtersLabel: string;
    readonly filterHumansCochrane: string;
    readonly filterRct: string;
    readonly filterSystematic: string;
    readonly qualifiersLabel: string;
    readonly generateCta: string;
    readonly generatingCta: string;
  };
  readonly step2: {
    readonly badge: string;
    readonly title: string;
    readonly subtitle: string;
    readonly meshColumnTitle: string;
    readonly addConceptPlaceholder: string;
    readonly addBtn: string;
    readonly noExplodeLabel: string;
    readonly majorTopicLabel: string;
    readonly rebuildQueryBtn: string;
    readonly equationColumnTitle: string;
    readonly pubmedHitsLabel: string;
    readonly auditScoreLabel: string;
    readonly pressStatusCompliant: string;
    readonly pressStatusNeedsRefinement: string;
    readonly pressStatusRevisionRequired: string;
    readonly pressAlertSingle: string;
    readonly pressAlertPlural: string;
    readonly strategyConvergedBadge: string;
    readonly pubmedErrorBannerPrefix: string;
    readonly pubmedUnavailableValue: string;
    readonly auditObservationsTitle: string;
    readonly pressBreakdownTitle: string;
    readonly showMoreSynonymsWord: string;
    readonly collapseSynonymsBtn: string;
    readonly freeTextConceptBadge: string;
    readonly droppedComparatorNotice: string;
    readonly unresolvedComparatorNotice: string;
    readonly optimizePicoBtn: string;
    readonly refiningPicoBtn: string;
    readonly refinePreviewTitle: string;
    readonly refineApplyBtn: string;
    readonly refineCancelBtn: string;
    readonly refineBeforeLabel: string;
    readonly refineAfterLabel: string;
    readonly refineActivatedBadge: string;
    readonly refineDeactivatedBadge: string;
    readonly refineNoChangesNotice: string;
    readonly refinedSuccessBanner: string;
    readonly copyQueryBtn: string;
    readonly copiedLabel: string;
    readonly saveBtn: string;
    readonly savedBtn: string;
    readonly applyEditedQueryBtn: string;
    readonly benchmarkTitle: string;
    readonly benchmarkHelper: string;
    readonly benchmarkPlaceholder: string;
    readonly benchmarkVerifyBtn: string;
    readonly backToStep1: string;
    readonly goToStep3: string;
  };
  readonly step3: {
    readonly badge: string;
    readonly title: string;
    readonly subtitle: string;
    readonly filterAll: string;
    readonly filterIncluded: string;
    readonly filterMaybe: string;
    readonly filterExcluded: string;
    readonly filterPending: string;
    readonly searchPlaceholder: string;
    readonly runAiScreeningBtn: string;
    readonly runAiNext50Btn: string;
    readonly runAiAllPendingBtn: string;
    readonly confirmAllTitle: string;
    readonly confirmAllApplyBtn: string;
    readonly confirmAllCancelBtn: string;
    readonly stopScreeningBtn: string;
    readonly screenedProgressUnit: string;
    readonly rayyanGroupTitle: string;
    readonly exportRayyanRisBtn: string;
    readonly exportRayyanCsvBtn: string;
    readonly partialSuffix: string;
    readonly importRayyanBtn: string;
    readonly includeAiNotesLabel: string;
    readonly partialPreviewBanner: string;
    readonly openOnPubMedBtn: string;
    readonly copyQueryBtn: string;
    readonly copiedLabel: string;
    readonly loadingCorpusLabel: string;
    readonly retryLoadBtn: string;
    readonly expandPageAbstractsBtn: string;
    readonly collapsePageAbstractsBtn: string;
    readonly paginationPrev: string;
    readonly paginationNext: string;
    readonly paginationPageLabel: string;
    readonly paginationOfLabel: string;
    readonly statusIncludedBadge: string;
    readonly statusMaybeBadge: string;
    readonly statusExcludedBadge: string;
    readonly evaluatorRayyan: string;
    readonly evaluatorManual: string;
    readonly exclusionReasonPrefix: string;
    readonly clinicalNotePrefix: string;
    readonly exclusionReasons: readonly string[];
    readonly noAbstractFallback: string;
    readonly btnInclude: string;
    readonly btnMaybe: string;
    readonly btnExclude: string;
    readonly showAbstract: string;
    readonly hideAbstract: string;
    readonly cochranePrecautionNote: string;
    readonly backToStep2: string;
    readonly goToStep4: string;
  };
  readonly step4: {
    readonly badge: string;
    readonly title: string;
    readonly subtitle: string;
    readonly tabFlowchart: string;
    readonly tabRob2: string;
    readonly tabMatrix: string;
    readonly tabReport: string;
    readonly scopeLabel: string;
    readonly scopeIncludedOnly: string;
    readonly scopeIncludedAndMaybe: string;
    readonly statusIncludedShort: string;
    readonly statusMaybeShort: string;
    readonly emptyScopeTitle: string;
    readonly emptyScopeDesc: string;
    readonly emptyScopeGoStep3Btn: string;
    readonly phase1Tag: string;
    readonly phase1Title: string;
    readonly phase1PubmedLabel: string;
    readonly phase1OtherLabel: string;
    readonly phase2Tag: string;
    readonly phase2Title: string;
    readonly phase2CappedNote: string;
    readonly phase2ExcludedTag: string;
    readonly phase2ExcludedTitle: string;
    readonly phase2OtherReasons: string;
    readonly phase3Tag: string;
    readonly phase3Title: string;
    readonly phase3Breakdown: string;
    readonly phase3PendingTag: string;
    readonly phase3PendingTitle: string;
    readonly phase4Tag: string;
    readonly phase4Title: string;
    readonly robTitle: string;
    readonly robSubtitle: string;
    readonly robDisclaimer: string;
    readonly robRunNext20Btn: string;
    readonly robRunAllBtn: string;
    readonly robStopBtn: string;
    readonly robConfirmAllTitle: string;
    readonly robConfirmApplyBtn: string;
    readonly robConfirmCancelBtn: string;
    readonly robProgressLabel: string;
    readonly robDoneFeedback: string;
    readonly robStoppedFeedback: string;
    readonly robAssessedProgress: string;
    readonly robColStudy: string;
    readonly robColD1: string;
    readonly robColD2: string;
    readonly robColD3: string;
    readonly robColD4: string;
    readonly robColD5: string;
    readonly robColOverall: string;
    readonly robLevelLow: string;
    readonly robLevelModerate: string;
    readonly robLevelHigh: string;
    readonly robLevelUnassessed: string;
    readonly robLevelNa: string;
    readonly robNaNote: string;
    readonly designRctTag: string;
    readonly designReviewTag: string;
    readonly designObsTag: string;
    readonly designOtherTag: string;
    readonly matrixTitle: string;
    readonly matrixSubtitle: string;
    readonly matrixColStudy: string;
    readonly matrixColDesignStatus: string;
    readonly matrixColSummary: string;
    readonly matrixColRob: string;
    readonly exportCsvBtn: string;
    readonly exportMdBtn: string;
    readonly runRobBatchBtn: string;
    readonly reportTitle: string;
    readonly reportMatrixSectionTitle: string;
    readonly reportMatrixExportNote: string;
    readonly reportMatrixMoreRows: string;
    readonly reportMatrixOpenTabBtn: string;
    readonly reportMatrixEmptyNote: string;
    readonly copyReportBtn: string;
    readonly downloadReportBtn: string;
    readonly backToStep3: string;
  };
  readonly settingsModal: {
    readonly title: string;
    readonly subtitle: string;
    readonly checkingStatus: string;
    readonly testingStatus: string;
    readonly testConnectionBtn: string;
    readonly testingConnectionBtn: string;
    readonly sectionProvider: string;
    readonly sectionApiAndModels: string;
    readonly apiKeyLabelGemini: string;
    readonly apiKeyLabelOpenai: string;
    readonly apiKeyLabelAnthropic: string;
    readonly getApiKeyLink: string;
    readonly analysisModelLabel: string;
    readonly batchModelLabel: string;
    readonly sectionPacing: string;
    readonly pacingPaygLabel: string;
    readonly pacingFreeTierLabel: string;
    readonly sectionMedicalBases: string;
    readonly ncbiKeyLabel: string;
    readonly ncbiKeyPlaceholder: string;
    readonly ncbiKeyHelp: string;
    readonly ncbiKeyLink: string;
    readonly hetopTitle: string;
    readonly hetopLink: string;
    readonly hetopUsernameLabel: string;
    readonly hetopUsernamePlaceholder: string;
    readonly hetopPasswordLabel: string;
    readonly hetopPasswordPlaceholder: string;
    readonly hetopHelp: string;
    readonly hetopTestBtn: string;
    readonly hetopStatusConfigured: string;
    readonly hetopStatusUnconfigured: string;
    readonly footerLocalNote: string;
    readonly footerSavedFeedback: string;
    readonly closeBtn: string;
    readonly saveBtn: string;
  };
  readonly reviewsDrawer: {
    readonly title: string;
    readonly subtitle: string;
    readonly reviewTitleLabel: string;
    readonly reviewTitlePlaceholder: string;
    readonly saveCurrentBtn: string;
    readonly updateCurrentBtn: string;
    readonly savedFeedback: string;
    readonly importJsonBtn: string;
    readonly importSuccessFeedback: string;
    readonly newReviewBtn: string;
    readonly confirmNewReviewText: string;
    readonly confirmNewReviewApply: string;
    readonly confirmNewReviewCancel: string;
    readonly savedListTitle: string;
    readonly emptyTitle: string;
    readonly emptyDesc: string;
    readonly activeBadge: string;
    readonly stepBadge: string;
    readonly statsSummary: string;
    readonly resumeBtn: string;
    readonly exportJsonBtn: string;
    readonly deleteBtn: string;
    readonly confirmDeleteBtn: string;
    readonly cancelDeleteBtn: string;
  };
  readonly prerequisitesModal: {
    readonly title: string;
    readonly subtitle: string;
    readonly badgeRequired: string;
    readonly badgeOptional: string;
    readonly aiBlockTitle: string;
    readonly aiKeyPlaceholderGemini: string;
    readonly aiKeyPlaceholderOpenai: string;
    readonly aiKeyPlaceholderAnthropic: string;
    readonly aiPortalGemini: string;
    readonly aiPortalOpenai: string;
    readonly aiPortalAnthropic: string;
    readonly testAiBtn: string;
    readonly testingAiBtn: string;
    readonly aiStatusReadyHint: string;
    readonly aiStatusMissingHint: string;
    readonly ncbiBlockTitle: string;
    readonly ncbiPlaceholder: string;
    readonly ncbiPortalLink: string;
    readonly ncbiHelp: string;
    readonly ncbiStatusConfigured: string;
    readonly hetopBlockTitle: string;
    readonly hetopUsernameLabel: string;
    readonly hetopUsernamePlaceholder: string;
    readonly hetopPasswordLabel: string;
    readonly hetopPasswordPlaceholder: string;
    readonly hetopHelp: string;
    readonly hetopPortalLink: string;
    readonly hetopTestBtn: string;
    readonly hetopTestingBtn: string;
    readonly hetopStatusConfigured: string;
    readonly footerHintReady: string;
    readonly footerHintMissingAi: string;
    readonly enterStudioBtn: string;
  };
  readonly footer: {
    readonly leftText: string;
    readonly rightText: string;
  };
}

export const frDictionary: TranslationDictionary = {
  appTitle: 'MeSHcraft Studio',
  appSubtitle: 'Assistant de revue systématique',
  header: {
    historyBtn: 'Mes revues',
    settingsBtn: 'Paramètres & API',
    step1Short: 'Question & PICO',
    step2Short: 'MeSH & Équations',
    step3Short: 'Sélection & Rayyan',
    step4Short: 'Synthèse & Thèse'
  },
  step1: {
    badge: 'Étape 1 sur 4 · Cadrage Clinique',
    title: 'Formulation de la question de recherche',
    subtitle: 'Structurez votre question clinique en français (sans balises techniques). Le résolveur interrogera officiellement HeTOP et la NLM à l\'étape suivante.',
    modeStructured: 'Saisie guidée par axe',
    modeFreeText: 'Assistant de structuration IA',
    frameworkApproachLabel: 'Approche :',
    frameworkPico: 'Interventionnelle (PICO)',
    frameworkPeco: 'Observationnelle / Étiologique (PECO)',
    pLabel: 'P · Population / Pathologie cible',
    pPlaceholder: 'Ex : Adultes en excès pondéral ou obésité, Infarctus du myocarde...',
    iLabelPico: 'I · Intervention',
    iLabelPeco: 'E · Exposition',
    iPlaceholderPico: 'Ex : Jeûne intermittent, Colchicine, Empagliflozine...',
    iPlaceholderPeco: 'Ex : Antipsychotiques, Halopéridol, Rispéridone...',
    cLabel: 'C · Comparateur',
    cTooltip: 'Recommandation Cochrane & PRESS : laissé inactif par défaut pour ne pas restreindre le rappel. À activer uniquement en cas de comparaison directe active.',
    cPlaceholder: 'Ex : Placebo, Soins standards, Absence d\'exposition...',
    oLabel: 'O · Critère de jugement principal (Outcome)',
    oPlaceholder: 'Ex : Perte de poids, Syndrome parkinsonien induit, Mortalité...',
    notLabel: 'NOT · Critères d\'exclusion',
    notTooltip: 'Recommandation Cochrane & PRESS : laissé inactif par défaut. À activer uniquement en cas de bruit avéré, pour ne pas exclure d\'études comparatives mixtes.',
    notPlaceholder: 'Ex : Patients pédiatriques, Péricardite aiguë...',
    freeTextLabel: 'Décrivez votre sujet de recherche ou collez votre protocole / abstract :',
    freeTextPlaceholder: 'Décrivez votre sujet de thèse, votre question clinique ou collez l\'abstract de votre protocole pour pré-remplir automatiquement les axes...',
    extractBtn: 'Structurer les axes avec l\'IA',
    extractingBtn: 'Structuration sémantique en cours...',
    applyExtractionBtn: 'Pré-remplir le formulaire',
    sampleFasting: 'Exemple : Jeûne intermittent',
    sampleSglt2: 'Exemple : Inhibiteurs SGLT2',
    sampleParkinson: 'Exemple : Parkinsonisme médicamenteux (PECO)',
    expertRefinementTitle: 'Affinage expert (optionnel)',
    expertActiveSingle: 'filtre actif',
    expertActivePlural: 'filtres actifs',
    sensitivityLabel: 'Profil de sensibilité',
    sensBroad: 'Haute sensibilité',
    sensBalanced: 'Équilibré (Recommandé)',
    sensSpecific: 'Haute spécificité',
    dateRangeLabel: 'Bornes de dates',
    dateFrom: 'Année début',
    dateTo: 'Année fin',
    dateEnable: 'Activer',
    dateEnabled: 'Activé ✓',
    filtersLabel: 'Filtres méthodologiques',
    filterHumansCochrane: 'Exclusion animale non destructive Cochrane (Préserve les articles récents)',
    filterRct: 'Essais contrôlés randomisés (ECR)',
    filterSystematic: 'Revues systématiques & Méta-analyses',
    qualifiersLabel: 'Qualificatifs MeSH (Subheadings)',
    generateCta: 'Valider les descripteurs MeSH & Générer les équations',
    generatingCta: 'Résolution terminologique HeTOP / NLM en cours...'
  },
  step2: {
    badge: 'Étape 2 sur 4 · Validation des termes et des équations',
    title: 'Validation de la stratégie de recherche',
    subtitle: 'Contrôlez les termes médicaux retenus par axe, appliquez les ajustements suggérés et copiez vos équations pour PubMed, Embase et CENTRAL.',
    meshColumnTitle: 'Descripteurs officiels NLM / HeTOP par axe',
    addConceptPlaceholder: 'Ajouter un synonyme ou une molécule...',
    addBtn: 'Ajouter',
    noExplodeLabel: 'Sans explosion (:NoExp)',
    majorTopicLabel: 'Sujet majeur ([Majr])',
    rebuildQueryBtn: 'Recalculer les équations & Relancer PubMed',
    equationColumnTitle: 'Équations booléennes & Audit méthodologique',
    pubmedHitsLabel: 'Notices PubMed identifiées',
    auditScoreLabel: 'Statut PRESS',
    pressStatusCompliant: 'Stratégie conforme',
    pressStatusNeedsRefinement: 'À affiner',
    pressStatusRevisionRequired: 'Révision requise',
    pressAlertSingle: 'alerte',
    pressAlertPlural: 'alertes',
    strategyConvergedBadge: 'Stratégie convergée',
    pubmedErrorBannerPrefix: 'Interrogation PubMed interrompue :',
    pubmedUnavailableValue: 'Erreur',
    auditObservationsTitle: 'Revue qualitative (PRISMA-S / PRESS)',
    pressBreakdownTitle: 'Contrôles techniques PRESS',
    showMoreSynonymsWord: 'autres synonymes',
    collapseSynonymsBtn: 'Réduire',
    freeTextConceptBadge: 'Texte libre [tiab]',
    droppedComparatorNotice: 'Comparateur passif écarté automatiquement selon les recommandations Cochrane',
    unresolvedComparatorNotice: 'Comparateur écarté automatiquement (aucun descripteur MeSH NLM associé)',
    optimizePicoBtn: 'Affiner le PICO selon l\'audit',
    refiningPicoBtn: 'Préparation des suggestions d\'affinage...',
    refinePreviewTitle: 'Aperçu des ajustements proposés (Avant / Après)',
    refineApplyBtn: 'Appliquer et recalculer',
    refineCancelBtn: 'Annuler',
    refineBeforeLabel: 'Avant',
    refineAfterLabel: 'Après',
    refineActivatedBadge: 'Axe activé',
    refineDeactivatedBadge: 'Axe désactivé',
    refineNoChangesNotice: 'Aucun champ textuel modifié : seul le profil de sensibilité ou les axes actifs sont ajustés.',
    refinedSuccessBanner: 'Descripteurs MeSH et équations PubMed, Embase et CENTRAL recalculés selon l\'audit.',
    copyQueryBtn: 'Copier l\'équation',
    copiedLabel: 'Copié !',
    saveBtn: 'Sauvegarder',
    savedBtn: 'Sauvegardé',
    applyEditedQueryBtn: 'Recalculer le volume PubMed',
    benchmarkTitle: 'Vérifier la présence d\'articles connus (PMID repères)',
    benchmarkHelper: 'Optionnel : saisissez les PMID de 2 ou 3 articles clés que vous connaissez déjà pour vérifier que votre équation les retrouve bien.',
    benchmarkPlaceholder: 'Collez vos PMID de référence séparés par des virgules ou espaces (ex: 26474316, 39359014)...',
    benchmarkVerifyBtn: 'Vérifier la couverture',
    backToStep1: '← Modifier le cadrage PICO',
    goToStep3: 'Passer à la sélection des études →'
  },
  step3: {
    badge: 'Étape 3 sur 4 · Sélection des études',
    title: 'Tri sur titres et résumés',
    subtitle: 'Les notices sans résumé sont classées automatiquement en « À vérifier sur texte intégral » selon les recommandations Cochrane.',
    filterAll: 'Toutes',
    filterIncluded: 'Incluses',
    filterMaybe: 'À vérifier',
    filterExcluded: 'Exclues',
    filterPending: 'En attente',
    searchPlaceholder: 'Filtrer par titre, auteur ou PMID...',
    runAiScreeningBtn: 'Pré-dépouiller par IA',
    runAiNext50Btn: 'Pré-dépouiller les {n} notices en attente suivantes',
    runAiAllPendingBtn: 'Tout pré-dépouiller ({n})',
    confirmAllTitle: 'Lancer le pré-dépouillement IA sur les {n} notices en attente ?',
    confirmAllApplyBtn: 'Confirmer le lancement',
    confirmAllCancelBtn: 'Annuler',
    stopScreeningBtn: 'Arrêter',
    screenedProgressUnit: 'triées',
    rayyanGroupTitle: 'Interopérabilité Rayyan / Zotero',
    exportRayyanRisBtn: 'Export .ris',
    exportRayyanCsvBtn: 'Export .csv',
    partialSuffix: '(partiel)',
    importRayyanBtn: 'Importer décisions',
    includeAiNotesLabel: 'Inclure les notes IA dans Rayyan',
    partialPreviewBanner: 'Aperçu limité à {loaded} / {total} notices. Pour un export PRISMA exhaustif, affinez votre équation à l\'Étape 2 ou exportez directement depuis PubMed.gov.',
    openOnPubMedBtn: 'Ouvrir sur PubMed.gov',
    copyQueryBtn: 'Copier l\'équation',
    copiedLabel: 'Copié !',
    loadingCorpusLabel: 'Chargement des notices et résumés PubMed...',
    retryLoadBtn: 'Réessayer le chargement',
    expandPageAbstractsBtn: 'Déplier les résumés de la page',
    collapsePageAbstractsBtn: 'Replier les résumés de la page',
    paginationPrev: 'Précédent',
    paginationNext: 'Suivant',
    paginationPageLabel: 'Page',
    paginationOfLabel: 'sur',
    statusIncludedBadge: 'Inclus',
    statusMaybeBadge: 'À vérifier (Texte intégral)',
    statusExcludedBadge: 'Exclu',
    evaluatorRayyan: 'Rayyan (Double lecture)',
    evaluatorManual: 'Lecteur humain',
    exclusionReasonPrefix: 'Motif : ',
    clinicalNotePrefix: 'Note clinique : ',
    exclusionReasons: [
      'Population hors périmètre (ex: pédiatrie ou autre pathologie)',
      'Intervention / Exposition non conforme ou retirée du marché',
      'Critère de jugement absent (aucune mesure de l\'événement cible)',
      'Modèle animal ou étude in vitro',
      'Format sans données originales (éditorial, lettre, revue narrative)'
    ],
    noAbstractFallback: 'Aucun résumé disponible dans PubMed pour cette référence.',
    btnInclude: 'Inclure',
    btnMaybe: 'À vérifier',
    btnExclude: 'Exclure',
    showAbstract: 'Lire le résumé',
    hideAbstract: 'Masquer le résumé',
    cochranePrecautionNote: 'L\'IA agit comme co-lecteur préparatoire : la décision finale d\'inclusion repose sur la double lecture humaine du texte intégral.',
    backToStep2: '← Retour aux équations',
    goToStep4: 'Accéder au Bilan PRISMA, Biais & Matrice →'
  },
  step4: {
    badge: 'Étape 4 sur 4 · Synthèse, biais et export thèse',
    title: 'Synthèse et export PRISMA 2020',
    subtitle: 'Consultez le diagramme PRISMA, pré-évaluez les biais méthodologiques, consolidez la matrice de synthèse et exportez votre chapitre Méthodes.',
    tabFlowchart: '1. Diagramme PRISMA 2020',
    tabRob2: '2. Risque de biais',
    tabMatrix: '3. Matrice de synthèse',
    tabReport: '4. Chapitre Méthodes',
    scopeLabel: 'Périmètre :',
    scopeIncludedOnly: 'Études incluses uniquement',
    scopeIncludedAndMaybe: 'Incluses + À vérifier',
    statusIncludedShort: 'Incluse',
    statusMaybeShort: 'À vérifier',
    emptyScopeTitle: 'Aucune étude retenue dans ce périmètre',
    emptyScopeDesc: 'Triez d\'abord vos notices en « Inclure » ou « À vérifier » à l\'Étape 3 pour alimenter l\'évaluation des biais et la matrice de synthèse.',
    emptyScopeGoStep3Btn: 'Revenir à l\'Étape 3 (Sélection)',
    phase1Tag: '1. Identification',
    phase1Title: 'Références identifiées dans les bases de données',
    phase1PubmedLabel: 'PubMed/MEDLINE',
    phase1OtherLabel: 'Autres bases',
    phase2Tag: '2. Sélection (screening)',
    phase2Title: 'Notices examinées sur titre et résumé',
    phase2CappedNote: 'Aperçu chargé dans l\'outil : {loaded} / {total} notices PubMed',
    phase2ExcludedTag: 'Exclusions titre/résumé',
    phase2ExcludedTitle: 'Notices exclues d\'emblée',
    phase2OtherReasons: '+ {count} autres motifs ({records} notices)',
    phase3Tag: '3. Éligibilité (texte intégral)',
    phase3Title: 'Rapports retenus pour lecture intégrale',
    phase3Breakdown: 'Incluses ({included}) + À vérifier par précaution ({maybe})',
    phase3PendingTag: 'En attente de texte intégral',
    phase3PendingTitle: 'Rapports classés « À vérifier »',
    phase4Tag: '4. Retenues après tri titre/résumé',
    phase4Title: 'Incluses après tri titre/résumé (avant validation finale sur texte intégral)',
    robTitle: 'Pré-évaluation du risque de biais',
    robSubtitle: 'D1 à D5 servent de pré-indicateurs harmonisés sur résumé avant cotation finale sur texte intégral. Cliquez sur une cellule pour ajuster manuellement.',
    robDisclaimer: 'Pré-repérage indicatif sur titre et résumé — la cotation définitive (RoB 2 / ROBINS-I / AMSTAR 2) requiert la lecture du texte intégral.',
    robRunNext20Btn: 'Pré-évaluer les {n} études suivantes',
    robRunAllBtn: 'Tout pré-évaluer ({n})',
    robStopBtn: 'Arrêter',
    robConfirmAllTitle: 'Confirmer le pré-repérage IA sur les {n} études éligibles non encore évaluées ?',
    robConfirmApplyBtn: 'Lancer ({n})',
    robConfirmCancelBtn: 'Annuler',
    robProgressLabel: 'Pré-repérage méthodologique des biais ({current} / {total})…',
    robDoneFeedback: 'Pré-repérage des biais terminé pour {n} étude(s) (évaluations existantes préservées).',
    robStoppedFeedback: 'Pré-repérage des biais interrompu ({n} étude(s) enregistrée(s)).',
    robAssessedProgress: '{assessed} / {eligible} évaluées',
    robColStudy: 'Étude & grille',
    robColD1: 'D1 · Sélection / Randomisation',
    robColD2: 'D2 · Déviations / Insu',
    robColD3: 'D3 · Données manquantes',
    robColD4: 'D4 · Mesure du critère',
    robColD5: 'D5 · Résultat rapporté',
    robColOverall: 'Biais global',
    robLevelLow: 'Faible',
    robLevelModerate: 'Modéré',
    robLevelHigh: 'Élevé',
    robLevelUnassessed: 'Non évalué',
    robLevelNa: 'Hors grille (N/A)',
    robNaNote: 'Format hors grille d\'évaluation des biais (revue narrative, recommandation ou autre).',
    designRctTag: 'ECR (RoB 2)',
    designReviewTag: 'Revue syst. (AMSTAR 2)',
    designObsTag: 'Obs. (ROBINS-I / JBI)',
    designOtherTag: 'Autre (Hors grille)',
    matrixTitle: 'Matrice de synthèse des études',
    matrixSubtitle: 'Tableau consolidé par étude (référence, plan d\'étude, synthèse titre/résumé et risque de biais).',
    matrixColStudy: 'Étude (Auteur, Année, Revue, PMID)',
    matrixColDesignStatus: 'Plan d\'étude & statut',
    matrixColSummary: 'Synthèse titre/résumé',
    matrixColRob: 'Risque de biais',
    exportCsvBtn: 'Exporter en Excel (.csv)',
    exportMdBtn: 'Copier en tableau Markdown',
    runRobBatchBtn: 'Pré-évaluer les biais par lots (IA)',
    reportTitle: 'Chapitre Méthodes et bilan PRISMA 2020',
    reportMatrixSectionTitle: 'Aperçu de la matrice de synthèse jointe à l\'export',
    reportMatrixExportNote: 'Le tableau Markdown complet est automatiquement intégré lors de la copie ou du téléchargement (.md).',
    reportMatrixMoreRows: '+ {n} autre(s) étude(s) incluse(s) dans l\'export complet (.md)',
    reportMatrixOpenTabBtn: 'Voir la matrice complète',
    reportMatrixEmptyNote: 'Aucune étude retenue dans le périmètre actuel (aucun tableau joint).',
    copyReportBtn: 'Copier le chapitre',
    downloadReportBtn: 'Télécharger (.md)',
    backToStep3: '← Retour à la sélection des articles'
  },
  settingsModal: {
    title: 'Paramètres et API',
    subtitle: 'Configuration du fournisseur IA, des modèles et du débit PubMed.',
    checkingStatus: 'Vérification de la connexion en cours…',
    testingStatus: 'Test de connexion en cours…',
    testConnectionBtn: 'Tester',
    testingConnectionBtn: 'Test en cours…',
    sectionProvider: '1. Fournisseur IA',
    sectionApiAndModels: '2. Clé API et modèles',
    apiKeyLabelGemini: 'Clé API Google Gemini',
    apiKeyLabelOpenai: 'Clé API OpenAI',
    apiKeyLabelAnthropic: 'Clé API Anthropic',
    getApiKeyLink: 'Obtenir une clé',
    analysisModelLabel: 'Modèle d\'analyse (cadrage PICO et audit d\'équation)',
    batchModelLabel: 'Modèle par lots (tri titre/résumé et pré-repérage des biais)',
    sectionPacing: '3. Cadencement des lots au dépouillement',
    pacingPaygLabel: 'Compte facturé (20 notices/lot, sans pause)',
    pacingFreeTierLabel: 'Quota gratuit (12 notices/lot, pause 4 s)',
    sectionMedicalBases: '4. Accès aux bases médicales (optionnels)',
    ncbiKeyLabel: 'Clé API NCBI PubMed',
    ncbiKeyPlaceholder: 'Collez votre clé NCBI (facultatif)…',
    ncbiKeyHelp: 'Facultatif — augmente le débit des requêtes PubMed de 3 à 10 req/s.',
    ncbiKeyLink: 'Créer une clé NCBI',
    hetopTitle: 'Compte HeTOP / CISMeF (CHU de Rouen)',
    hetopLink: 'Portail HeTOP',
    hetopUsernameLabel: 'Identifiant HeTOP',
    hetopUsernamePlaceholder: 'Nom d\'utilisateur HeTOP',
    hetopPasswordLabel: 'Mot de passe HeTOP',
    hetopPasswordPlaceholder: 'Mot de passe',
    hetopHelp: 'Facultatif — active la résolution officielle des descripteurs MeSH francophones via HeTOP.',
    hetopTestBtn: 'Tester HeTOP',
    hetopStatusConfigured: 'Identifiants enregistrés',
    hetopStatusUnconfigured: 'Non configuré',
    footerLocalNote: 'Clés enregistrées uniquement dans votre navigateur.',
    footerSavedFeedback: 'Paramètres enregistrés.',
    closeBtn: 'Fermer',
    saveBtn: 'Appliquer & Enregistrer'
  },
  reviewsDrawer: {
    title: 'Mes revues',
    subtitle: 'Sauvegarde locale complète (PICO, équations, tri et biais) et export portable (.json).',
    reviewTitleLabel: 'Titre de la revue en cours',
    reviewTitlePlaceholder: 'Ex. SGLT2i et insuffisance cardiaque…',
    saveCurrentBtn: 'Sauvegarder la revue en cours',
    updateCurrentBtn: 'Mettre à jour la revue',
    savedFeedback: 'Revue sauvegardée localement.',
    importJsonBtn: 'Importer (.json)',
    importSuccessFeedback: 'Revue importée et restaurée avec succès.',
    newReviewBtn: 'Nouvelle revue',
    confirmNewReviewText: 'Réinitialiser la session en cours pour démarrer une nouvelle revue ?',
    confirmNewReviewApply: 'Réinitialiser',
    confirmNewReviewCancel: 'Annuler',
    savedListTitle: 'Revues sauvegardées',
    emptyTitle: 'Aucune revue sauvegardée',
    emptyDesc: 'Sauvegardez votre revue en cours pour la reprendre plus tard ou l\'exporter au format .json.',
    activeBadge: 'En cours',
    stepBadge: 'Étape {step}/4',
    statsSummary: '{hits} notices · {screened} triées · {rob} biais',
    resumeBtn: 'Reprendre',
    exportJsonBtn: 'Exporter (.json)',
    deleteBtn: 'Supprimer',
    confirmDeleteBtn: 'Confirmer',
    cancelDeleteBtn: 'Annuler'
  },
  prerequisitesModal: {
    title: 'Configuration initiale · MeSHcraft Studio',
    subtitle: 'Vos clés API sont enregistrées uniquement dans votre navigateur (stockage local) et ne transitent par aucun serveur tiers.',
    badgeRequired: 'Requis',
    badgeOptional: 'Optionnel',
    aiBlockTitle: '1. Fournisseur IA',
    aiKeyPlaceholderGemini: 'Collez votre clé API Google Gemini (AIzaSy…)',
    aiKeyPlaceholderOpenai: 'Collez votre clé API OpenAI (sk-proj-…)',
    aiKeyPlaceholderAnthropic: 'Collez votre clé API Anthropic (sk-ant-…)',
    aiPortalGemini: 'Obtenir une clé Google AI Studio',
    aiPortalOpenai: 'Obtenir une clé OpenAI',
    aiPortalAnthropic: 'Obtenir une clé Anthropic',
    testAiBtn: 'Tester la connexion',
    testingAiBtn: 'Test en cours…',
    aiStatusReadyHint: 'Clé IA renseignée — cliquez sur « Tester la connexion » pour vérifier ou accédez directement au studio.',
    aiStatusMissingHint: 'Renseignez une clé API valide (Google Gemini, OpenAI ou Anthropic) pour continuer.',
    ncbiBlockTitle: '2. Clé API NCBI PubMed',
    ncbiPlaceholder: 'Clé API NCBI Entrez (facultatif)…',
    ncbiPortalLink: 'Créer une clé NCBI gratuite',
    ncbiHelp: 'PubMed fonctionne sans clé (3 req/s ; la clé gratuite porte la limite à 10 req/s).',
    ncbiStatusConfigured: '10 req/s activé',
    hetopBlockTitle: '3. Identifiants HeTOP / CISMeF',
    hetopUsernameLabel: 'Identifiant HeTOP',
    hetopUsernamePlaceholder: 'Nom d\'utilisateur HeTOP (facultatif)',
    hetopPasswordLabel: 'Mot de passe HeTOP',
    hetopPasswordPlaceholder: 'Mot de passe (facultatif)',
    hetopHelp: 'La résolution MeSH fonctionne aussi sans compte HeTOP (le compte HeTOP ajoute la correspondance officielle française CISMeF).',
    hetopPortalLink: 'Portail HeTOP',
    hetopTestBtn: 'Tester HeTOP',
    hetopTestingBtn: 'Test…',
    hetopStatusConfigured: 'Identifiants enregistrés',
    footerHintReady: 'Clé IA prête. Les accès NCBI et HeTOP restent configurables à tout moment dans Paramètres & API.',
    footerHintMissingAi: 'Ajoutez une clé IA pour débloquer l\'accès au studio.',
    enterStudioBtn: 'Accéder à MeSHcraft Studio'
  },
  footer: {
    leftText: 'MeSHcraft Studio · Plateforme d\'ingénierie documentaire médicale & revues systématiques',
    rightText: 'Conforme PRISMA 2020, PRISMA-S & Cochrane Handbook · Thésaurus officiel HeTOP & NCBI Entrez'
  }
};

export const enDictionary: TranslationDictionary = {
  appTitle: 'MeSHcraft Studio',
  appSubtitle: 'Systematic review assistant',
  header: {
    historyBtn: 'My reviews',
    settingsBtn: 'Settings & API',
    step1Short: 'Clinical PICO',
    step2Short: 'MeSH & Queries',
    step3Short: 'Screening & Rayyan',
    step4Short: 'PRISMA & Matrix'
  },
  step1: {
    badge: 'Step 1 of 4 · Clinical Framing',
    title: 'Research Question Formulation',
    subtitle: 'Enter concise atomic clinical concepts. Official MeSH resolution is performed dynamically via HeTOP and NCBI Entrez in Step 2.',
    modeStructured: 'Guided PICO/PECO fields',
    modeFreeText: 'AI Structuring Assistant',
    frameworkApproachLabel: 'Approach:',
    frameworkPico: 'Interventional (PICO)',
    frameworkPeco: 'Observational / Etiologic (PECO)',
    pLabel: 'P · Target Population / Condition',
    pPlaceholder: 'e.g., Adults with overweight or obesity, Myocardial infarction...',
    iLabelPico: 'I · Intervention',
    iLabelPeco: 'E · Exposure',
    iPlaceholderPico: 'e.g., Intermittent fasting, Colchicine, Empagliflozin...',
    iPlaceholderPeco: 'e.g., Antipsychotic agents, Haloperidol, Risperidone...',
    cLabel: 'C · Comparator',
    cTooltip: 'Cochrane & PRESS recommendation: inactive by default to preserve recall. Enable only for active direct comparisons.',
    cPlaceholder: 'e.g., Placebo, Standard of care, Unexposed...',
    oLabel: 'O · Primary Outcome',
    oPlaceholder: 'e.g., Weight loss, Drug-induced parkinsonism, Mortality...',
    notLabel: 'NOT · Exclusion Criteria',
    notTooltip: 'Cochrane & PRESS recommendation: inactive by default. Enable only when confirmed noise occurs, to avoid excluding mixed comparative studies.',
    notPlaceholder: 'e.g., Pediatric patients, Acute pericarditis...',
    freeTextLabel: 'Describe your research topic or paste your protocol / abstract:',
    freeTextPlaceholder: 'Describe your thesis topic, clinical question, or paste your protocol abstract to automatically pre-fill the axes...',
    extractBtn: 'Structure axes with AI',
    extractingBtn: 'Semantic structuring in progress...',
    applyExtractionBtn: 'Pre-fill form',
    sampleFasting: 'Sample: Intermittent Fasting',
    sampleSglt2: 'Sample: SGLT2 Inhibitors',
    sampleParkinson: 'Sample: Drug-Induced Parkinsonism (PECO)',
    expertRefinementTitle: 'Expert refinement (optional)',
    expertActiveSingle: 'active filter',
    expertActivePlural: 'active filters',
    sensitivityLabel: 'Sensitivity profile',
    sensBroad: 'High sensitivity',
    sensBalanced: 'Balanced (Recommended)',
    sensSpecific: 'High specificity',
    dateRangeLabel: 'Date bounds',
    dateFrom: 'Start year',
    dateTo: 'End year',
    dateEnable: 'Enable',
    dateEnabled: 'Enabled ✓',
    filtersLabel: 'Methodological filters',
    filterHumansCochrane: 'Cochrane non-destructive animal exclusion (Preserves recent articles)',
    filterRct: 'Randomized Controlled Trials (RCT)',
    filterSystematic: 'Systematic Reviews & Meta-Analyses',
    qualifiersLabel: 'MeSH Subheadings (Qualifiers)',
    generateCta: 'Validate MeSH Descriptors & Build Equations',
    generatingCta: 'Resolving official HeTOP / NLM MeSH descriptors...'
  },
  step2: {
    badge: 'Step 2 of 4 · Terms and Equations Validation',
    title: 'Search Strategy Validation',
    subtitle: 'Review the selected medical terms by axis, apply suggested adjustments, and copy your equations for PubMed, Embase, and CENTRAL.',
    meshColumnTitle: 'Official NLM / HeTOP Descriptors by Axis',
    addConceptPlaceholder: 'Add a synonym or drug name...',
    addBtn: 'Add',
    noExplodeLabel: 'No Explosion (:NoExp)',
    majorTopicLabel: 'Major Topic ([Majr])',
    rebuildQueryBtn: 'Rebuild Equations & Rerun PubMed',
    equationColumnTitle: 'Boolean Queries & Methodological Audit',
    pubmedHitsLabel: 'PubMed records retrieved',
    auditScoreLabel: 'PRESS Status',
    pressStatusCompliant: 'Compliant strategy',
    pressStatusNeedsRefinement: 'Needs refinement',
    pressStatusRevisionRequired: 'Revision required',
    pressAlertSingle: 'alert',
    pressAlertPlural: 'alerts',
    strategyConvergedBadge: 'Strategy converged',
    pubmedErrorBannerPrefix: 'PubMed query failed:',
    pubmedUnavailableValue: 'Error',
    auditObservationsTitle: 'Qualitative review (PRISMA-S / PRESS)',
    pressBreakdownTitle: 'PRESS technical checks',
    showMoreSynonymsWord: 'more synonyms',
    collapseSynonymsBtn: 'Collapse',
    freeTextConceptBadge: 'Free text [tiab]',
    droppedComparatorNotice: 'Passive comparator automatically excluded per Cochrane recommendations',
    unresolvedComparatorNotice: 'Comparator automatically excluded (no matching NLM MeSH descriptor)',
    optimizePicoBtn: 'Refine PICO from Audit',
    refiningPicoBtn: 'Preparing refinement preview...',
    refinePreviewTitle: 'Proposed PICO adjustments preview (Before / After)',
    refineApplyBtn: 'Apply and recalculate',
    refineCancelBtn: 'Cancel',
    refineBeforeLabel: 'Before',
    refineAfterLabel: 'After',
    refineActivatedBadge: 'Axis activated',
    refineDeactivatedBadge: 'Axis deactivated',
    refineNoChangesNotice: 'No text field changed: only sensitivity profile or active axes are adjusted.',
    refinedSuccessBanner: 'MeSH descriptors and PubMed, Embase, and CENTRAL equations recalculated from audit.',
    copyQueryBtn: 'Copy Query',
    copiedLabel: 'Copied!',
    saveBtn: 'Save',
    savedBtn: 'Saved',
    applyEditedQueryBtn: 'Recalculate PubMed volume',
    benchmarkTitle: 'Check known articles presence (benchmark PMIDs)',
    benchmarkHelper: 'Optional: enter the PMIDs of 2 or 3 key articles you already know to verify that your equation retrieves them.',
    benchmarkPlaceholder: 'Paste reference PMIDs separated by commas or spaces...',
    benchmarkVerifyBtn: 'Check coverage',
    backToStep1: '← Edit PICO Framing',
    goToStep3: 'Proceed to Study Screening →'
  },
  step3: {
    badge: 'Step 3 of 4 · Study selection',
    title: 'Title and abstract screening',
    subtitle: 'Records without an abstract are automatically retained for full-text review per Cochrane guidance.',
    filterAll: 'All',
    filterIncluded: 'Included',
    filterMaybe: 'Maybe',
    filterExcluded: 'Excluded',
    filterPending: 'Pending',
    searchPlaceholder: 'Filter by title, author, or PMID...',
    runAiScreeningBtn: 'Run AI pre-screening',
    runAiNext50Btn: 'Pre-screen next {n} pending records',
    runAiAllPendingBtn: 'Pre-screen all ({n})',
    confirmAllTitle: 'Run AI pre-screening on all {n} pending records?',
    confirmAllApplyBtn: 'Confirm run',
    confirmAllCancelBtn: 'Cancel',
    stopScreeningBtn: 'Stop',
    screenedProgressUnit: 'screened',
    rayyanGroupTitle: 'Rayyan / Zotero interoperability',
    exportRayyanRisBtn: 'Export .ris',
    exportRayyanCsvBtn: 'Export .csv',
    partialSuffix: '(partial)',
    importRayyanBtn: 'Import decisions',
    includeAiNotesLabel: 'Include AI notes in Rayyan',
    partialPreviewBanner: 'Preview limited to {loaded} / {total} records. For an exhaustive PRISMA export, refine your query in Step 2 or export directly from PubMed.gov.',
    openOnPubMedBtn: 'Open on PubMed.gov',
    copyQueryBtn: 'Copy query',
    copiedLabel: 'Copied!',
    loadingCorpusLabel: 'Loading PubMed records and abstracts...',
    retryLoadBtn: 'Retry loading',
    expandPageAbstractsBtn: 'Expand page abstracts',
    collapsePageAbstractsBtn: 'Collapse page abstracts',
    paginationPrev: 'Previous',
    paginationNext: 'Next',
    paginationPageLabel: 'Page',
    paginationOfLabel: 'of',
    statusIncludedBadge: 'Included',
    statusMaybeBadge: 'Maybe (Full-text)',
    statusExcludedBadge: 'Excluded',
    evaluatorRayyan: 'Rayyan (Dual review)',
    evaluatorManual: 'Human reviewer',
    exclusionReasonPrefix: 'Reason: ',
    clinicalNotePrefix: 'Clinical note: ',
    exclusionReasons: [
      'Out-of-scope population (e.g., pediatric or different condition)',
      'Non-eligible intervention / exposure',
      'Target outcome not reported',
      'Animal or in vitro study',
      'Non-original format (editorial, letter, narrative review)'
    ],
    noAbstractFallback: 'No abstract available in PubMed for this record.',
    btnInclude: 'Include',
    btnMaybe: 'Maybe',
    btnExclude: 'Exclude',
    showAbstract: 'Read abstract',
    hideAbstract: 'Hide abstract',
    cochranePrecautionNote: 'AI acts as a preparatory co-screener: final inclusion relies on independent human full-text review.',
    backToStep2: '← Back to Equations',
    goToStep4: 'Open PRISMA Flowchart, Bias & Matrix →'
  },
  step4: {
    badge: 'Step 4 of 4 · Synthesis, bias and thesis export',
    title: 'PRISMA 2020 synthesis and export',
    subtitle: 'Review the PRISMA flowchart, pre-assess methodological bias, consolidate the synthesis matrix and export your Methods section.',
    tabFlowchart: '1. PRISMA 2020 flowchart',
    tabRob2: '2. Risk of bias',
    tabMatrix: '3. Synthesis matrix',
    tabReport: '4. Methods section',
    scopeLabel: 'Scope:',
    scopeIncludedOnly: 'Included studies only',
    scopeIncludedAndMaybe: 'Included + Maybe',
    statusIncludedShort: 'Included',
    statusMaybeShort: 'Maybe',
    emptyScopeTitle: 'No studies retained in this scope',
    emptyScopeDesc: 'Screen records as "Include" or "Maybe" in Step 3 first to populate the risk of bias table and synthesis matrix.',
    emptyScopeGoStep3Btn: 'Back to Step 3 (Screening)',
    phase1Tag: '1. Identification',
    phase1Title: 'Records identified from databases',
    phase1PubmedLabel: 'PubMed/MEDLINE',
    phase1OtherLabel: 'Other databases',
    phase2Tag: '2. Screening',
    phase2Title: 'Records screened on title and abstract',
    phase2CappedNote: 'Preview loaded in tool: {loaded} / {total} PubMed records',
    phase2ExcludedTag: 'Title/abstract exclusions',
    phase2ExcludedTitle: 'Records excluded',
    phase2OtherReasons: '+ {count} other reasons ({records} records)',
    phase3Tag: '3. Eligibility (full text)',
    phase3Title: 'Reports sought for full-text assessment',
    phase3Breakdown: 'Included ({included}) + Maybe ({maybe})',
    phase3PendingTag: 'Pending full-text verification',
    phase3PendingTitle: 'Records marked "Maybe"',
    phase4Tag: '4. Retained after title/abstract screening',
    phase4Title: 'Included after title/abstract screening (pending final full-text validation)',
    robTitle: 'Risk of bias pre-assessment',
    robSubtitle: 'D1–D5 serve as harmonized abstract-level pre-indicators prior to final full-text appraisal. Click any cell to adjust manually.',
    robDisclaimer: 'Indicative pre-screening on title and abstract — definitive appraisal (RoB 2 / ROBINS-I / AMSTAR 2) requires full-text reading.',
    robRunNext20Btn: 'Pre-assess next {n} studies',
    robRunAllBtn: 'Pre-assess all ({n})',
    robStopBtn: 'Stop',
    robConfirmAllTitle: 'Confirm AI pre-assessment for all {n} unassessed eligible studies?',
    robConfirmApplyBtn: 'Run ({n})',
    robConfirmCancelBtn: 'Cancel',
    robProgressLabel: 'Pre-assessing methodological bias ({current} / {total})…',
    robDoneFeedback: 'Bias pre-assessment completed for {n} study(ies) (existing appraisals preserved).',
    robStoppedFeedback: 'Bias pre-assessment stopped ({n} study(ies) saved).',
    robAssessedProgress: '{assessed} / {eligible} assessed',
    robColStudy: 'Study & tool',
    robColD1: 'D1 · Selection / Randomization',
    robColD2: 'D2 · Deviations / Blinding',
    robColD3: 'D3 · Missing data',
    robColD4: 'D4 · Outcome measurement',
    robColD5: 'D5 · Reported result',
    robColOverall: 'Overall bias',
    robLevelLow: 'Low',
    robLevelModerate: 'Moderate',
    robLevelHigh: 'High',
    robLevelUnassessed: 'Unassessed',
    robLevelNa: 'Not applicable (N/A)',
    robNaNote: 'Format outside bias appraisal checklists (narrative review, guideline or other).',
    designRctTag: 'RCT (RoB 2)',
    designReviewTag: 'Syst. review (AMSTAR 2)',
    designObsTag: 'Obs. (ROBINS-I / JBI)',
    designOtherTag: 'Other (N/A)',
    matrixTitle: 'Study synthesis matrix',
    matrixSubtitle: 'Per-study consolidated table (reference, study design, title/abstract synthesis and risk of bias).',
    matrixColStudy: 'Study (Author, Year, Journal, PMID)',
    matrixColDesignStatus: 'Study design & status',
    matrixColSummary: 'Title/abstract synthesis',
    matrixColRob: 'Risk of bias',
    exportCsvBtn: 'Export Excel (.csv)',
    exportMdBtn: 'Copy Markdown table',
    runRobBatchBtn: 'Pre-assess bias in batches (AI)',
    reportTitle: 'Methods section and PRISMA 2020 summary',
    reportMatrixSectionTitle: 'Preview of the synthesis matrix attached to export',
    reportMatrixExportNote: 'The complete Markdown table is automatically appended when copying or downloading (.md).',
    reportMatrixMoreRows: '+ {n} more study(ies) included in the full export (.md)',
    reportMatrixOpenTabBtn: 'Open full matrix',
    reportMatrixEmptyNote: 'No studies retained in the current scope (no table attached).',
    copyReportBtn: 'Copy section',
    downloadReportBtn: 'Download (.md)',
    backToStep3: '← Back to study selection'
  },
  settingsModal: {
    title: 'Settings and API',
    subtitle: 'Configure AI provider, models and PubMed request rate.',
    checkingStatus: 'Checking connection…',
    testingStatus: 'Testing connection…',
    testConnectionBtn: 'Test',
    testingConnectionBtn: 'Testing…',
    sectionProvider: '1. AI provider',
    sectionApiAndModels: '2. API key and models',
    apiKeyLabelGemini: 'Google Gemini API key',
    apiKeyLabelOpenai: 'OpenAI API key',
    apiKeyLabelAnthropic: 'Anthropic API key',
    getApiKeyLink: 'Get API key',
    analysisModelLabel: 'Analysis model (PICO framing and query audit)',
    batchModelLabel: 'Batch model (title/abstract screening and bias pre-screening)',
    sectionPacing: '3. Screening batch pacing',
    pacingPaygLabel: 'Billed account (20 records/batch, no pause)',
    pacingFreeTierLabel: 'Free tier (12 records/batch, 4 s pause)',
    sectionMedicalBases: '4. Medical database access (optional)',
    ncbiKeyLabel: 'NCBI PubMed API key',
    ncbiKeyPlaceholder: 'Paste your NCBI key (optional)…',
    ncbiKeyHelp: 'Optional — increases PubMed request throughput from 3 to 10 req/s.',
    ncbiKeyLink: 'Create NCBI key',
    hetopTitle: 'HeTOP / CISMeF account (Rouen University Hospital)',
    hetopLink: 'HeTOP portal',
    hetopUsernameLabel: 'HeTOP username',
    hetopUsernamePlaceholder: 'HeTOP username',
    hetopPasswordLabel: 'HeTOP password',
    hetopPasswordPlaceholder: 'Password',
    hetopHelp: 'Optional — enables official French-to-English MeSH descriptor resolution via HeTOP.',
    hetopTestBtn: 'Test HeTOP',
    hetopStatusConfigured: 'Credentials saved',
    hetopStatusUnconfigured: 'Not configured',
    footerLocalNote: 'Keys are stored locally in your browser only.',
    footerSavedFeedback: 'Settings saved.',
    closeBtn: 'Close',
    saveBtn: 'Apply & Save'
  },
  reviewsDrawer: {
    title: 'My reviews',
    subtitle: 'Full local persistence (PICO, queries, screening & bias) and portable .json export.',
    reviewTitleLabel: 'Current review title',
    reviewTitlePlaceholder: 'e.g., SGLT2i in chronic heart failure…',
    saveCurrentBtn: 'Save current review',
    updateCurrentBtn: 'Update saved review',
    savedFeedback: 'Review saved locally.',
    importJsonBtn: 'Import (.json)',
    importSuccessFeedback: 'Review imported and restored successfully.',
    newReviewBtn: 'New review',
    confirmNewReviewText: 'Reset the current session to start a new review?',
    confirmNewReviewApply: 'Reset',
    confirmNewReviewCancel: 'Cancel',
    savedListTitle: 'Saved reviews',
    emptyTitle: 'No saved reviews yet',
    emptyDesc: 'Save your current review to resume it later or export it as a portable .json file.',
    activeBadge: 'Active',
    stepBadge: 'Step {step}/4',
    statsSummary: '{hits} records · {screened} screened · {rob} bias',
    resumeBtn: 'Resume',
    exportJsonBtn: 'Export (.json)',
    deleteBtn: 'Delete',
    confirmDeleteBtn: 'Confirm',
    cancelDeleteBtn: 'Cancel'
  },
  prerequisitesModal: {
    title: 'Initial setup · MeSHcraft Studio',
    subtitle: 'Your API keys are stored solely in your browser (local storage) and are never routed through any third-party server.',
    badgeRequired: 'Required',
    badgeOptional: 'Optional',
    aiBlockTitle: '1. AI provider',
    aiKeyPlaceholderGemini: 'Paste your Google Gemini API key (AIzaSy…)',
    aiKeyPlaceholderOpenai: 'Paste your OpenAI API key (sk-proj-…)',
    aiKeyPlaceholderAnthropic: 'Paste your Anthropic API key (sk-ant-…)',
    aiPortalGemini: 'Get Google AI Studio key',
    aiPortalOpenai: 'Get OpenAI key',
    aiPortalAnthropic: 'Get Anthropic key',
    testAiBtn: 'Test connection',
    testingAiBtn: 'Testing…',
    aiStatusReadyHint: 'AI key entered — click "Test connection" to verify or enter the studio directly.',
    aiStatusMissingHint: 'Enter a valid API key (Google Gemini, OpenAI or Anthropic) to continue.',
    ncbiBlockTitle: '2. NCBI PubMed API key',
    ncbiPlaceholder: 'NCBI Entrez API key (optional)…',
    ncbiPortalLink: 'Create free NCBI key',
    ncbiHelp: 'PubMed works without a key (3 req/s; a free key raises the limit to 10 req/s).',
    ncbiStatusConfigured: '10 req/s enabled',
    hetopBlockTitle: '3. HeTOP / CISMeF credentials',
    hetopUsernameLabel: 'HeTOP username',
    hetopUsernamePlaceholder: 'HeTOP username (optional)',
    hetopPasswordLabel: 'HeTOP password',
    hetopPasswordPlaceholder: 'Password (optional)',
    hetopHelp: 'MeSH resolution also works without a HeTOP account (a HeTOP account adds official French CISMeF mapping).',
    hetopPortalLink: 'HeTOP portal',
    hetopTestBtn: 'Test HeTOP',
    hetopTestingBtn: 'Testing…',
    hetopStatusConfigured: 'Credentials saved',
    footerHintReady: 'AI key ready. NCBI and HeTOP access can also be updated later in Settings & API.',
    footerHintMissingAi: 'Add an AI key to unlock the studio.',
    enterStudioBtn: 'Open MeSHcraft Studio'
  },
  footer: {
    leftText: 'MeSHcraft Studio · Evidence-Based Medicine & Systematic Review Platform',
    rightText: 'PRISMA 2020, PRISMA-S & Cochrane Handbook Compliant · Official HeTOP & NCBI Entrez APIs'
  }
};

interface I18nContextValue {
  readonly locale: LocaleCode;
  readonly setLocale: (loc: LocaleCode) => void;
  readonly t: TranslationDictionary;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'fr',
  setLocale: () => {},
  t: frDictionary
});

export function LanguageProvider({ children }: { readonly children: React.ReactNode }) {
  const [locale, setLocale] = useState<LocaleCode>('fr');
  const t = locale === 'en' ? enDictionary : frDictionary;

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation(): I18nContextValue {
  return useContext(I18nContext);
}

