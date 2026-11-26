//! Moteur Algébrique & Morpho-Syntaxique Pur — MeSHcraft Studio (Rust / WebAssembly)
//! Conformité stricte `gemini.md` :
//! 1. Zéro dictionnaire médical en dur (uniquement des invariants morphologiques, algébriques et structurels NLM).
//! 2. Filtre d'arité lexicale (`[tw]`) pour les substances pharmacologiques (DCI/INN vs sels et codes IUPAC).
//! 3. Dominance dérivationnelle des troncatures (`-ism`/`-ian`/`-oid` bloquant la racine courte `$R^*$`).
//! 4. Subsomption préfixielle booléenne ($A \lor (A \land B) \equiv A$).
//! 5. Absorption des sous-descripteurs MeSH ($D \lor D/q \equiv D \implies \text{émettre uniquement } D/q$).

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

// ============================================================================
// EXPRESSIONS RÉGULIÈRES PRÉ-COMPILÉES (ZÉRO DICTIONNAIRE MÉDICAL EN DUR)
// ============================================================================

/// DCI / USAN monolexicale stricte : 4 à 25 lettres alphabétiques pures (sans chiffre, tiret, sel ni parenthèse).
static RE_INN_MONO: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z]{4,25}$").expect("Invalid RE_INN_MONO"));

/// DCI acide carboxylique officielle NLM/USAN : un radical alphabétique suivi de ` acid` (ex. `valproic acid`).
static RE_INN_ACID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z]{4,20}\s+acid$").expect("Invalid RE_INN_ACID"));

/// Token alphabétique pur pour l'analyse morphologique dérivationnelle.
static RE_ALPHA_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[a-z]{4,}").expect("Invalid RE_ALPHA_TOKEN"));

/// Détection de la forme inversée NLM avec virgule (`Nom, Qualificatif`).
static RE_NLM_INVERTED_COMMA: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^([^,]+),\s*(.+)$").expect("Invalid RE_NLM_INVERTED_COMMA"));

/// Marqueurs morphologiques NLM des descripteurs génériques de classe pharmacologique.
static RE_PHARMA_CLASS_HEADING: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(?:agents|drugs|inhibitors|antagonists|agonists|blockers|stimulants|depressants|therapeutics|preparations|compounds|derivatives|hormones|antibiotics|analgesics|anesthetics|vaccines|receptors|enzymes|analogues|analogs)\b",
    )
    .expect("Invalid RE_PHARMA_CLASS_HEADING")
});

/// Détecte les locants IUPAC (`1-(glucopyranosyl)-...`, `3-oxazolidin-5-yl...`) et codes labo (`BAY 59-7939`).
static RE_IUPAC_LOCANT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\d+[a-z]?-[a-z]|[a-z]-\d+-|\(\d+[a-z]?\)|-\(\(").expect("Invalid RE_IUPAC_LOCANT")
});

static RE_LAB_CODE_SHORT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^[a-z]{2,5}[-\s]?(?:\d{3,}|\d{2,}[-\s]\d{2,})[a-z0-9-\s]*$")
        .expect("Invalid RE_LAB_CODE_SHORT")
});

/// Stopwords structurels et racines génériques non-cliniques (`NON_CLINICAL_STEMS`)
/// qui ne doivent jamais générer de troncature unitaire `stem*[tiab]` isolée,
/// afin de préserver intactes les locutions composées (ex: `"problem-based learning"[tiab]`).
const NON_CLINICAL_STEMS: &[&str] = &[
    "disease",
    "diseases",
    "disorder",
    "disorders",
    "syndrome",
    "syndromes",
    "secondary",
    "chemically",
    "induced",
    "adverse",
    "effect",
    "effects",
    "reaction",
    "reactions",
    "related",
    "agent",
    "agents",
    "therapy",
    "therapies",
    "treatment",
    "treatments",
    "acute",
    "chronic",
    "idiopathic",
    "symptomatic",
    "experimental",
    "human",
    "humans",
    "animal",
    "animals",
    "side",
    "with",
    "without",
    "from",
    "type",
    "types",
    "problem",
    "problems",
    "based",
    "learning",
    "solving",
    "curriculum",
    "curricula",
    "health",
    "healthcare",
    "care",
    "clinical",
    "system",
    "systems",
    "trial",
    "trials",
    "outcome",
    "outcomes",
    "personnel",
    "provider",
    "providers",
    "worker",
    "workers",
    "professional",
    "professionals",
    "student",
    "students",
    "education",
    "educational",
    "practice",
    "practices",
    "service",
    "services",
    "program",
    "programs",
    "management",
    "method",
    "methods",
    "study",
    "studies",
    "patient",
    "patients",
    "group",
    "groups",
    "model",
    "models",
    "level",
    "levels",
    "factor",
    "factors",
    "process",
    "processes",
    "control",
    "controls",
    "active",
    "experiential",
    "continuing",
    "development",
    "staff",
    "intervention",
    "interventions",
    "medical",
    "medicine",
    "general",
    "primary",
    "traditional",
    "standard",
    "usual",
    "routine",
];

