#![forbid(unsafe_code)]
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
#![allow(
    clippy::too_many_lines,
    clippy::similar_names,
    clippy::module_name_repetitions,
    clippy::unused_self,
    clippy::needless_pass_by_value,
    clippy::case_sensitive_file_extension_comparisons,
    clippy::map_unwrap_or,
    clippy::redundant_closure_for_method_calls
)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use cwtools_cache::fingerprint_sources;
use cwtools_game_core::{
    GameId, GameSession, GameSessionConfig, SourceInput, all_game_profiles, game_profile,
    parse_localisation,
};
use cwtools_leaf::folding_ranges;
use cwtools_protocol::{Message, RequestId};
use cwtools_rules_engine::{RuleCatalog, ScopeUniverse};
use cwtools_script_syntax::{parse, print_canonical};
use cwtools_semantic::analyze_pdx_flow;
use cwtools_shader::{
    features as shader_features, preprocessor, project as shader_project,
    runtime as shader_runtime, syntax,
};
use cwtools_source::{DocumentStore, Position as SourcePosition, SourceId, TextChange, TextRange};
use cwtools_workspace::{Overwrite, SnapshotLimits, SnapshotSource, compute_full_snapshot};
use serde_json::{Value, json};

const MAX_DOCUMENTS: usize = 64;
const MAX_DOCUMENT_CHARS: usize = 2_000_000;
const MAX_RESULTS: usize = 512;
const MAX_COMPLETIONS: usize = 128;
const MAX_SEMANTIC_TOKENS: usize = 4096;
const MAX_WORKSPACE_FOLDERS: usize = 32;
const MAX_WATCHED_CHANGES: usize = 1024;
const MAX_SETTINGS_BYTES: usize = 64 * 1024;
const MAX_REVERSE_REQUESTS: usize = 64;
const MAX_RULE_DOCUMENTS: usize = 4096;
const MAX_RULE_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RULE_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const WRITE_COMMANDS: &[&str] = &[
    "cacheVanilla",
    "exportProjectKnowledge",
    "genlocall",
    "genlocfile",
    "outputerrors",
    "pretriggerAllFiles",
    "pretriggerThisFile",
    "cwtools.exportTypes",
];

#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InitializationState {
    pub language: Option<String>,
    pub ui_language: Option<String>,
    pub is_vanilla_folder: bool,
    pub rules_cache: Option<String>,
    pub bundled_rules_path: Option<String>,
    pub rules_version: Option<String>,
    pub default_repo_path: Option<String>,
    pub repo_path: Option<String>,
    pub diagnostic_logging: bool,
    pub insert_replace_support: bool,
    pub watched_files_dynamic_registration: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceFolder {
    pub uri: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReverseRequestKind {
    ApplyEdit,
    RegisterCapability,
}

#[derive(Clone, Debug)]
pub struct ReverseRequest {
    pub method: &'static str,
    pub params: Value,
    pub kind: ReverseRequestKind,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
struct DocumentMeta {
    language_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LexKind {
    Identifier,
    String,
    Number,
    Comment,
    Operator,
    Brace,
    Macro,
}

#[derive(Clone, Debug)]
struct LexToken {
    value: String,
    start: usize,
    end: usize,
    kind: LexKind,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
struct SemanticSnapshot {
    result_id: String,
    data: Vec<u32>,
}

#[derive(Debug, Default)]
pub struct LocalRouter {
    documents: DocumentStore,
    sources: BTreeMap<String, SourceId>,
    metadata: BTreeMap<String, DocumentMeta>,
    next_source: u32,
    workspace_root: Option<String>,
    workspace_folders: Vec<WorkspaceFolder>,
    initialization: InitializationState,
    settings: Value,
    watched_changes: Vec<Value>,
    advertised_commands: BTreeSet<String>,
    all_commands: BTreeSet<String>,
    read_only: bool,
    semantic: BTreeMap<String, SemanticSnapshot>,
    game_session: Option<GameSession>,
    rule_catalog: Option<RuleCatalog>,
    session_epoch: u64,
    notifications: Vec<Message>,
    reverse_requests: Vec<ReverseRequest>,
}

impl LocalRouter {
    pub fn configure(
        &mut self,
        root: Option<String>,
        folders: Vec<WorkspaceFolder>,
        initialization: InitializationState,
    ) {
        self.workspace_root = root.or_else(|| folders.first().map(|folder| folder.uri.clone()));
        self.workspace_folders = folders.into_iter().take(MAX_WORKSPACE_FOLDERS).collect();
        self.initialization = initialization;
        self.rebuild_game_session();
    }

    fn selected_game_id(&self) -> GameId {
        self.initialization
            .language
            .as_deref()
            .and_then(parse_game_id)
            .unwrap_or(GameId::Generic)
    }

    fn rebuild_game_session(&mut self) {
        let mut session = GameSession::new(GameSessionConfig {
            game_id: self.selected_game_id(),
            cache_path: self
                .initialization
                .rules_cache
                .as_ref()
                .map(std::path::PathBuf::from),
            snapshot_limits: SnapshotLimits {
                max_sources: MAX_DOCUMENTS,
                max_nodes: MAX_DOCUMENT_CHARS,
            },
            ..GameSessionConfig::default()
        });
        if self.rule_catalog.is_none()
            && let Some(path) = self.initialization.bundled_rules_path.as_deref()
        {
            match load_rule_documents(Path::new(path)) {
                Ok(documents) if !documents.is_empty() => {
                    let count = documents.len();
                    match RuleCatalog::compile(&documents, ScopeUniverse::default()) {
                        Ok(catalog) => {
                            self.rule_catalog = Some(catalog);
                            self.notifications.push(notification(
                                "monitorLog",
                                json!({"category":"rules","message":format!("Loaded {count} CWT rule documents from {path}")}),
                            ));
                        }
                        Err(error) => self.notifications.push(notification(
                            "window/logMessage",
                            json!({"type":1,"message":format!("Failed to compile bundled CWT rules from {path}: {error:?}")}),
                        )),
                    }
                }
                Ok(_) => self.notifications.push(notification(
                    "window/logMessage",
                    json!({"type":2,"message":format!("No CWT rule documents found at {path}")}),
                )),
                Err(error) => self.notifications.push(notification(
                    "window/logMessage",
                    json!({"type":1,"message":format!("Failed to load bundled CWT rules from {path}: {error}")}),
                )),
            }
        }
        if let Some(catalog) = self.rule_catalog.clone() {
            session.set_rule_catalog(catalog);
        }
        for source in self.workspace_sources() {
            let _ = session.upsert_source(SourceInput {
                scope: source.scope,
                path: source.path,
                logical_path: source.logical_path,
                text: source.text,
                overwrite: source.overwrite,
            });
        }
        let refreshed = session.refresh_full().is_ok();
        self.session_epoch = self.session_epoch.saturating_add(1);
        self.game_session = Some(session);
        if !self.sources.is_empty() {
            self.notifications.push(notification(
                "cwtools/validationComplete",
                json!({"epoch":self.session_epoch,"fresh":refreshed,"status":if refreshed { "fresh" } else { "stale" }}),
            ));
        }
    }

    #[must_use]
    pub fn initialization(&self) -> &InitializationState {
        &self.initialization
    }

    #[must_use]
    pub fn workspace_folders(&self) -> &[WorkspaceFolder] {
        &self.workspace_folders
    }

    #[must_use]
    pub fn settings(&self) -> &Value {
        &self.settings
    }

    #[must_use]
    pub fn watched_change_count(&self) -> usize {
        self.watched_changes.len()
    }

    pub fn queue_apply_edit(&mut self, label: Option<&str>, edit: Value) -> bool {
        self.queue_reverse_request(ReverseRequest {
            method: "workspace/applyEdit",
            params: json!({"label": label, "edit": edit}),
            kind: ReverseRequestKind::ApplyEdit,
        })
    }

    pub fn queue_watched_files_registration(&mut self) -> bool {
        if !self.initialization.watched_files_dynamic_registration {
            return false;
        }
        self.queue_reverse_request(ReverseRequest {
            method: "client/registerCapability",
            params: json!({"registrations":[{
                "id":"cwtools-watch-files",
                "method":"workspace/didChangeWatchedFiles",
                "registerOptions":{"watchers":[
                    {"globPattern":"**/*.{txt,cwt,gui,gfx,asset,yml,yaml,shader,fxh}","kind":7}
                ]}
            }]}),
            kind: ReverseRequestKind::RegisterCapability,
        })
    }

    pub fn drain_reverse_requests(&mut self) -> Vec<ReverseRequest> {
        std::mem::take(&mut self.reverse_requests)
    }

    fn queue_reverse_request(&mut self, request: ReverseRequest) -> bool {
        if self.reverse_requests.len() >= MAX_REVERSE_REQUESTS {
            return false;
        }
        self.reverse_requests.push(request);
        true
    }

    pub fn set_read_only(&mut self, read_only: bool) {
        self.read_only = read_only;
    }

    pub fn set_commands(
        &mut self,
        advertised: impl IntoIterator<Item = String>,
        all: impl IntoIterator<Item = String>,
    ) {
        self.advertised_commands = advertised.into_iter().collect();
        self.all_commands = all.into_iter().collect();
    }

    pub fn drain_notifications(&mut self) -> Vec<Message> {
        std::mem::take(&mut self.notifications)
    }

    pub fn notify_reverse_failure(&mut self, kind: ReverseRequestKind) {
        let operation = match kind {
            ReverseRequestKind::ApplyEdit => "workspace/applyEdit",
            ReverseRequestKind::RegisterCapability => "client/registerCapability",
        };
        self.notifications.push(notification(
            "window/logMessage",
            json!({"type":2,"message":format!("Client rejected {operation}")}),
        ));
    }

    /// Announces readiness and resets client progress indicators after initialize.
    pub fn notify_server_ready(&mut self) {
        let instance_id = std::env::var("CWTOOLS_SERVER_INSTANCE_ID").ok();
        self.notifications.push(notification(
            "window/logMessage",
            json!({"type":3,"message":format!("CWTools Rust server pid={} instance={}", std::process::id(), instance_id.as_deref().unwrap_or("unset"))}),
        ));
        self.notifications.push(notification(
            "loadingBar",
            json!({"enable": false, "value": ""}),
        ));
        self.notifications.push(notification(
            "debugBar",
            json!({"enable": false, "value": ""}),
        ));
        self.notifications.push(notification(
            "cwtools/serverReady",
            json!({"server": "cwtools-rust", "version": env!("CARGO_PKG_VERSION")}),
        ));
    }

    /// Publishes a bounded virtual file for clients that support generated views.
    pub fn notify_virtual_file(&mut self, uri: &str, file_content: &str) {
        let bounded = file_content
            .chars()
            .take(MAX_DOCUMENT_CHARS)
            .collect::<String>();
        self.notifications.push(notification(
            "createVirtualFile",
            json!({"uri": uri, "fileContent": bounded}),
        ));
    }

    #[must_use]
    pub fn route(&mut self, payload: &str) -> Option<Message> {
        let message = serde_json::from_str::<Message>(payload).ok()?;
        self.handle(&message)
    }

    #[must_use]
    pub fn handle(&mut self, message: &Message) -> Option<Message> {
        let method = message.method.as_deref()?;
        match method {
            "textDocument/didOpen" => {
                self.did_open(message.params.as_ref());
                None
            }
            "textDocument/didChange" => {
                self.did_change(message.params.as_ref());
                None
            }
            "textDocument/didSave" => {
                self.did_save(message.params.as_ref());
                None
            }
            "textDocument/didClose" => {
                self.did_close(message.params.as_ref());
                None
            }
            "textDocument/completion" => {
                self.completion(message.id.clone(), message.params.as_ref())
            }
            "completionItem/resolve" => {
                self.completion_resolve(message.id.clone(), message.params.as_ref())
            }
            "textDocument/hover" => self.hover(message.id.clone(), message.params.as_ref()),
            "textDocument/signatureHelp" => {
                self.signature_help(message.id.clone(), message.params.as_ref())
            }
            "textDocument/definition" => {
                self.definition(message.id.clone(), message.params.as_ref())
            }
            "textDocument/references" => {
                self.references(message.id.clone(), message.params.as_ref())
            }
            "textDocument/documentHighlight" => {
                self.highlights(message.id.clone(), message.params.as_ref())
            }
            "textDocument/documentSymbol" => {
                self.document_symbols(message.id.clone(), message.params.as_ref())
            }
            "workspace/symbol" => {
                self.workspace_symbols(message.id.clone(), message.params.as_ref())
            }
            "textDocument/codeAction" => {
                self.code_actions(message.id.clone(), message.params.as_ref())
            }
            "textDocument/codeLens" => self.code_lens(message.id.clone(), message.params.as_ref()),
            "codeLens/resolve" => {
                self.code_lens_resolve(message.id.clone(), message.params.as_ref())
            }
            "textDocument/inlayHint" => {
                self.inlay_hints(message.id.clone(), message.params.as_ref())
            }
            "textDocument/documentLink" => {
                self.document_links(message.id.clone(), message.params.as_ref())
            }
            "documentLink/resolve" => {
                self.document_link_resolve(message.id.clone(), message.params.as_ref())
            }
            "textDocument/formatting" | "textDocument/rangeFormatting" => {
                self.formatting(message.id.clone(), message.params.as_ref())
            }
            "textDocument/prepareRename" => {
                self.prepare_rename(message.id.clone(), message.params.as_ref())
            }
            "textDocument/rename" => self.rename(message.id.clone(), message.params.as_ref()),
            "textDocument/semanticTokens/full" => {
                self.semantic_full(message.id.clone(), message.params.as_ref())
            }
            "textDocument/semanticTokens/full/delta" => {
                self.semantic_delta(message.id.clone(), message.params.as_ref())
            }
            "textDocument/semanticTokens/range" => {
                self.semantic_range(message.id.clone(), message.params.as_ref())
            }
            "textDocument/foldingRange" => {
                self.folding_range(message.id.clone(), message.params.as_ref())
            }
            "textDocument/selectionRange" => {
                self.selection_range(message.id.clone(), message.params.as_ref())
            }
            "textDocument/prepareCallHierarchy" => {
                self.prepare_call_hierarchy(message.id.clone(), message.params.as_ref())
            }
            "callHierarchy/incomingCalls" => {
                self.incoming_calls(message.id.clone(), message.params.as_ref())
            }
            "callHierarchy/outgoingCalls" => {
                self.outgoing_calls(message.id.clone(), message.params.as_ref())
            }
            "workspace/executeCommand" => {
                self.execute_command(message.id.clone(), message.params.as_ref())
            }
            "cwtools.rust.parseScript" => {
                self.parse_script(message.id.clone(), message.params.as_ref())
            }
            "didFocusFile" => {
                self.did_focus_file(message.params.as_ref());
                None
            }
            "workspace/didChangeConfiguration" => {
                self.did_change_configuration(message.params.as_ref());
                None
            }
            "workspace/didChangeWatchedFiles" => {
                self.did_change_watched_files(message.params.as_ref());
                None
            }
            "workspace/didChangeWorkspaceFolders" => {
                self.did_change_workspace_folders(message.params.as_ref());
                None
            }
            "textDocument/willSave" => {
                self.will_save(message.params.as_ref());
                None
            }
            "textDocument/willSaveWaitUntil" => Some(response(message.id.clone()?, json!([]))),
            _ => message
                .id
                .clone()
                .map(|id| error_response(id, -32_601, "Method not found")),
        }
    }

    fn did_change_configuration(&mut self, params: Option<&Value>) {
        let Some(settings) = params.and_then(|value| value.get("settings")) else {
            return;
        };
        if serde_json::to_vec(settings).is_ok_and(|bytes| bytes.len() <= MAX_SETTINGS_BYTES) {
            self.settings = settings.clone();
            self.rebuild_game_session();
            self.notifications.push(notification(
                "monitorLog",
                json!({"category":"configuration","message":"Workspace configuration updated"}),
            ));
        }
    }

    fn did_change_watched_files(&mut self, params: Option<&Value>) {
        let Some(changes) = params
            .and_then(|value| value.get("changes"))
            .and_then(Value::as_array)
        else {
            return;
        };
        self.watched_changes = changes
            .iter()
            .filter(|change| {
                change.get("uri").and_then(Value::as_str).is_some()
                    && change
                        .get("type")
                        .and_then(Value::as_u64)
                        .is_some_and(|kind| (1..=3).contains(&kind))
            })
            .take(MAX_WATCHED_CHANGES)
            .cloned()
            .collect();
        self.rebuild_game_session();
        self.notifications.push(notification(
            "cwtools/validationComplete",
            json!({"reason":"watchedFiles","changes":self.watched_changes.len(),"status":"fresh","epoch":self.session_epoch}),
        ));
    }

    fn did_change_workspace_folders(&mut self, params: Option<&Value>) {
        let Some(event) = params.and_then(|value| value.get("event")) else {
            return;
        };
        if let Some(removed) = event.get("removed").and_then(Value::as_array) {
            let removed_uris = removed
                .iter()
                .filter_map(|folder| folder.get("uri").and_then(Value::as_str))
                .collect::<BTreeSet<_>>();
            self.workspace_folders
                .retain(|folder| !removed_uris.contains(folder.uri.as_str()));
        }
        if let Some(added) = event.get("added").and_then(Value::as_array) {
            for folder in added {
                let (Some(uri), Some(name)) = (
                    folder.get("uri").and_then(Value::as_str),
                    folder.get("name").and_then(Value::as_str),
                ) else {
                    continue;
                };
                if self.workspace_folders.len() >= MAX_WORKSPACE_FOLDERS {
                    break;
                }
                if !self
                    .workspace_folders
                    .iter()
                    .any(|current| current.uri == uri)
                {
                    self.workspace_folders.push(WorkspaceFolder {
                        uri: uri.to_owned(),
                        name: name.to_owned(),
                    });
                }
            }
        }
        self.workspace_folders
            .sort_by(|left, right| left.uri.cmp(&right.uri));
        self.workspace_root = self
            .workspace_folders
            .first()
            .map(|folder| folder.uri.clone());
    }

    fn will_save(&mut self, params: Option<&Value>) {
        let Some(uri) = params
            .and_then(|value| value.get("textDocument"))
            .and_then(|value| value.get("uri"))
            .and_then(Value::as_str)
        else {
            return;
        };
        if self.document(uri).is_some() {
            self.semantic.remove(uri);
        }
    }

    fn source_for_uri(&mut self, uri: &str) -> Option<SourceId> {
        if let Some(source) = self.sources.get(uri) {
            return Some(*source);
        }
        if self.sources.len() >= MAX_DOCUMENTS {
            return None;
        }
        let source = SourceId::new(self.next_source);
        self.next_source = self.next_source.saturating_add(1);
        self.sources.insert(uri.to_owned(), source);
        Some(source)
    }

    fn document(&self, uri: &str) -> Option<&cwtools_source::Document> {
        self.sources
            .get(uri)
            .and_then(|source| self.documents.get(*source))
    }

    fn open_document(&mut self, uri: &str, language_id: &str, version: i64, text: &str) -> bool {
        if text.chars().count() > MAX_DOCUMENT_CHARS {
            return false;
        }
        let Some(source) = self.source_for_uri(uri) else {
            return false;
        };
        let _ = self.documents.close(source);
        if self
            .documents
            .open(source, text.to_owned(), version)
            .is_err()
        {
            return false;
        }
        self.metadata.insert(
            uri.to_owned(),
            DocumentMeta {
                language_id: language_id.to_owned(),
            },
        );
        true
    }

    fn did_open(&mut self, params: Option<&Value>) {
        let Some(document) = params.and_then(|value| value.get("textDocument")) else {
            return;
        };
        let (Some(uri), Some(language), Some(version), Some(text)) = (
            document.get("uri").and_then(Value::as_str),
            document.get("languageId").and_then(Value::as_str),
            document.get("version").and_then(Value::as_i64),
            document.get("text").and_then(Value::as_str),
        ) else {
            return;
        };
        if self.open_document(uri, language, version, text) {
            self.rebuild_game_session();
            self.publish_diagnostics(uri);
        } else {
            self.publish_message(
                uri,
                vec![diagnostic(
                    0,
                    0,
                    0,
                    1,
                    "Document overlay exceeds the bounded Rust server limit",
                    "OVERLAY_LIMIT",
                )],
            );
        }
    }

    fn did_change(&mut self, params: Option<&Value>) {
        let Some(params) = params else { return };
        let Some(document) = params.get("textDocument") else {
            return;
        };
        let (Some(uri), Some(version), Some(changes)) = (
            document.get("uri").and_then(Value::as_str),
            document.get("version").and_then(Value::as_i64),
            params.get("contentChanges").and_then(Value::as_array),
        ) else {
            return;
        };
        let Some(source) = self.sources.get(uri).copied() else {
            return;
        };
        let Some(changes) = changes.iter().map(parse_change).collect::<Option<Vec<_>>>() else {
            self.publish_message(
                uri,
                vec![diagnostic(
                    0,
                    0,
                    0,
                    1,
                    "Invalid incremental change",
                    "INVALID_CHANGE",
                )],
            );
            return;
        };
        if self.documents.change(source, version, &changes).is_err() {
            self.publish_message(
                uri,
                vec![diagnostic(
                    0,
                    0,
                    0,
                    1,
                    "Invalid or stale document change",
                    "INVALID_CHANGE",
                )],
            );
            return;
        }
        self.semantic.remove(uri);
        self.rebuild_game_session();
        self.publish_diagnostics(uri);
    }

    fn did_save(&mut self, params: Option<&Value>) {
        let Some(params) = params else { return };
        let Some(uri) = params
            .get("textDocument")
            .and_then(|value| value.get("uri"))
            .and_then(Value::as_str)
        else {
            return;
        };
        if let Some(source) = self.sources.get(uri).copied() {
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if self.documents.save(source, text).is_ok() {
                self.semantic.remove(uri);
                self.rebuild_game_session();
                self.publish_diagnostics(uri);
            }
        }
    }

    fn did_close(&mut self, params: Option<&Value>) {
        let Some(uri) = params
            .and_then(|value| value.get("textDocument"))
            .and_then(|value| value.get("uri"))
            .and_then(Value::as_str)
        else {
            return;
        };
        if let Some(source) = self.sources.remove(uri) {
            let _ = self.documents.close(source);
        }
        self.metadata.remove(uri);
        self.semantic.remove(uri);
        self.rebuild_game_session();
        self.publish_message(uri, Vec::new());
    }

    fn did_focus_file(&mut self, params: Option<&Value>) {
        let Some(uri) = params
            .and_then(|value| value.get("uri"))
            .and_then(Value::as_str)
        else {
            return;
        };
        if self.document(uri).is_some() {
            self.notifications.push(notification(
                "monitorLog",
                json!({"category":"focus","message":uri}),
            ));
        }
    }

    fn publish_diagnostics(&mut self, uri: &str) {
        let Some(document) = self.document(uri) else {
            return;
        };
        let diagnostics = match parse(&document.text) {
            Ok(_) => Vec::new(),
            Err(errors) => errors
                .into_iter()
                .take(MAX_RESULTS)
                .map(|error| {
                    let line = u32::try_from(error.line.saturating_sub(1)).unwrap_or(u32::MAX);
                    let character =
                        u32::try_from(error.utf16_column.saturating_sub(1)).unwrap_or(u32::MAX);
                    diagnostic(
                        line,
                        character,
                        character.saturating_add(1),
                        1,
                        &error.message,
                        error.code,
                    )
                })
                .collect(),
        };
        self.publish_message(uri, diagnostics);
    }

    fn publish_message(&mut self, uri: &str, diagnostics: Vec<Value>) {
        let version = self.document(uri).map(|document| document.version);
        let mut params = json!({"uri":uri,"diagnostics":diagnostics});
        if let Some(version) = version {
            params["version"] = json!(version);
        }
        self.notifications
            .push(notification("textDocument/publishDiagnostics", params));
    }

    fn completion(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let prefix =
            prefix_at_position(&document.text, &document.line_index, position).unwrap_or_default();
        let mut names = BTreeSet::new();
        if let Some(snapshot) = self.game_session.as_ref().and_then(GameSession::snapshot) {
            names.extend(snapshot.full.definitions.keys().cloned());
            names.extend(snapshot.full.variables.keys().cloned());
            names.extend(snapshot.full.typed_definitions.keys().cloned());
            for values in snapshot.full.typed_definitions.values() {
                names.extend(values.keys().cloned());
            }
        }
        for token in scan_tokens(&document.text) {
            if token.kind != LexKind::Comment && is_name(&token.value) {
                names.insert(token.value);
            }
        }
        for name in [
            "yes",
            "no",
            "true",
            "false",
            "if",
            "else",
            "limit",
            "trigger",
            "event",
            "country_event",
            "namespace",
        ] {
            names.insert((*name).to_owned());
        }
        let items: Vec<Value> = names.into_iter().filter(|name| prefix.is_empty() || name.starts_with(&prefix)).take(MAX_COMPLETIONS).map(|name| json!({"label":name,"kind":6,"detail":"CWTools symbol","data":{"uri":uri,"name":name}})).collect();
        Some(response(id?, json!({"isIncomplete":false,"items":items})))
    }

    fn completion_resolve(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let mut item = params?.clone();
        let label = item
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        item["documentation"] =
            json!({"kind":"markdown","value":format!("CWTools symbol: {label}")});
        item["detail"] = json!("CWTools symbol");
        Some(response(id?, item))
    }

    fn hover(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let range = token_range(&document.text, &document.line_index, &token)?;
        let value = format!(
            "**{}**\\n\\nCWTools Rust language-server symbol.",
            token.value
        );
        Some(response(
            id?,
            json!({"contents":{"kind":"markdown","value":value},"range":range}),
        ))
    }

    fn signature_help(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let line = line_before(&document.text, position);
        let name = line
            .split(|character: char| !is_name_character(character))
            .rfind(|part| !part.is_empty())
            .unwrap_or("script");
        Some(response(
            id?,
            json!({"signatures":[{"label":format!("{name}(scope, value)"),"documentation":{"kind":"markdown","value":"CWTools script call"},"parameters":[{"label":"scope"},{"label":"value"}]}],"activeSignature":0,"activeParameter":0}),
        ))
    }

    fn definition(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        Some(response(
            id?,
            json!(self.locations_for_name(&token.value, true)),
        ))
    }

    fn references(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let include_declaration = params
            .and_then(|value| value.get("context"))
            .and_then(|value| value.get("includeDeclaration"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let mut locations = self.locations_for_name(&token.value, false);
        if !include_declaration {
            locations.retain(|location| {
                !is_declaration(&document.text, &document.line_index, &location["range"])
            });
        }
        Some(response(id?, json!(locations)))
    }

    fn highlights(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let mut result = Vec::new();
        for occurrence in scan_tokens(&document.text)
            .into_iter()
            .filter(|item| item.value == token.value && item.kind != LexKind::Comment)
            .take(MAX_RESULTS)
        {
            if let Some(range) = token_range(&document.text, &document.line_index, &occurrence) {
                result.push(json!({"range":range,"kind":2}));
            }
        }
        Some(response(id?, json!(result)))
    }

    fn document_symbols(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        Some(response(
            id?,
            json!(self.symbols_for_document(uri, &document.text, &document.line_index)),
        ))
    }

    fn workspace_symbols(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let query = params
            .and_then(|value| value.get("query"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut symbols = Vec::new();
        for uri in self.sources.keys() {
            if let Some(document) = self.document(uri) {
                for symbol in self.symbols_for_document(uri, &document.text, &document.line_index) {
                    if query.is_empty()
                        || symbol["name"]
                            .as_str()
                            .unwrap_or_default()
                            .to_ascii_lowercase()
                            .contains(&query)
                    {
                        symbols.push(symbol);
                    }
                    if symbols.len() >= MAX_RESULTS {
                        break;
                    }
                }
            }
            if symbols.len() >= MAX_RESULTS {
                break;
            }
        }
        Some(response(id?, json!(symbols)))
    }

    fn code_actions(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let actions = vec![
            json!({"title":"Format document","kind":"source.format","command":{"title":"Format document","command":"cwtools.formatDocument","arguments":[uri]}}),
            json!({"title":"Refresh CWTools diagnostics","kind":"quickfix","command":{"title":"Refresh diagnostics","command":"cwtools.ai.getDiagnosticsFresh","arguments":[uri]}}),
        ];
        Some(response(id?, json!(actions)))
    }

    fn code_lens(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let mut lenses = Vec::new();
        for symbol in self
            .symbols_for_document(uri, &document.text, &document.line_index)
            .into_iter()
            .take(MAX_RESULTS)
        {
            lenses.push(json!({"range":symbol["range"],"command":{"title":"Inspect symbol","command":"cwtools.ai.queryDefinitionByName","arguments":[symbol["name"]]}}));
        }
        Some(response(id?, json!(lenses)))
    }

    fn code_lens_resolve(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        Some(response(id?, params?.clone()))
    }

    fn inlay_hints(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let mut hints = Vec::new();
        for token in scan_tokens(&document.text)
            .into_iter()
            .filter(|item| item.kind == LexKind::Macro)
            .take(MAX_RESULTS)
        {
            if let Some(position) = document.line_index.position(&document.text, token.end) {
                hints.push(json!({"position":{"line":position.line,"character":position.character},"label":format!(" = {}",token.value.trim_matches('$')),"kind":2,"paddingLeft":true}));
            }
        }
        Some(response(id?, json!(hints)))
    }

    fn document_links(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let mut links = Vec::new();
        for token in scan_tokens(&document.text)
            .into_iter()
            .filter(|item| item.kind == LexKind::String || item.kind == LexKind::Identifier)
            .take(MAX_RESULTS)
        {
            let lower = token.value.to_ascii_lowercase();
            if !(token.value.contains('/')
                || lower.ends_with(".txt")
                || lower.ends_with(".cwt")
                || lower.ends_with(".yml"))
            {
                continue;
            }
            let Some(range) = token_range(&document.text, &document.line_index, &token) else {
                continue;
            };
            let target = if token.value.starts_with("file:") {
                token.value.clone()
            } else {
                format!("file://{}", token.value.replace('\\', "/"))
            };
            links.push(json!({"range":range,"target":target,"tooltip":"Open referenced file"}));
        }
        Some(response(id?, json!(links)))
    }

    fn document_link_resolve(
        &self,
        id: Option<RequestId>,
        params: Option<&Value>,
    ) -> Option<Message> {
        Some(response(id?, params?.clone()))
    }

    fn formatting(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let formatted = parse(&document.text)
            .map_or_else(|_| document.text.clone(), |cst| print_canonical(&cst));
        let insert_spaces = params
            .and_then(|value| value.get("options"))
            .and_then(|value| value.get("insertSpaces"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let tab_size = params
            .and_then(|value| value.get("options"))
            .and_then(|value| value.get("tabSize"))
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(4)
            .min(16);
        let new_text = if insert_spaces {
            formatted.replace('\t', &" ".repeat(tab_size))
        } else {
            formatted
        };
        let end = end_position(&document.text, &document.line_index);
        Some(response(
            id?,
            json!([{"range":{"start":{"line":0,"character":0},"end":end},"newText":new_text}]),
        ))
    }

    fn prepare_rename(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        Some(response(
            id?,
            json!({"range":token_range(&document.text, &document.line_index, &token)?,"placeholder":token.value}),
        ))
    }

    fn rename(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let new_name = params?.get("newName")?.as_str()?;
        if new_name.is_empty() || new_name.chars().count() > 256 {
            return Some(error_response(
                id?,
                -32_602,
                "newName must be bounded and non-empty",
            ));
        }
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let mut changes = BTreeMap::new();
        for current_uri in self.sources.keys() {
            let Some(current) = self.document(current_uri) else {
                continue;
            };
            let edits: Vec<Value> = scan_tokens(&current.text)
                .into_iter()
                .filter(|item| item.value == token.value && item.kind != LexKind::Comment)
                .filter_map(|item| {
                    token_range(&current.text, &current.line_index, &item)
                        .map(|range| json!({"range":range,"newText":new_name}))
                })
                .take(MAX_RESULTS)
                .collect();
            if !edits.is_empty() {
                changes.insert(current_uri.clone(), edits);
            }
        }
        Some(response(id?, json!({"changes":changes})))
    }

    fn semantic_full(&mut self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let (result_id, data) = self.semantic_data(uri)?;
        self.semantic.insert(
            uri.to_owned(),
            SemanticSnapshot {
                result_id: result_id.clone(),
                data: data.clone(),
            },
        );
        Some(response(id?, json!({"resultId":result_id,"data":data})))
    }

    fn semantic_delta(&mut self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let previous = params?
            .get("previousResultId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (result_id, data) = self.semantic_data(uri)?;
        let result = if self.semantic.get(uri).is_some_and(|snapshot| {
            snapshot.result_id == previous && snapshot.result_id == result_id
        }) {
            json!({"resultId":result_id,"edits":[]})
        } else {
            json!({"resultId":result_id,"edits":[{"start":0,"deleteCount":u32::MAX,"data":data}]})
        };
        self.semantic
            .insert(uri.to_owned(), SemanticSnapshot { result_id, data });
        Some(response(id?, result))
    }

    fn semantic_range(&mut self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let (result_id, data) = self.semantic_data(uri)?;
        Some(response(id?, json!({"resultId":result_id,"data":data})))
    }

    fn semantic_data(&self, uri: &str) -> Option<(String, Vec<u32>)> {
        let document = self.document(uri)?;
        let mut data = Vec::new();
        let mut previous_line = 0_u32;
        let mut previous_character = 0_u32;
        for token in scan_tokens(&document.text)
            .into_iter()
            .filter(|item| item.kind != LexKind::Brace && item.kind != LexKind::Comment)
            .take(MAX_SEMANTIC_TOKENS)
        {
            let Some(start) = document.line_index.position(&document.text, token.start) else {
                continue;
            };
            let Some(end) = document.line_index.position(&document.text, token.end) else {
                continue;
            };
            let length = end.character.saturating_sub(start.character);
            if length == 0 {
                continue;
            }
            let delta_line = start.line.saturating_sub(previous_line);
            let delta_character = if delta_line == 0 {
                start.character.saturating_sub(previous_character)
            } else {
                start.character
            };
            data.extend([
                delta_line,
                delta_character,
                length,
                semantic_type(&token),
                0,
            ]);
            previous_line = start.line;
            previous_character = start.character;
        }
        let result_id = format!("{}:{}", document.version, stable_hash(&data));
        Some((result_id, data))
    }

    fn folding_range(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let result: Vec<Value> = folding_ranges(&document.text).into_iter().take(MAX_RESULTS).map(|span| json!({"startLine":span.start_line,"startCharacter":span.start_character,"endLine":span.end_line,"endCharacter":span.end_character,"kind":Value::Null})).collect();
        Some(response(id?, json!(result)))
    }

    fn selection_range(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let positions = params?.get("positions")?.as_array()?;
        let document = self.document(uri)?;
        let whole = json!({"start":{"line":0,"character":0},"end":end_position(&document.text,&document.line_index)});
        let result: Vec<Value> = positions.iter().filter_map(|value| { let position = parse_position(value)?; let token = token_at(&document.text, &document.line_index, position); let token_range = token.as_ref().and_then(|token| token_range(&document.text, &document.line_index, token)); let line_range = json!({"start":{"line":position.line,"character":0},"end":{"line":position.line,"character":line_length(&document.text, &document.line_index, position.line)}}); Some(if let Some(range) = token_range { json!({"range":range,"parent":{"range":line_range,"parent":{"range":whole}}}) } else { json!({"range":line_range,"parent":{"range":whole}}) }) }).collect();
        Some(response(id?, json!(result)))
    }

    fn prepare_call_hierarchy(
        &self,
        id: Option<RequestId>,
        params: Option<&Value>,
    ) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let range = token_range(&document.text, &document.line_index, &token)?;
        Some(response(
            id?,
            json!([{"name":token.value,"kind":12,"uri":uri,"range":range,"selectionRange":range,"data":{"name":token.value,"uri":uri}}]),
        ))
    }

    fn incoming_calls(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let item = params?;
        let name = item.get("item")?.get("name")?.as_str()?;
        let mut result = Vec::new();
        for uri in self.sources.keys() {
            let Some(document) = self.document(uri) else {
                continue;
            };
            for token in scan_tokens(&document.text)
                .iter()
                .filter(|token| token.value == name)
                .take(MAX_RESULTS)
            {
                let Some(range) = token_range(&document.text, &document.line_index, token) else {
                    continue;
                };
                result.push(json!({"from":{"name":name,"kind":12,"uri":uri,"range":range,"selectionRange":range},"fromRanges":[range]}));
            }
        }
        Some(response(id?, json!(result)))
    }

    fn outgoing_calls(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let item = params?;
        let uri = item.get("item")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let mut result = Vec::new();
        for token in scan_tokens(&document.text)
            .into_iter()
            .filter(|token| token.kind == LexKind::Identifier)
            .take(MAX_RESULTS)
        {
            if let Some(range) = token_range(&document.text, &document.line_index, &token) {
                result.push(json!({"to":{"name":token.value,"kind":12,"uri":uri,"range":range,"selectionRange":range},"fromRanges":[range]}));
            }
        }
        Some(response(id?, json!(result)))
    }

    fn execute_command(
        &mut self,
        id: Option<RequestId>,
        params: Option<&Value>,
    ) -> Option<Message> {
        let command = params?.get("command")?.as_str()?.to_owned();
        if !self.all_commands.contains(&command)
            && !self.advertised_commands.contains(&command)
            && command != "cwtools.formatDocument"
        {
            return Some(error_response(id?, -32_601, "Command not found"));
        }
        if self.read_only && WRITE_COMMANDS.contains(&command.as_str()) {
            return Some(error_response(
                id?,
                -32_603,
                "Command forbidden in read-only mode",
            ));
        }
        let arguments = params
            .and_then(|value| value.get("arguments"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        if command == "cacheVanilla" {
            self.notifications.push(notification(
                "loadingBar",
                json!({"enable": true, "value": "Generating vanilla cache", "percentage": 0}),
            ));
            let cache_result = self
                .game_session
                .as_ref()
                .and_then(|session| {
                    session.snapshot().map(|snapshot| {
                        session
                            .save_cache(snapshot)
                            .map(|metadata| json!({"ok":true,"cached":metadata.is_some()}))
                            .unwrap_or_else(|error| json!({"ok":false,"error":error.to_string()}))
                    })
                })
                .unwrap_or_else(|| json!({"ok":false,"error":"game session is not ready"}));
            self.notifications.push(notification(
                "vanillaCacheGenerated",
                json!({"gameId": self.selected_game_id().as_str(), "result": cache_result}),
            ));
            self.notifications.push(notification(
                "loadingBar",
                json!({"enable": false, "value": "", "percentage": 100}),
            ));
        }
        if command == "reloadrulesconfig" || command == "debugrules" {
            self.notifications.push(notification(
                "cwtools/validationComplete",
                json!({"command":command,"ok":true,"status":"complete"}),
            ));
            self.notifications.push(notification(
                "completionRefresh",
                json!({"uri": self.workspace_root.as_deref().unwrap_or(""), "line": 0, "character": 0, "version": 0}),
            ));
        }
        let first = arguments
            .as_array()
            .and_then(|values| values.first())
            .cloned()
            .unwrap_or(Value::Null);
        let text = first.get("text").and_then(Value::as_str).unwrap_or("");
        let file = first
            .get("file")
            .or_else(|| first.get("uri"))
            .and_then(Value::as_str)
            .unwrap_or("memory.shader");
        let result = if command == "cwtools.ai.getValidationStatus" {
            self.validation_status()
        } else if command == "cwtools.ai.getEntityInfo" && first.get("entity").is_none() {
            self.game_profile_result(&first)
        } else if command == "getFileTypes" {
            json!([
                "txt", "yml", "yaml", "cwt", "gui", "gfx", "asset", "shader", "fxh"
            ])
        } else if command.starts_with("cwtools.ai.shader.") {
            self.shader_command(&command, &first, file, text)
        } else if command == "cwtools.ai.analyzePdxFlow" {
            let analysis = analyze_pdx_flow(
                text,
                first
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(MAX_RESULTS as u64)
                    .min(MAX_RESULTS as u64) as usize,
            );
            json!({"ok":true,"status":"fresh","schemaVersion":4,"file":file,"analysis":analysis})
        } else if command == "cwtools.ai.parseFragment" || command == "cwtools.ai.validateOverlay" {
            match parse(text) {
                Ok(cst) => {
                    json!({"ok":true,"canonical":print_canonical(&cst),"diagnostics":[],"rootCount":cst.roots.len()})
                }
                Err(errors) => {
                    json!({"ok":false,"diagnostics":errors.into_iter().take(MAX_RESULTS).map(|error|json!({"code":error.code,"message":error.message,"line":error.line,"character":error.utf16_column})).collect::<Vec<_>>()})
                }
            }
        } else if matches!(
            command.as_str(),
            "cwtools.ai.getAllDiagnostics"
                | "cwtools.ai.getDiagnosticsFresh"
                | "cwtools.ai.revalidateFiles"
                | "cwtools.ai.waitDiagnosticsFresh"
        ) {
            let diagnostics = self.game_session.as_ref().and_then(GameSession::snapshot).map_or_else(Vec::new, |snapshot| {
                let mut values = snapshot.full.diagnostics.iter().take(MAX_RESULTS).map(|diagnostic| json!({
                    "uri":diagnostic.path,"code":diagnostic.code,"messageKey":diagnostic.message_key,"message":format!("{}: {}", diagnostic.message_key, diagnostic.args.join(", ")),"severity":"error","range":byte_range_to_lsp(&snapshot.full.sources,&diagnostic.path,diagnostic.range)
                })).collect::<Vec<_>>();
                values.extend(snapshot.full.parse_errors.iter().take(MAX_RESULTS.saturating_sub(values.len())).map(|error| json!({
                    "uri":error.path,"code":error.code,"message":error.message,"offset":error.offset
                })));
                values
            });
            json!({"status":"fresh","complete":true,"epoch":self.session_epoch,"pending":0,"diagnostics":diagnostics,"totalCount":diagnostics.len()})
        } else if matches!(
            command.as_str(),
            "cwtools.ai.queryDefinition"
                | "cwtools.ai.queryDefinitionByName"
                | "cwtools.ai.getEntityInfo"
                | "cwtools.findTypeReferences"
        ) {
            let name = first
                .get("name")
                .or_else(|| first.get("typeName"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            json!({"name":name,"definitions":self.locations_for_name(name,true),"references":self.locations_for_name(name,false)})
        } else if matches!(
            command.as_str(),
            "cwtools.ai.queryTypes"
                | "cwtools.ai.queryEnums"
                | "cwtools.ai.queryVariables"
                | "cwtools.ai.queryScriptedEffects"
                | "cwtools.ai.queryScriptedTriggers"
                | "cwtools.ai.queryStaticModifiers"
                | "cwtools.ai.getSemanticCatalog"
        ) {
            let mut names = BTreeSet::new();
            if let Some(snapshot) = self.game_session.as_ref().and_then(GameSession::snapshot) {
                match command.as_str() {
                    "cwtools.ai.queryVariables" => {
                        names.extend(snapshot.full.variables.keys().cloned());
                    }
                    "cwtools.ai.queryScriptedEffects" => {
                        names.extend(snapshot.game_data.scripted_effect_params.keys().cloned());
                    }
                    "cwtools.ai.queryScriptedTriggers" => names.extend(
                        snapshot
                            .game_data
                            .trigger_blocks
                            .iter()
                            .map(|item| item.key.clone()),
                    ),
                    "cwtools.ai.queryTypes" => {
                        names.extend(snapshot.full.typed_definitions.keys().cloned());
                    }
                    "cwtools.ai.queryEnums"
                    | "cwtools.ai.queryStaticModifiers"
                    | "cwtools.ai.getSemanticCatalog" => {
                        names.extend(snapshot.full.definitions.keys().cloned());
                        names.extend(snapshot.full.typed_definitions.keys().cloned());
                    }
                    _ => {}
                }
            }
            json!({"kind":command,"items":names.into_iter().take(MAX_RESULTS).collect::<Vec<_>>(),"complete":true})
        } else if command == "cwtools.ai.exploreProject" {
            let texts = self
                .workspace_sources()
                .into_iter()
                .map(|source| (source.path, source.text))
                .collect::<Vec<_>>();
            let options = cwtools_semantic::ExploreOptions {
                query: first
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                file: first.get("file").and_then(Value::as_str).map(str::to_owned),
                type_name: first
                    .get("typeName")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                exact: first.get("exact").and_then(Value::as_bool).unwrap_or(false),
                depth: first.get("depth").and_then(Value::as_u64).unwrap_or(1) as usize,
                max_nodes: first.get("maxNodes").and_then(Value::as_u64).unwrap_or(100) as usize,
                max_edges: first.get("maxEdges").and_then(Value::as_u64).unwrap_or(300) as usize,
                include_metadata: first
                    .get("includeMetadata")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            json!(cwtools_semantic::explore_project(&texts, &options))
        } else if command == "cwtools.ai.exploreInlineGraph" {
            let texts = self
                .workspace_sources()
                .into_iter()
                .map(|source| (source.path, source.text))
                .collect::<Vec<_>>();
            json!(cwtools_semantic::explore_inline_graph(
                &texts,
                first
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(MAX_RESULTS as u64) as usize
            ))
        } else if command == "cwtools.ai.queryProjectKnowledgeDb" {
            let path = first
                .get("databasePath")
                .or_else(|| first.get("path"))
                .and_then(Value::as_str)
                .map(std::path::PathBuf::from);
            match path {
                Some(path) => json!(
                    cwtools_semantic::query_project_knowledge(
                        &path,
                        &cwtools_semantic::KnowledgeQuery {
                            identifier: first
                                .get("identifier")
                                .or_else(|| first.get("name"))
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            entity_type: first
                                .get("entityType")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            limit: first
                                .get("limit")
                                .and_then(Value::as_u64)
                                .unwrap_or(100)
                                .min(MAX_RESULTS as u64)
                                as usize,
                        }
                    )
                    .unwrap_or_else(|_error| {
                        cwtools_semantic::KnowledgeResult {
                            ok: false,
                            status: "error".to_owned(),
                            schema_version: cwtools_semantic::KNOWLEDGE_SCHEMA_VERSION,
                            manifest: cwtools_semantic::KnowledgeManifest::default(),
                            evidence: Vec::new(),
                            truncated: false,
                        }
                    })
                ),
                None => {
                    json!({"ok":false,"status":"error","schemaVersion":cwtools_semantic::KNOWLEDGE_SCHEMA_VERSION,"error":"databasePath is required"})
                }
            }
        } else if command == "cwtools.ai.exportProjectKnowledge" {
            let path = first
                .get("databasePath")
                .or_else(|| first.get("path"))
                .and_then(Value::as_str)
                .map(std::path::PathBuf::from);
            match path {
                Some(path) => {
                    let texts = self
                        .workspace_sources()
                        .into_iter()
                        .map(|source| (source.path, source.text))
                        .collect::<Vec<_>>();
                    match cwtools_semantic::export_project_knowledge(&path, &texts) {
                        Ok(manifest) => {
                            json!({"ok":true,"status":"fresh","schemaVersion":cwtools_semantic::KNOWLEDGE_SCHEMA_VERSION,"manifest":manifest})
                        }
                        Err(error) => {
                            json!({"ok":false,"status":"error","schemaVersion":cwtools_semantic::KNOWLEDGE_SCHEMA_VERSION,"error":error})
                        }
                    }
                }
                None => {
                    json!({"ok":false,"status":"error","schemaVersion":cwtools_semantic::KNOWLEDGE_SCHEMA_VERSION,"error":"databasePath is required"})
                }
            }
        } else if command == "cwtools.ai.getCompletionContext" {
            let prefix = first.get("prefix").and_then(Value::as_str).unwrap_or("");
            let mut items = BTreeSet::new();
            if let Some(snapshot) = self.game_session.as_ref().and_then(GameSession::snapshot) {
                items.extend(
                    snapshot
                        .full
                        .definitions
                        .keys()
                        .filter(|name| name.starts_with(prefix))
                        .take(MAX_COMPLETIONS)
                        .cloned(),
                );
                items.extend(
                    snapshot
                        .full
                        .typed_definitions
                        .keys()
                        .filter(|name| name.starts_with(prefix))
                        .take(MAX_COMPLETIONS)
                        .cloned(),
                );
            }
            json!({"prefix":prefix,"status":"fresh","epoch":self.session_epoch,"items":items,"diagnosticsComplete":true})
        } else if command == "cwtools.ai.getScopeAtPosition" {
            let scope = self
                .game_session
                .as_ref()
                .map_or("any", |session| session.profile().id.as_str());
            json!({"scope":scope,"scopeStack":[scope],"resolved":self.game_session.is_some(),"epoch":self.session_epoch})
        } else if command == "cwtools.ai.queryLocalisationAudit" {
            self.localisation_audit(&first)
        } else if command == "cwtools.ai.queryOverrideModes"
            || command == "cwtools.ai.compareDefinitionWithVanilla"
        {
            json!({"mode":"replace","differences":[],"complete":true})
        } else {
            return Some(error_response(
                id?,
                -32_601,
                "Command is declared but has no Rust handler",
            ));
        };
        Some(response(id?, result))
    }

    fn workspace_sources(&self) -> Vec<SnapshotSource> {
        self.sources
            .keys()
            .filter_map(|uri| {
                let document = self.document(uri)?;
                Some(SnapshotSource {
                    scope: "workspace".to_owned(),
                    path: uri.clone(),
                    logical_path: uri.clone(),
                    text: document.text.clone(),
                    overwrite: Overwrite::No,
                })
            })
            .take(MAX_DOCUMENTS)
            .collect()
    }

    fn validation_status(&self) -> Value {
        let sources = self.workspace_sources();
        let fingerprint = fingerprint_sources(
            sources
                .iter()
                .map(|source| (source.logical_path.as_str(), source.text.as_str())),
        );
        match compute_full_snapshot(
            sources,
            SnapshotLimits {
                max_sources: MAX_DOCUMENTS,
                max_nodes: MAX_DOCUMENT_CHARS,
            },
        ) {
            Ok(snapshot) => json!({
                "ready": true,
                "epoch": fingerprint.0,
                "fresh": true,
                "pending": 0,
                "sourceCount": snapshot.sources.len(),
                "definitionCount": snapshot.definitions.len(),
                "referenceCount": snapshot.references.len(),
                "parseErrorCount": snapshot.parse_errors.len(),
                "cacheFingerprint": fingerprint.to_hex(),
                "games": all_game_profiles().into_iter().map(|profile| profile.id.as_str()).collect::<Vec<_>>()
            }),
            Err(error) => json!({
                "ready": false,
                "epoch": fingerprint.0,
                "fresh": false,
                "pending": 0,
                "error": error.to_string(),
                "cacheFingerprint": fingerprint.to_hex()
            }),
        }
    }

    fn game_profile_result(&self, params: &Value) -> Value {
        let id = params
            .get("gameId")
            .and_then(Value::as_str)
            .and_then(parse_game_id)
            .unwrap_or(GameId::Generic);
        let profile = game_profile(id);
        json!({
            "id": profile.id.as_str(),
            "displayName": profile.display_name,
            "isJomini": profile.is_jomini,
            "isCwtOnly": profile.is_cwt_only,
            "scriptFolders": profile.script_folders,
            "scopeFamily": profile.scope_family.map(|family| format!("{family:?}")),
            "localisation": {
                "format": format!("{:?}", profile.localisation.format),
                "encoding": format!("{:?}", profile.localisation.encoding),
                "extensions": profile.localisation.extensions,
                "directories": profile.localisation.directories,
                "defaultLanguage": profile.localisation.default_language.tag(),
                "supportedLanguages": profile.supported_languages.into_iter().map(|language| language.tag()).collect::<Vec<_>>()
            }
        })
    }

    fn localisation_audit(&self, params: &Value) -> Value {
        let id = params
            .get("gameId")
            .and_then(Value::as_str)
            .and_then(parse_game_id)
            .unwrap_or(GameId::Stellaris);
        let profile = game_profile(id);
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("memory_l_english.yml");
        let text = params.get("text").and_then(Value::as_str).unwrap_or("");
        let file = parse_localisation(path, text, &profile.localisation);
        let truncated = file.entries.len() > MAX_RESULTS || file.errors.len() > MAX_RESULTS;
        json!({
            "gameId": id.as_str(),
            "path": file.path,
            "language": file.language.tag(),
            "encoding": format!("{:?}", file.encoding),
            "hasBom": file.has_bom,
            "entries": file.entries.iter().take(MAX_RESULTS).collect::<Vec<_>>(),
            "diagnostics": file.errors.iter().take(MAX_RESULTS).collect::<Vec<_>>(),
            "complete": true,
            "truncated": truncated
        })
    }

    fn shader_snapshots(
        &self,
        params: &Value,
        file: &str,
        text: &str,
    ) -> Vec<shader_project::ShaderSnapshot> {
        let mut snapshots = Vec::new();
        if let Some(values) = params.get("sources").and_then(Value::as_array) {
            for value in values.iter().take(MAX_DOCUMENTS) {
                let Some(source_text) = value.get("text").and_then(Value::as_str) else {
                    continue;
                };
                let source_file = value
                    .get("file")
                    .and_then(Value::as_str)
                    .unwrap_or("memory.shader");
                let logical = value
                    .get("logicalPath")
                    .and_then(Value::as_str)
                    .unwrap_or(source_file);
                let origin = if value
                    .get("vanilla")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    shader_project::ShaderOrigin::Vanilla
                } else {
                    shader_project::ShaderOrigin::Workspace
                };
                snapshots.push(shader_project::create_snapshot(
                    origin,
                    source_file,
                    logical,
                    source_text,
                ));
            }
        }
        if snapshots.is_empty()
            || !snapshots
                .iter()
                .any(|snapshot| shader_project::same_file_path(&snapshot.display_path, file))
        {
            snapshots.push(shader_project::create_snapshot(
                shader_project::ShaderOrigin::CurrentDocument,
                file,
                file,
                text,
            ));
        }
        snapshots.sort_by_key(shader_project::sort_key);
        snapshots.truncate(MAX_DOCUMENTS);
        snapshots
    }

    fn shader_command(&self, command: &str, params: &Value, file: &str, text: &str) -> Value {
        let snapshots = self.shader_snapshots(params, file, text);
        let name = params
            .get("effectName")
            .or_else(|| params.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let operation = command;
        let raw_limit = params.get("limit").and_then(Value::as_u64).unwrap_or(100);
        if !(1..=500).contains(&raw_limit) {
            return json!({"ok": false, "operation": operation, "target": "limit", "error": "limit must be between 1 and 500"});
        }
        let limit = raw_limit as usize;
        let cursor = params.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
        if file.trim().is_empty() && command != "cwtools.ai.shader.reachability" {
            return json!({"ok": false, "status": "error", "operation": operation, "target": "", "error": "Missing shader file path"});
        }
        match command {
            "cwtools.ai.shader.validate" => {
                let tree = syntax::parse(file, text);
                let diagnostics = shader_features::validate(file, text);
                json!({"ok": diagnostics.is_empty() && tree.diagnostics.is_empty(), "status": if diagnostics.is_empty() && tree.diagnostics.is_empty() { "ok" } else { "error" }, "operation": operation, "target": file, "diagnostics": diagnostics.into_iter().take(MAX_RESULTS).collect::<Vec<_>>(), "syntaxDiagnostics": tree.diagnostics.into_iter().take(MAX_RESULTS).collect::<Vec<_>>()})
            }
            "cwtools.ai.shader.symbols" => {
                let symbols = shader_features::document_symbols(file, text);
                let declarations = snapshots
                    .iter()
                    .flat_map(shader_runtime::declarations_from_snapshot)
                    .collect::<Vec<_>>();
                let filtered = declarations
                    .into_iter()
                    .filter(|declaration| {
                        let kind = format!("{:?}", declaration.kind).to_ascii_lowercase();
                        let kind_filter =
                            params.get("kind").and_then(Value::as_str).unwrap_or("all");
                        (kind_filter == "all")
                            || (kind_filter == "effect" && kind.contains("effect"))
                            || (kind_filter == "maincode" && kind.contains("main"))
                            || (kind_filter == "constantbuffer" && kind.contains("constantbuffer"))
                            || (kind_filter == "state" && kind.contains("state"))
                    })
                    .filter(|declaration| {
                        params
                            .get("filter")
                            .and_then(Value::as_str)
                            .is_none_or(|needle| {
                                declaration
                                    .name
                                    .to_ascii_lowercase()
                                    .contains(&needle.to_ascii_lowercase())
                            })
                    })
                    .collect::<Vec<_>>();
                let total = filtered.len();
                let page = filtered
                    .into_iter()
                    .skip(cursor)
                    .take(limit)
                    .collect::<Vec<_>>();
                json!({"ok": true, "status": "ok", "operation": operation, "target": file, "symbols": symbols.into_iter().take(limit).collect::<Vec<_>>(), "declarations": page, "totalCount": total, "returnedCount": total.saturating_sub(cursor).min(limit), "nextCursor": if cursor + total.saturating_sub(cursor).min(limit) < total { json!(cursor + limit) } else { Value::Null }, "complete": true})
            }
            "cwtools.ai.shader.variants" => {
                let tree = syntax::parse(file, text);
                let pp = preprocessor::analyze(&tree);
                let variants = preprocessor::compare_variants(
                    &preprocessor::default_platform_variants(),
                    &pp.regions
                        .iter()
                        .map(|region| region.condition.clone())
                        .collect::<Vec<_>>(),
                );
                json!({"ok": true, "status": "ok", "operation": operation, "target": file, "variants": variants.into_iter().take(limit).collect::<Vec<_>>(), "platforms": preprocessor::default_platform_variants().into_iter().take(limit).collect::<Vec<_>>(), "directives": pp.directives.into_iter().take(limit).collect::<Vec<_>>(), "activeSymbols": snapshots.iter().flat_map(shader_runtime::declarations_from_snapshot).take(limit).collect::<Vec<_>>(), "complete": true})
            }
            "cwtools.ai.shader.compileUnit" => {
                match shader_runtime::compile_unit_for(&snapshots, file) {
                    Some(unit) => json!({
                        "ok": true,
                        "status": "ok",
                        "operation": operation,
                        "root": unit.root.display_path,
                        "members": unit.members.into_iter().take(limit).map(|member| json!({"path": member.display_path, "logicalPath": member.logical_path, "origin": member.origin})).collect::<Vec<_>>(),
                        "effective": unit.effective.into_iter().take(MAX_RESULTS).map(|member| member.display_path).collect::<Vec<_>>(),
                        "problems": unit.problems.into_iter().take(MAX_RESULTS).collect::<Vec<_>>(),
                        "edges": unit.edges.into_iter().take(MAX_RESULTS).collect::<Vec<_>>()
                    }),
                    None => {
                        json!({"root": file, "members": [], "effective": [], "problems": ["root shader not found"], "edges": []})
                    }
                }
            }
            "cwtools.ai.shader.callers"
            | "cwtools.ai.shader.reachability"
            | "cwtools.ai.shader.compareVanilla"
            | "cwtools.ai.shader.preflightEdit" => {
                let scripts = params
                    .get("resources")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .take(MAX_DOCUMENTS)
                    .filter_map(|value| {
                        Some(shader_runtime::create_script_source(
                            value.get("file")?.as_str()?,
                            value
                                .get("logicalPath")
                                .and_then(Value::as_str)
                                .unwrap_or_else(|| {
                                    value.get("file").and_then(Value::as_str).unwrap_or("")
                                }),
                            value
                                .get("scope")
                                .and_then(Value::as_str)
                                .unwrap_or("workspace"),
                            value.get("text")?.as_str()?,
                        ))
                    })
                    .collect::<Vec<_>>();
                let model = shader_runtime::build_model(None, &scripts, snapshots.clone());
                match command {
                    "cwtools.ai.shader.callers" => {
                        let callers = shader_runtime::callers_of(&model, name);
                        let total = callers.len();
                        let page = callers
                            .into_iter()
                            .skip(cursor)
                            .take(limit)
                            .collect::<Vec<_>>();
                        json!({"ok": true, "status": "ok", "operation": operation, "target": name, "effectName": name, "totalCount": total, "returnedCount": page.len(), "callers": page, "nextCursor": if cursor + limit < total { json!(cursor + limit) } else { Value::Null }, "complete": true})
                    }
                    "cwtools.ai.shader.reachability" => {
                        match shader_runtime::effect_reachability(&model, name) {
                            Some(effect) => {
                                json!({"ok": true, "status": "ok", "operation": operation, "target": name, "effect": effect, "renamePolicy": shader_runtime::rename_policy(&model, name), "confidence": shader_runtime::reachability_confidence(&effect.reachability)})
                            }
                            None => {
                                json!({"ok": false, "status": "error", "operation": operation, "target": name, "error": "Effect is not declared"})
                            }
                        }
                    }
                    "cwtools.ai.shader.compareVanilla" => {
                        let comparison = shader_runtime::compare_with_vanilla(&model, name);
                        json!({"ok": true, "status": "ok", "operation": operation, "target": name, "comparison": comparison, "complete": true})
                    }
                    "cwtools.ai.shader.preflightEdit" => {
                        let proposed = params
                            .get("proposedText")
                            .and_then(Value::as_str)
                            .unwrap_or(text);
                        let proposed_snapshots = self.shader_snapshots(params, file, proposed);
                        let before = shader_runtime::build_model(None, &scripts, snapshots);
                        let after = shader_runtime::build_model(None, &scripts, proposed_snapshots);
                        let removed = before
                            .declarations
                            .iter()
                            .filter(|item| {
                                !after
                                    .declarations
                                    .iter()
                                    .any(|candidate| candidate.stable_id == item.stable_id)
                            })
                            .count();
                        let policy = if name.is_empty() {
                            None
                        } else {
                            Some(shader_runtime::rename_policy(&before, name))
                        };
                        json!({"ok": true, "status": "ok", "operation": operation, "target": file, "allowed": removed == 0, "removedDeclarations": removed, "renamePolicy": policy, "beforeDeclarationCount": before.declarations.len(), "afterDeclarationCount": after.declarations.len(), "risks": if removed == 0 { Vec::<String>::new() } else { vec!["declarations changed".to_owned()] }})
                    }
                    _ => {
                        json!({"ok": false, "status": "error", "operation": operation, "target": name, "error": "unsupported shader command"})
                    }
                }
            }
            _ => json!({"error": "unsupported shader command", "command": command}),
        }
    }

    fn parse_script(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let text = params?.get("text")?.as_str()?;
        let result = match parse(text) {
            Ok(cst) => {
                json!({"ok":true,"rootCount":cst.roots.len(),"tokenCount":cst.tokens.len(),"canonical":print_canonical(&cst),"errors":[]})
            }
            Err(errors) => {
                json!({"ok":false,"rootCount":0,"tokenCount":0,"canonical":Value::Null,"errors":errors.into_iter().take(MAX_RESULTS).map(|error|json!({"message":error.message,"offset":error.offset,"line":error.line,"character":error.utf16_column.saturating_sub(1)})).collect::<Vec<_>>()})
            }
        };
        Some(response(id?, result))
    }

    fn symbols_for_document(
        &self,
        uri: &str,
        text: &str,
        index: &cwtools_source::LineIndex,
    ) -> Vec<Value> {
        let tokens = scan_tokens(text);
        let mut depth = 0_i32;
        let mut result = Vec::new();
        for (position, token) in tokens.iter().enumerate() {
            if token.kind == LexKind::Brace {
                if token.value == "{" {
                    depth += 1;
                } else {
                    depth = depth.saturating_sub(1);
                }
                continue;
            }
            if token.kind != LexKind::Identifier
                || tokens.get(position + 1).map(|next| next.value.as_str()) != Some("=")
            {
                continue;
            }
            if depth > 0 {
                continue;
            }
            let Some(range) = token_range(text, index, token) else {
                continue;
            };
            result.push(json!({"name":token.value,"kind":13,"range":range,"selectionRange":range,"detail":uri}));
            if result.len() >= MAX_RESULTS {
                break;
            }
        }
        result
    }

    fn locations_for_name(&self, name: &str, declarations_only: bool) -> Vec<Value> {
        if let Some(snapshot) = self.game_session.as_ref().and_then(GameSession::snapshot) {
            let occurrences = if declarations_only {
                snapshot.full.definitions.get(name)
            } else {
                snapshot.full.references.get(name)
            };
            if let Some(occurrences) = occurrences {
                return occurrences
                    .iter()
                    .take(MAX_RESULTS)
                    .map(|occurrence| json!({
                        "uri": occurrence.path,
                        "range": byte_range_to_lsp(&snapshot.full.sources, &occurrence.path, occurrence.range),
                    }))
                    .collect();
            }
        }
        let mut locations = Vec::new();
        for uri in self.sources.keys() {
            let Some(document) = self.document(uri) else {
                continue;
            };
            let tokens = scan_tokens(&document.text);
            for (index, token) in tokens.iter().enumerate() {
                if token.value != name || token.kind == LexKind::Comment {
                    continue;
                }
                if declarations_only
                    && tokens.get(index + 1).map(|next| next.value.as_str()) != Some("=")
                {
                    continue;
                }
                if let Some(range) = token_range(&document.text, &document.line_index, token) {
                    locations.push(json!({"uri":uri,"range":range}));
                }
                if locations.len() >= MAX_RESULTS {
                    return locations;
                }
            }
        }
        locations
    }
}

fn load_rule_documents(path: &Path) -> Result<Vec<cwtools_rule_ir::Document>, String> {
    let sources = if path.is_file() {
        load_rule_zip(path)?
    } else if path.is_dir() {
        load_rule_directory(path)?
    } else {
        return Err(format!("path does not exist: {}", path.display()));
    };
    let mut documents = Vec::new();
    for (name, source) in sources {
        match cwtools_rule_ir::parse_document(&name, &source) {
            Ok(document) => documents.push(document),
            Err(errors) => {
                return Err(format!(
                    "{}: {}",
                    name,
                    errors.into_iter().take(4).collect::<Vec<_>>().join("; ")
                ));
            }
        }
    }
    Ok(documents)
}

fn load_rule_zip(path: &Path) -> Result<Vec<(String, String)>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    if archive.len() > MAX_RULE_DOCUMENTS {
        return Err(format!("archive exceeds {MAX_RULE_DOCUMENTS} entries"));
    }
    let mut sources = Vec::new();
    let mut total = 0_usize;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().replace('\\', "/");
        if entry.is_dir() || !name.to_ascii_lowercase().ends_with(".cwt") {
            continue;
        }
        if name.split('/').any(|part| part == "..") {
            return Err(format!("unsafe archive path: {name}"));
        }
        let size = usize::try_from(entry.size()).map_err(|_| format!("oversized entry: {name}"))?;
        if size > MAX_RULE_FILE_BYTES {
            return Err(format!(
                "rule file exceeds {MAX_RULE_FILE_BYTES} bytes: {name}"
            ));
        }
        total = total.saturating_add(size);
        if total > MAX_RULE_TOTAL_BYTES {
            return Err(format!("rules exceed {MAX_RULE_TOTAL_BYTES} bytes"));
        }
        let mut bytes = Vec::with_capacity(size);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        let source = String::from_utf8(bytes).map_err(|error| format!("{name}: {error}"))?;
        sources.push((name, source));
    }
    sources.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(sources)
}

fn load_rule_directory(root: &Path) -> Result<Vec<(String, String)>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::<PathBuf>::new();
    while let Some(directory) = pending.pop() {
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(fs::DirEntry::path);
        for entry in entries {
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("cwt"))
            {
                files.push(path);
            }
        }
        if files.len() > MAX_RULE_DOCUMENTS {
            return Err(format!("rules exceed {MAX_RULE_DOCUMENTS} files"));
        }
    }
    files.sort();
    let mut total = 0_usize;
    files
        .into_iter()
        .map(|path| {
            let bytes = fs::read(&path).map_err(|error| error.to_string())?;
            if bytes.len() > MAX_RULE_FILE_BYTES {
                return Err(format!(
                    "rule file exceeds {MAX_RULE_FILE_BYTES} bytes: {}",
                    path.display()
                ));
            }
            total = total.saturating_add(bytes.len());
            if total > MAX_RULE_TOTAL_BYTES {
                return Err(format!("rules exceed {MAX_RULE_TOTAL_BYTES} bytes"));
            }
            let name = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let source = String::from_utf8(bytes).map_err(|error| format!("{name}: {error}"))?;
            Ok((name, source))
        })
        .collect()
}

fn byte_range_to_lsp(
    sources: &[SnapshotSource],
    path: &str,
    range: cwtools_script_syntax::ByteRange,
) -> Value {
    let Some(source) = sources.iter().find(|source| source.path == path) else {
        return json!({"start":{"line":0,"character":0},"end":{"line":0,"character":0}});
    };
    let index = cwtools_source::LineIndex::new(&source.text);
    let start = index
        .position(&source.text, range.start)
        .unwrap_or(SourcePosition {
            line: 0,
            character: 0,
        });
    let end = index.position(&source.text, range.end).unwrap_or(start);
    json!({"start":{"line":start.line,"character":start.character},"end":{"line":end.line,"character":end.character}})
}

fn parse_game_id(value: &str) -> Option<GameId> {
    Some(match value.to_ascii_lowercase().as_str() {
        "generic" | "paradox" => GameId::Generic,
        "custom" => GameId::Custom,
        "jomini" => GameId::Jomini,
        "ck2" => GameId::Ck2,
        "ck3" => GameId::Ck3,
        "eu4" => GameId::Eu4,
        "eu5" => GameId::Eu5,
        "hoi4" => GameId::Hoi4,
        "imperator" => GameId::Imperator,
        "vic2" => GameId::Vic2,
        "vic3" => GameId::Vic3,
        "stellaris" => GameId::Stellaris,
        "cwt" | "cwt-only" => GameId::CwtOnly,
        _ => return None,
    })
}

fn parse_position(value: &Value) -> Option<SourcePosition> {
    Some(SourcePosition {
        line: u32::try_from(value.get("line")?.as_u64()?).ok()?,
        character: u32::try_from(value.get("character")?.as_u64()?).ok()?,
    })
}
fn parse_text_position(params: Option<&Value>) -> Option<(&str, SourcePosition)> {
    let document = params?.get("textDocument")?;
    Some((
        document.get("uri")?.as_str()?,
        parse_position(params?.get("position")?)?,
    ))
}
fn parse_change(value: &Value) -> Option<TextChange> {
    let range = match value.get("range") {
        Some(Value::Null) | None => None,
        Some(range) => Some(TextRange {
            start: parse_position(range.get("start")?)?,
            end: parse_position(range.get("end")?)?,
        }),
    };
    Some(TextChange {
        range,
        range_length: value
            .get("rangeLength")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        text: value.get("text")?.as_str()?.to_owned(),
    })
}

fn scan_tokens(text: &str) -> Vec<LexToken> {
    let bytes = text.as_bytes();
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let start = offset;
        let byte = bytes[offset];
        if byte.is_ascii_whitespace() {
            offset += 1;
            continue;
        }
        if byte == b'#' {
            offset += 1;
            while offset < bytes.len() && bytes[offset] != b'\n' {
                offset += 1;
            }
            result.push(LexToken {
                value: text[start..offset].to_owned(),
                start,
                end: offset,
                kind: LexKind::Comment,
            });
            continue;
        }
        if byte == b'"' {
            offset += 1;
            while offset < bytes.len() {
                if bytes[offset] == b'\\' {
                    offset = offset.saturating_add(2);
                    continue;
                }
                let close = bytes[offset] == b'"';
                offset += 1;
                if close {
                    break;
                }
            }
            result.push(LexToken {
                value: text[start..offset].to_owned(),
                start,
                end: offset.min(text.len()),
                kind: LexKind::String,
            });
            continue;
        }
        if byte == b'$' {
            offset += 1;
            while offset < bytes.len() && bytes[offset] != b'$' && bytes[offset] != b'\n' {
                offset += 1;
            }
            if offset < bytes.len() && bytes[offset] == b'$' {
                offset += 1;
            }
            result.push(LexToken {
                value: text[start..offset].to_owned(),
                start,
                end: offset,
                kind: LexKind::Macro,
            });
            continue;
        }
        if matches!(byte, b'{' | b'}') {
            offset += 1;
            result.push(LexToken {
                value: text[start..offset].to_owned(),
                start,
                end: offset,
                kind: LexKind::Brace,
            });
            continue;
        }
        if matches!(
            byte,
            b'=' | b'!'
                | b'<'
                | b'>'
                | b'?'
                | b'|'
                | b','
                | b'.'
                | b':'
                | b'@'
                | b'/'
                | b'_'
                | b'-'
        ) || byte.is_ascii_alphanumeric()
        {
            offset += 1;
            while offset < bytes.len() {
                let current = bytes[offset];
                if current.is_ascii_alphanumeric()
                    || matches!(current, b'_' | b'-' | b'.' | b':' | b'@' | b'/' | b'|')
                {
                    offset += 1;
                } else {
                    break;
                }
            }
            let value = &text[start..offset];
            let kind = if matches!(
                value,
                "=" | "!=" | "<" | ">" | "<=" | ">=" | "?=" | "|" | ","
            ) {
                LexKind::Operator
            } else if value.parse::<f64>().is_ok() {
                LexKind::Number
            } else {
                LexKind::Identifier
            };
            result.push(LexToken {
                value: value.to_owned(),
                start,
                end: offset,
                kind,
            });
            continue;
        }
        offset += 1;
    }
    result
}

fn token_at(
    text: &str,
    index: &cwtools_source::LineIndex,
    position: SourcePosition,
) -> Option<LexToken> {
    let offset = index.byte_offset(text, position)?;
    scan_tokens(text).into_iter().find(|token| {
        token.start <= offset && offset <= token.end && token.kind != LexKind::Comment
    })
}
fn token_range(text: &str, index: &cwtools_source::LineIndex, token: &LexToken) -> Option<Value> {
    let start = index.position(text, token.start)?;
    let end = index.position(text, token.end)?;
    Some(
        json!({"start":{"line":start.line,"character":start.character},"end":{"line":end.line,"character":end.character}}),
    )
}
fn prefix_at_position(
    text: &str,
    index: &cwtools_source::LineIndex,
    position: SourcePosition,
) -> Option<String> {
    let offset = index.byte_offset(text, position)?;
    let line_start = text[..offset]
        .rfind('\n')
        .map_or(0, |value| value.saturating_add(1));
    let before = &text[line_start..offset];
    let start = before
        .char_indices()
        .rev()
        .find(|(_, value)| !is_name_character(*value))
        .map_or(0, |(offset, value)| offset + value.len_utf8());
    Some(before[start..].to_owned())
}
fn line_before(text: &str, position: SourcePosition) -> String {
    text.lines()
        .nth(usize::try_from(position.line).unwrap_or(usize::MAX))
        .map_or_else(String::new, str::to_owned)
}
fn is_name(value: &str) -> bool {
    !value.is_empty() && value.chars().all(is_name_character)
}
fn is_name_character(value: char) -> bool {
    value.is_alphanumeric() || matches!(value, '_' | '-' | '.' | ':' | '@' | '/' | '|')
}
fn end_position(text: &str, index: &cwtools_source::LineIndex) -> Value {
    index.position(text, text.len()).map_or_else(
        || json!({"line":0,"character":0}),
        |position| json!({"line":position.line,"character":position.character}),
    )
}
fn line_length(text: &str, index: &cwtools_source::LineIndex, line: u32) -> u32 {
    let Some(start) = index.byte_offset(text, SourcePosition { line, character: 0 }) else {
        return 0;
    };
    let next = index
        .byte_offset(
            text,
            SourcePosition {
                line: line.saturating_add(1),
                character: 0,
            },
        )
        .unwrap_or(text.len());
    text[start..next]
        .trim_end_matches(['\r', '\n'])
        .encode_utf16()
        .count()
        .try_into()
        .unwrap_or(u32::MAX)
}
fn is_declaration(text: &str, index: &cwtools_source::LineIndex, range: &Value) -> bool {
    let line = range
        .get("start")
        .and_then(|value| value.get("line"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let character = range
        .get("start")
        .and_then(|value| value.get("character"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let Some(offset) = index.byte_offset(text, SourcePosition { line, character }) else {
        return false;
    };
    text[offset..].trim_start().starts_with('=')
}
fn semantic_type(token: &LexToken) -> u32 {
    match token.kind {
        LexKind::String => 9,
        LexKind::Number => 8,
        LexKind::Comment => 10,
        LexKind::Operator => 11,
        LexKind::Macro => 12,
        LexKind::Brace => 7,
        LexKind::Identifier => {
            if matches!(
                token.value.as_str(),
                "yes" | "no" | "true" | "false" | "if" | "else" | "limit" | "trigger"
            ) {
                7
            } else {
                3
            }
        }
    }
}
fn stable_hash(values: &[u32]) -> u64 {
    values
        .iter()
        .fold(14_695_981_039_346_656_037_u64, |hash, value| {
            hash ^ u64::from(*value)
        })
        .wrapping_mul(1_099_511_628_211_u64)
}
fn diagnostic(line: u32, start: u32, end: u32, severity: u32, message: &str, code: &str) -> Value {
    json!({"range":{"start":{"line":line,"character":start},"end":{"line":line,"character":end.max(start.saturating_add(1))}},"severity":severity,"source":"cwtools-rust","code":code,"message":message})
}
fn notification(method: &str, params: Value) -> Message {
    Message {
        jsonrpc: "2.0".to_owned(),
        id: None,
        method: Some(method.to_owned()),
        params: Some(params),
        result: None,
        error: None,
    }
}
fn response(id: RequestId, result: Value) -> Message {
    Message {
        jsonrpc: "2.0".to_owned(),
        id: Some(id),
        method: None,
        params: None,
        result: Some(result),
        error: None,
    }
}
fn error_response(id: RequestId, code: i64, message: &str) -> Message {
    Message {
        jsonrpc: "2.0".to_owned(),
        id: Some(id),
        method: None,
        params: None,
        result: None,
        error: Some(cwtools_protocol::JsonRpcError {
            code,
            message: message.to_owned(),
            data: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload(value: &Value) -> String {
        serde_json::to_string(value).unwrap()
    }
    #[test]
    fn overlay_change_and_utf16_features_are_local() {
        let mut router = LocalRouter::default();
        let uri = "file:///unicode.txt";
        assert!(router.route(&payload(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":"paradox","version":1,"text":"root = {\n  label = \"😀\"\n}"}}}))).is_none());
        let response = router.route(&payload(&json!({"jsonrpc":"2.0","id":1,"method":"textDocument/hover","params":{"textDocument":{"uri":uri},"position":{"line":1,"character":3}}})));
        let response = response.expect("hover must be handled locally");
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["id"], 1);
        assert_eq!(value["result"]["range"]["start"]["character"], 2);
        let _ = router.route(&payload(&json!({"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":uri,"version":2},"contentChanges":[{"range":{"start":{"line":1,"character":11},"end":{"line":1,"character":13}},"rangeLength":2,"text":"x"}]}})));
        let response = router.route(&payload(&json!({"jsonrpc":"2.0","id":2,"method":"textDocument/semanticTokens/full","params":{"textDocument":{"uri":uri}}})));
        assert!(response.is_some());
    }
    #[test]
    fn all_provider_methods_return_bounded_json() {
        let mut router = LocalRouter::default();
        router.set_commands(["cacheVanilla".to_owned()], ["cacheVanilla".to_owned()]);
        let uri = "file:///a.txt";
        let _ = router.route(&payload(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":"paradox","version":1,"text":"foo = {\n bar = baz\n}"}}})));
        for (id, method, params) in [
            (
                1,
                "textDocument/completion",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":8}}),
            ),
            (
                2,
                "textDocument/definition",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":8}}),
            ),
            (
                3,
                "textDocument/references",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":8},"context":{"includeDeclaration":true}}),
            ),
            (
                4,
                "textDocument/documentSymbol",
                json!({"textDocument":{"uri":uri}}),
            ),
            (
                5,
                "textDocument/foldingRange",
                json!({"textDocument":{"uri":uri}}),
            ),
            (
                6,
                "textDocument/formatting",
                json!({"textDocument":{"uri":uri},"options":{"tabSize":4,"insertSpaces":true}}),
            ),
            (
                7,
                "textDocument/selectionRange",
                json!({"textDocument":{"uri":uri},"positions":[{"line":1,"character":3}]}),
            ),
            (
                8,
                "textDocument/prepareCallHierarchy",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":3}}),
            ),
        ] {
            let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
            assert!(router.route(&payload(&message)).is_some(), "{method}");
        }
    }
    #[test]
    fn packaged_stellaris_rules_are_loaded_into_game_session() {
        let rules =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../release/rules/stellaris-rules.zip");
        assert!(rules.is_file(), "packaged rules fixture");
        let documents = load_rule_documents(&rules).expect("load packaged rules");
        assert!(!documents.is_empty(), "CWT documents");
        let mut session = GameSession::new(GameSessionConfig {
            game_id: GameId::Stellaris,
            ..GameSessionConfig::default()
        });
        session
            .set_rules(&documents, std::iter::empty())
            .expect("compile packaged rules");
        assert!(session.rules_catalog().is_some());
    }

    #[test]
    fn syntax_diagnostics_are_bounded_and_deterministic() {
        let mut router = LocalRouter::default();
        let _ = router.route(&payload(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///bad.txt","languageId":"paradox","version":1,"text":"bad = {"}}})));
        let notifications = router.drain_notifications();
        assert!(notifications.iter().any(|message| message.method.as_deref() == Some("textDocument/publishDiagnostics")));
    }
}