// ============================================================================
// CONTRATS DE SÉRIALISATION SERDE (MIROIR EXACT TYPESCRIPT CAMELCASE)
// ============================================================================

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PicoAxisRole {
    PathologyOutcome,
    DrugInnList,
    TherapeuticClass,
    Population,
    Comparator,
    Exclusion,
    #[serde(other)]
    GenericIntervention,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeshDescriptorNode {
    pub descriptor: String,
    pub mesh_id: String,
    #[serde(default)]
    pub allowed_subheadings: Vec<String>,
    #[serde(default)]
    pub selected_subheadings: Vec<String>,
    #[serde(default)]
    pub tree_numbers: Vec<String>,
    #[serde(default)]
    pub is_pharmacological_substance: bool,
    #[serde(default)]
    pub no_exp: bool,
    #[serde(default)]
    pub is_major: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AxisCompilationInput {
    pub axis_role: PicoAxisRole,
    #[serde(default)]
    pub implied_subheadings: Vec<String>,
    #[serde(default)]
    pub descriptors: Vec<MeshDescriptorNode>,
    #[serde(default)]
    pub entry_terms: Vec<String>,
    #[serde(default)]
    pub raw_clinical_tokens: Vec<String>,
    #[serde(default)]
    pub custom_truncations: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompiledAxisOutput {
    pub pubmed_clause: String,
    pub embase_clause: String,
    pub central_clause: String,
    pub mesh_terms_emitted: Vec<String>,
    pub tw_terms_emitted: Vec<String>,
    pub truncations_emitted: Vec<String>,
    pub tiab_terms_emitted: Vec<String>,
    pub pruned_by_subsumption: Vec<String>,
    pub rejected_by_arity: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArityFilterResult {
    pub accepted_tw_clauses: Vec<String>,
    pub accepted_raw_terms: Vec<String>,
    pub rejected_terms: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxValidationResult {
    pub is_valid: bool,
    pub open_parens: usize,
    pub close_parens: usize,
    pub quote_count: usize,
    pub has_doubled_tags: bool,
    pub has_nested_quotes: bool,
    pub has_inverted_comma_in_tiab: bool,
    pub has_short_truncation: bool,
    pub errors: Vec<String>,
}

// ============================================================================
// 1. FILTRE D'ARITÉ LEXICALE (`[tw]`) — SUBSTANCES PHARMACOLOGIQUES (DCI / INN)
// ============================================================================

/// Normalise une chaîne candidate et teste si elle respecte l'arité lexicale stricte d'une DCI :
/// - `^[a-z]{4,25}$` -> `terme[tw]` (sans guillemets, ex. `haloperidol[tw]`, `methotrimeprazine[tw]`)
/// - `^[a-z]{4,20}\s+acid$` -> `"terme acid"[tw]` (avec guillemets, ex. `"valproic acid"[tw]`)
/// Rejette systématiquement les sels galéniques (`valproate sodium`, `chlorpromazine hydrochloride`),
/// les esters (`haloperidol decanoate`) et les formules IUPAC contenant chiffres, crochets ou tirets.
pub fn filter_inn_arity_tw(candidates: &[String]) -> ArityFilterResult {
    let mut seen = HashSet::<String>::new();
    let mut accepted_tw_clauses = Vec::<String>::new();
    let mut accepted_raw_terms = Vec::<String>::new();
    let mut rejected_terms = Vec::<String>::new();

    for raw in candidates {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }

        // Si forme inversée NLM d'un acide organique : "Acid, Valproic" -> "valproic acid"
        let candidate = if let Some(caps) = RE_NLM_INVERTED_COMMA.captures(&normalized) {
            let head = caps.get(1).map_or("", |m| m.as_str().trim());
            let tail = caps.get(2).map_or("", |m| m.as_str().trim());
            if head == "acid" && !tail.contains(' ') {
                format!("{} {}", tail, head)
            } else {
                normalized.clone()
            }
        } else {
            normalized
        };

        if RE_INN_MONO.is_match(&candidate) {
            if seen.insert(candidate.clone()) {
                accepted_tw_clauses.push(format!("{}[tw]", candidate));
                accepted_raw_terms.push(candidate);
            }
        } else if RE_INN_ACID.is_match(&candidate) {
            let collapsed = candidate.split_whitespace().collect::<Vec<_>>().join(" ");
            if seen.insert(collapsed.clone()) {
                accepted_tw_clauses.push(format!("\"{}\"[tw]", collapsed));
                accepted_raw_terms.push(collapsed);
            }
        } else {
            rejected_terms.push(raw.trim().to_string());
        }
    }

    ArityFilterResult {
        accepted_tw_clauses,
        accepted_raw_terms,
        rejected_terms,
    }
}

// ============================================================================
// 2. DOMINANCE DÉRIVATIONNELLE DES TRONCATURES ($R+\text{ism/ian/oid}^* \succ R^*$)
// ============================================================================

fn is_non_clinical_stem(token: &str) -> bool {
    NON_CLINICAL_STEMS.contains(&token)
}

fn normalize_monolexical_base_stem(word: &str) -> String {
    if word.len() >= 6
        && word.ends_with('s')
        && !word.ends_with("ss")
        && !word.ends_with("is")
        && !word.ends_with("us")
    {
        word[..word.len() - 1].to_string()
    } else {
        word.to_string()
    }
}

/// Extrait les racines de troncature ($\ge 5$ caractères, norme BiUM/NLM) depuis le pool sémantique
/// (descripteurs + entry terms) et applique :
/// 1. Le blocage strict des `NON_CLINICAL_STEMS` et l'interdiction de fragmenter les locutions
///    composées multi-mots en troncatures unitaires génériques (préservant `"problem-based learning"[tiab]`).
/// 2. La **Dominance Dérivationnelle** : si le pool contient des dérivés suffixés en `-ism`/`-isms` (`...is*`),
///    `-ian`/`-ians` (`...ian*`), ou `-oid`/`-oids` (`...oid*`), leurs racines dérivées $R'^*$
///    bloquent algébriquement la racine nominale nue $R^*$ (`parkinson*`).
pub fn compute_derivational_stems(
    descriptors: &[MeshDescriptorNode],
    entry_terms: &[String],
    custom_truncations: &[String],
) -> Vec<String> {
    let mut all_tokens = Vec::<String>::new();
    let mut monolexical_tokens = Vec::<String>::new();

    for d in descriptors {
        let lower = d.descriptor.trim().to_ascii_lowercase();
        let tokens: Vec<String> = RE_ALPHA_TOKEN
            .find_iter(&lower)
            .map(|m| m.as_str().to_string())
            .collect();
        if tokens.len() == 1 && !lower.contains(' ') && !lower.contains('-') {
            let tok = &tokens[0];
            if !is_non_clinical_stem(tok) {
                monolexical_tokens.push(tok.clone());
            }
        }
        for tok in tokens {
            if !is_non_clinical_stem(&tok) {
                all_tokens.push(tok);
            }
        }
    }

    for entry in entry_terms {
        let lower = entry.trim().to_ascii_lowercase();
        let tokens: Vec<String> = RE_ALPHA_TOKEN
            .find_iter(&lower)
            .map(|m| m.as_str().to_string())
            .collect();
        if tokens.len() == 1 && !lower.contains(' ') && !lower.contains('-') {
            let tok = &tokens[0];
            if !is_non_clinical_stem(tok) {
                monolexical_tokens.push(tok.clone());
            }
        }
        for tok in tokens {
            if !is_non_clinical_stem(&tok) {
                all_tokens.push(tok);
            }
        }
    }

    let mut derived_stems = Vec::<String>::new();
    let mut base_stems = Vec::<String>::new();

    for tok in &all_tokens {
        // 1. Dérivés nosologiques / syndromiques en -ism / -isms -> troncature sur `...is`
        if tok.len() >= 8 && (tok.ends_with("ism") || tok.ends_with("isms")) {
            let stem = if tok.ends_with("isms") {
                &tok[..tok.len() - 2]
            } else {
                &tok[..tok.len() - 1]
            };
            if stem.len() >= 5
                && !is_non_clinical_stem(stem)
                && !derived_stems.contains(&stem.to_string())
            {
                derived_stems.push(stem.to_string());
            }
            continue;
        }

        // 2. Dérivés adjectivaux en -ian / -ians -> troncature sur `...ian`
        if tok.len() >= 8 && (tok.ends_with("ian") || tok.ends_with("ians")) {
            let stem = if tok.ends_with("ians") {
                &tok[..tok.len() - 1]
            } else {
                tok.as_str()
            };
            if stem.len() >= 5
                && !is_non_clinical_stem(stem)
                && !derived_stems.contains(&stem.to_string())
            {
                derived_stems.push(stem.to_string());
            }
            continue;
        }

        // 3. Dérivés en -oid / -oids -> troncature sur `...oid`
        if tok.len() >= 8 && (tok.ends_with("oid") || tok.ends_with("oids")) {
            let stem = if tok.ends_with("oids") {
                &tok[..tok.len() - 1]
            } else {
                tok.as_str()
            };
            if stem.len() >= 5
                && !is_non_clinical_stem(stem)
                && !derived_stems.contains(&stem.to_string())
            {
                derived_stems.push(stem.to_string());
            }
            continue;
        }
    }

    // 4. Racines nominales de base (>= 5 caractères) : extraites exclusivement des concepts
    // monolexicaux spécifiques (ex. Delirium -> delirium*, Hospitals -> hospital*, Nurses -> nurse*),
    // sans jamais découper les locutions composées (ex. "Problem-Based Learning").
    for mono in &monolexical_tokens {
        if mono.ends_with("ism")
            || mono.ends_with("isms")
            || mono.ends_with("ian")
            || mono.ends_with("ians")
            || mono.ends_with("oid")
            || mono.ends_with("oids")
        {
            continue;
        }
        let stem = normalize_monolexical_base_stem(mono);
        if stem.len() >= 5 && !is_non_clinical_stem(&stem) && !base_stems.contains(&stem) {
            base_stems.push(stem);
        }
    }

    // 5. Troncatures personnalisées éventuelles (>= 5 chars, hors NON_CLINICAL_STEMS)
    for custom in custom_truncations {
        let clean = custom
            .trim()
            .trim_end_matches('*')
            .to_ascii_lowercase();
        if clean.len() >= 5
            && RE_ALPHA_TOKEN.is_match(&clean)
            && !is_non_clinical_stem(&clean)
            && !derived_stems.contains(&clean)
            && !base_stems.contains(&clean)
        {
            if clean.ends_with("is") || clean.ends_with("ian") || clean.ends_with("oid") {
                derived_stems.push(clean);
            } else {
                base_stems.push(clean);
            }
        }
    }

    // Tri morphologique canonique : substantifs nosologiques (-is) > adjectifs (-ian) > (-oid)
    derived_stems.sort_by_key(|s| {
        if s.ends_with("is") {
            0usize
        } else if s.ends_with("ian") {
            1usize
        } else {
            2usize
        }
    });

    // LOI DE DOMINANCE DÉRIVATIONNELLE :
    // Toute racine nominale de base `R` qui est un préfixe strict d'une racine dérivée `R'`
    // (avec 2 <= len(R') - len(R) <= 5, ex. `parkinson` < `parkinsonis` / `parkinsonian`)
    // est dominée et bloquée.
    let mut active_stems = Vec::<String>::new();

    for d_stem in &derived_stems {
        if !active_stems.contains(d_stem) {
            active_stems.push(d_stem.clone());
        }
    }

    let has_syndromic_context = descriptors.iter().any(|d| {
        let low = d.descriptor.to_ascii_lowercase();
        low.contains(", secondary")
            || low.contains("disorders")
            || low.contains("syndrome")
            || d.selected_subheadings
                .iter()
                .any(|s| s == "chemically induced")
    });

    for b_stem in &base_stems {
        let is_dominated = derived_stems.iter().any(|d_stem| {
            d_stem.starts_with(b_stem.as_str())
                && d_stem.len() > b_stem.len()
                && (d_stem.len() - b_stem.len()) <= 5
        });

        if !is_dominated && (!has_syndromic_context || derived_stems.is_empty()) {
            if !active_stems.contains(b_stem) {
                active_stems.push(b_stem.clone());
            }
        }
    }

    // Déduplication par préfixe : une racine plus courte absorbe les variantes plus longues
    // commençant par elle (ex: `mortal*` absorbe `mortality*`, `mortalitie*`, `mortalities*`).
    let mut deduplicated_stems = Vec::<String>::new();
    for stem in &active_stems {
        if deduplicated_stems.contains(stem) {
            continue;
        }
        let subsumed_by_shorter = active_stems
            .iter()
            .any(|other| other.len() < stem.len() && stem.starts_with(other.as_str()));
        if !subsumed_by_shorter {
            deduplicated_stems.push(stem.clone());
        }
    }

    deduplicated_stems
}

// ============================================================================
// 3. SUBSOMPTION PRÉFIXIELLE BOOLÉENNE ($A \lor (A \land B) \equiv A$)
// ============================================================================

/// Inverse une chaîne NLM avec virgule (`"Parkinsonism, Secondary"` -> `"secondary parkinsonism"`)
/// afin de respecter l'interdiction absolue des virgules d'inversion dans `[tiab]`.
pub fn normalize_nlm_entry_for_tiab(raw: &str) -> String {
    let trimmed = raw.trim().to_ascii_lowercase();
    if let Some(caps) = RE_NLM_INVERTED_COMMA.captures(&trimmed) {
        let head = caps.get(1).map_or("", |m| m.as_str().trim());
        let tail = caps.get(2).map_or("", |m| m.as_str().trim());
        if !head.is_empty() && !tail.is_empty() && !tail.contains(',') {
            return format!("{} {}", tail, head);
        }
    }
    trimmed
}

pub fn is_iupac_or_lab_code_term(phrase: &str) -> bool {
    let trimmed = phrase.trim();
    if trimmed.is_empty() {
        return false;
    }
    let open_parens = trimmed.matches('(').count();
    let close_parens = trimmed.matches(')').count();
    if open_parens != close_parens || trimmed.contains('[') || trimmed.contains(']') {
        return true;
    }
    if RE_IUPAC_LOCANT.is_match(trimmed) || RE_LAB_CODE_SHORT.is_match(trimmed) {
        return true;
    }
    let digit_count = trimmed.chars().filter(|c| c.is_ascii_digit()).count();
    let hyphen_count = trimmed.matches('-').count();
    if (digit_count >= 2 && hyphen_count >= 2) || (open_parens > 0 && digit_count >= 1) {
        return true;
    }
    if trimmed.len() > 60 && (digit_count >= 1 || hyphen_count >= 3) {
        return true;
    }
    false
}

/// Élagage algébrique par subsomption préfixielle ($A \lor (A \land B) \equiv A$) :
/// Tout terme candidat `[tiab]` $P$ dont au moins un mot commence par une racine de troncature
/// active $s \in \text{active\_stems}$ (`s*[tiab]`) est un sous-ensemble strict des résultats de `s*[tiab]`.
/// Il est donc mathématiquement absorbé et supprimé pour garantir la concision canonique.
pub fn prune_by_prefix_subsumption(
    candidate_phrases: &[String],
    active_stems: &[String],
) -> (Vec<String>, Vec<String>) {
    let mut retained = Vec::<String>::new();
    let mut pruned = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();

    for raw in candidate_phrases {
        let normalized = normalize_nlm_entry_for_tiab(raw);
        if normalized.is_empty() || normalized.contains(',') || is_iupac_or_lab_code_term(&normalized) {
            continue;
        }

        if !seen.insert(normalized.clone()) {
            continue;
        }

        let words: Vec<&str> = normalized
            .split(|c: char| !c.is_ascii_alphabetic())
            .filter(|w| !w.is_empty())
            .collect();

        let is_subsumed = words.iter().any(|word| {
            active_stems
                .iter()
                .any(|stem| stem.len() >= 5 && word.starts_with(stem.as_str()))
        });

        if is_subsumed {
            pruned.push(normalized);
        } else {
            retained.push(normalized);
        }
    }

    (retained, pruned)
}

// ============================================================================
// 4. COMPILATION ALGÉBRIQUE D'UN AXE PICO/PECO (PUBMED, EMBASE, CENTRAL)
// ============================================================================

fn normalize_subheading_comparison_key(subheading: &str) -> String {
    subheading
        .trim()
        .to_ascii_lowercase()
        .replace('&', " and ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Résout les sous-descripteurs (`qualifiers`) actifs d'un descripteur NLM :
/// Union de `selected_subheadings` et `implied_subheadings`, filtrée par `allowed_subheadings`
/// lorsque le référentiel NLM a fourni la liste `ds_subheading` du descripteur.
fn resolve_active_subheadings(
    node: &MeshDescriptorNode,
    implied_subheadings: &[String],
) -> Vec<String> {
    let mut combined = Vec::<String>::new();
    let mut seen_keys = HashSet::<String>::new();

    for sh in &node.selected_subheadings {
        let key = normalize_subheading_comparison_key(sh);
        if !key.is_empty() && seen_keys.insert(key.clone()) {
            combined.push(key);
        }
    }
    for sh in implied_subheadings {
        let key = normalize_subheading_comparison_key(sh);
        if !key.is_empty() && seen_keys.insert(key.clone()) {
            combined.push(key);
        }
    }

    if node.allowed_subheadings.is_empty() {
        return combined;
    }

    let allowed_lower: HashSet<String> = node
        .allowed_subheadings
        .iter()
        .map(|s| normalize_subheading_comparison_key(s))
        .collect();

    combined
        .into_iter()
        .filter(|sh| allowed_lower.contains(sh))
        .collect()
}

fn is_pharmacological_class_node(node: &MeshDescriptorNode, all_nodes: &[MeshDescriptorNode]) -> bool {
    let has_d27_tree = node
        .tree_numbers
        .iter()
        .any(|tn| tn.trim().to_ascii_uppercase().starts_with("D27"));
    if has_d27_tree {
        return true;
    }
    if RE_PHARMA_CLASS_HEADING.is_match(&node.descriptor) {
        return true;
    }
    !node.is_pharmacological_substance
        && all_nodes.iter().any(|other| other.is_pharmacological_substance)
}

/// Compile un bloc PICO/PECO complet selon son `PicoAxisRole` :
/// - Si `DrugInnList` (et qu'aucun descripteur de classe pharmacologique D27/générique n'est présent) :
///   applique le **Filtre d'Arité Lexicale `[tw]`** sans émettre de `[Mesh]` redondant.
/// - Sinon (y compris axe mixte classe D27 + molécules DCI) :
///   1. Applique la **Loi d'Absorption des Sous-Descripteurs** (`"Descriptor/subheading"[Mesh]`).
///   2. Calcule les troncatures par **Dominance Dérivationnelle** (`stem*[tiab]`).
///   3. Élague les synonymes `[tiab]` par **Subsomption Préfixielle** ($A \lor (A \land B) \equiv A$).
pub fn compile_axis_block_rust(input: &AxisCompilationInput) -> CompiledAxisOutput {
    let has_pharmacological_class = input
        .descriptors
        .iter()
        .any(|d| is_pharmacological_class_node(d, &input.descriptors));
    let is_drug_list = !has_pharmacological_class
        && (input.axis_role == PicoAxisRole::DrugInnList
            || (input.descriptors.len() > 1
                && input
                    .descriptors
                    .iter()
                    .all(|d| d.is_pharmacological_substance)));

    // ------------------------------------------------------------------------
    // CAS A : LISTE DE SUBSTANCES PHARMACOLOGIQUES (DCI / INN -> `[tw]`)
    // ------------------------------------------------------------------------
    if is_drug_list {
        let mut all_candidates = Vec::<String>::new();
        for d in &input.descriptors {
            all_candidates.push(d.descriptor.clone());
        }
        for raw in &input.raw_clinical_tokens {
            all_candidates.push(raw.clone());
        }
        for entry in &input.entry_terms {
            all_candidates.push(entry.clone());
        }

        let arity = filter_inn_arity_tw(&all_candidates);

        let pubmed_clause = if arity.accepted_tw_clauses.is_empty() {
            String::new()
        } else {
            format!("({})", arity.accepted_tw_clauses.join(" OR "))
        };

        let embase_terms: Vec<String> = arity
            .accepted_raw_terms
            .iter()
            .map(|t| format!("'{}':ti,ab,kw,de", t))
            .collect();
        let embase_clause = if embase_terms.is_empty() {
            String::new()
        } else {
            format!("({})", embase_terms.join(" OR "))
        };

        let central_terms: Vec<String> = arity
            .accepted_raw_terms
            .iter()
            .map(|t| {
                if t.contains(' ') {
                    format!("\"{}\":ti,ab,kw", t)
                } else {
                    format!("{}:ti,ab,kw", t)
                }
            })
            .collect();
        let central_clause = if central_terms.is_empty() {
            String::new()
        } else {
            format!("({})", central_terms.join(" OR "))
        };

        return CompiledAxisOutput {
            pubmed_clause,
            embase_clause,
            central_clause,
            mesh_terms_emitted: Vec::new(),
            tw_terms_emitted: arity.accepted_tw_clauses,
            truncations_emitted: Vec::new(),
            tiab_terms_emitted: Vec::new(),
            pruned_by_subsumption: Vec::new(),
            rejected_by_arity: arity.rejected_terms,
        };
    }

    // ------------------------------------------------------------------------
    // CAS B : AXE NOSOLOGIQUE / CLINIQUE / CLASSE THÉRAPEUTIQUE
    // ------------------------------------------------------------------------
    let mut mesh_terms_emitted = Vec::<String>::new();
    let mut embase_parts = Vec::<String>::new();
    let mut central_parts = Vec::<String>::new();
    let mut seen_mesh = HashSet::<String>::new();
    let mut seen_embase = HashSet::<String>::new();

    // 1. Loi d'Absorption des Sous-Descripteurs :
    // Si un descripteur possède au moins un sous-descripteur actif, on émet UNIQUEMENT
    // `"Descriptor/subheading"[Mesh]` et JAMAIS `"Descriptor"[Mesh]` nu en OR.
    for node in &input.descriptors {
        let desc_clean = node.descriptor.trim();
        if desc_clean.is_empty() || node.mesh_id.trim().is_empty() {
            continue;
        }

        let tag = match (node.is_major, node.no_exp) {
            (true, true) => "[Majr:NoExp]",
            (true, false) => "[Majr]",
            (false, true) => "[Mesh:NoExp]",
            (false, false) => "[Mesh]",
        };

        let active_sh = resolve_active_subheadings(node, &input.implied_subheadings);
        if active_sh.is_empty() {
            let formatted = format!("\"{}\"{}", desc_clean, tag);
            if seen_mesh.insert(formatted.clone()) {
                mesh_terms_emitted.push(formatted);
                let embase_term = format!(
                    "'{}'/{}",
                    desc_clean.to_ascii_lowercase(),
                    if node.no_exp { "de" } else { "exp" }
                );
                if seen_embase.insert(embase_term.clone()) {
                    embase_parts.push(embase_term);
                }
                central_parts.push(format!(
                    "[mh {}\"{}\"]",
                    if node.no_exp { "^" } else { "" },
                    desc_clean
                ));
            }
        } else {
            for sh in active_sh {
                let formatted = format!("\"{}/{}\"{}", desc_clean, sh, tag);
                if seen_mesh.insert(formatted.clone()) {
                    mesh_terms_emitted.push(formatted);
                    let embase_term = format!(
                        "'{}'/{}",
                        desc_clean.to_ascii_lowercase(),
                        if node.no_exp { "de" } else { "exp" }
                    );
                    if seen_embase.insert(embase_term.clone()) {
                        embase_parts.push(embase_term);
                    }
                    central_parts.push(format!(
                        "[mh {}\"{}\"/{}]",
                        if node.no_exp { "^" } else { "" },
                        desc_clean,
                        subheading_to_central_code(&sh)
                    ));
                }
            }
        }
    }

    // 2. Calcul des troncatures actives par Dominance Dérivationnelle
    // Sur un axe mixte (classe D27 + DCI), garantir aussi l'inclusion des molécules en [tiab].
    let mut effective_entry_terms = input.entry_terms.clone();
    let mut seen_entry_lower: HashSet<String> = effective_entry_terms
        .iter()
        .map(|t| t.trim().to_ascii_lowercase())
        .collect();
    for node in &input.descriptors {
        if node.is_pharmacological_substance {
            let lower_name = node.descriptor.trim().to_ascii_lowercase();
            if !lower_name.is_empty() && seen_entry_lower.insert(lower_name.clone()) {
                effective_entry_terms.push(lower_name);
            }
        }
    }

    let active_stems = compute_derivational_stems(
        &input.descriptors,
        &effective_entry_terms,
        &input.custom_truncations,
    );

    let truncations_emitted: Vec<String> = active_stems
        .iter()
        .map(|stem| format!("{}*[tiab]", stem))
        .collect();

    for stem in &active_stems {
        embase_parts.push(format!("'{}*':ti,ab,kw,de", stem));
        central_parts.push(format!("{}*:ti,ab,kw", stem));
    }

    // 3. Élagage des Entry Terms `[tiab]` par Subsomption Préfixielle ($A \lor (A \land B) \equiv A$)
    let (retained_phrases, pruned_by_subsumption) =
        prune_by_prefix_subsumption(&effective_entry_terms, &active_stems);

    let tiab_terms_emitted: Vec<String> = retained_phrases
        .iter()
        .map(|p| format!("\"{}\"[tiab]", p))
        .collect();

    for p in &retained_phrases {
        embase_parts.push(format!("'{}':ti,ab,kw,de", p));
        central_parts.push(format!("\"{}\":ti,ab,kw", p));
    }

    let mut all_pubmed_parts = Vec::<String>::new();
    all_pubmed_parts.extend(mesh_terms_emitted.clone());
    all_pubmed_parts.extend(truncations_emitted.clone());
    all_pubmed_parts.extend(tiab_terms_emitted.clone());

    let pubmed_clause = if all_pubmed_parts.is_empty() {
        String::new()
    } else {
        format!("({})", all_pubmed_parts.join(" OR "))
    };

    let embase_clause = if embase_parts.is_empty() {
        String::new()
    } else {
        format!("({})", embase_parts.join(" OR "))
    };

    let central_clause = if central_parts.is_empty() {
        String::new()
    } else {
        format!("({})", central_parts.join(" OR "))
    };

    CompiledAxisOutput {
        pubmed_clause,
        embase_clause,
        central_clause,
        mesh_terms_emitted,
        tw_terms_emitted: Vec::new(),
        truncations_emitted,
        tiab_terms_emitted,
        pruned_by_subsumption,
        rejected_by_arity: Vec::new(),
    }
}

/// Convertit un sous-descripteur NLM canonique vers son code 2 lettres Cochrane CENTRAL.
fn subheading_to_central_code(subheading: &str) -> &'static str {
    match subheading.trim().to_ascii_lowercase().as_str() {
        "chemically induced" => "CI",
        "adverse effects" => "AE",
        "drug therapy" => "DT",
        "therapy" => "TH",
        "toxicity" => "TO",
        "poisoning" => "PO",
        "pharmacology" => "PD",
        "pharmacokinetics" => "PK",
        "etiology" => "ET",
        "diagnosis" => "DI",
        "prevention and control" => "PC",
        "epidemiology" => "EP",
        "mortality" => "MO",
        "complications" => "CO",
        _ => "CI",
    }
}

// ============================================================================
// 5. VALIDATION DES INVARIANTS MATHÉMATIQUES BOOLÉENS (SECTION 1.2 GEMINI.MD)
// ============================================================================

pub fn validate_boolean_syntax_invariants(query: &str) -> SyntaxValidationResult {
    let open_parens = query.chars().filter(|&c| c == '(').count();
    let close_parens = query.chars().filter(|&c| c == ')').count();
    let quote_count = query.chars().filter(|&c| c == '"').count();

    let has_doubled_tags = query.contains("][");
    let has_nested_quotes = query.contains("\"\"");

    let re_inverted_tiab =
        Regex::new(r#""[^"]+,[^"]+"\s*\[(?i:tiab|tw)\]"#).expect("Invalid regex");
    let has_inverted_comma_in_tiab = re_inverted_tiab.is_match(query);

    let re_short_trunc =
        Regex::new(r"\b([a-zA-Z]{1,4})\*\s*\[(?i:tiab|tw)\]").expect("Invalid regex");
    let has_short_truncation = re_short_trunc.is_match(query);

    let mut errors = Vec::<String>::new();
    if open_parens != close_parens {
        errors.push(format!(
            "Déséquilibre des parenthèses : {} ouvrante(s) vs {} fermante(s).",
            open_parens, close_parens
        ));
    }
    if quote_count % 2 != 0 {
        errors.push(format!(
            "Nombre impair de guillemets ({}) détecté.",
            quote_count
        ));
    }
    if has_doubled_tags {
        errors.push("Balises de champ doublées détectées (ex. [TiAb][TiAb]).".to_string());
    }
    if has_nested_quotes {
        errors.push("Guillemets imbriqués détectés (\"\"Terme\"\").".to_string());
    }
    if has_inverted_comma_in_tiab {
        errors.push(
            "Forme inversée NLM avec virgule détectée dans [TiAb] ou [tw].".to_string(),
        );
    }
    if has_short_truncation {
        errors.push(
            "Troncature prohibée (< 5 caractères alphabétiques) détectée.".to_string(),
        );
    }

    SyntaxValidationResult {
        is_valid: errors.is_empty(),
        open_parens,
        close_parens,
        quote_count,
        has_doubled_tags,
        has_nested_quotes,
        has_inverted_comma_in_tiab,
        has_short_truncation,
        errors,
    }
}

// ============================================================================
// EXPORTS WEBASSEMBLY (PONT SERDE JSON <-> WASM-BINDGEN SANS CHATTER)
// ============================================================================

#[wasm_bindgen(js_name = compileAxisBlockWasm)]
pub fn compile_axis_block_wasm(input_json: &str) -> Result<String, JsValue> {
    let input: AxisCompilationInput = serde_json::from_str(input_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid AxisCompilationInput JSON: {}", e)))?;
    let output = compile_axis_block_rust(&input);
    serde_json::to_string(&output)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}

#[wasm_bindgen(js_name = filterInnArityTwWasm)]
pub fn filter_inn_arity_tw_wasm(candidates_json: &str) -> Result<String, JsValue> {
    let candidates: Vec<String> = serde_json::from_str(candidates_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid candidates JSON: {}", e)))?;
    let result = filter_inn_arity_tw(&candidates);
    serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}

#[wasm_bindgen(js_name = validateBooleanSyntaxWasm)]
pub fn validate_boolean_syntax_wasm(query: &str) -> Result<String, JsValue> {
    let result = validate_boolean_syntax_invariants(query);
    serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}

// ============================================================================
// TESTS UNITAIRES RUST (GOLD STANDARD PARKINSONISME MÉDICAMENTEUX)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inn_arity_filter_gold_standard() {
        let raw_entry_terms = vec![
            "Haloperidol".to_string(),
            "Haloperidol Decanoate".to_string(),
            "4-(4-(4-chlorophenyl)-4-hydroxy-1-piperidinyl)-1-(4-fluorophenyl)-1-butanone"
                .to_string(),
            "Chlorpromazine".to_string(),
            "Chlorpromazine Hydrochloride".to_string(),
            "Methotrimeprazine".to_string(),
            "Levomepromazine".to_string(),
            "Valproic Acid".to_string(),
            "Valproate Sodium".to_string(),
            "Sodium Valproate".to_string(),
            "2-Propylpentanoic Acid".to_string(),
        ];

        let res = filter_inn_arity_tw(&raw_entry_terms);
        assert_eq!(
            res.accepted_tw_clauses,
            vec![
                "haloperidol[tw]",
                "chlorpromazine[tw]",
                "methotrimeprazine[tw]",
                "levomepromazine[tw]",
                "\"valproic acid\"[tw]",
            ]
        );
        assert_eq!(res.rejected_terms.len(), 6);
    }

    #[test]
    fn test_derivational_dominance_and_prefix_subsumption_parkinsonism() {
        let input = AxisCompilationInput {
            axis_role: PicoAxisRole::PathologyOutcome,
            implied_subheadings: vec!["chemically induced".to_string()],
            descriptors: vec![
                MeshDescriptorNode {
                    descriptor: "Parkinson Disease, Secondary".to_string(),
                    mesh_id: "D010302".to_string(),
                    allowed_subheadings: vec![
                        "chemically induced".to_string(),
                        "diagnosis".to_string(),
                        "epidemiology".to_string(),
                    ],
                    selected_subheadings: vec![],
                    tree_numbers: vec![],
                    is_pharmacological_substance: false,
                    no_exp: false,
                    is_major: false,
                },
                MeshDescriptorNode {
                    descriptor: "Parkinsonian Disorders".to_string(),
                    mesh_id: "D020734".to_string(),
                    allowed_subheadings: vec![
                        "chemically induced".to_string(),
                        "drug therapy".to_string(),
                    ],
                    selected_subheadings: vec![],
                    tree_numbers: vec![],
                    is_pharmacological_substance: false,
                    no_exp: false,
                    is_major: false,
                },
            ],
            entry_terms: vec![
                "Secondary Parkinsonism".to_string(),
                "Parkinsonism, Secondary".to_string(),
                "Drug-Induced Parkinsonism".to_string(),
                "Parkinsonian Syndrome".to_string(),
                "Parkinsonian Syndromes".to_string(),
                "Autosomal Dominant Parkinsonism".to_string(),
            ],
            raw_clinical_tokens: vec!["parkinsonisme médicamenteux".to_string()],
            custom_truncations: vec![],
        };

        let compiled = compile_axis_block_rust(&input);

        // 1. Vérifie que `parkinson*` est bloqué par dominance dérivationnelle au profit de `parkinsonis*` et `parkinsonian*`
        assert_eq!(
            compiled.truncations_emitted,
            vec!["parkinsonis*[tiab]", "parkinsonian*[tiab]"]
        );

        // 2. Vérifie que tous les entry_terms contenant "parkinsonism" ou "parkinsonian" sont élagués par subsomption préfixielle
        assert!(compiled.tiab_terms_emitted.is_empty());
        assert_eq!(compiled.pruned_by_subsumption.len(), 5);

        // 3. Vérifie l'identité exacte avec le bloc Gold Standard de la thèse :
        assert_eq!(
            compiled.pubmed_clause,
            "(\"Parkinson Disease, Secondary/chemically induced\"[Mesh] OR \"Parkinsonian Disorders/chemically induced\"[Mesh] OR parkinsonis*[tiab] OR parkinsonian*[tiab])"
        );
    }

    #[test]
    fn test_mixed_pharmacological_class_d27_and_inn_preserves_class_mesh() {
        let input = AxisCompilationInput {
            axis_role: PicoAxisRole::DrugInnList,
            implied_subheadings: vec![],
            descriptors: vec![
                MeshDescriptorNode {
                    descriptor: "Sodium-Glucose Transporter 2 Inhibitors".to_string(),
                    mesh_id: "D000077203".to_string(),
                    allowed_subheadings: vec!["pharmacology".to_string(), "therapeutic use".to_string()],
                    selected_subheadings: vec![],
                    tree_numbers: vec!["D27.505.519.936".to_string()],
                    is_pharmacological_substance: false,
                    no_exp: false,
                    is_major: false,
                },
                MeshDescriptorNode {
                    descriptor: "Canagliflozin".to_string(),
                    mesh_id: "D000068896".to_string(),
                    allowed_subheadings: vec!["pharmacology".to_string(), "adverse effects".to_string()],
                    selected_subheadings: vec![],
                    tree_numbers: vec!["D02.078".to_string()],
                    is_pharmacological_substance: true,
                    no_exp: false,
                    is_major: false,
                },
            ],
            entry_terms: vec![
                "sodium-glucose transporter 2 inhibitors".to_string(),
                "empagliflozin".to_string(),
                "dapagliflozin".to_string(),
            ],
            raw_clinical_tokens: vec!["inhibiteurs sglt2".to_string()],
            custom_truncations: vec![],
        };

        let compiled = compile_axis_block_rust(&input);
        assert!(compiled
            .mesh_terms_emitted
            .contains(&"\"Sodium-Glucose Transporter 2 Inhibitors\"[Mesh]".to_string()));
        assert!(compiled
            .pubmed_clause
            .contains("\"Sodium-Glucose Transporter 2 Inhibitors\"[Mesh]"));
        assert!(compiled.pubmed_clause.contains("empagliflozin*[tiab]"));
        assert!(compiled.pubmed_clause.contains("dapagliflozin*[tiab]"));
        assert!(compiled.pubmed_clause.contains("canagliflozin*[tiab]"));
    }

    #[test]
    fn test_pure_inn_list_compiles_tw_without_mesh() {
        let input = AxisCompilationInput {
            axis_role: PicoAxisRole::DrugInnList,
            implied_subheadings: vec![],
            descriptors: vec![
                MeshDescriptorNode {
                    descriptor: "Haloperidol".to_string(),
                    mesh_id: "D006220".to_string(),
                    allowed_subheadings: vec!["pharmacology".to_string(), "adverse effects".to_string()],
                    selected_subheadings: vec![],
                    tree_numbers: vec!["D03.383.621".to_string()],
                    is_pharmacological_substance: true,
                    no_exp: false,
                    is_major: false,
                },
                MeshDescriptorNode {
                    descriptor: "Risperidone".to_string(),
                    mesh_id: "D018967".to_string(),
                    allowed_subheadings: vec!["pharmacology".to_string(), "adverse effects".to_string()],
                    selected_subheadings: vec![],
                    tree_numbers: vec!["D03.383.621".to_string()],
                    is_pharmacological_substance: true,
                    no_exp: false,
                    is_major: false,
                },
            ],
            entry_terms: vec![
                "Haloperidol Decanoate".to_string(),
                "Metoclopramide".to_string(),
                "4-(4-(4-chlorophenyl)-4-hydroxy-1-piperidinyl)-1-(4-fluorophenyl)-1-butanone"
                    .to_string(),
            ],
            raw_clinical_tokens: vec!["halopéridol".to_string(), "rispéridone".to_string()],
            custom_truncations: vec![],
        };

        let compiled = compile_axis_block_rust(&input);
        assert!(compiled.mesh_terms_emitted.is_empty());
        assert_eq!(
            compiled.tw_terms_emitted,
            vec!["haloperidol[tw]", "risperidone[tw]", "metoclopramide[tw]"]
        );
        assert_eq!(
            compiled.pubmed_clause,
            "(haloperidol[tw] OR risperidone[tw] OR metoclopramide[tw])"
        );
        assert_eq!(
            compiled.embase_clause,
            "('haloperidol':ti,ab,kw,de OR 'risperidone':ti,ab,kw,de OR 'metoclopramide':ti,ab,kw,de)"
        );
        assert_eq!(
            compiled.central_clause,
            "(haloperidol:ti,ab,kw OR risperidone:ti,ab,kw OR metoclopramide:ti,ab,kw)"
        );
    }

    #[test]
    fn test_non_substance_descriptor_in_drug_list_prevents_mesh_drop() {
        // Cas limite : un descripteur sans D27 explicite ni suffixe pluriel mais flaggé is_pharmacological_substance: false
        // aux côtés d'une molécule (is_pharmacological_substance: true) ne doit pas être effacé par is_drug_list.
        let input = AxisCompilationInput {
            axis_role: PicoAxisRole::DrugInnList,
            implied_subheadings: vec![],
            descriptors: vec![
                MeshDescriptorNode {
                    descriptor: "Chemotherapy, Adjuvant".to_string(),
                    mesh_id: "D002624".to_string(),
                    allowed_subheadings: vec!["methods".to_string()],
                    selected_subheadings: vec![],
                    tree_numbers: vec!["E02.319.162".to_string()],
                    is_pharmacological_substance: false,
                    no_exp: false,
                    is_major: false,
                },
                MeshDescriptorNode {
                    descriptor: "Cisplatin".to_string(),
                    mesh_id: "D002945".to_string(),
                    allowed_subheadings: vec!["pharmacology".to_string()],
                    selected_subheadings: vec![],
                    tree_numbers: vec!["D01.210.375".to_string()],
                    is_pharmacological_substance: true,
                    no_exp: false,
                    is_major: false,
                },
            ],
            entry_terms: vec!["adjuvant chemotherapy".to_string(), "cisplatin".to_string()],
            raw_clinical_tokens: vec![],
            custom_truncations: vec![],
        };

        let compiled = compile_axis_block_rust(&input);
        assert!(compiled
            .mesh_terms_emitted
            .contains(&"\"Chemotherapy, Adjuvant\"[Mesh]".to_string()));
        assert!(compiled
            .pubmed_clause
            .contains("\"Chemotherapy, Adjuvant\"[Mesh]"));
        assert!(compiled.pubmed_clause.contains("\"adjuvant chemotherapy\"[tiab]"));
        assert!(compiled.pubmed_clause.contains("cisplatin*[tiab]"));
    }

    #[test]
    fn test_canonical_nlm_subheading_prevention_and_control_with_central_pc() {
        let input = AxisCompilationInput {
            axis_role: PicoAxisRole::Population,
            implied_subheadings: vec![],
            descriptors: vec![MeshDescriptorNode {
                descriptor: "Hypertension".to_string(),
                mesh_id: "D006973".to_string(),
                allowed_subheadings: vec!["therapy".to_string(), "prevention and control".to_string()],
                selected_subheadings: vec!["prevention & control".to_string()],
                tree_numbers: vec!["C14.907.489".to_string()],
                is_pharmacological_substance: false,
                no_exp: false,
                is_major: false,
            }],
            entry_terms: vec!["high blood pressure".to_string()],
            raw_clinical_tokens: vec![],
            custom_truncations: vec![],
        };

        let compiled = compile_axis_block_rust(&input);
        assert!(compiled
            .pubmed_clause
            .contains("\"Hypertension/prevention and control\"[Mesh]"));
        assert!(!compiled.pubmed_clause.contains("prevention & control"));
        assert!(compiled.central_clause.contains("[mh \"Hypertension\"/PC]"));
    }

    #[test]
    fn test_non_clinical_stems_blocked_in_compound_phrases() {
        let input = AxisCompilationInput {
            axis_role: PicoAxisRole::GenericIntervention,
            implied_subheadings: vec![],
            descriptors: vec![
                MeshDescriptorNode {
                    descriptor: "Problem-Based Learning".to_string(),
                    mesh_id: "D018794".to_string(),
                    allowed_subheadings: vec![],
                    selected_subheadings: vec![],
                    tree_numbers: vec!["I02.903".to_string()],
                    is_pharmacological_substance: false,
                    no_exp: false,
                    is_major: false,
                },
                MeshDescriptorNode {
                    descriptor: "Problem Solving".to_string(),
                    mesh_id: "D011340".to_string(),
                    allowed_subheadings: vec![],
                    selected_subheadings: vec![],
                    tree_numbers: vec!["F02.463".to_string()],
                    is_pharmacological_substance: false,
                    no_exp: false,
                    is_major: false,
                },
            ],
            entry_terms: vec![
                "Problem-Based Learning".to_string(),
                "Problem Solving".to_string(),
                "Problem-Based Curriculum".to_string(),
                "Problem-Based Curricula".to_string(),
            ],
            raw_clinical_tokens: vec![],
            custom_truncations: vec![],
        };

        let compiled = compile_axis_block_rust(&input);
        assert!(compiled.truncations_emitted.is_empty());
        assert_eq!(
            compiled.pubmed_clause,
            "(\"Problem-Based Learning\"[Mesh] OR \"Problem Solving\"[Mesh] OR \"problem-based learning\"[tiab] OR \"problem solving\"[tiab] OR \"problem-based curriculum\"[tiab] OR \"problem-based curricula\"[tiab])"
        );
    }

    #[test]
    fn test_prefix_deduplication_subsumes_longer_truncations() {
        let input = AxisCompilationInput {
            axis_role: PicoAxisRole::PathologyOutcome,
            implied_subheadings: vec![],
            descriptors: vec![MeshDescriptorNode {
                descriptor: "Mortality".to_string(),
                mesh_id: "D009026".to_string(),
                allowed_subheadings: vec![],
                selected_subheadings: vec![],
                tree_numbers: vec!["N06.850.505.400".to_string()],
                is_pharmacological_substance: false,
                no_exp: false,
                is_major: false,
            }],
            entry_terms: vec![
                "Mortality".to_string(),
                "Mortalities".to_string(),
                "mortality rate".to_string(),
            ],
            raw_clinical_tokens: vec![],
            custom_truncations: vec![
                "mortal*".to_string(),
                "mortality*".to_string(),
                "mortalities*".to_string(),
            ],
        };

        let compiled = compile_axis_block_rust(&input);
        assert!(compiled
            .truncations_emitted
            .contains(&"mortal*[tiab]".to_string()));
        assert!(!compiled
            .truncations_emitted
            .contains(&"mortality*[tiab]".to_string()));
        assert!(!compiled
            .truncations_emitted
            .contains(&"mortalities*[tiab]".to_string()));
    }

    #[test]
    fn test_iupac_and_lab_codes_filtered_from_tiab() {
        let input = AxisCompilationInput {
            axis_role: PicoAxisRole::TherapeuticClass,
            implied_subheadings: vec![],
            descriptors: vec![MeshDescriptorNode {
                descriptor: "Anticoagulants".to_string(),
                mesh_id: "D000925".to_string(),
                allowed_subheadings: vec![],
                selected_subheadings: vec![],
                tree_numbers: vec!["D27.505.954.502".to_string()],
                is_pharmacological_substance: false,
                no_exp: false,
                is_major: false,
            }],
            entry_terms: vec![
                "rivaroxaban".to_string(),
                "3-oxazolidin-5-yl)methyl)thiophene-2-carboxamide 5-chloro-n-(((5s)-2-oxo-3-(4-(3-oxomorpholin-4-yl)phenyl)-1".to_string(),
                "1-(glucopyranosyl)-4-methyl-3-(5-(4-fluorophenyl)-2-thienylmethyl)benzene - t777973".to_string(),
                "bay 59-7939".to_string(),
                "bay 597939".to_string(),
                "interleukin-17".to_string(),
            ],
            raw_clinical_tokens: vec![],
            custom_truncations: vec![],
        };

        let compiled = compile_axis_block_rust(&input);
        assert!(compiled.pubmed_clause.contains("rivaroxaban*[tiab]"));
        assert!(compiled.pubmed_clause.contains("\"interleukin-17\"[tiab]"));
        assert!(!compiled.pubmed_clause.contains("3-oxazolidin"));
        assert!(!compiled.pubmed_clause.contains("glucopyranosyl"));
        assert!(!compiled.pubmed_clause.contains("bay 59-7939"));
        assert!(!compiled.pubmed_clause.contains("bay 597939"));
    }
}
